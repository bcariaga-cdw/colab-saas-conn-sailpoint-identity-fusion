import {
    AccountV2025 as Account,
    AccountsApiListAccountsRequest,
    Source,
    SchemaV2025,
    SourcesV2025ApiGetSourceSchemasRequest,
    OwnerDto,
} from 'sailpoint-api-client'
import { ConnectorError, ConnectorErrorType } from '@sailpoint/connector-sdk'
import { FusionConfig, SourceConfig } from '../../model/config'
import { ClientService, QueuePriority } from '../clientService'
import { LogService } from '../logService'
import { assert } from '../../utils/assert'
import { wrapConnectorError } from '../../utils/error'
import { trimStr } from '../../utils/safeRead'
import { buildSourceConfigPatch } from './helpers'
import { SourceInfo } from './types'
import { buildIscAccountsQueryFilter } from './accountFilters'
import { FusionRun } from '../../model/fusionRun'
import { getManagedAccountKeyFromAccount } from '../../model/managedAccountKey'
import { forEachChunked } from '../../utils/yieldToEventLoop'
import {
    fetchAllSources as fetchAllSourcesImpl,
    validateAccountJmespathFilters as validateAccountJmespathFiltersImpl,
    type SourceDiscoveryDeps,
} from './sourceDiscovery'
import {
    fetchManagedAccounts as fetchManagedAccountsImpl,
    filterManagedMachineAccounts,
    isMachineManagedAccount,
    matchesManagedJmespathFilter,
    type ManagedAccountFetcherDeps,
} from './managedAccountFetcher'
import {
    aggregateDelayedSources as aggregateDelayedSourcesImpl,
    aggregateManagedSource as aggregateManagedSourceImpl,
    aggregateManagedSources as aggregateManagedSourcesImpl,
    getLatestAggregationDate as getLatestAggregationDateImpl,
    type SourceAggregationTaskDeps,
    type SourceAggregatorDeps,
} from './sourceAggregator'
import {
    clearReverseCorrelationReadinessCache as clearReverseCorrelationReadinessCacheImpl,
    ensureFusionSchemaAttribute as ensureFusionSchemaAttributeImpl,
    ensureIdentityAttribute as ensureIdentityAttributeImpl,
    ensureIdentityProfileMapping as ensureIdentityProfileMappingImpl,
    ensureManagedSourceCorrelation as ensureManagedSourceCorrelationImpl,
    getReverseCorrelationSetupStatus as getReverseCorrelationSetupStatusImpl,
    runAssertReverseCorrelationReady,
    runEnsureReverseCorrelationSetup,
    requiresFullReverseCorrelationArtifacts,
    setupReverseCorrelationSources as setupReverseCorrelationSourcesImpl,
    validateNoAttributeOverlap as validateNoAttributeOverlapImpl,
    waitForIdentityProfileMapping as waitForIdentityProfileMappingImpl,
    type ReverseCorrelationDeps,
    type ReverseCorrelationSetupStatus,
} from './reverseCorrelationArtifacts'

// ============================================================================
// SourceService Class
// ============================================================================

/**
 * Service for managing sources, source discovery, and aggregation coordination.
 * Handles all source-related operations including finding the fusion source,
 * managing managed sources, and coordinating aggregations.
 */
function isUnknownMachineAccountId(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const withStatus = error as { status?: number; response?: { status?: number } }
    return (withStatus.response?.status ?? withStatus.status) === 404
}

export class SourceService {
    // Unified source storage - both managed and fusion sources
    private sourcesById: Map<string, SourceInfo> = new Map()
    private aggregationDateCache: Map<string, Promise<Date>> = new Map()
    private allSourcesValue?: SourceInfo[]
    private fusionSourceIdValue?: string
    private fusionSourceOwnerValue?: OwnerDto
    private fusionSourceManagementWorkgroupId?: string
    private workgroupMemberIdsByWorkgroupId = new Map<string, string[]>()
    private processLockAcquired = false
    private sourceSchemasCache: Map<string, SchemaV2025[]> = new Map()

    /** Per-run cache: managed source names that passed reverse-correlation setup/assert this session. */
    private reverseCorrelationReadinessBySourceName = new Set<string>()

    public fusionAccountsByNativeIdentity?: Map<string, Account>

    /**
     * Clear managed accounts cache to free memory after processing.
     */
    public clearManagedAccounts(): void {
        this.run.clearManagedAccountState()
        this.log.debug('Managed accounts cache cleared from memory')
    }

    /**
     * Clear fusion accounts cache to free memory after processing.
     */
    public clearFusionAccounts(): void {
        if (this.fusionAccountsByNativeIdentity) {
            this.fusionAccountsByNativeIdentity.clear()
        }
        this.log.debug('Fusion accounts cache cleared from memory')
    }

    // Config settings
    private readonly config: FusionConfig
    private readonly sources: SourceConfig[]
    private readonly spConnectorInstanceId: string
    private readonly concurrencyCheckEnabled: boolean
    private readonly accountJmespathFiltersBySourceName = new Map<
        string,
        import('./accountFilters').CompiledAccountJmespathFilter
    >()

    // Sources configured for batch mode (`accountLimit` defined)
    private readonly batchLimitedSourceNames: Set<string>
    // Batch mode cumulative count per source (persisted across runs)
    private batchCumulativeCount: Record<string, number>

    constructor(
        config: FusionConfig,
        private log: LogService,
        private client: ClientService,
        public run: FusionRun
    ) {
        this.config = config
        this.sources = config.sources
        this.spConnectorInstanceId = config.spConnectorInstanceId
        this.concurrencyCheckEnabled = config.concurrencyCheckEnabled
        this.batchLimitedSourceNames = new Set(
            this.sources
                .filter((source) => typeof source.accountLimit === 'number' && Number.isFinite(source.accountLimit))
                .map((source) => source.name)
        )

        const raw = config.batchCumulativeCount
        const persistedCount =
            raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, number>) : {}
        this.batchCumulativeCount = Object.fromEntries(
            Object.entries(persistedCount).filter(
                ([sourceName, count]) => this.batchLimitedSourceNames.has(sourceName) && typeof count === 'number'
            )
        )
    }

    // ------------------------------------------------------------------------
    // Public Properties/Getters
    // ------------------------------------------------------------------------

    public get fusionSourceId(): string {
        assert(this.fusionSourceIdValue, 'Fusion source not found')
        return this.fusionSourceIdValue
    }

    public get managedSources(): SourceInfo[] {
        assert(this.allSourcesValue, 'Sources have not been loaded')
        if (!this.fusionSourceIdValue) {
            return this.allSourcesValue
        }
        return this.allSourcesValue.filter((s) => s.id !== this.fusionSourceId)
    }

    public get allSources(): SourceInfo[] {
        assert(this.allSourcesValue, 'Sources have not been loaded')
        return this.allSourcesValue
    }

    public get managedAccounts(): Account[] {
        assert(this.run.managedAccountsById, 'Managed accounts have not been loaded')
        return Array.from(this.run.managedAccountsById.values())
    }

    public get managedAccountCount(): number {
        return this.run.managedAccountsById.size
    }

    public get fusionAccounts(): Account[] {
        assert(this.fusionAccountsByNativeIdentity, 'Fusion accounts have not been loaded')
        return Array.from(this.fusionAccountsByNativeIdentity.values())
    }

    public get fusionAccountCount(): number {
        return this.fusionAccountsByNativeIdentity?.size ?? 0
    }

    public get hasFusionSource(): boolean {
        return !!this.fusionSourceIdValue
    }

    public get isCascadeAggregationEnabled(): boolean {
        return this.config.cascadeAggregationEnabled ?? false
    }

    // ------------------------------------------------------------------------
    // Public Source Fetch Methods
    // ------------------------------------------------------------------------

    public async fetchAllSources(requireFusionSource = true): Promise<void> {
        const deps = this.discoveryDeps
        await fetchAllSourcesImpl(deps, requireFusionSource)
        const { state } = deps
        this.allSourcesValue = state.allSources
        this.fusionSourceIdValue = state.fusionSourceId
        this.fusionSourceOwnerValue = state.fusionSourceOwner
        this.fusionSourceManagementWorkgroupId = state.fusionSourceManagementWorkgroupId
        this.sourcesById = state.sourcesById
    }

    // ------------------------------------------------------------------------
    // Public Source Lookup Methods
    // ------------------------------------------------------------------------

    public getFusionSource(): SourceInfo | undefined {
        return Array.from(this.sourcesById.values()).find((s) => !s.isManaged)
    }

    public get fusionSourceOwner(): OwnerDto {
        assert(this.fusionSourceOwnerValue, 'Fusion source owner not found')
        return this.fusionSourceOwnerValue
    }

    public isEmailWorkflowConfigured(): boolean {
        return Boolean(this.config.workflowName)
    }

    public async fetchGlobalOwnerIdentityIds(): Promise<string[]> {
        const ownerIdSet = new Set<string>()

        let owner: OwnerDto
        try {
            owner = this.fusionSourceOwner
        } catch (error) {
            if (error instanceof Error && error.message.includes('Fusion source owner not found')) {
                return []
            }
            throw error
        }

        if (owner.id) {
            if (String(owner.type).toUpperCase() === 'GOVERNANCE_GROUP') {
                const memberIds = await this.listWorkgroupMemberIdentityIds(owner.id)
                for (const id of memberIds) ownerIdSet.add(id)
            } else {
                ownerIdSet.add(owner.id)
            }
        }

        const workgroupId = this.fusionSourceManagementWorkgroupId
        if (workgroupId) {
            const memberIds = await this.listWorkgroupMemberIdentityIds(workgroupId)
            for (const id of memberIds) ownerIdSet.add(id)
        }

        return Array.from(ownerIdSet)
    }

    private async listWorkgroupMemberIdentityIds(workgroupId: string): Promise<string[]> {
        const cached = this.workgroupMemberIdsByWorkgroupId.get(workgroupId)
        if (cached) return cached

        const members = await this.client.call<any[]>(
            (api: any) =>
                api.governanceGroups.listWorkgroupMembers({ workgroupId, limit: 250 }).then((r: any) => r.data),
            { priority: QueuePriority.HIGH, context: 'SourceService>fetchGlobalOwnerIdentityIds' }
        )
        const memberIds = (members ?? []).filter((m: any) => m.id).map((m: any) => m.id!)
        this.workgroupMemberIdsByWorkgroupId.set(workgroupId, memberIds)
        return memberIds
    }

    public getSourceById(id: string): SourceInfo | undefined {
        return this.sourcesById.get(id)
    }

    public getSourceByName(name: string): SourceInfo | undefined {
        return this.run.sourcesByName.get(name)
    }

    public getSourceByNameSafe(name?: string | null): SourceInfo | undefined {
        if (!name?.trim()) return undefined
        return this.getSourceByName(name)
    }

    // ------------------------------------------------------------------------
    // Public Source Configuration Methods
    // ------------------------------------------------------------------------

    public getSourceConfig(sourceName: string): SourceConfig | undefined {
        const sourceInfo = this.run.sourcesByName.get(sourceName)
        return sourceInfo?.config ?? this.sources.find((sc) => sc.name === sourceName)
    }

    public getAccountFilter(sourceName: string): string | undefined {
        return this.getSourceConfig(sourceName)?.accountFilter
    }

    public get delayedAggregationSources(): SourceConfig[] {
        return this.sources.filter((sc) => sc.aggregationMode === 'delayed')
    }

    public get reverseCorrelationSources(): SourceConfig[] {
        return this.sources.filter((sc) => sc.correlationMode === 'reverse')
    }

    public validateAccountJmespathFilters(): void {
        validateAccountJmespathFiltersImpl(this.discoveryDeps)
    }

    public async fireDisableAccount(accountId: string): Promise<void> {
        const accessToken = await this.resolveApiAccessToken()
        const tenantBaseUrl = this.config.baseurl.replace(/\/+$/, '')
        const apiBaseUrl = tenantBaseUrl.endsWith('/v2025') ? tenantBaseUrl : `${tenantBaseUrl}/v2025`
        const url = `${apiBaseUrl}/accounts/${encodeURIComponent(accountId)}/disable`

        this.log.info(`Disabling account ${accountId} with low priority`)
        await this.client.call(
            async (_api: any) => {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({}),
                })

                if (!response.ok) {
                    const responseBody = await response.text()
                    const safeBodyPreview =
                        responseBody.length > 100 ? responseBody.substring(0, 100) + '...' : responseBody
                    throw new Error(`HTTP ${response.status} ${response.statusText} - ${safeBodyPreview}`)
                }
            },
            { priority: QueuePriority.LOW, context: 'SourceService>fireDisableAccount' }
        )
    }

    private async resolveApiAccessToken(): Promise<string> {
        const accessTokenResolver = this.client.accessToken
        assert(accessTokenResolver, 'Client access token resolver is not configured')

        if (typeof accessTokenResolver === 'string') {
            return accessTokenResolver
        }

        if (typeof accessTokenResolver === 'function') {
            const token = await accessTokenResolver(undefined, [])
            assert(token, 'Failed to resolve API access token')
            return token
        }

        const token = await accessTokenResolver
        assert(token, 'Failed to resolve API access token')
        return token
    }

    // ------------------------------------------------------------------------
    // Public Account Fetch Methods (Bulk)
    // ------------------------------------------------------------------------

    public async fetchAccountsBySourceId(sourceId: string, limit?: number): Promise<Account[]> {
        const sourceInfo = this.sourcesById.get(sourceId)
        assert(sourceInfo, `Source not found for id: ${sourceId}`)

        const filters = buildIscAccountsQueryFilter(sourceInfo)
        const sorters = 'id'

        const requestParameters: AccountsApiListAccountsRequest = {
            filters,
            limit,
            sorters,
        }

        const ctx = `SourceService>fetchAccountsBySourceId ${sourceInfo.name}`
        const accounts = await this.client.call<any>((api: any, params: any) => api.accounts.listAccounts(params), {
            paginate: { mode: 'sequential', baseParams: requestParameters as any },
            priority: QueuePriority.HIGH,
            context: ctx,
        })
        if (!sourceInfo.isManaged) {
            return accounts
        }
        const { filteredAccounts, discardedMachineCount } = filterManagedMachineAccounts(accounts)
        if (discardedMachineCount > 0) {
            this.log.warn(
                `Source ${sourceInfo.name}: discarded ${discardedMachineCount} managed machine account(s) where isMachine=true`
            )
        }
        return filteredAccounts
    }

    public async *fetchAccountsBySourceIdGenerator(
        sourceId: string,
        abortSignal?: AbortSignal,
        limit?: number,
        onPageProgress?: (loaded: number, total?: number) => void
    ): AsyncGenerator<Account[], void, unknown> {
        const sourceInfo = this.sourcesById.get(sourceId)
        assert(sourceInfo, `Source not found for id: ${sourceId}`)

        const filters = buildIscAccountsQueryFilter(sourceInfo)
        const sorters = 'id'

        const requestParameters: AccountsApiListAccountsRequest = {
            filters,
            sorters,
        }

        const ctx = `SourceService>fetchAccountsBySourceIdGenerator ${sourceInfo.name}`
        yield* this.client.call<any>((api: any, params: any) => api.accounts.listAccounts(params), {
            paginate: { mode: 'parallel', baseParams: requestParameters as any, limit },
            priority: QueuePriority.HIGH,
            context: ctx,
            abortSignal,
            onPageProgress,
        })
    }

    /**
     * Fetches Fusion accounts and bulk-ingests each page without blocking operation timers.
     */
    public async fetchFusionAccounts(): Promise<void> {
        this.log.debug('Fetching fusion accounts')
        await wrapConnectorError(async () => {
            this.fusionAccountsByNativeIdentity = new Map()
            let ingested = 0
            let knownTotal: number | undefined
            let ingestDetailLogged = false

            for await (const batch of this.fetchAccountsBySourceIdGenerator(
                this.fusionSourceId,
                undefined,
                undefined,
                (_loaded, total) => {
                    knownTotal = total
                }
            )) {
                if (!ingestDetailLogged && knownTotal && knownTotal > 0) {
                    this.log.detail({ action: 'ingesting fusion-accounts', count: knownTotal })
                    ingestDetailLogged = true
                }

                const pageStart = ingested
                await forEachChunked(
                    batch,
                    (account) => {
                        this.fusionAccountsByNativeIdentity!.set(account.nativeIdentity!, account)
                    },
                    {
                        onProgress: (pageDone) => {
                            const done = pageStart + pageDone
                            this.log.setFetchPopulationProgress('fusion-accounts', done, knownTotal ?? done)
                        },
                    }
                )
                ingested += batch.length
            }
            this.log.debug(`Fetched ${this.fusionAccountsByNativeIdentity.size} fusion account(s)`)
        }, 'Failed to fetch fusion accounts from the fusion source')
    }

    public async fetchManagedAccounts(abortSignal?: AbortSignal): Promise<void> {
        return fetchManagedAccountsImpl(this.managedAccountFetcherDeps, abortSignal)
    }

    // ------------------------------------------------------------------------
    // Public Account Fetch Methods (Single)
    // ------------------------------------------------------------------------

    public async fetchFusionAccount(nativeIdentity: string, mustExist = true): Promise<void> {
        this.log.debug('Fetching fusion account')
        const fusionAccount = await this.fetchSourceAccountByNativeIdentity(this.fusionSourceId, nativeIdentity)

        if (!fusionAccount) {
            if (mustExist) {
                throw new ConnectorError(
                    `Fusion account not found for identity: ${nativeIdentity}`,
                    ConnectorErrorType.Generic
                )
            }
            return
        }

        if (!this.fusionAccountsByNativeIdentity) {
            this.fusionAccountsByNativeIdentity = new Map()
        }
        this.fusionAccountsByNativeIdentity.set(fusionAccount.nativeIdentity!, fusionAccount)
        this.log.debug(`Fetched fusion account: ${fusionAccount.name}`)
    }

    public async fetchManagedAccount(sourceId: string, nativeIdentity: string): Promise<void> {
        const sourceInfo = this.sourcesById.get(sourceId)
        if (!sourceInfo?.isManaged) {
            this.log.warn(
                `Discarded account for native identity "${nativeIdentity}" from non-configured or non-managed source "${sourceId}" during single-account fetch`
            )
            return
        }

        const managedAccount = await this.fetchSourceAccountByNativeIdentity(sourceId, nativeIdentity)
        if (!managedAccount) {
            return
        }

        const accountKey = getManagedAccountKeyFromAccount(managedAccount)
        if (!accountKey) {
            this.log.warn(
                `Managed account missing composite key data for source "${sourceId}" nativeIdentity "${nativeIdentity}"`
            )
            return
        }
        this.run.setManagedAccount(accountKey, managedAccount)
    }

    public resolveIscAccountIdForManagedKey(managedKey: string): string | undefined {
        const key = trimStr(managedKey)
        if (key === undefined) return undefined
        const queueAccount = this.run.managedAccountsById.get(key)
        if (queueAccount) {
            return trimStr(queueAccount.id)
        }
        return trimStr(this.run.getManagedAccountInfo(key)?.id)
    }

    public async fetchSourceAccountByNativeIdentity(
        sourceId: string,
        nativeIdentity: string
    ): Promise<Account | undefined> {
        const sourceInfo = this.sourcesById.get(sourceId)
        assert(sourceInfo, `Source not found for id: ${sourceId}`)

        const filters = buildIscAccountsQueryFilter(sourceInfo, `nativeIdentity eq "${nativeIdentity}"`)

        const requestParameters: AccountsApiListAccountsRequest = {
            filters,
            limit: 1,
        }

        const accounts = await this.client.call<any[]>(
            (api: any) => api.accounts.listAccounts(requestParameters).then((r: any) => r.data ?? []),
            { priority: QueuePriority.HIGH, context: 'SourceService>fetchSourceAccountByNativeIdentity' }
        )
        const candidate = accounts?.[0]
        if (
            sourceInfo.isManaged &&
            candidate &&
            !matchesManagedJmespathFilter(sourceInfo, candidate, this.accountJmespathFiltersBySourceName)
        ) {
            this.log.warn(
                `Discarded managed account for native identity "${nativeIdentity}" on source "${sourceInfo.name}" due to Accounts JMESPath filter`
            )
            return undefined
        }
        if (sourceInfo.isManaged && candidate && isMachineManagedAccount(candidate)) {
            this.log.warn(
                `Discarded managed machine account for native identity "${nativeIdentity}" on source "${sourceInfo.name}" where isMachine=true`
            )
            return undefined
        }
        return candidate
    }

    /**
     * Sets `ownerIdentity` on a machine account to the selected identity.
     * This updates `ownerIdentity` and does not correlate the account: it does not PATCH `/identityId`.
     * Uses JSON Patch `add` so a missing/null `ownerIdentity` is created (ISC upsert semantics).
     * The machine-account update operation does not define an experimental header, so none is sent.
     * A failed write is logged and does not fail aggregation. No local owned flag is stored, so the next run retries.
     */
    public async setMachineAccountOwnerIdentity(
        account: { id: string; iscAccountId?: string; sourceId?: string; nativeIdentity?: string },
        identityId: string
    ): Promise<void> {
        const ownerIdentity = { type: 'IDENTITY' as const, id: identityId }
        const fetchedId = this.resolveFetchedMachineAccountId(account)
        if (fetchedId) {
            try {
                await this.patchMachineAccountOwnerIdentity(fetchedId, ownerIdentity)
                return
            } catch (error) {
                if (!isUnknownMachineAccountId(error)) {
                    this.logOwnerIdentityWriteFailure(account, error)
                    return
                }
            }
        }

        try {
            const resolvedId = await this.findMachineAccountIdByNativeIdentity(account)
            if (!resolvedId || resolvedId === fetchedId) {
                this.logOwnerIdentityWriteFailure(account, new Error(`Machine account id not found for "${account.id}"`))
                return
            }
            await this.patchMachineAccountOwnerIdentity(resolvedId, ownerIdentity)
        } catch (error) {
            this.logOwnerIdentityWriteFailure(account, error)
        }
    }

    private resolveFetchedMachineAccountId(account: {
        id: string
        iscAccountId?: string
    }): string | undefined {
        return trimStr(account.iscAccountId) ?? this.resolveIscAccountIdForManagedKey(account.id)
    }

    private async patchMachineAccountOwnerIdentity(
        id: string,
        ownerIdentity: { type: 'IDENTITY'; id: string }
    ): Promise<void> {
        const result = await this.client.call(
            (api) =>
                api.machineAccounts
                    .updateMachineAccount({
                        id,
                        // `add` upserts when ownerIdentity is missing/null; `replace` yields 400.1 in that case.
                        requestBody: [{ op: 'add', path: '/ownerIdentity', value: ownerIdentity }],
                    })
                    .then((response) => response.data),
            {
                priority: QueuePriority.LOW,
                context: 'SourceService>setMachineAccountOwnerIdentity',
                throwOnError: true,
            }
        )
        if (result === undefined) {
            throw new Error(`Machine account owner identity update returned no result for "${id}"`)
        }
    }

    private async findMachineAccountIdByNativeIdentity(account: {
        sourceId?: string
        nativeIdentity?: string
    }): Promise<string | undefined> {
        const sourceId = trimStr(account.sourceId)
        const nativeIdentity = trimStr(account.nativeIdentity)
        if (!sourceId || !nativeIdentity) return undefined
        const accounts = await this.client.call(
            (api) =>
                api.machineAccounts
                    .listMachineAccounts({
                        filters: `source.id eq "${sourceId}" and nativeIdentity eq "${nativeIdentity}"`,
                        limit: 1,
                    })
                    .then((response) => response.data ?? []),
            { priority: QueuePriority.LOW, context: 'SourceService>findMachineAccountIdByNativeIdentity' }
        )
        return trimStr(accounts?.[0]?.id)
    }

    private logOwnerIdentityWriteFailure(
        account: { id: string; nativeIdentity?: string },
        error: unknown
    ): void {
        const detail = error instanceof Error ? error.message : String(error)
        this.log.error(
            `Failed to set owner identity for machine account "${account.nativeIdentity ?? account.id}": ${detail}`
        )
    }

    // ------------------------------------------------------------------------
    // Public Aggregation Methods
    // ------------------------------------------------------------------------

    public async aggregateManagedSources(): Promise<void> {
        return aggregateManagedSourcesImpl(this.aggregatorDeps)
    }

    public async aggregateDelayedSources(
        scheduleAggregation: (args: {
            sourceId: string
            delayMinutes: number
            disableOptimization: boolean
        }) => Promise<void>
    ): Promise<void> {
        return aggregateDelayedSourcesImpl(this.aggregatorDeps, scheduleAggregation)
    }

    public async getLatestAggregationDate(sourceId: string): Promise<Date> {
        return getLatestAggregationDateImpl(this.aggregatorDeps, sourceId)
    }

    public async aggregateManagedSource(
        id: string,
        disableOptimization?: boolean,
        awaitTaskStatus: boolean = true
    ): Promise<void> {
        return aggregateManagedSourceImpl(this.aggregationTaskDeps, id, disableOptimization, awaitTaskStatus)
    }

    // ------------------------------------------------------------------------
    // Public Schema Methods
    // ------------------------------------------------------------------------

    public async listSourceSchemas(sourceId: string): Promise<SchemaV2025[]> {
        const cachedSchemas = this.sourceSchemasCache.get(sourceId)
        if (cachedSchemas) {
            return cachedSchemas
        }

        const requestParameters: SourcesV2025ApiGetSourceSchemasRequest = {
            sourceId,
        }
        const schemas = await this.client.call(
            (api) => api.sources.getSourceSchemas(requestParameters).then((r) => r.data ?? []),
            { priority: QueuePriority.HIGH, context: 'SourceService>listSourceSchemas' }
        )
        if (!schemas) {
            throw new ConnectorError(
                `Failed to fetch schemas for source "${sourceId}". The API call returned no data.`,
                ConnectorErrorType.Generic
            )
        }

        this.sourceSchemasCache.set(sourceId, schemas)
        return schemas
    }

    // ------------------------------------------------------------------------
    // Public Configuration Methods
    // ------------------------------------------------------------------------

    public async patchSourceConfig(
        sourceId: string,
        path: string,
        value: any,
        context?: string
    ): Promise<Source | undefined> {
        const requestParameters = buildSourceConfigPatch(sourceId, path, value)
        const ctx = context ?? 'SourceService>patchSourceConfig'
        return await this.client.call((api) => api.sources.updateSource(requestParameters).then((r) => r.data), {
            priority: QueuePriority.HIGH,
            context: ctx,
        })
    }

    // ------------------------------------------------------------------------
    // Public Process Lock Methods
    // ------------------------------------------------------------------------

    public async setProcessLock(): Promise<void> {
        if (!this.concurrencyCheckEnabled) {
            this.log.debug('Concurrency check is disabled, skipping processing lock.')
            return
        }

        const fusionSourceId = this.fusionSourceId

        const currentSource = await this.client.call(
            (api) => api.sources.getSource({ id: fusionSourceId }).then((r) => r.data),
            { priority: QueuePriority.HIGH, context: 'SourceService>setProcessLock executeGetSource' }
        )
        assert(currentSource, 'Failed to fetch fusion source to check processing lock. The API call returned no data.')

        const processing = (currentSource!.connectorAttributes as any)?.processing
        if (processing === 'true' || processing === true) {
            this.log.warn('Processing flag is active. Aborting this run.')
            throw new ConnectorError(
                'An account aggregation is already in progress or the previous one did not finish cleanly. ' +
                    'Please verify no other aggregation is running and try again.',
                ConnectorErrorType.Generic
            )
        }

        this.log.info('Setting processing lock to true.')
        await this.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/processing',
            true,
            'SourceService>setProcessLock'
        )
        this.processLockAcquired = true
    }

    public async releaseProcessLock(): Promise<void> {
        if (!this.concurrencyCheckEnabled || !this.processLockAcquired) {
            return
        }

        try {
            const fusionSourceId = this.fusionSourceId
            this.log.info('Releasing processing lock.')
            await this.patchSourceConfig(
                fusionSourceId,
                '/connectorAttributes/processing',
                false,
                'SourceService>releaseProcessLock'
            )
            this.processLockAcquired = false
        } catch (error) {
            this.log.error(
                `Failed to release processing lock: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    // ------------------------------------------------------------------------
    // Public Batch Cumulative Count Methods
    // ------------------------------------------------------------------------

    public async saveBatchCumulativeCount(): Promise<void> {
        if (Object.keys(this.batchCumulativeCount).length === 0) {
            return
        }

        const fusionSourceId = this.fusionSourceId
        this.log.info(`Saving batch cumulative count: ${JSON.stringify(this.batchCumulativeCount)}`)
        await this.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/batchCumulativeCount',
            this.batchCumulativeCount,
            'SourceService>saveBatchCumulativeCount'
        )
    }

    public async resetBatchCumulativeCount(): Promise<void> {
        if (Object.keys(this.batchCumulativeCount).length === 0) {
            return
        }

        this.batchCumulativeCount = {}
        const fusionSourceId = this.fusionSourceId
        this.log.info('Resetting batch cumulative count')
        await this.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/batchCumulativeCount',
            {},
            'SourceService>resetBatchCumulativeCount'
        )
    }

    // ------------------------------------------------------------------------
    // Public Reverse Correlation Setup Methods
    // ------------------------------------------------------------------------

    public validateNoAttributeOverlap(attributeName: string, schemaAttributeNames: Set<string>): void {
        validateNoAttributeOverlapImpl(this.config, attributeName, schemaAttributeNames)
    }

    public async ensureReverseCorrelationSetup(
        sourceConfig: SourceConfig,
        schemaAttributeNames: Set<string>
    ): Promise<void> {
        return runEnsureReverseCorrelationSetup(this.reverseCorrelationDeps, sourceConfig, schemaAttributeNames, {
            ensureReverseCorrelationSetupPhases: (...args) => this.ensureReverseCorrelationSetupPhases(...args),
            getReverseCorrelationSetupStatus: (...args) => this.getReverseCorrelationSetupStatus(...args),
            repairReverseCorrelationSetup: (...args) => this.repairReverseCorrelationSetup(...args),
        })
    }

    public clearReverseCorrelationReadinessCache(): void {
        clearReverseCorrelationReadinessCacheImpl(this.reverseCorrelationDeps)
    }

    public async setupReverseCorrelationSources(schemaAttrNames: Set<string>): Promise<number> {
        return setupReverseCorrelationSourcesImpl(
            this.reverseCorrelationDeps,
            this.sources,
            schemaAttrNames,
            (sourceConfig, schemaAttributeNames) =>
                this.ensureReverseCorrelationSetup(sourceConfig, schemaAttributeNames)
        )
    }

    public async assertReverseCorrelationReady(sourceConfig: SourceConfig): Promise<void> {
        return runAssertReverseCorrelationReady(this.reverseCorrelationDeps, sourceConfig, (...args) =>
            this.getReverseCorrelationSetupStatus(...args)
        )
    }

    private async ensureReverseCorrelationSetupPhases(
        correlationAttribute: string,
        correlationDisplayName: string,
        managedSourceId: string,
        sourceConfig: SourceConfig
    ): Promise<void> {
        const full = requiresFullReverseCorrelationArtifacts(sourceConfig)
        if (full) {
            await this.ensureFusionSchemaAttribute(correlationAttribute, correlationDisplayName)
            await this.ensureIdentityAttribute(correlationAttribute, correlationDisplayName)
            await this.ensureIdentityProfileMapping(correlationAttribute, sourceConfig)
            await this.ensureManagedSourceCorrelation(correlationAttribute, managedSourceId)
            return
        }

        this.log.info(
            `Reverse correlation for source "${sourceConfig.name}" (sourceType=${sourceConfig.sourceType}): ` +
                'minimal setup — identity attribute and managed source correlation only (no fusion schema or identity profile changes).'
        )
        await this.ensureIdentityAttribute(correlationAttribute, correlationDisplayName)
        await this.ensureManagedSourceCorrelation(correlationAttribute, managedSourceId)
    }

    private async repairReverseCorrelationSetup(
        correlationAttribute: string,
        correlationDisplayName: string,
        managedSourceId: string,
        status: ReverseCorrelationSetupStatus,
        sourceConfig: SourceConfig
    ): Promise<void> {
        const full = requiresFullReverseCorrelationArtifacts(sourceConfig)
        if (full && status.missingArtifacts.includes('fusion_schema_attribute')) {
            await this.ensureFusionSchemaAttribute(correlationAttribute, correlationDisplayName)
        }
        if (status.missingArtifacts.includes('identity_attribute')) {
            await this.ensureIdentityAttribute(correlationAttribute, correlationDisplayName)
        }
        if (full && status.missingArtifacts.includes('identity_profile_mapping')) {
            await this.ensureIdentityProfileMapping(correlationAttribute, sourceConfig)
        }
        if (status.missingArtifacts.includes('managed_source_correlation')) {
            await this.ensureManagedSourceCorrelation(correlationAttribute, managedSourceId)
        }
    }

    private async getReverseCorrelationSetupStatus(
        correlationAttribute: string,
        managedSourceId: string,
        sourceConfig: SourceConfig
    ): Promise<ReverseCorrelationSetupStatus> {
        return getReverseCorrelationSetupStatusImpl(
            this.reverseCorrelationDeps,
            correlationAttribute,
            managedSourceId,
            sourceConfig
        )
    }

    private async ensureFusionSchemaAttribute(attributeName: string, displayName: string): Promise<void> {
        return ensureFusionSchemaAttributeImpl(this.reverseCorrelationDeps, attributeName, displayName)
    }

    private async ensureIdentityAttribute(attributeName: string, displayName: string): Promise<void> {
        return ensureIdentityAttributeImpl(this.reverseCorrelationDeps, attributeName, displayName)
    }

    private async ensureIdentityProfileMapping(attributeName: string, sourceConfig: SourceConfig): Promise<void> {
        return ensureIdentityProfileMappingImpl(this.reverseCorrelationDeps, attributeName, sourceConfig)
    }

    private async ensureManagedSourceCorrelation(attributeName: string, managedSourceId: string): Promise<void> {
        return ensureManagedSourceCorrelationImpl(this.reverseCorrelationDeps, attributeName, managedSourceId)
    }

    private async waitForIdentityProfileMapping(
        profileId: string,
        attributeName: string,
        fusionSourceName: string,
        fusionSourceId: string
    ): Promise<boolean> {
        return waitForIdentityProfileMappingImpl(
            this.reverseCorrelationDeps,
            profileId,
            attributeName,
            fusionSourceName,
            fusionSourceId
        )
    }

    // ------------------------------------------------------------------------
    // Module dependency builders
    // ------------------------------------------------------------------------

    private get aggregationTaskDeps(): SourceAggregationTaskDeps {
        return {
            log: this.log,
            client: this.client,
            sourcesById: this.sourcesById,
        }
    }

    private get discoveryDeps(): SourceDiscoveryDeps {
        return {
            log: this.log,
            client: this.client,
            run: this.run,
            state: {
                sources: this.sources,
                spConnectorInstanceId: this.spConnectorInstanceId,
                allSources: this.allSourcesValue,
                fusionSourceId: this.fusionSourceIdValue,
                fusionSourceOwner: this.fusionSourceOwnerValue,
                fusionSourceManagementWorkgroupId: this.fusionSourceManagementWorkgroupId,
                sourcesById: this.sourcesById,
                workgroupMemberIdsByWorkgroupId: this.workgroupMemberIdsByWorkgroupId,
                accountJmespathFiltersBySourceName: this.accountJmespathFiltersBySourceName,
            },
        }
    }

    private get managedAccountFetcherDeps(): ManagedAccountFetcherDeps {
        return {
            log: this.log,
            run: this.run,
            managedSources: this.managedSources,
            batchLimitedSourceNames: this.batchLimitedSourceNames,
            batchCumulativeCount: this.batchCumulativeCount,
            accountJmespathFiltersBySourceName: this.accountJmespathFiltersBySourceName,
            fetchAccountsBySourceIdGenerator: this.fetchAccountsBySourceIdGenerator.bind(this),
        }
    }

    private get aggregatorDeps(): SourceAggregatorDeps {
        return {
            ...this.aggregationTaskDeps,
            fusionSourceId: this.fusionSourceId,
            managedSources: this.managedSources,
            aggregationDateCache: this.aggregationDateCache,
        }
    }

    private get reverseCorrelationCoreDeps(): Omit<ReverseCorrelationDeps, 'waitForIdentityProfileMapping'> {
        return {
            log: this.log,
            client: this.client,
            config: this.config,
            run: this.run,
            getFusionSourceId: () => this.fusionSourceId,
            getFusionSource: () => this.getFusionSource(),
            listSourceSchemas: (sourceId) => this.listSourceSchemas(sourceId),
            invalidateSourceSchemasCache: (sourceId) => {
                this.sourceSchemasCache.delete(sourceId)
            },
            reverseCorrelationReadinessBySourceName: this.reverseCorrelationReadinessBySourceName,
        }
    }

    private get reverseCorrelationDeps(): ReverseCorrelationDeps {
        return {
            ...this.reverseCorrelationCoreDeps,
            waitForIdentityProfileMapping: (profileId, attributeName, fusionSourceName, fusionSourceId) =>
                this.waitForIdentityProfileMapping(profileId, attributeName, fusionSourceName, fusionSourceId),
        }
    }
}

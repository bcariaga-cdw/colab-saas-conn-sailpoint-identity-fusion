import {
    FusionConfig,
    NormalAttributeDefinition,
    UniqueAttributeDefinition,
    SourceConfig,
} from '../../model/config'
import { LogService } from '../logService'
import { FusionAccount } from '../../model/account'
import { getManagedAccountSnapshotKey } from '../../utils/velocityAccountSnapshot'
import { FusionAccountKind } from '../../model/fusionAccountTypes'
import { SchemaService } from '../schemaService'
import { InMemoryLockService } from '../lockService'
import { StateWrapper } from './stateWrapper'
import { ConnectorError, ConnectorErrorType, SimpleKey, SimpleKeyType } from '@sailpoint/connector-sdk'
import { applyOutputTransforms, evaluateAttributeTemplate } from './templateEvaluator'
import { createRenderContextForPass, padNumber } from './formatting'
import crypto from 'crypto'
import { assert } from '../../utils/assert'
import { FUSION_STATE_CONFIG_PATH } from './constants'
import { isValidAttributeValue } from '../../utils/attributes'
import { hasValue, isNullish, missing, readString, trimStr } from '../../utils/safeRead'
import { runtimeDefaults } from '../../data/config'
import { FusionAttribute } from '../../data/schema'
import { AccountV2025 as Account } from 'sailpoint-api-client'
import { FusionRun } from '../../model/fusionRun'
import { MappingService } from '../mappingService'
import { promiseAllBatched, getFusionParallelBatchSize } from '../fusionService/collections'
import { buildUniqueRegistrationPlan, UniqueRegistrationPlan } from './uniqueRegistrationPlan'
import { IDENTITIES_SOURCE_NAME } from '../../model/fusionAccount'
import type { SourceService } from '../sourceService'

export interface RecordUniqueRegistrationProgress {
    onProgress?: (done: number, total: number) => void
}

export class DefinitionService {
    private normalDefinitions: NormalAttributeDefinition[] = []
    private uniqueDefinitions: UniqueAttributeDefinition[] = []
    private uniqueAttributeNames: Set<string> = new Set()
    private uniqueValuesByAttribute: Map<string, Set<string>> = new Map()
    private uniqueDefinitionByName: Map<string, UniqueAttributeDefinition> = new Map()
    private stateWrapper?: StateWrapper
    private readonly skipAccountsWithMissingId: boolean
    private readonly forceAttributeRefresh: boolean
    private readonly maxAttempts?: number
    private readonly reverseSources: SourceConfig[]
    readonly registrationPlan: UniqueRegistrationPlan
    private readonly includeIdentities: boolean

    constructor(
        private config: FusionConfig,
        private schemas: SchemaService,
        private log: LogService,
        private locks: InMemoryLockService,
        private sourceService?: SourceService
    ) {
        this.normalDefinitions = config.normalAttributeDefinitions ?? []
        this.uniqueDefinitions = config.uniqueAttributeDefinitions ?? []
        this.skipAccountsWithMissingId = config.skipAccountsWithMissingId
        this.forceAttributeRefresh = config.forceAttributeRefresh
        this.maxAttempts = config.maxAttempts

        this.uniqueDefinitionByName = new Map(this.uniqueDefinitions.map((d) => [d.name, d]))
        this.uniqueAttributeNames = new Set(this.uniqueDefinitions.map((d) => d.name))

        this.setStateWrapper(config.fusionState)
        this.reverseSources = (config.sources ?? []).filter(
            (sc) => sc.correlationMode === 'reverse' && sc.correlationAttribute
        )
        this.registrationPlan = buildUniqueRegistrationPlan(config)
        this.includeIdentities = config.includeIdentities !== false
    }

    public setStateWrapper(state: Record<string, unknown> | undefined): void {
        this.stateWrapper = new StateWrapper(state, this.locks)
    }

    private getStateWrapper(): StateWrapper {
        assert(this.stateWrapper, 'State wrapper is not set')
        return this.stateWrapper!
    }

    private isUniqueAttribute(name: string): boolean {
        return this.uniqueAttributeNames.has(name)
    }

    private getUniqueValues(attributeName: string): Set<string> {
        let set = this.uniqueValuesByAttribute.get(attributeName)
        if (!set) {
            set = new Set<string>()
            this.uniqueValuesByAttribute.set(attributeName, set)
        }
        return set
    }

    // ========================================================================
    // Public — Attribute Refresh
    // ========================================================================

    public async refreshAllAttributes(fusionAccount: FusionAccount): Promise<void> {
        const context = this.buildVelocityContext(fusionAccount)
        const renderContext = createRenderContextForPass(context)

        for (const definition of this.normalDefinitions) {
            try {
                this.processNormalDefinition(definition, fusionAccount, context, renderContext)
            } catch (error) {
                this.log.error(
                    `Error generating normal attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
            }
        }

        for (const definition of this.uniqueDefinitions) {
            try {
                await this.processUniqueDefinition(definition, fusionAccount, context)
            } catch (error) {
                this.log.error(
                    `Error generating unique attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
                throw error
            }
        }

        this.ensureCoreSchemaAttributes(fusionAccount)
    }

    /**
     * True when this Fusion account has at least one Normal definition with Always recalculate
     * (`definition.refresh`) that would not be skipped as static on an existing Fusion account.
     * Same eligibility as {@link refreshNormalAttributes}.
     */
    public hasEligibleAlwaysRecalculate(fusionAccount: FusionAccount): boolean {
        return this.normalDefinitions.some(
            (definition) => definition.refresh && !this.shouldSkipStaticDefinition(definition, fusionAccount)
        )
    }

    public async refreshNormalAttributes(
        fusionAccount: FusionAccount,
        onStats?: (stats: { evaluated: number; skipped: number }) => void
    ): Promise<void> {
        if (this.normalDefinitions.length === 0) {
            onStats?.({ evaluated: 0, skipped: 0 })
            return
        }

        const shouldRefresh =
            fusionAccount.needsRefresh || fusionAccount.needsReset || this.forceAttributeRefresh
        const hasRefreshableDefinitions = this.hasEligibleAlwaysRecalculate(fusionAccount)
        if (!shouldRefresh && !hasRefreshableDefinitions) {
            onStats?.({ evaluated: 0, skipped: this.normalDefinitions.length })
            return
        }

        if (this.log.getLogLevel() === 'debug') {
            this.log.debug(
                `Refreshing normal attributes for account: ${fusionAccount.name} [${fusionAccount.sourceName}]`
            )
        }
        const context = this.buildVelocityContext(fusionAccount)
        const renderContext = createRenderContextForPass(context)

        let evaluated = 0
        let skipped = 0
        for (const definition of this.normalDefinitions) {
            try {
                const outcome = this.processNormalDefinition(definition, fusionAccount, context, renderContext)
                if (outcome === 'evaluated') {
                    evaluated++
                } else {
                    skipped++
                }
            } catch (error) {
                this.log.error(
                    `Error generating normal attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
            }
        }
        onStats?.({ evaluated, skipped })
    }

    /**
     * True when a configured Unique definition has no usable value on this account.
     * Blank means null, undefined, or whitespace-only — the same check used when
     * deciding whether to generate a Unique value.
     */
    public hasMissingUniqueAttribute(fusionAccount: FusionAccount): boolean {
        return this.uniqueDefinitions.some(
            (def) => !isValidAttributeValue(fusionAccount.attributes[def.name])
        )
    }

    public async refreshUniqueAttributes(fusionAccount: FusionAccount): Promise<void> {
        if (fusionAccount.type === FusionAccountKind.Decision && !fusionAccount.needsReset) return
        if (fusionAccount.isMatch) return

        if (this.uniqueDefinitions.length === 0) {
            this.ensureCoreSchemaAttributes(fusionAccount)
            return
        }

        const shouldRefresh =
            fusionAccount.needsRefresh || fusionAccount.needsReset || this.hasMissingUniqueAttribute(fusionAccount)
        if (!shouldRefresh) {
            this.ensureCoreSchemaAttributes(fusionAccount)
            return
        }

        this.log.debug(
            `Refreshing unique attributes for account: ${fusionAccount.name} [${fusionAccount.sourceName}]`
        )

        if (fusionAccount.needsReset) {
            await this.unregisterUniqueAttributes(fusionAccount)
        }

        const context = this.buildVelocityContext(fusionAccount)

        for (const definition of this.uniqueDefinitions) {
            try {
                await this.processUniqueDefinition(definition, fusionAccount, context)
            } catch (error) {
                this.log.error(
                    `Error generating unique attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
                throw error
            }
        }

        this.ensureCoreSchemaAttributes(fusionAccount)
    }

    // ========================================================================
    // Public — Reverse Correlation
    // ========================================================================

    public refreshReverseCorrelationAttributes(fusionAccount: FusionAccount): void {
        if (fusionAccount.missingAccountIds.length === 0) return
        for (const sc of this.reverseSources) {
            const missingForSource = fusionAccount.collections.accounts.getMissingForSource(sc.name)
            if (missingForSource.length > 0) {
                const firstAccountId = missingForSource[0]
                const info = fusionAccount.collections.managedAccountInfo.get(firstAccountId)
                if (info) {
                    fusionAccount.setReverseCorrelationAttribute(sc.correlationAttribute!, info.schema.id)
                    this.log.debug(
                        `Set reverse correlation attribute "${sc.correlationAttribute}" = "${info.schema.id}" ` +
                        `for fusion account ${fusionAccount.name} (source: ${sc.name})`
                    )
                }
            } else {
                fusionAccount.clearReverseCorrelationAttribute(sc.correlationAttribute!)
            }
        }
    }

    // ========================================================================
    // Public — Display Attribute Override
    // ========================================================================

    public applyDisplayAttributeOverride(fusionAccount: FusionAccount): void {
        const { fusionDisplayAttribute } = this.schemas
        if (!fusionDisplayAttribute) return
        this.applyDisplayAttributeOverrideIfApplicable(fusionAccount, fusionDisplayAttribute)
    }

    /**
     * Writes the identity alias into the Fusion display attribute when the account is
     * override-eligible. Returns false when the override did not take ownership of the
     * attribute — including when no alias resolves — so Normal definitions still evaluate.
     */
    private applyDisplayAttributeOverrideIfApplicable(
        fusionAccount: FusionAccount,
        attributeName: string
    ): boolean {
        const { fusionDisplayAttribute } = this.schemas
        if (attributeName !== fusionDisplayAttribute) return false
        if (!this.shouldApplyDisplayAttributeOverride(fusionAccount)) return false
        const hasExistingValue = isValidAttributeValue(fusionAccount.attributes[attributeName])
        const canResetDisplay = fusionAccount.needsReset
        const isExistingFusionAccount = this.isExistingFusionAccount(fusionAccount)
        if (hasExistingValue && !canResetDisplay && isExistingFusionAccount) {
            return true
        }

        const label = fusionAccount.identityAlias
        if (!label) return false
        this.log.info(`Setting identity alias for attr: ${attributeName} for account: ${fusionAccount.name}`)
        fusionAccount.attributes[attributeName] = label
        return true
    }

    // ========================================================================
    // Public — Unique Value Registration
    // ========================================================================

    public async registerUniqueAttributes(fusionAccount: FusionAccount): Promise<void> {
        this.log.debug(`Registering unique attributes for account: ${fusionAccount.managedKey}`)

        for (const definition of this.uniqueDefinitions) {
            const value = fusionAccount.attributes[definition.name]
            if (missing(value)) continue

            const valueStr = String(value)
            assert(
                this.uniqueDefinitionByName.has(definition.name),
                `Attribute ${definition.name} not found in unique attribute definition config`
            )
            this.getUniqueValues(definition.name).add(valueStr)
        }
    }


    /**
     * Lightweight record-only path: selective map + register without normal/unique Define evaluation.
     */
    public async registerUniqueValuesFromRecordManagedAccount(
        account: Account,
        mappingService: MappingService,
        run: FusionRun
    ): Promise<void> {
        const fusionAccount = FusionAccount.fromManagedAccount(account)
        mappingService.mapAttributes(fusionAccount, run, {
            onlyTargets: this.registrationPlan.mapTargets,
        })
        await this.registerUniqueAttributes(fusionAccount)
    }

    public async registerUniqueValuesFromRecordManagedAccounts(
        accounts: Account[],
        mappingService: MappingService,
        run: FusionRun,
        options?: RecordUniqueRegistrationProgress
    ): Promise<number> {
        if (accounts.length === 0 || this.uniqueDefinitions.length === 0) {
            return 0
        }

        await promiseAllBatched(
            accounts,
            (account) => this.registerUniqueValuesFromRecordManagedAccount(account, mappingService, run),
            getFusionParallelBatchSize(this.config),
            (processed, total) => options?.onProgress?.(processed, total)
        )

        this.log.debug(
            `Registered unique values from ${accounts.length} record managed account(s) using registration plan`
        )
        return accounts.length
    }

    public async unregisterUniqueAttributes(fusionAccount: FusionAccount): Promise<void> {
        const { fusionIdentityAttribute } = this.schemas
        this.log.debug(`Unregistering unique attributes for account: ${fusionAccount.managedKey}`)

        for (const definition of this.uniqueDefinitions) {
            if (definition.name === fusionIdentityAttribute) continue

            const value = fusionAccount.attributes[definition.name]
            if (missing(value)) continue

            const valueStr = String(value)
            const lockKey = `unique:${definition.name}`
            await this.locks.withLock(lockKey, async () => {
                if (!this.getUniqueValues(definition.name).delete(valueStr)) return
                this.log.debug(`Unregistered unique value '${valueStr}' for attribute ${definition.name}`)
            })
        }
    }

    public registerExistingValues(attributeName: string, values: string[]): void {
        if (values.length === 0) return
        const set = this.getUniqueValues(attributeName)
        for (const value of values) {
            if (hasValue(value)) {
                set.add(String(value))
            }
        }
        this.log.debug(`Registered ${values.length} existing value(s) for attribute '${attributeName}'`)
    }

    public registerUniqueValuesFromManagedSourceAccounts(fusionAccounts: Iterable<any>): void {
        if (this.uniqueDefinitions.length === 0) return

        const accounts = Array.from(fusionAccounts)
        if (accounts.length === 0) return

        for (const definition of this.uniqueDefinitions) {
            const values: string[] = []
            for (const account of accounts) {
                const value = account.attributes?.[definition.name]
                if (hasValue(value)) {
                    values.push(String(value))
                }
            }
            this.registerExistingValues(definition.name, values)
        }

        this.log.debug(
            `Registered unique values from ${accounts.length} managed source account(s) ` +
            `for ${this.uniqueDefinitions.length} unique attribute definition(s)`
        )
    }

    // ========================================================================
    // Public — Key Generation
    // ========================================================================

    public getSimpleKey(fusionAccount: FusionAccount): SimpleKeyType | undefined {
        const { fusionIdentityAttribute } = this.schemas

        const uniqueId = fusionAccount.attributes[fusionIdentityAttribute] as string | undefined

        if (isNullish(uniqueId) && this.skipAccountsWithMissingId) {
            this.log.warn(
                `Skipping account ${fusionAccount.name} [${fusionAccount.sourceName}]: ` +
                `Missing value for fusion identity attribute '${fusionIdentityAttribute}'`
            )
            return undefined
        }

        assert(
            uniqueId,
            `Account ID is required for simple key: account ${fusionAccount.name} [${fusionAccount.sourceName}] ` +
            `is missing value for fusion identity attribute '${fusionIdentityAttribute}'`
        )

        return SimpleKey(uniqueId)
    }

    // ========================================================================
    // Public — Counter Management
    // ========================================================================

    public async initializeCounters(): Promise<void> {
        const stateWrapper = this.getStateWrapper()
        const counterDefinitions = this.uniqueDefinitions.filter(
            (definition) => definition.useIncrementalCounter
        )
        if (counterDefinitions.length === 0) return

        this.log.debug(`Initializing ${counterDefinitions.length} incremental counter attributes`)
        const existingCounters = Object.fromEntries(
            Array.from(stateWrapper.entries()).filter(([key]) =>
                counterDefinitions.some((definition) => definition.name === key)
            )
        )
        if (Object.keys(existingCounters).length > 0) {
            this.log.debug(`Preserving existing counter values: ${JSON.stringify(existingCounters)}`)
        }

        await Promise.all(
            counterDefinitions.map((definition) => {
                const start = definition.counterStart ?? 1
                return stateWrapper.initCounter(definition.name, start)
            })
        )

        const finalCounters: { [key: string]: number } = {}
        for (const definition of counterDefinitions) {
            const value = stateWrapper.get(definition.name)
            if (value !== undefined) {
                finalCounters[definition.name] = value
            }
        }
        this.log.debug(
            `All incremental counters initialized. Current values: ${JSON.stringify(finalCounters)}`
        )
    }

    public async saveState(): Promise<void> {
        const stateObject = await this.getStateObject()
        this.log.info(`Saving state object: ${JSON.stringify(stateObject)}`)

        // Persist counter state to the Fusion source's connector attributes so the next
        // aggregation continues from the last generated values instead of resetting.
        const sourceService = this.sourceService
        if (!sourceService) {
            throw new ConnectorError(
                'SourceService is not configured on DefinitionService; cannot persist fusion state.',
                ConnectorErrorType.Generic
            )
        }
        await sourceService.patchSourceConfig(
            sourceService.fusionSourceId,
            FUSION_STATE_CONFIG_PATH,
            stateObject,
            'DefinitionService>saveState'
        )
    }

    public async getStateObject(): Promise<{ [key: string]: number }> {
        if (this.locks && typeof this.locks.waitForAllPendingOperations === 'function') {
            await this.locks.waitForAllPendingOperations()
        }
        const stateWrapper = this.getStateWrapper()
        this.log.debug(
            `Reading state - StateWrapper has ${stateWrapper.getSize()} entries`
        )

        const state = stateWrapper.getState()
        this.log.debug(`getState() returned: ${JSON.stringify(state)}`)

        return state
    }

    // ========================================================================
    // Private — Velocity Context Builder
    // ========================================================================

    /**
     * Builds the Velocity caller context as `Object.create(attributeBag.current)` plus
     * own-property shadows. `statuses`, `actions`, and `reviews` are live
     * FusionCollections arrays for this run — they shadow any persisted snapshot
     * inherited from the bag. `previous` remains `attributeBag.previous` (prior-run view).
     * Account-id sets, missing-accounts, sources, and history are not bound here;
     * `accounts` and `sources` keep their managed-snapshot meaning.
     */
    private buildVelocityContext(fusionAccount: FusionAccount): Record<string, any> {
        const context: Record<string, any> = Object.create(fusionAccount.attributeBag.current)
        const identityInputsEnabled = this.identityInputsEnabled(fusionAccount)
        const identityAlias = identityInputsEnabled ? fusionAccount.identityAlias : undefined

        if (identityAlias && context.name === undefined) {
            context.name = identityAlias
        }

        const orderedAccounts = this.getOrderedAccountsForContext(fusionAccount)
        const identityBag = identityInputsEnabled ? fusionAccount.attributeBag.identity : {}

        context.identity = identityBag
        if (identityAlias) {
            context.identity = {
                ...identityBag,
                name: identityAlias,
            }
        }

        context.accounts = orderedAccounts
        context.previous = fusionAccount.attributeBag.previous
        context.sources = Object.fromEntries(
            [...fusionAccount.attributeBag.sources.entries()].filter(
                ([sourceName]) => identityInputsEnabled || sourceName !== IDENTITIES_SOURCE_NAME
            )
        )
        context.account = this.resolveOriginAccountObjectForVelocity(
            fusionAccount,
            orderedAccounts
        )

        if (fusionAccount.originSource) {
            context.originSource = fusionAccount.originSource
        }
        if (fusionAccount.originAccountId) {
            context.originAccount = fusionAccount.originAccountId
        }

        context.statuses = fusionAccount.statuses
        context.actions = fusionAccount.actions
        context.reviews = fusionAccount.reviews

        return context
    }

    private resolveOriginAccountObjectForVelocity(
        fusionAccount: FusionAccount,
        orderedAccounts: Record<string, any>[]
    ): Record<string, any> | undefined {
        const originIdRaw =
            fusionAccount.originAccountId ??
            fusionAccount.attributes[FusionAttribute.OriginAccount]
        const originId = trimStr(originIdRaw)
        if (!originId) return undefined

        const { originSource } = fusionAccount
        const identityBag = (
            this.identityInputsEnabled(fusionAccount) ? (fusionAccount.attributeBag.identity ?? {}) : {}
        ) as Record<string, unknown>
        const identityHasData = Object.keys(identityBag).length > 0
        const { fusionDisplayAttribute, fusionIdentityAttribute } = this.schemas

        const configuredSchemaName = this.readAccountAttributeString(
            fusionAccount,
            fusionDisplayAttribute
        )
        const configuredSchemaId = this.readAccountAttributeString(
            fusionAccount,
            fusionIdentityAttribute
        )
        const identityAlias = this.identityInputsEnabled(fusionAccount) ? fusionAccount.identityAlias : undefined
        const identityId = fusionAccount.identityId ?? trimStr(identityBag.id)

        const schemaName = configuredSchemaName ?? identityAlias ?? originId
        const schemaId = configuredSchemaId ?? identityId ?? originId

        const identityIdTrimmed = trimStr(identityId)
        const identityMatchesOrigin =
            identityIdTrimmed !== undefined && identityIdTrimmed === originId
        if (originSource === 'Identities' && identityHasData && identityMatchesOrigin) {
            return {
                ...identityBag,
                source: { name: 'Identities' },
                schema: {
                    name: schemaName,
                    id: schemaId,
                },
                IIQDisabled: Boolean(fusionAccount.disabled),
            }
        }

        const managed = orderedAccounts.find(
            (account) => getManagedAccountSnapshotKey(account) === originId
        )
        if (managed) return managed

        return undefined
    }

    private readAccountAttributeString(
        fusionAccount: FusionAccount,
        attributeName: string
    ): string | undefined {
        return trimStr(fusionAccount.attributes[attributeName])
    }

    private getOrderedAccountsForContext(
        fusionAccount: FusionAccount
    ): Record<string, any>[] {
        const { sourceAccountContexts } = fusionAccount.attributeBag
        const sources = this.identityInputsEnabled(fusionAccount)
            ? fusionAccount.attributeBag.sources
            : new Map(
                [...fusionAccount.attributeBag.sources.entries()].filter(
                    ([sourceName]) => sourceName !== IDENTITIES_SOURCE_NAME
                )
            )
        if (sources.size === 0) return sourceAccountContexts

        const ordered = this.buildOrderedAccountList(sources)
        return this.prioritizeMainAccount(ordered, fusionAccount)
    }

    private buildOrderedAccountList(
        sources: Map<string, Record<string, any>[]>
    ): Record<string, any>[] {
        const ordered: Record<string, any>[] = []
        const seenSources = new Set<string>()

        for (const sourceConfig of this.config.sources ?? []) {
            const sourceAccounts = sources.get(sourceConfig.name)
            if (sourceAccounts?.length) {
                ordered.push(...sourceAccounts)
                seenSources.add(sourceConfig.name)
            }
        }

        for (const [sourceName, sourceAccounts] of sources.entries()) {
            if (!seenSources.has(sourceName) && sourceAccounts.length > 0) {
                ordered.push(...sourceAccounts)
            }
        }

        return ordered
    }

    private prioritizeMainAccount(
        ordered: Record<string, any>[],
        fusionAccount: FusionAccount
    ): Record<string, any>[] {
        const mainAccountId = this.getMainAccountOverrideId(fusionAccount)
        if (!mainAccountId) return ordered

        const index = ordered.findIndex(
            (account) =>
                getManagedAccountSnapshotKey(account) === mainAccountId ||
                trimStr(account?._id) === mainAccountId
        )
        if (index <= 0) return ordered

        const prioritized = ordered[index]
        const before = ordered.slice(0, index)
        const after = ordered.slice(index + 1)
        return [prioritized, ...before, ...after]
    }

    private getMainAccountOverrideId(
        fusionAccount: FusionAccount
    ): string | undefined {
        return trimStr(
            fusionAccount.attributeBag.current[FusionAttribute.MainAccount]
        )
    }

    // ========================================================================
    // Private — Normal Definition Processing
    // ========================================================================

    private processNormalDefinition(
        definition: NormalAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>,
        renderContext?: Record<string, any>
    ): 'evaluated' | 'skipped' {
        const { fusionIdentityAttribute, fusionDisplayAttribute } = this.schemas

        if (this.applyDisplayAttributeOverrideIfApplicable(fusionAccount, definition.name)) {
            return 'skipped'
        }

        if (this.isSystemProvenanceAttribute(definition.name)) {
            return 'skipped'
        }

        const { current } = fusionAccount.attributeBag
        const hasExistingValue = isValidAttributeValue(current[definition.name])
        const isExistingFusionAccount = this.isExistingFusionAccount(fusionAccount)

        const isImmutableIdentityAttribute =
            definition.name === fusionIdentityAttribute &&
            hasExistingValue &&
            isExistingFusionAccount
        const isImmutableDisplayAttribute =
            definition.name === fusionDisplayAttribute &&
            hasExistingValue &&
            isExistingFusionAccount

        if (isImmutableIdentityAttribute || isImmutableDisplayAttribute) {
            return 'skipped'
        }

        if (this.shouldSkipStaticDefinition(definition, fusionAccount)) {
            return 'skipped'
        }

        if (this.isUniqueAttribute(definition.name) && current[definition.name] !== undefined) {
            return 'skipped'
        }

        if (
            !definition.refresh &&
            !fusionAccount.needsRefresh &&
            !fusionAccount.needsReset &&
            !this.forceAttributeRefresh &&
            hasExistingValue
        ) {
            return 'skipped'
        }

        const result = evaluateAttributeTemplate(
            definition,
            context,
            renderContext ? { renderContext } : undefined
        )
        if (result.error) {
            this.log.error(
                `Error evaluating normal attribute ${definition.name}: ${result.error}`
            )
            this.applyNormalDefinitionClearOrSafeDefault(
                definition.name,
                fusionAccount,
                context,
                fusionIdentityAttribute,
                fusionDisplayAttribute,
                renderContext
            )
            return 'evaluated'
        }

        if (result.value !== undefined && result.value !== null) {
            fusionAccount.attributes[definition.name] = result.value
            context[definition.name] = result.value
            if (renderContext) {
                renderContext[definition.name] = result.value
            }
            if (this.log.getLogLevel() === 'debug') {
                this.log.debug(
                    `[${fusionAccount.name}] ${definition.name} = ${typeof result.value === 'object' ? JSON.stringify(result.value) : result.value}`
                )
            }
        } else {
            this.applyNormalDefinitionClearOrSafeDefault(
                definition.name,
                fusionAccount,
                context,
                fusionIdentityAttribute,
                fusionDisplayAttribute,
                renderContext
            )
        }
        return 'evaluated'
    }

    private applyNormalDefinitionClearOrSafeDefault(
        attributeName: string,
        fusionAccount: FusionAccount,
        context: Record<string, any>,
        fusionIdentityAttribute: string,
        fusionDisplayAttribute: string,
        renderContext?: Record<string, any>
    ): void {
        const safeDefault = this.fusionAttributeSafeDefault(
            attributeName,
            fusionAccount,
            fusionIdentityAttribute,
            fusionDisplayAttribute
        )
        if (safeDefault !== undefined) {
            fusionAccount.attributes[attributeName] = safeDefault
            context[attributeName] = safeDefault
            if (renderContext) {
                renderContext[attributeName] = safeDefault
            }
            return
        }
        delete fusionAccount.attributes[attributeName]
        delete context[attributeName]
        if (renderContext) {
            delete renderContext[attributeName]
        }
    }

    // ========================================================================
    // Private — Unique Definition Processing
    // ========================================================================

    private async processUniqueDefinition(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>
    ): Promise<void> {
        const { name } = definition
        if (this.isSystemProvenanceAttribute(name)) return

        const { fusionIdentityAttribute, fusionDisplayAttribute } = this.schemas
        const existingValue = fusionAccount.attributes[name]
        const hasValue = isValidAttributeValue(existingValue)
        const isFusionIdentityAttribute = name === fusionIdentityAttribute
        const isFusionDisplayAttribute = name === fusionDisplayAttribute
        const isExistingFusionAccount = this.isExistingFusionAccount(fusionAccount)
        const isExistingIdentity = isExistingFusionAccount && fusionAccount.isIdentity

        const prevIsUnique = context.isUnique
        context.isUnique = (value: unknown) => this.isUniqueTemplateValue(definition, value, context)
        try {
            // Preserve stable unique values unless the account is being reset.
            if (hasValue && !fusionAccount.needsReset) {
                const valueStr = String(existingValue)
                this.getUniqueValues(name).add(valueStr)
                if (definition.useIncrementalCounter) {
                    await this.seedIncrementalCounterFromExistingValue(definition, valueStr)
                }
                return
            }

            if (hasValue && isFusionIdentityAttribute && isExistingIdentity) {
                this.getUniqueValues(name).add(String(fusionAccount.attributes[name]))
                return
            }

            if (
                isFusionDisplayAttribute &&
                this.applyDisplayAttributeOverrideIfApplicable(fusionAccount, name)
            ) {
                return
            }

            if (hasValue) {
                this.getUniqueValues(name).delete(String(existingValue))
            }

            const value = await this.generateUniqueAttributeValue(definition, fusionAccount, context)
            if (value === undefined || value === null) {
                const fallback = this.fusionAttributeSafeDefault(
                    name,
                    fusionAccount,
                    fusionIdentityAttribute,
                    fusionDisplayAttribute
                )
                if (fallback !== undefined) {
                    this.getUniqueValues(name).add(fallback)
                    fusionAccount.attributes[name] = fallback
                    context[name] = fallback
                    return
                }
                delete fusionAccount.attributes[name]
                delete context[name]
                return
            }

            fusionAccount.attributes[name] = value
            context[name] = value
        } finally {
            if (prevIsUnique !== undefined) {
                context.isUnique = prevIsUnique
            } else {
                delete context.isUnique
            }
        }
    }

    // ========================================================================
    // Private — Unique Value Generation
    // ========================================================================

    private async tryRegisterUniqueValue(definitionName: string, strValue: string): Promise<boolean> {
        return this.locks.withLock(`unique:${definitionName}`, async () => {
            const registeredValues = this.getUniqueValues(definitionName)
            if (registeredValues.has(strValue)) return false
            registeredValues.add(strValue)
            return true
        })
    }

    private debugUniqueGeneration(message: string): void {
        if (this.log.getLogLevel?.() === 'debug') {
            this.log.debug(message)
        }
    }

    private async generateUniqueAttributeValue(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>
    ): Promise<any> {
        const maxAttempts = this.maxAttempts ?? runtimeDefaults.maxAttempts

        if (definition.useIncrementalCounter) {
            return await this.generateWithIncrementalCounter(definition, fusionAccount, context, maxAttempts)
        }

        return await this.generateWithCollisionDisambiguation(definition, fusionAccount, context, maxAttempts)
    }

    private async generateWithIncrementalCounter(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>,
        maxAttempts: number
    ): Promise<any> {
        const stateWrapper = this.getStateWrapper()
        const counterFn = stateWrapper.getCounter(definition.name)
        const digits = definition.digits ?? 1

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const counterValue = await counterFn()
            context.counter = padNumber(counterValue, digits)

            this.injectUUIDIfNeeded(definition, context)

            const result = evaluateAttributeTemplate(definition, context)
            if (result.error) {
                this.log.error(result.error)
                return undefined
            }
            const value = result.value
            if (value === undefined || value === null) return undefined
            this.debugUniqueGeneration(
                `[${fusionAccount.name}] ${definition.name} = ${typeof value === 'object' ? JSON.stringify(value) : value}`
            )

            const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value)
            if (await this.tryRegisterUniqueValue(definition.name, strValue)) {
                this.debugUniqueGeneration(
                    `Generated unique value (incremental) for attribute ${definition.name}: ${strValue}`
                )
                return value
            }

            this.debugUniqueGeneration(
                `Collision on incremental counter for ${definition.name}, retrying (attempt ${attempt + 1})`
            )
        }

        this.log.error(
            `DefinitionService: Failed to generate unique value for attribute ${definition.name} ` +
            `for account: ${fusionAccount.name ?? fusionAccount.managedKey ?? 'unknown'} ` +
            `(${fusionAccount.sourceName}) after ${maxAttempts} attempts (incremental counter)`
        )
        return undefined
    }

    private async generateWithCollisionDisambiguation(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>,
        maxAttempts: number
    ): Promise<any> {
        const counter = StateWrapper.getCounter()
        const digits = definition.digits ?? 1
        const effectiveExpression = this.buildEffectiveExpression(definition)
        context.counter = ''

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            this.injectUUIDIfNeeded(definition, context)

            const result = evaluateAttributeTemplate(definition, context, {
                expressionOverride: effectiveExpression,
            })
            if (result.error) {
                this.log.error(result.error)
                return undefined
            }
            const value = result.value
            if (value === undefined || value === null) return undefined
            this.debugUniqueGeneration(
                `[${fusionAccount.name}] ${definition.name} = ${typeof value === 'object' ? JSON.stringify(value) : value}`
            )

            const strValue = typeof value === 'object' ? JSON.stringify(value) : String(value)
            if (await this.tryRegisterUniqueValue(definition.name, strValue)) {
                this.debugUniqueGeneration(
                    `Generated unique value for attribute ${definition.name}: ${strValue}`
                )
                return value
            }

            this.debugUniqueGeneration(
                `Value ${strValue} already exists for unique attribute: ${definition.name}`
            )
            context.counter = padNumber(counter(), digits)
            this.debugUniqueGeneration(
                `Regenerating unique attribute: ${definition.name} (attempt ${attempt + 1})`
            )
        }

        this.log.error(
            `DefinitionService: Failed to generate unique value for attribute ${definition.name} ` +
            `for account: ${fusionAccount.name ?? fusionAccount.managedKey ?? 'unknown'} ` +
            `(${fusionAccount.sourceName}) after ${maxAttempts} attempts (collision disambiguation)`
        )
        return undefined
    }

    private buildEffectiveExpression(definition: UniqueAttributeDefinition): string {
        const expression = definition.expression ?? ''
        if (!expression) return ''
        if (
            expression.includes('$counter') ||
            expression.includes('${counter}') ||
            expression.includes('$UUID') ||
            expression.includes('${UUID}')
        ) {
            return expression
        }
        return `${expression}$counter`
    }

    private injectUUIDIfNeeded(
        definition: UniqueAttributeDefinition,
        context: Record<string, any>
    ): void {
        if (
            definition.expression &&
            (definition.expression.includes('$UUID') ||
                definition.expression.includes('${UUID}'))
        ) {
            context.UUID = crypto.randomUUID()
        }
    }

    // ========================================================================
    // Private — Core Schema Attributes
    // ========================================================================

    private ensureCoreSchemaAttributes(fusionAccount: FusionAccount): void {
        const { fusionIdentityAttribute, fusionDisplayAttribute } = this.schemas

        if (
            !this.skipAccountsWithMissingId &&
            !isValidAttributeValue(
                fusionAccount.attributes[fusionIdentityAttribute]
            )
        ) {
            const prevId =
                fusionAccount.previousAttributes?.[fusionIdentityAttribute]
            if (isValidAttributeValue(prevId)) {
                fusionAccount.attributes[fusionIdentityAttribute] = prevId
            } else {
                fusionAccount.attributes[fusionIdentityAttribute] = crypto.randomUUID()
                this.log.debug(
                    `Generated fallback UUID for missing identity attribute: ${fusionAccount.name}`
                )
            }
        }

        if (
            !isValidAttributeValue(
                fusionAccount.attributes[fusionDisplayAttribute]
            )
        ) {
            const prevDisplay =
                fusionAccount.previousAttributes?.[fusionDisplayAttribute]
            if (isValidAttributeValue(prevDisplay)) {
                fusionAccount.attributes[fusionDisplayAttribute] = prevDisplay
            } else {
                const defaultDisplay = trimStr(fusionAccount.name)
                if (defaultDisplay) {
                    fusionAccount.attributes[fusionDisplayAttribute] =
                        defaultDisplay
                    this.log.debug(
                        `Generated fallback for missing display attribute: ${fusionAccount.name}`
                    )
                }
            }
        }
    }

    private isUniqueTemplateValue(
        definition: UniqueAttributeDefinition,
        value: unknown,
        context: Record<string, any>
    ): boolean {
        if (missing(value)) return false
        const raw = String(value)

        const transformed = applyOutputTransforms(raw, definition, definition.expression, context)
        if (transformed === '') return false

        return !this.getUniqueValues(definition.name).has(String(transformed))
    }

    private async seedIncrementalCounterFromExistingValue(
        definition: UniqueAttributeDefinition,
        value: string
    ): Promise<void> {
        const match = value.match(/(\d+)\s*$/)
        if (!match) return
        const parsed = Number.parseInt(match[1], 10)
        if (!Number.isFinite(parsed) || parsed <= 0) return

        const stateWrapper = this.getStateWrapper()
        const key = definition.name
        const lockKey = `counter:${key}`
        await this.locks.withLock(lockKey, async () => {
            if (stateWrapper.get(key) === undefined) {
                const start = definition.counterStart ?? 1
                await stateWrapper.initCounter(key, start)
            }
            const nextCurrent = stateWrapper.get(key) ?? 0
            if (parsed > nextCurrent) {
                stateWrapper.set(key, parsed)
            }
        })
    }

    // ========================================================================
    // Private — Helpers
    // ========================================================================

    private isExistingFusionAccount(fusionAccount: FusionAccount): boolean {
        return (
            fusionAccount.type === FusionAccountKind.Fusion &&
            Object.keys(fusionAccount.previousAttributes ?? {}).length > 0
        )
    }

    private shouldSkipStaticDefinition(
        definition: NormalAttributeDefinition,
        fusionAccount: FusionAccount
    ): boolean {
        return Boolean(definition.static && this.isExistingFusionAccount(fusionAccount))
    }

    /**
     * Identity alias override applies to identity-origin accounts and managed-source
     * correlated origins (source account uncorrelated === false). Uncorrelated managed
     * accounts keep display values from attribute mapping/definitions.
     *
     * Eligibility is independent of identity scope (`includeIdentities`): the alias is a
     * naming contract for an identity the account already belongs to, not identity data
     * exposed to Velocity because identity scope was enabled.
     */
    private shouldApplyDisplayAttributeOverride(fusionAccount: FusionAccount): boolean {
        if (fusionAccount.fromIdentity || fusionAccount.type === FusionAccountKind.Identity) {
            return true
        }
        return fusionAccount.isIdentity
    }

    private identityInputsEnabled(fusionAccount: FusionAccount): boolean {
        return (
            this.includeIdentities ||
            fusionAccount.fromIdentity ||
            fusionAccount.type === FusionAccountKind.Identity
        )
    }

    private fusionAttributeSafeDefault(
        attributeName: string,
        fusionAccount: FusionAccount,
        fusionIdentityAttribute: string,
        fusionDisplayAttribute: string
    ): string | undefined {
        if (attributeName === fusionIdentityAttribute) {
            if (this.skipAccountsWithMissingId) {
                return undefined
            }
            return crypto.randomUUID()
        }
        if (attributeName === fusionDisplayAttribute) {
            return trimStr(fusionAccount.name)
        }
        return undefined
    }

    private isSystemProvenanceAttribute(name: string): boolean {
        return (
            name === FusionAttribute.OriginAccount ||
            name === FusionAttribute.OriginSource
        )
    }
}

import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'
import { SimpleKey, StdAccountListOutput, StandardCommand } from '@sailpoint/connector-sdk'
import { FusionConfig, SourceType } from '../../model/config'
import { LogService } from '../logService'
import { FormService } from '../formService'
import { IdentityService } from '../identityService'
import { SourceService } from '../sourceService'
import { FusionAccount, FusionAccountKind } from '../../model/account'
import { IDENTITIES_SOURCE_NAME } from '../../model/fusionAccount'
import { MappingService } from '../mappingService'
import { DefinitionService } from '../definitionService'
import { MatchingService } from '../matchingService'
import {
    hasDeferredOnlyCandidateMatches,
    isRecordMatchingEnabledForSource,
    logDeferredMatchDiscoveryForReview,
} from '../matchingService/matchingHelpers'
import { assert } from '../../utils/assert'
import { createUrlContext, UrlContext } from '../../utils/url'
import { forEachBatched } from './collections'
import { FusionDecision } from '../../model/form'
import { SchemaService } from '../schemaService'
import { FusionReport, FusionReportAccount as _FusionReportAccount, FusionReportStats } from './types'
import type { MatchingResultsSnapshot, MatchingResultsSweepSummary } from '../recordingService/matchingResultsSnapshot'
import { FusionReportBlend } from '../../model/fusionReportBlend'
import {
    batchProcess,
    getManagedAccountsBatchSize,
    getManagedAccountEventLoopYieldEvery,
    getFusionParallelBatchSize,
} from './collections'
import { yieldToEventLoop } from '../../utils/yieldToEventLoop'
import { measureMs } from '../../utils/measureMs'
import {
    buildFusionReport,
    buildMatchingResultsSnapshot as buildMatchingResultsSnapshotFromState,
} from './fusionReportBuilder'
import { skipBlendHistoryKeysForDecisionAccountId } from './helpers'
import { ManagedAccountAnalysisRecorder } from './managedAccountAnalysisRecorder'
import { AggregationTracker } from './aggregationTracker'
import { logFusionDecisionApplied } from './decisionLogging'

import { AttributeOperations } from '../definitionService/types'
import { getManagedAccountKeyFromAccount, isCompositeManagedAccountKey } from '../../model/managedAccountKey'
import { addFusionAccountLinkedKeysToIndex, isManagedAccountLinkedInFusion } from '../../model/managedAccountLink'
import { StatusEntitlement } from '../../model/statusEntitlement'
import { trimStr } from '../../utils/safeRead'
import { resolveManagedAccountIscIdForReport } from './reportAccountResolver'
import { IdentityProcessor } from './identityProcessor'
import { CorrelationManager } from '../correlationManager'
import { DecisionProcessor } from './decisionProcessor'
import { MatchOutcomeDispatcher, MatchSweepMode } from '../matchingService/matchOutcomeDispatcher'
import { sourceHasReviewers, sourceShouldEnterMatchScoring } from '../matchingService/reviewerAvailability'
import { AccountAssembly } from '../accountAssembly'
import { FusionRun } from '../../model/fusionRun'
import { FusionAttribute } from '../../data/schema'
import { getManagedAccountSnapshotKey } from '../../utils/velocityAccountSnapshot'

// ============================================================================
// FusionService Class
// ============================================================================

const MAX_LOGGED_SOURCE_NAMES = 20

/**
 * Formats managed source names for a single aggregated log line.
 *
 * @param names - Managed source names to list
 * @returns Quoted, comma-separated names, truncated with a remainder count when long
 */
function formatSourceNameList(names: string[]): string {
    const shown = names.slice(0, MAX_LOGGED_SOURCE_NAMES).map((name) => `"${name}"`)
    const remaining = names.length - shown.length
    return remaining > 0 ? `${shown.join(', ')} (+${remaining} more)` : shown.join(', ')
}

export interface FusionServiceDeps {
    readonly config: FusionConfig
    readonly log: LogService
    readonly identities: IdentityService
    readonly sources: SourceService
    readonly forms: FormService
    readonly mappingService: MappingService
    readonly definitionService: DefinitionService
    readonly matchingService: MatchingService
    readonly schemas: SchemaService
    readonly run: FusionRun
    readonly commandType?: StandardCommand
    readonly shouldCaptureReportData?: boolean
    readonly isAggregationMode?: boolean
}

/**
 * Service for identity fusion logic.
 * Pure in-memory operations - no ClientService dependency.
 * All data structures are passed in as parameters.
 */
export class FusionService {
    private identityProcessor: IdentityProcessor
    public correlationManager: CorrelationManager
    public decisionProcessor: DecisionProcessor
    public matchOutcomeDispatcher!: MatchOutcomeDispatcher
    public accountAssembly: AccountAssembly
    public config: FusionConfig
    public log: LogService
    public identities: IdentityService
    public sources: SourceService
    public forms: FormService
    private mappingService: MappingService
    private definitionService: DefinitionService
    public matchingService: MatchingService
    public schemas: SchemaService
    public run: FusionRun

    private get dispatcher(): MatchOutcomeDispatcher {
        assert(this.matchOutcomeDispatcher, 'MatchOutcomeDispatcher has not been wired to FusionService')
        return this.matchOutcomeDispatcher
    }

    private readonly resetAccounts: boolean
    private readonly resetForms: boolean
    private readonly reportAttributes: string[]
    public readonly urlContext: UrlContext
    private readonly deleteEmpty: boolean
    /** Cached set of configured source names — built once in the constructor (config is immutable). */
    public readonly configSourceNames: Set<string>
    public readonly fusionOwnerIsGlobalReviewer: boolean
    /** Owner ids resolved once per aggregation; shared by fetch, refresh, and reviewer setup. */
    private globalOwnerIdentityIdsCache: string[] | undefined
    public readonly fusionReportOnAggregation: boolean
    public readonly commandType?: StandardCommand
    /** When true, report data should be captured even during aggregation (legacy constructor flag). */
    private readonly shouldCaptureReportData: boolean
    /** Runtime flag set by setupPhase — when false, correlation-on-aggregation is suppressed. */
    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    /**
     * @param deps - Collaborators and run context for fusion operations
     */
    constructor(deps: FusionServiceDeps) {
        const {
            config,
            log,
            identities,
            sources,
            forms,
            mappingService,
            definitionService,
            matchingService,
            schemas,
            run,
            commandType,
            shouldCaptureReportData,
            isAggregationMode,
        } = deps
        this.config = config
        this.log = log
        this.identities = identities
        this.sources = sources
        this.forms = forms
        this.mappingService = mappingService
        this.definitionService = definitionService
        this.matchingService = matchingService
        this.schemas = schemas
        this.run = run
        FusionAccount.configure(config)
        this.configSourceNames = new Set(config.sources.map((s) => s.name))
        this.accountAssembly = new AccountAssembly({
            run: this.run,
            sources: this.sources,
            mappingService: this.mappingService,
            definitionService: this.definitionService,
            log: this.log,
            config: this.config,
            commandType,
            isAggregationMode: isAggregationMode ?? false,
            buildFusionBlend: (fa, account) => this.buildFusionBlend(fa, account),
        })
        this.correlationManager = new CorrelationManager(config, log, this.sources, this.identities, () =>
            this.accountAssembly.isAggregationAccountListMode()
        )
        this.identityProcessor = new IdentityProcessor(config, log, this.run, {
            identities: this.identities,
            configSourceNames: this.configSourceNames,
            accountAssembly: this.accountAssembly,
            correlationManager: this.correlationManager,
            getTracker: () => this.run.getTracker(),
        })
        this.decisionProcessor = new DecisionProcessor(config, log, this.run, {
            forms: this.forms,
            identities: this.identities,
            correlationManager: this.correlationManager,
            definitionService: this.definitionService,
            mappingService: this.mappingService,
            accountAssembly: this.accountAssembly,
            sources: this.sources,
        })
        this.resetAccounts = config.resetAccounts
        this.resetForms = config.resetForms
        this.fusionOwnerIsGlobalReviewer = config.fusionOwnerIsGlobalReviewer ?? false
        this.fusionReportOnAggregation = config.fusionReportOnAggregation ?? false
        this.reportAttributes = config.fusionFormAttributes ?? []
        this.urlContext = createUrlContext(config.baseurl)
        this.run.analysisRecorder = new ManagedAccountAnalysisRecorder({
            log: this.log,
            tracker: () => this.requireTracker(),
            urlContext: this.urlContext,
            reportAttributes: this.reportAttributes,
            sourcesByName: this.run.sourcesByName,
            config: this.config,
            sources: this.sources,
            run: this.run,
            shouldCaptureReportData: () => this.shouldCaptureManagedAccountReportData(),
        })
        this.commandType = commandType
        this.shouldCaptureReportData = shouldCaptureReportData ?? false
        this.run.setDisableOperationFactory(async (account) => {
            if (!this.accountAssembly.isAggregationAccountListMode()) {
                return
            }
            try {
                await this.fireDisableOperation(account)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                this.log.warn(
                    `Disable operation failed for account ${account.name} [${account.sourceName}]: ${message}`
                )
            }
        })
        this.deleteEmpty = config.deleteEmpty
    }

    /**
     * Runs the provided function over items in bounded concurrent batches, logging progress.
     * Kept on FusionService so external callers (e.g. DecisionProcessor) do not need to
     * import batching utilities directly.
     */

    /**
     * Populate match / deferred / non-match report slices during managed-account analysis.
     * Dry-run and Fusion report capture via `run.isDryRunMode` without `fusionReportOnAggregation`.
     */
    private shouldCaptureManagedAccountReportData(): boolean {
        return (
            this.run.isRecordMode ||
            this.run.isDryRunMode ||
            this.fusionReportOnAggregation ||
            !this.accountAssembly.isAggregationAccountListMode() ||
            this.shouldCaptureReportData
        )
    }

    // ------------------------------------------------------------------------
    // Public Reset/Configuration Methods
    // ------------------------------------------------------------------------

    /**
     * Checks if the account reset flag is enabled in configuration.
     *
     * @returns true when Fusion accounts should be cleared on the next aggregation
     */
    public isResetAccounts(): boolean {
        return this.resetAccounts
    }

    /**
     * Checks if the form reset flag is enabled in configuration.
     *
     * @returns true when Fusion review forms should be deleted on the next aggregation
     */
    public isResetForms(): boolean {
        return this.resetForms
    }

    /**
     * Retrieves a Fusion identity from the in-memory map by ISC identity ID.
     * A Fusion identity is a Fusion account that became an identity.
     *
     * @param identityId - The ISC identity ID to look up
     * @returns The Fusion account for this identity, or undefined if not found
     */
    public getFusionIdentity(identityId: string): FusionAccount | undefined {
        return this.run.getFusionIdentity(identityId)
    }

    /**
     * Sets the AggregationTracker instance to record report state.
     */
    public setTracker(tracker: AggregationTracker): void {
        this.run.setTracker(tracker)
    }

    /** Returns the active AggregationTracker, crashing when unset. */
    private requireTracker(): AggregationTracker {
        const t = this.run.getTracker()
        this.log.assert(!!t, 'AggregationTracker has not been set on FusionRun')
        if (!t) {
            this.log.crash('AggregationTracker has not been set on FusionRun')
        }
        return t!
    }

    /**
     * Disable the account reset flag in the source configuration.
     * Also clears the legacy `reset` connector attribute when present.
     */
    public async disableResetAccounts(): Promise<void> {
        const { fusionSourceId } = this.sources
        await this.sources.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/resetAccounts',
            false,
            'FusionService>disableResetAccounts'
        )
        await this.sources.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/reset',
            false,
            'FusionService>disableResetAccounts>legacyReset'
        )
    }

    /** Disable the form reset flag in the source configuration. */
    public async disableResetForms(): Promise<void> {
        const { fusionSourceId } = this.sources
        await this.sources.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/resetForms',
            false,
            'FusionService>disableResetForms'
        )
    }

    /**
     * Disable the forceAttributeRefresh flag in the source configuration.
     * This makes the "Force attribute refresh on next aggregation?" option transient.
     */
    public async disableForceAttributeRefresh(): Promise<void> {
        const { fusionSourceId } = this.sources
        await this.sources.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/forceAttributeRefresh',
            false,
            'FusionService>disableForceAttributeRefresh'
        )
    }

    /** Clears the persisted fusion state in the source configuration. */
    public async resetState(): Promise<void> {
        const { fusionSourceId } = this.sources
        await this.sources.patchSourceConfig(
            fusionSourceId,
            '/connectorAttributes/fusionState',
            false,
            'FusionService>resetState'
        )
    }

    // ------------------------------------------------------------------------
    // Public Fusion Account Processing Methods
    // ------------------------------------------------------------------------

    /**
     * Pre-process all fusion accounts from sources.
     * Loads fusion accounts from the platform, builds FusionAccount instances, and registers them
     * in the internal maps (identity-linked Fusion account map / fusionAccountMap) via setFusionAccount.
     *
     * @returns Empty array (registration is done via setFusionAccount; return kept for API consistency)
     */
    public async preProcessFusionAccounts(): Promise<FusionAccount[]> {
        const { fusionAccounts } = this.sources
        this.log.detail({
            action: 'pre-processing fusion accounts',
            count: fusionAccounts.length,
        })
        const results: FusionAccount[] = []
        await forEachBatched(fusionAccounts, async (x: Account) => {
            const fusionAccount = FusionAccount.fromFusionAccount(x)
            this.setFusionAccount(fusionAccount)
            results.push(fusionAccount)
        })
        this.log.detail({
            action: 'fusion account pre-process finished',
            count: results.length,
        })
        return results
    }

    /**
     * Process all fusion accounts from sources.
     *
     * This is Phase 2 of the work queue depletion process:
     * - Phase 1: fetchFormData removes accounts with pending form decisions
     * - Phase 2: processFusionAccounts (this method) removes accounts belonging to existing fusion accounts
     * - Phase 3: processIdentities removes accounts belonging to identities
     * - Phase 4: processManagedAccounts processes only what remains (uncorrelated accounts)
     *
     * Each fusion account processes in parallel using Promise.all, but all share the same
     * work queue (this.run.managedAccountsById). As accounts are matched, they're
     * deleted from the queue via addManagedAccountLayer.
     *
     * Memory Optimization:
     * - No snapshot or copy is made of managedAccountsById
     * - All parallel operations work with the direct reference
     * - Deletions physically remove accounts from memory as they're processed
     *
     * @returns Processed fusion accounts
     */
    public async processFusionAccounts(): Promise<FusionAccount[]> {
        const { fusionAccounts } = this.sources
        this.log.detail({
            action: 'processing fusion accounts',
            count: fusionAccounts.length,
        })
        const results = await batchProcess(
            fusionAccounts,
            'Fusion accounts',
            async (x: Account) => {
                return await this.processFusionAccount(x)
            },
            this.config,
            this.log,
            undefined,
            'refreshed'
        )
        this.log.detail({
            action: 'fusion accounts phase finished',
            count: results.length,
        })
        return results
    }

    /**
     * Reconcile transient entitlements derived from pending form instances.
     *
     * This is intended for StdAccountList runs:
     * - Clears any persisted/stale 'candidate' and reviewer 'reviews'
     * - Re-applies them only from currently-known pending (unanswered) form instances
     *
     * This is necessary because not all identities may originate from existing fusion accounts
     * (some can be created from Identity documents), and those would otherwise retain stale values.
     */
    public reconcilePendingFormState(): void {
        this.decisionProcessor.reconcilePendingFormState()
    }

    /**
     * Refresh pending form data and reconcile transient candidate/reviewer output state
     * for the single account being processed.
     *
     * Single-account operations (create/read/enable/disable) handle one identity at a time,
     * but the shared form/decision state can carry transient 'candidate' and reviewer
     * 'reviews' entries from other accounts processed in the same lifecycle. Before
     * serializing the ISC account output, this method:
     * 1. Re-fetches the latest pending form instances via {@link FusionForms.fetchFormData}
     *    so the current account's pending decisions are reflected.
     * 2. Calls {@link reconcilePendingFormState} to drop stale 'candidate' / 'reviews'
     *    entries (which may reference accounts not present in this run) and
     *    rebuild them from the currently-known pending (unanswered) form instances,
     *    so the serialized output only references the account being returned.
     */
    public async normalizePendingFormStateForOutput(): Promise<void> {
        await this.decisionProcessor.normalizePendingFormStateForOutput()
    }

    /**
     * Process a single fusion account.
     *
     * This method builds a complete fusion account by layering data from multiple sources:
     * 1. Pre-process: Extract basic account info and set key
     * 2. Reviewer layer: Identify reviewers for this fusion account's sources
     * 3. Identity layer: Add identity document data
     * 4. Decision layer: Add any manual fusion decisions from forms
     * 5. Managed account layer: Find and attach managed accounts from work queue
     * 6. Attribute mapping and normal attribute definitions
     *
     * Attribute mapping and normal definitions are applied here, **before** the global
     * unique attribute refresh that runs after all accounts have been processed.  This
     * two-phase design means normal attributes are available for Fusion matching/scoring
     * while unique attributes are evaluated afterwards with full knowledge of every
     * account's normal attribute values.
     *
     * Work Queue Integration:
     * addManagedAccountLayer receives the direct reference to this.run.managedAccountsById,
     * which is the shared work queue. As accounts are matched and processed, they're deleted
     * from the queue to prevent duplicate processing in later phases.
     *
     * @param account - The fusion account from the platform
     * @param attributeOperations - Flags controlling which attribute operations to perform
     * @returns Processed FusionAccount with all layers applied
     */
    public async processFusionAccount(
        account: Account,
        attributeOperations: AttributeOperations = {
            refreshMapping: false,
            refreshDefinition: false,
            resetDefinition: false,
        },
        originIdentityInScope?: boolean
    ): Promise<FusionAccount> {
        const { refreshMapping, refreshDefinition, resetDefinition } = attributeOperations
        const fusionAccount = FusionAccount.fromFusionAccount(account)
        this.log.debug(
            `Pre-processing fusion account: ${fusionAccount.name} (${fusionAccount.managedKey}), ` +
                `identityId=${fusionAccount.identityId ?? 'none'}, disabled=${fusionAccount.disabled}, uncorrelated=${fusionAccount.uncorrelated}`
        )

        assert(this.run.managedAccountsById, 'Managed accounts have not been loaded')

        let mergeDecision: FusionDecision | undefined
        let skipBlendHistoryForManagedKeys: ReadonlySet<string> | undefined
        const accountIdsBefore = fusionAccount.accountIdsSet.size
        let queueEntriesScanned = 0

        const preludeMs = await measureMs(async () => {
            this.applyReviewerLayersToFusionAccount(fusionAccount)
            mergeDecision = this.applyIdentityLayerForFusionAccount(fusionAccount)
            skipBlendHistoryForManagedKeys = skipBlendHistoryKeysForDecisionAccountId(mergeDecision?.account.id)
            await this.setOriginIdentityInScopeIfNeeded(fusionAccount, originIdentityInScope)
        })
        this.log.recordRefreshSubStep('prelude', preludeMs)

        const managedLayerMs = await measureMs(async () => {
            const hasEligibleAlwaysRecalculate = this.definitionService.hasEligibleAlwaysRecalculate(fusionAccount)
            await this.accountAssembly.addManagedAccountLayer(fusionAccount, {
                addBlendHistory: true,
                skipBlendHistoryForManagedKeys,
                onQueueScan: (entriesExamined) => {
                    queueEntriesScanned += entriesExamined
                },
                forceAttributeRefresh: this.config.forceAttributeRefresh,
                refreshMapping,
                refreshDefinition,
                resetDefinition,
                hasEligibleAlwaysRecalculate,
                requireLiveSourceSnapshots:
                    this.config.forceAttributeRefresh ||
                    refreshMapping ||
                    refreshDefinition ||
                    resetDefinition ||
                    hasEligibleAlwaysRecalculate,
            })
        })
        this.log.recordRefreshSubStep('managedLayer', managedLayerMs, {
            queueEntriesScanned,
            managedAccountsBlended: Math.max(0, fusionAccount.accountIdsSet.size - accountIdsBefore),
        })

        await yieldToEventLoop()

        const uniqueRegisterMs = await measureMs(async () => {
            if (!resetDefinition) {
                await this.definitionService.registerUniqueAttributes(fusionAccount)
            }
        })
        this.log.recordRefreshSubStep('uniqueRegister', uniqueRegisterMs)

        fusionAccount.setNeedsRefresh(
            fusionAccount.needsRefresh ||
                resetDefinition ||
                refreshDefinition ||
                refreshMapping ||
                this.config.forceAttributeRefresh
        )
        fusionAccount.setNeedsReset(resetDefinition)
        this.applyPromoteMainAccountWhenOriginMissing(fusionAccount)

        let defineStats: { definitionsEvaluated: number; definitionsSkipped: number } | undefined
        await this.accountAssembly.applyAttributeProcessing(fusionAccount, {
            onDefineStats: (stats) => {
                defineStats = {
                    definitionsEvaluated: stats.evaluated,
                    definitionsSkipped: stats.skipped,
                }
            },
            onSubStep: (step, ms) => {
                if (step === 'map') {
                    this.log.recordRefreshSubStep('map', ms)
                    return
                }
                this.log.recordRefreshSubStep('normalDefine', ms, defineStats)
            },
        })

        const correlationMs = await measureMs(async () => {
            await this.correlationManager.applyPerSourceCorrelationIfNeeded(fusionAccount, mergeDecision)
        })
        this.log.recordRefreshSubStep('correlation', correlationMs)

        const finalizeMs = await measureMs(async () => {
            this.finalizeProcessedFusionAccount(fusionAccount)
        })
        this.log.recordRefreshSubStep('finalize', finalizeMs)
        this.log.incrementRefreshAccountsProcessed()

        return fusionAccount
    }

    private applyReviewerLayersToFusionAccount(fusionAccount: FusionAccount): void {
        const reviewerSources = fusionAccount.collections.actions.listReviewerSources()
        reviewerSources.forEach((sourceId) => this.setReviewerForSource(fusionAccount, sourceId))
        if (reviewerSources.length > 0) {
            this.populateReviewerFusionReviewsFromPending(fusionAccount)
        }
    }

    private applyIdentityLayerForFusionAccount(fusionAccount: FusionAccount): FusionDecision | undefined {
        // Platform `uncorrelated` means pending managed-account work, not "ignore identity".
        if (!fusionAccount.identityId) return undefined

        const { identityId } = fusionAccount
        const identity = this.identities.getIdentityById(identityId)
        if (identity) {
            fusionAccount.addIdentityLayer(identity)
        }
        // Identity ID is already on _identityInfo from factory; no re-registration needed here.

        const mergeDecision = this.forms.getFusionMergeDecision(identityId)
        if (mergeDecision) {
            fusionAccount.layers.addFusionDecisionLayer(mergeDecision)
            logFusionDecisionApplied(this.log, mergeDecision, 'merged')
        }
        this.log.debug(`Applied identity layer for ${fusionAccount.name}: identityId=${identityId}`)
        return mergeDecision
    }

    /**
     * While the Processing Control toggle is on, point `mainAccount` at the first live managed
     * account when the origin is not a current contributor, and clear it when the origin is a
     * current contributor again. Runs after the managed-account layer and before Map.
     */
    private applyPromoteMainAccountWhenOriginMissing(fusionAccount: FusionAccount): void {
        if (this.config.promoteMainAccountWhenOriginMissing !== true) return

        const originAbsent = this.originIsNotCurrentContributor(fusionAccount)
        if (originAbsent === undefined) return

        const next = originAbsent ? this.firstLiveManagedAccountKey(fusionAccount) : undefined
        const previous = trimStr(fusionAccount.getStringAttribute(FusionAttribute.MainAccount))
        if (previous === next) return

        if (next) {
            fusionAccount.attributes[FusionAttribute.MainAccount] = next
        } else {
            delete fusionAccount.attributes[FusionAttribute.MainAccount]
        }
        fusionAccount.setNeedsRefresh(true)
        fusionAccount.collections.addHistoryMessage(
            `Set mainAccount from ${previous ?? 'unset'} to ${next ?? 'cleared'}`
        )
    }

    /**
     * Managed-origin absence is the origin key missing from `accounts` after blend and prune.
     * Identity-origin absence is a resolved out-of-scope origin. Unresolved scope is not absence.
     */
    private originIsNotCurrentContributor(fusionAccount: FusionAccount): boolean | undefined {
        if (fusionAccount.fromIdentity) {
            if (fusionAccount.originIdentityInScope === true) return false
            if (fusionAccount.originIdentityInScope === false) return true
            return undefined
        }
        const originKey = fusionAccount.originAccountId
        if (!originKey) return true
        return !fusionAccount.accountIdsSet.has(originKey)
    }

    /**
     * First managed-source account still linked, in configured source order, then blend order
     * within a source. The identity bag is not a candidate. Snapshot order is used when this
     * run materialized managed snapshots; otherwise linked account keys are ordered the same way.
     */
    private firstLiveManagedAccountKey(fusionAccount: FusionAccount): string | undefined {
        const linked = fusionAccount.accountIdsSet
        const identityId = trimStr(fusionAccount.identityId)
        if (this.hasMaterializedManagedSnapshots(fusionAccount)) {
            return this.firstLinkedSnapshotKey(fusionAccount, linked, identityId)
        }
        return this.firstLinkedAccountKey(fusionAccount, linked, identityId)
    }

    private hasMaterializedManagedSnapshots(fusionAccount: FusionAccount): boolean {
        for (const [sourceName, snapshots] of fusionAccount.attributeBag.sources) {
            if (sourceName === IDENTITIES_SOURCE_NAME) continue
            if (snapshots.length > 0) return true
        }
        return false
    }

    private firstLinkedSnapshotKey(
        fusionAccount: FusionAccount,
        linked: ReadonlySet<string>,
        identityId: string | undefined
    ): string | undefined {
        const sources = fusionAccount.attributeBag.sources
        const ordered: string[] = []
        const seen = new Set<string>()
        const pushSource = (sourceName: string): void => {
            if (sourceName === IDENTITIES_SOURCE_NAME || seen.has(sourceName)) return
            seen.add(sourceName)
            for (const snapshot of sources.get(sourceName) ?? []) {
                const key = getManagedAccountSnapshotKey(snapshot)
                if (!this.isLiveManagedAccountKey(key, linked, identityId)) continue
                ordered.push(key)
            }
        }

        for (const sourceConfig of this.config.sources ?? []) {
            pushSource(sourceConfig.name)
        }
        for (const sourceName of sources.keys()) {
            pushSource(sourceName)
        }
        return ordered[0]
    }

    private firstLinkedAccountKey(
        fusionAccount: FusionAccount,
        linked: ReadonlySet<string>,
        identityId: string | undefined
    ): string | undefined {
        const keysBySource = new Map<string, string[]>()
        const sourceSeen: string[] = []
        for (const key of linked) {
            if (!this.isLiveManagedAccountKey(key, linked, identityId)) continue
            const sourceName = this.sourceNameForManagedKey(fusionAccount, key) ?? ''
            const keys = keysBySource.get(sourceName)
            if (keys) {
                keys.push(key)
            } else {
                keysBySource.set(sourceName, [key])
                sourceSeen.push(sourceName)
            }
        }

        const ordered: string[] = []
        const emitted = new Set<string>()
        for (const sourceConfig of this.config.sources ?? []) {
            const keys = keysBySource.get(sourceConfig.name)
            if (!keys) continue
            ordered.push(...keys)
            emitted.add(sourceConfig.name)
        }
        for (const sourceName of sourceSeen) {
            if (emitted.has(sourceName)) continue
            ordered.push(...(keysBySource.get(sourceName) ?? []))
        }
        return ordered[0]
    }

    private isLiveManagedAccountKey(key: string, linked: ReadonlySet<string>, identityId: string | undefined): boolean {
        if (!key || !linked.has(key) || !isCompositeManagedAccountKey(key)) return false
        if (identityId && key === identityId) return false
        return true
    }

    private sourceNameForManagedKey(fusionAccount: FusionAccount, key: string): string | undefined {
        return (
            trimStr(fusionAccount.collections.managedAccountInfo.get(key)?.source.name) ??
            trimStr(this.run.getManagedAccountInfo(key)?.sourceName)
        )
    }

    private async setOriginIdentityInScopeIfNeeded(
        fusionAccount: FusionAccount,
        originIdentityInScope?: boolean
    ): Promise<void> {
        if (!fusionAccount.fromIdentity || fusionAccount.originIdentityInScope !== undefined) return

        const originIdentityId = fusionAccount.originAccountId ?? fusionAccount.identityId
        if (!originIdentityId) return

        const inScope =
            originIdentityInScope !== undefined
                ? originIdentityInScope
                : await this.identities.resolveOriginIdentityInScope(
                      originIdentityId,
                      this.identities.getIdentityById(originIdentityId)
                  )
        fusionAccount.setOriginIdentityInScope(inScope)
    }

    private finalizeProcessedFusionAccount(fusionAccount: FusionAccount): void {
        // Sync _uncorrelated with _missingAccountIds so setFusionAccount routes to the correct map.
        fusionAccount.updateCorrelationStatus(
            this.accountAssembly.isAggregationAccountListMode()
                ? undefined
                : () => this.log.recordCorrelatedActionGranted()
        )

        this.log.debug(
            `Completed processing fusion account: ${fusionAccount.name}, ` +
                `needsRefresh=${fusionAccount.needsRefresh}, sources=[${fusionAccount.sources.join(', ')}]`
        )

        this.accountAssembly.registerFusionAccount(fusionAccount)

        // Deplete the identity work queue so processIdentities skips this identity without map-only guards.
        const claimedIdentityId = fusionAccount.identityId
        if (claimedIdentityId) {
            this.identities.deleteIdentity(claimedIdentityId)
        }
    }

    // ------------------------------------------------------------------------
    // Per-Source Correlation
    // ------------------------------------------------------------------------

    /**
     * Run per-source correlation for missing accounts (direct PATCH and/or reverse attributes).
     * Use when correlation must run outside account-list aggregation (e.g. correlate entitlement action).
     */
    public async correlateMissingAccountsPerSource(fusionAccount: FusionAccount): Promise<void> {
        await this.correlationManager.correlateMissingAccountsPerSource(fusionAccount)
    }

    // ------------------------------------------------------------------------
    // Public Identity Processing Methods
    // ------------------------------------------------------------------------

    /**
     * Process all identities.
     * Delegates to IdentityProcessor.
     */
    public async processIdentities(): Promise<FusionAccount[]> {
        const results = await this.identityProcessor.processIdentities()
        await this.initializeSourceReviewers()
        return results
    }

    /**
     * Process a single identity.
     * Delegates to IdentityProcessor.
     */
    public async processIdentity(identity: IdentityDocument): Promise<FusionAccount | undefined> {
        return this.identityProcessor.processIdentity(identity)
    }

    /**
     * Process queued Fusion identity decisions, including authorized merges that
     * were not applied during refresh because no persisted Fusion account existed.
     *
     * @returns The fusion accounts produced by the new identity decisions
     */
    public async processFusionIdentityDecisions(): Promise<FusionAccount[]> {
        return this.decisionProcessor.processFusionIdentityDecisions()
    }

    /**
     * Processes a single Fusion identity decision (reviewer form response).
     * Creates a new Fusion identity (a Fusion account that became an identity) for
     * "new identity" decisions, or merges into an existing one for "authorized" decisions.
     *
     * For record/orphan source types, "new identity" (toggle true) means "no match":
     * - record: registers unique attributes but does not output as ISC account
     * - orphan: drops the account; optionally fires a disable operation
     *
     * @param fusionDecision - The reviewer's decision from the review form
     * @returns The fusion account produced or updated, or undefined if the decision was skipped
     */
    public async processFusionIdentityDecision(fusionDecision: FusionDecision): Promise<FusionAccount | undefined> {
        return this.decisionProcessor.processFusionIdentityDecision(fusionDecision)
    }

    // ------------------------------------------------------------------------
    // Public Managed Account Processing Methods
    // ------------------------------------------------------------------------

    /**
     * Process all managed accounts from the work queue.
     *
     * This is Phase 4 of the work queue depletion process:
     * - Phase 1: fetchFormData removes accounts with pending form decisions
     * - Phase 2: processFusionAccounts removes accounts belonging to existing fusion accounts
     * - Phase 3: processIdentities removes accounts belonging to identities
     * - Phase 4: processManagedAccounts (this method) processes ONLY what remains
     *
     * At this point, the work queue (this.run.managedAccountsById) contains ONLY
     * uncorrelated accounts that don't belong to any existing fusion account or identity.
     * These are the truly new accounts that need Match review.
     *
     * The work queue pattern ensures:
     * - No duplicate processing (accounts are physically removed as they're claimed)
     * - Efficient filtering (no need to re-check thousands of already-processed accounts)
     * - Clear ownership (each account is processed exactly once)
     *
     * Memory Efficiency:
     * - Uses per-phase snapshots to avoid iterator invalidation while work-queue entries are removed
     * - Configurable batch size (managedAccountsBatchSize, default 100) limits concurrent in-flight objects
     * - Non-matches store minimal report data; full FusionAccount only for matches
     * - Tracker state cleared by generateReport() after use
     * - Processes bounded batches to improve throughput while preserving shared-state updates.
     *
     * @returns Empty array (side effects register accounts in fusionAccountMap / identity-linked Fusion account map)
     */
    public async processManagedAccounts(): Promise<void> {
        await this.initializeManagedAccountProcessing()
        await this.processCorrelatedManagedAccounts()
        await this.processRecordUniqueRegistration()
        const { processed } = await this.processUncorrelatedManagedAccounts()
        this.log.detail({
            action: 'managed accounts phase finished',
            processed,
        })
    }

    private validateManagedSourceReviewers(): void {
        this.run.sourcesWithoutReviewers.clear()
        const withoutMatchScoring: string[] = []
        const withoutReviewers: string[] = []
        for (const source of this.sources.managedSources) {
            const sourceInfo = { id: source.id, name: source.name } as import('../sourceService').SourceInfo
            if (!sourceShouldEnterMatchScoring(this.config, sourceInfo, this.run)) {
                this.run.sourcesWithoutReviewers.add(source.name)
                withoutMatchScoring.push(source.name)
            } else if (this.config.fusionEnableAutoMerge && !sourceHasReviewers(sourceInfo, this.run)) {
                withoutReviewers.push(source.name)
            }
        }

        if (withoutMatchScoring.length > 0) {
            this.log.info(
                `Match scoring is not configured for ${withoutMatchScoring.length} managed source(s): ` +
                    `${formatSourceNameList(withoutMatchScoring)} ` +
                    `(enable automatic merge and/or manual review with valid reviewers). ` +
                    `Managed accounts from these sources will be treated as NonMatched.`
            )
        }

        if (withoutReviewers.length > 0) {
            this.log.warn(
                `No reviewers configured for ${withoutReviewers.length} managed source(s) with automatic merge enabled: ` +
                    `${formatSourceNameList(withoutReviewers)}. ` +
                    `Manual review is unavailable; borderline matches will register as non-match.`
            )
        }
    }

    private buildLinkedAccountKeyIndex(): void {
        // Build a one-shot flat index of every account key already linked in a loaded Fusion account.
        // isManagedAccountLinkedInFusion uses this for O(1) per-account lookups instead
        // of scanning fusionAccountMap + identity-linked Fusion account map (O(A+I)) for every queued
        // managed account in both the correlated and uncorrelated sweeps.
        this.run.initLinkedAccountIndex()
        for (const fa of this.run.fusionAccountsIterable()) {
            addFusionAccountLinkedKeysToIndex(fa, this.run)
        }
        for (const fa of this.run.allFusionIdentities) {
            addFusionAccountLinkedKeysToIndex(fa, this.run)
        }
    }

    private async runCorrelatedAccountSweep(map: Map<string, Account>): Promise<void> {
        // Correlated account sweep: resolve all correlated managed accounts before uncorrelated scoring begins.
        // Orphan correlated accounts (correlated on the source but absent from any loaded Fusion account)
        // are registered as non-matches in the identity-linked Fusion account map here, so they are immediately visible
        // as deferred-match candidates when uncorrelated accounts are scored in the uncorrelated scoring sweep.
        const correlatedAccounts = [...map.values()].filter((a) => a.uncorrelated === false)
        if (correlatedAccounts.length === 0) {
            return
        }

        this.log.detail({
            action: 'correlated account sweep',
            count: correlatedAccounts.length,
        })
        let droppedLinked = 0
        await batchProcess(
            correlatedAccounts,
            'Correlated managed accounts',
            async (account) => {
                if (isManagedAccountLinkedInFusion(account, this.run)) {
                    droppedLinked++
                }
                return this.processManagedAccount(account)
            },
            this.config,
            this.log,
            this.run.managedAccountProcessingBatchSize
        )
        this.log.detail({
            action: 'correlated account sweep complete',
            droppedLinked,
            remaining: map.size,
        })
    }

    /**
     * Uncorrelated scoring sweep: drains the remaining uncorrelated managed-account queue after the
     * correlated account sweep has claimed linked/correlated entries.
     */
    private async runUncorrelatedManagedAccountSweep(
        queuedAccounts: Account[],
        batchSize: number,
        _managedAccountProcessingStartedAt: number
    ): Promise<number> {
        const result = await this.dispatcher.runMatchSweep(queuedAccounts, batchSize)
        return result.processed
    }

    /**
     * Wait for all pending asynchronous disable operations to complete.
     * Safe to call multiple times; it drains the current pending set.
     */
    public async awaitPendingDisableOperations(): Promise<void> {
        if (this.run.pendingDisableOperationsCount === 0) {
            return
        }

        this.log.detail({
            action: 'waiting for pending disable operations',
            count: this.run.pendingDisableOperationsCount,
        })
        await this.run.awaitPendingDisableOperations()
        this.log.detail({ action: 'pending disable operations completed' })
    }

    /**
     * Processes a single managed account through the Match workflow (or a correlated
     * orphan shortcut when the account is correlated on the source but not linked to
     * any loaded Fusion account).
     * After scoring, the account is either assigned automatically to the matched identity
     * (perfect scores when enabled), sent for manual review (partial match), or handled
     * based on the source type:
     * - authoritative: added as non-matched new identity (output as ISC account)
     * - record: unique attributes registered but not output as ISC account
     * - orphan: dropped immediately; optionally fires a disable operation
     *
     * @param account - The ISC account from a managed source (typically uncorrelated on the work queue)
     * @returns The fusion account produced or updated, or undefined if skipped or sent for manual review.
     *          Deferred candidate matches (deferred candidate is another provisional Fusion account from the same source) are removed from
     *          the managed-account work queue for this run; they are expected to be re-fetched next aggregation.
     */
    /**
     * Processes a single managed account through the Match workflow.
     * Delegates scoring, resolution, and outcome dispatch to {@link MatchOutcomeDispatcher}.
     */
    public async processManagedAccount(account: Account): Promise<FusionAccount | undefined> {
        const result = await this.dispatcher.runMatchSweep([account], 1)
        return result.resolved[0]?.fusionAccount
    }

    /**
     * Full sequential scan of every loaded managed account, returning a FusionAccount per entry.
     * Used when correlating outside the primary fusion-ISC stream (e.g. dry-run emission for
     * uncorrelated / work-queue remainder). Iterates the map directly; runs sequentially so
     * deferred-candidate visibility is preserved between managed accounts.
     *
     * @returns Array of FusionAccount with match results populated for each
     */
    public async analyzeUncorrelatedAccounts(): Promise<FusionAccount[]> {
        const map = this.run.managedAccountsById
        assert(map, 'Managed accounts have not been loaded')
        this.run.matchScoringMs = 0
        const results: FusionAccount[] = []

        const accounts = [...map.values()]
        const sweepResult = await this.dispatcher.runMatchSweep(
            accounts,
            this.run.managedAccountProcessingBatchSize || 1,
            { mode: MatchSweepMode.AnalysisOnly }
        )

        let processed = 0
        const yieldEveryManaged = getManagedAccountEventLoopYieldEvery(this.config)
        for (const resolved of sweepResult.resolved) {
            const analysis = resolved.analysis!
            this.run.recordAnalysis(analysis)
            const { fusionAccount, account } = analysis
            if (hasDeferredOnlyCandidateMatches(fusionAccount)) {
                logDeferredMatchDiscoveryForReview(
                    this.log,
                    fusionAccount,
                    this.run,
                    this.config,
                    account.name ?? '',
                    account.sourceName ?? undefined
                )
            }
            results.push(fusionAccount)
            processed += 1
            if (processed % yieldEveryManaged === 0) {
                await yieldToEventLoop()
            }
        }
        return results
    }

    // ------------------------------------------------------------------------
    // Public Output/Listing Methods
    // ------------------------------------------------------------------------

    private shouldLogBatchProgress(
        currentBatch: number,
        totalBatches: number,
        processedInLoop: number,
        totalEligible: number,
        logProgressEveryBatch: number
    ): boolean {
        return (
            currentBatch === 1 ||
            currentBatch % logProgressEveryBatch === 0 ||
            currentBatch === totalBatches ||
            processedInLoop === totalEligible
        )
    }

    /**
     * Unique refresh runs for accounts that are already refresh- or reset-eligible,
     * and also when a Unique attribute is blank. Populated values are preserved
     * inside `refreshUniqueAttributes` unless the account is being reset.
     */
    private accountNeedsUniqueRefresh(account: FusionAccount): boolean {
        return (
            account.needsRefresh ||
            account.needsReset ||
            this.definitionService.hasMissingUniqueAttribute(account)
        )
    }

    private async processOutputBatch(
        batch: FusionAccount[],
        refreshUniqueAttributes: boolean,
        send: (account: StdAccountListOutput) => unknown
    ): Promise<number> {
        const outputBatch = await Promise.all(
            batch.map(async (account) => {
                if (refreshUniqueAttributes && this.accountNeedsUniqueRefresh(account)) {
                    await this.definitionService.refreshUniqueAttributes(account)
                }
                return this.getISCAccount(account, false)
            })
        )

        let sent = 0
        for (let j = 0; j < outputBatch.length; j++) {
            const output = outputBatch[j]
            if (output) {
                await send(output)
                sent++
            }
            this.run.removeFusionAccount(batch[j])
        }
        return sent
    }

    /**
     * Streams each ISC account to the provided callback as soon as it's ready.
     * Memory optimization: avoids accumulating the full output array - processes
     * and sends one at a time instead of building the whole array first.
     *
     * @param send - Callback for each account. Async callbacks are awaited so a slow client can apply backpressure.
     * @returns Number of accounts sent and number of eligible accounts
     */
    public async forEachISCAccount(
        send: (account: StdAccountListOutput) => unknown,
        refreshUniqueAttributes: boolean = false
    ): Promise<{ sent: number; eligible: number }> {
        const batchSize = getFusionParallelBatchSize(this.config)
        let count = 0

        const allAccounts = [...this.run.allFusionAccounts, ...this.run.allFusionIdentities]
        const eligibleAccounts = this.deleteEmpty
            ? allAccounts.filter((account) => !account.collections.statuses.isOrphan())
            : allAccounts

        const totalEligible = eligibleAccounts.length
        const totalBatches = Math.ceil(totalEligible / batchSize)
        const logProgressEveryBatch = Math.max(1, Math.min(50, Math.ceil(totalBatches / 20) || 1))
        for (let i = 0; i < eligibleAccounts.length; i += batchSize) {
            const batch = eligibleAccounts.slice(i, i + batchSize)
            count += await this.processOutputBatch(batch, refreshUniqueAttributes, send)

            const processedInLoop = Math.min(i + batch.length, totalEligible)
            const currentBatch = Math.floor(i / batchSize) + 1
            if (
                this.shouldLogBatchProgress(
                    currentBatch,
                    totalBatches,
                    processedInLoop,
                    totalEligible,
                    logProgressEveryBatch
                )
            ) {
                this.log.setProgress(processedInLoop, totalEligible, 'sent')
            }
            await yieldToEventLoop()
        }

        return { sent: count, eligible: totalEligible }
    }

    /**
     * Converts a fusion account to the ISC account output format.
     * Resolves all pending operations (correlations, reviews) before building the output,
     * then syncs collection attributes and applies the schema subset filter.
     *
     * Key / managedKey handling:
     * - Existing Fusion accounts (reloaded from ISC): `key.simple.id = fusionAccount.managedKey`,
     *   and the fusion identity attribute is realigned to that managedKey when it has drifted.
     * - New Managed/Identity accounts: key comes from `getSimpleKey` (fusion identity attribute).
     * - The managedKey is set by the factory method and never changed afterwards.
     * - When `skipAccountsWithMissingId` is enabled and the identity attribute is empty,
     *   getSimpleKey returns undefined and the account is omitted from the output. This
     *   enables a deliberate pattern: generate an empty identity attribute to prevent
     *   specific managed accounts or identities from producing Fusion accounts.
     *
     * @param fusionAccount - The fusion account to convert
     * @returns The formatted account output for the platform, or undefined if key cannot be generated
     */
    public async getISCAccount(
        fusionAccount: FusionAccount,
        awaitCorrelations = true,
        recomputeCorrelationStatus = true
    ): Promise<StdAccountListOutput | undefined> {
        await fusionAccount.correlation.resolvePendingOperations(awaitCorrelations)
        // Update correlation status/action based on whatever correlations have resolved so far.
        if (recomputeCorrelationStatus) {
            fusionAccount.updateCorrelationStatus(
                this.accountAssembly.isAggregationAccountListMode()
                    ? undefined
                    : () => this.log.recordCorrelatedActionGranted()
            )
        }
        // Match forms: ensure this exact Fusion account reflects FormService pending state at output time.
        // Global reconcile runs during aggregation, but accountRead and edge paths only guarantee
        // correctness if we re-apply pending candidate + reviewer URLs here (mirrors reviewer
        // handling in processFusionAccount via populateReviewerFusionReviewsFromPending).
        this.ensurePendingFormDerivedCollectionStateForOutput(fusionAccount)
        // Sync collection state (reviews, accounts, statuses, actions) into the attribute bag
        // so that the subset and output include current values (e.g. reviewer review URLs).
        fusionAccount.syncCollectionAttributesToBag()

        if (!this.setCoreSchemaAttributes(fusionAccount)) {
            return undefined
        }

        const attributes = this.schemas.getFusionAttributeSubset(fusionAccount.attributes)
        const disabled = fusionAccount.disabled

        return {
            key: fusionAccount.key,
            attributes,
            disabled,
        }
    }

    // ------------------------------------------------------------------------
    // Private Helper Methods
    // ------------------------------------------------------------------------

    /**
     * Enforce display attribute overrides and generate/assign a key for interim accounts.
     * Returns true when the account is ready for output, false when it should be skipped.
     *
     * Existing Fusion accounts (reloaded from ISC) always emit `managedKey` as the output key
     * and realign the fusion identity attribute to it. That keeps single-account refresh from
     * creating a duplicate when the identity attribute has drifted away from nativeIdentity.
     * New Managed/Identity accounts still take their key from {@link DefinitionService.getSimpleKey}.
     */
    private setCoreSchemaAttributes(fusionAccount: FusionAccount): boolean {
        // Enforce hosting identity name display override if correlated
        this.definitionService.applyDisplayAttributeOverride(fusionAccount)

        const managedKey = trimStr(fusionAccount.managedKey)
        const isExistingFusionAccount =
            fusionAccount.type === FusionAccountKind.Fusion &&
            Object.keys(fusionAccount.previousAttributes ?? {}).length > 0

        if (isExistingFusionAccount && managedKey) {
            const { fusionIdentityAttribute } = this.schemas
            if (fusionAccount.attributes[fusionIdentityAttribute] !== managedKey) {
                fusionAccount.attributes[fusionIdentityAttribute] = managedKey
            }
            fusionAccount.setKey(SimpleKey(managedKey))
            return true
        }

        // Generate and assign key for interim accounts (key postponed from processIdentity/processFusionIdentityDecision)
        const key = fusionAccount.key ?? this.definitionService.getSimpleKey(fusionAccount)
        if (!key) {
            return false
        }
        if (!fusionAccount.key) {
            fusionAccount.setKey(key)
        }
        return true
    }

    /**
     * Apply pending fusion Match form URLs and candidate status for this account's identityId.
     * Idempotent: safe to call after reconcilePendingFormState and before syncCollectionAttributesToBag.
     */
    private ensurePendingFormDerivedCollectionStateForOutput(fusionAccount: FusionAccount): void {
        const identityId = fusionAccount.identityId
        if (!identityId) {
            return
        }

        const pendingCandidates = this.run.pendingCandidateIdentityIds
        const needsCandidate = pendingCandidates.has(identityId)
        if (needsCandidate) {
            fusionAccount.collections.statuses.add(StatusEntitlement.Candidate)
        }

        if (fusionAccount.collections.actions.listReviewerSources().length > 0) {
            const reviewerUrls = this.run.getReviewerUrls(identityId)
            if (reviewerUrls?.length) {
                for (const u of reviewerUrls) {
                    fusionAccount.collections.reviews.addFusionReview(u)
                }
            }
        }
    }

    /**
     * True when this managed account is already represented on a loaded Fusion account
     * (platform Fusion account or identity-origin Fusion account), or when its identityId matches
     * a loaded identity-origin Fusion account.
     *
     * Uses the linked account key index (O(1)) while managed account processing is active (built by
     * initializeManagedAccountProcessing, released after the uncorrelated sweep), falling back to a
     * linear scan of fusionAccountMap + identity-linked Fusion account map for standalone calls.
     */
    private isCorrelatedManagedAccountLinkedInFusion(account: Account): boolean {
        return isManagedAccountLinkedInFusion(account, this.run)
    }

    /**
     * Execute a low-priority disable operation for a managed account.
     * Used by the orphan source type when disableNonMatchingAccounts is enabled.
     */
    private async fireDisableOperation(account: Account): Promise<void> {
        const accountId = account.id
        if (!accountId) {
            this.log.warn(`Cannot disable account without ID: ${account.name} [${account.sourceName}]`)
            return
        }
        if (account.disabled) {
            return
        }
        this.log.detail({
            action: 'firing low-priority disable',
            account: account.name,
            source: account.sourceName,
            accountId,
        })
        await this.sources.fireDisableAccount(accountId)
    }

    /** Resolve a reviewer fusion account by ISC identity id (identity map or managed-key index). */
    private findFusionAccountForReviewerIdentity(identityId: string): FusionAccount | undefined {
        const fromIdentityMap = this.run.getFusionIdentity(identityId)
        if (fromIdentityMap) return fromIdentityMap
        for (const account of this.run.fusionAccountsIterable()) {
            if (account.identityId === identityId) return account
        }
        return undefined
    }

    /**
     * Resolve or create an identity-origin Fusion account for a global reviewer.
     * Global owners often sit outside the configured identity scope, so this path
     * fetches the ISC identity directly and materializes a Fusion account when needed.
     */
    private async resolveGlobalReviewerFusionAccount(reviewerId: string): Promise<FusionAccount | undefined> {
        let reviewer = this.findFusionAccountForReviewerIdentity(reviewerId)
        if (reviewer) return reviewer

        const identity = await this.identities.ensureIdentityById(reviewerId)
        if (!identity) return undefined
        if (identity.protected) {
            this.log.warn(`Global reviewer identity ${reviewerId} is protected; skipping reviewer registration.`)
            return undefined
        }

        this.identities.markIdentityInScope(reviewerId)

        reviewer = this.findFusionAccountForReviewerIdentity(reviewerId)
        if (reviewer) return reviewer

        const processed = await this.processIdentity(identity)
        return processed ?? this.findFusionAccountForReviewerIdentity(reviewerId)
    }

    /**
     * Set a reviewer for a specific source.
     *
     * @param fusionAccount - The fusion account to set as reviewer
     * @param sourceId - The source ID to associate the reviewer with
     */
    private setReviewerForSource(fusionAccount: FusionAccount, sourceId: string): void {
        this.log.debug(`Setting reviewer for ${fusionAccount.name} -> sourceId=${sourceId}`)
        fusionAccount.collections.actions.setSourceReviewer(sourceId)
        const reviewers: Set<FusionAccount> = this.run.reviewersBySourceId.get(sourceId) ?? new Set()
        reviewers.add(fusionAccount)
        this.run.reviewersBySourceId.set(sourceId, reviewers)
    }

    /**
     * Populate a reviewer's fusion reviews from pending (unanswered) form instances.
     * Clears existing reviews so only current-run pending URLs are included.
     */
    private populateReviewerFusionReviewsFromPending(reviewer: FusionAccount): void {
        reviewer.collections.reviews.clearFusionReviews()
        const identityId = reviewer.identityId
        if (!identityId) return
        const urls = this.run.getReviewerUrls(identityId)
        if (!urls?.length) return
        for (const url of urls) {
            reviewer.collections.reviews.addFusionReview(url)
        }
    }

    /**
     * Build the sources-by-name lookup and, when the fusion owner acts as a global reviewer,
     * register every managed source as a reviewer source and populate pending reviews.
     */

    /**
     * Hydrate fusion source owners and mark them in aggregation scope before persisted
     * identity-origin Fusion accounts are processed. Without this, a global reviewer Fusion account
     * from a prior run can be marked orphan when the owner sits outside identityScopeQuery.
     */
    public cacheGlobalOwnerIdentityIds(ids: string[]): void {
        this.globalOwnerIdentityIdsCache = ids
    }

    private async resolveGlobalOwnerIdentityIds(): Promise<string[]> {
        if (this.globalOwnerIdentityIdsCache !== undefined) {
            return this.globalOwnerIdentityIdsCache
        }
        const ids = await this.sources.fetchGlobalOwnerIdentityIds()
        this.globalOwnerIdentityIdsCache = ids
        return ids
    }

    public async ensureGlobalReviewerOwnersInScope(): Promise<void> {
        if (!this.fusionOwnerIsGlobalReviewer) {
            return
        }

        const globalOwnerIds = await this.resolveGlobalOwnerIdentityIds()
        if (globalOwnerIds.length === 0) {
            return
        }

        for (const ownerId of globalOwnerIds) {
            await this.identities.ensureIdentityById(ownerId)
            this.identities.markIdentityInScope(ownerId)
        }
    }

    public async initializeSourceReviewers(): Promise<void> {
        this.run.sourcesByName.clear()
        for (const source of this.sources.managedSources) {
            this.run.sourcesByName.set(source.name, source)
        }

        if (!this.fusionOwnerIsGlobalReviewer) {
            return
        }

        const globalOwnerIds = await this.resolveGlobalOwnerIdentityIds()
        if (globalOwnerIds.length === 0) {
            this.log.warn(
                'Owners are global reviewers is enabled but no Fusion source owner identity IDs were resolved. ' +
                    'Configure a Fusion source owner (or governance group) or assign per-source reviewer entitlements.'
            )
            return
        }

        for (const reviewerId of globalOwnerIds) {
            const reviewer = await this.resolveGlobalReviewerFusionAccount(reviewerId)
            if (!reviewer) {
                this.log.warn(
                    `Global reviewer identity ${reviewerId} is not available as a Fusion identity; ` +
                        'skipping global reviewer registration for this identity.'
                )
                continue
            }
            for (const source of this.sources.managedSources) {
                this.setReviewerForSource(reviewer, source.id!)
            }
            this.populateReviewerFusionReviewsFromPending(reviewer)
        }
    }

    /**
     * Pre-process a managed account before processing or analysis.
     *
     * @param account - The managed source account to pre-process
     * @returns FusionAccount with basic attributes mapped and non-unique attributes refreshed
     */
    public async preProcessManagedAccount(account: Account): Promise<FusionAccount> {
        return this.accountAssembly.assembleManagedAccount(account)
    }

    /**
     * Returns an iterable over fusion identities, skipping those whose identityId is in `excludeIds`.
     * Used to filter already auto-assigned identities during managed account scoring.
     */
    public *fusionIdentitiesExcluding(excludeIds: ReadonlySet<string>): Iterable<FusionAccount> {
        for (const identity of this.run.allFusionIdentities) {
            if (!identity.identityId || !excludeIds.has(identity.identityId)) {
                yield identity
            }
        }
    }

    private ensureManagedAccountProcessingInitialized(): void {
        if (this.run.managedAccountProcessingState !== 'initialized') {
            throw new Error('initializeManagedAccountProcessing must be called before managed account processing')
        }
    }

    /** Initialize managed account processing state: rebuilt trigram index, linked account key index, and reviewer validation. */
    public async initializeManagedAccountProcessing(): Promise<void> {
        if (this.run.managedAccountProcessingState !== 'idle') {
            throw new Error('Managed account processing already initialized')
        }
        const map = this.run.managedAccountsById
        assert(map, 'Managed accounts have not been loaded')

        this.run.startManagedAccountProcessing(Math.max(1, getManagedAccountsBatchSize(this.config)))

        this.requireTracker().newManagedAccountsCount = map.size
        this.run.clearDeferredCandidates()
        this.run.resetScoringState()

        for (const fusionAccount of this.run.fusionAccountMap.values()) {
            this.run.registerPersistedDeferredCandidate(fusionAccount)
        }
        for (const fusionAccount of this.run.allFusionIdentities) {
            this.run.registerPersistedDeferredCandidate(fusionAccount)
        }

        this.validateManagedSourceReviewers()

        // Build the trigram blocking index over all currently-loaded fusion identities so that
        // each managed account can skip the vast majority of identity comparisons.
        // The index is rebuilt each run (identity pool may change between runs).
        this.matchingService.buildTrigramIndex(this.run.allFusionIdentities)

        this.buildLinkedAccountKeyIndex()
    }

    /** Correlated account sweep: resolve linked/correlated managed accounts before uncorrelated scoring. */

    /**
     * Bulk-register unique attribute values for record sources with match disabled.
     * Removes processed accounts from the managed-account work queue.
     */
    public async processRecordUniqueRegistration(): Promise<{ registered: number }> {
        this.ensureManagedAccountProcessingInitialized()
        const map = this.run.managedAccountsById
        const eligible: Account[] = []

        for (const account of map.values()) {
            if (!account.sourceName) continue
            const sourceInfo = this.run.sourcesByName.get(account.sourceName)
            if (sourceInfo?.sourceType !== SourceType.Record) continue
            if (isRecordMatchingEnabledForSource(account.sourceName, this.run.sourcesByName)) continue
            eligible.push(account)
        }

        if (eligible.length === 0) {
            return { registered: 0 }
        }

        this.log.detail({
            action: 'registering unique attribute values',
            count: eligible.length,
        })

        const registered = await this.definitionService.registerUniqueValuesFromRecordManagedAccounts(
            eligible,
            this.mappingService,
            this.run,
            {
                onProgress: (done, total) => this.log.setProgress(done, total, 'registered'),
            }
        )

        for (const account of eligible) {
            const key = getManagedAccountKeyFromAccount(account)
            if (key) {
                this.run.claimAccount(key, account.identityId)
            }
        }

        this.log.recordEvent('recordUniqueRegistered', { count: registered })
        this.log.detail({
            action: 'record unique registration complete',
            registered,
        })
        return { registered }
    }

    public async processCorrelatedManagedAccounts(): Promise<void> {
        this.ensureManagedAccountProcessingInitialized()
        const map = this.run.managedAccountsById
        await this.runCorrelatedAccountSweep(map)
    }

    /**
     * Uncorrelated scoring sweep: drain remaining work-queue entries after the correlated account sweep.
     * @returns Processed count and match scoring duration for metric emission.
     */
    public async processUncorrelatedManagedAccounts(): Promise<{ processed: number; matchScoringMs: number }> {
        this.ensureManagedAccountProcessingInitialized()
        const map = this.run.managedAccountsById
        const queuedAccounts = [...map.values()]
        const initialQueueSize = queuedAccounts.length
        this.log.detail({
            action: 'processing uncorrelated managed accounts',
            count: initialQueueSize,
        })
        const processed = await this.runUncorrelatedManagedAccountSweep(
            queuedAccounts,
            this.run.managedAccountProcessingBatchSize,
            this.run.managedAccountProcessingBatchSize
        )
        // Released only after the uncorrelated sweep: its pre-score gate checks every queued account
        // for an existing Fusion link, and without the index each check scans every loaded Fusion account.
        this.run.clearLinkedAccountIndex()
        this.run.resetManagedAccountProcessing()
        return { processed, matchScoringMs: this.run.matchScoringMs }
    }

    /**
     * Records conflicting correlated Fusion accounts and logs warning guidance.
     */
    public setFusionAccount(fusionAccount: FusionAccount): void {
        this.accountAssembly.registerFusionAccount(fusionAccount)
    }

    public buildFusionBlend(fusionAccount: FusionAccount, account: Account): FusionReportBlend {
        const sourceName = account.sourceName ?? ''
        const nativeIdentity = trimStr(account.nativeIdentity) ?? ''
        const blendedAccountName = trimStr(account.name) || nativeIdentity || account.id || ''
        const blendedAccountId = resolveManagedAccountIscIdForReport(
            getManagedAccountKeyFromAccount(account),
            this.sources,
            this.run,
            { storedIscAccountId: account.id }
        )
        return {
            accountName: fusionAccount.name ?? fusionAccount.identityId ?? 'Unknown',
            accountUrl: fusionAccount.identityId ? this.urlContext.identity(fusionAccount.identityId) : undefined,
            blendedAccountName,
            blendedAccountUrl: blendedAccountId
                ? this.urlContext.accountManagement(blendedAccountId, account.isMachine === true)
                : undefined,
            blendedSource: sourceName,
        }
    }

    /**
     * Retrieves a fusion account by its managedKey (unique key).
     *
     * @param managedKey - The managedKey string to look up
     * @returns The fusion account, or undefined if not found
     */
    public getFusionAccountByManagedKey(managedKey: string): FusionAccount | undefined {
        return this.run.getFusionAccountByManagedKey(managedKey)
    }

    /**
     * Generate a fusion report with all accounts that have matches.
     *
     * Memory Optimization:
     * After generating the report, this method clears the tracker to free memory.
     * Callers that build an additional report from the same tracker afterwards must
     * pass `clearTracker: false` so the later build still sees the match accounts.
     *
     * @param tracker - The AggregationTracker instance to build the report from
     * @param includeNonMatches - When true, append per-account rows for managed non-matches. Email reports omit these.
     * @param stats - Optional processing statistics to include in the report
     * @param options - `clearTracker` (default true) controls tracker reset after the build
     * @returns Complete fusion report with match/non-match accounts
     */
    public generateReport(
        tracker: AggregationTracker,
        includeNonMatches: boolean = false,
        stats?: FusionReportStats,
        options?: { clearTracker?: boolean }
    ): FusionReport {
        const report = buildFusionReport(
            {
                conflictingFusionIdentityAccounts: tracker.conflictingFusionIdentityAccounts,
                matchAccounts: tracker.matchAccounts,
                failedMatchingAccounts: tracker.failedMatchingAccounts,
                deferredMatchReportData: tracker.deferredMatchReportData,
                analyzedNonMatchReportData: tracker.analyzedNonMatchReportData,
                newManagedAccountsCount: tracker.newManagedAccountsCount,
                urlContext: this.urlContext,
                sourcesByName: this.run.sourcesByName,
                reportAttributes: this.reportAttributes,
                fusionIdentityComparisonsByAccount: tracker.fusionIdentityComparisonsByAccount,
                sources: this.sources,
                fusionEnableAutoMerge: this.config.fusionEnableAutoMerge,
                fusionAutoMergeScore: this.config.fusionAutoMergeScore,
                fusionMaxCandidatesForForm: this.config.fusionMaxCandidatesForForm,
            },
            includeNonMatches,
            stats
        )

        if (tracker.fusionBlends.length > 0) {
            report.fusionBlends = [...tracker.fusionBlends]
        }

        if (this.run.deletedFusionReviewForms.length > 0) {
            report.fusionReviewDeletions = this.run.deletedFusionReviewForms.map((entry) => ({ ...entry }))
        }

        if (options?.clearTracker ?? true) {
            tracker.clear()
        }

        return report
    }

    /**
     * Builds matching-results snapshot for record mode without clearing the tracker.
     */
    public buildMatchingResultsSnapshot(
        tracker: AggregationTracker,
        options?: { sweepSummary?: MatchingResultsSweepSummary; stepId?: string; operation?: string }
    ): MatchingResultsSnapshot {
        return buildMatchingResultsSnapshotFromState(
            {
                conflictingFusionIdentityAccounts: tracker.conflictingFusionIdentityAccounts,
                matchAccounts: tracker.matchAccounts,
                failedMatchingAccounts: tracker.failedMatchingAccounts,
                deferredMatchReportData: tracker.deferredMatchReportData,
                analyzedNonMatchReportData: tracker.analyzedNonMatchReportData,
                newManagedAccountsCount: tracker.newManagedAccountsCount,
                urlContext: this.urlContext,
                sourcesByName: this.run.sourcesByName,
                reportAttributes: this.reportAttributes,
                fusionIdentityComparisonsByAccount: tracker.fusionIdentityComparisonsByAccount,
                sources: this.sources,
                fusionEnableAutoMerge: this.config.fusionEnableAutoMerge,
                fusionAutoMergeScore: this.config.fusionAutoMergeScore,
                fusionMaxCandidatesForForm: this.config.fusionMaxCandidatesForForm,
            },
            options
        )
    }
}

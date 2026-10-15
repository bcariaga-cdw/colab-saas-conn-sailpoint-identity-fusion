import { ServiceRegistry } from '../../services/serviceRegistry'
import { PhaseTimer } from '../../services/logService'
import {
    formatDecisionOutcomesSegment,
    formatFormOutcomesSegment,
    formatMatchOutcomesSegment,
} from '../../services/logService/operationHeartbeat'
import { formatCorrelationSummaryValue } from '../../services/logService/operationRunContext'
import { SourceType } from '../../model/config'
import { AggregationTracker } from '../../services/fusionService'
import { generateReport } from './generateReport'
import { buildReportAggregationStats, buildTerminalSummary, DryRunInput, type FetchResult } from './accountListHelpers'
import { sendWithBackpressure } from '../../utils/responseBackpressure'

export type { FetchResult } from './accountListHelpers'

export interface PhaseOptions {
    isPersistent: boolean
    tracker?: AggregationTracker
    streamProgress?: { sent: number }
}

// --- Private helpers ---

async function applyFusionFormsReset(serviceRegistry: ServiceRegistry): Promise<void> {
    const { forms, fusion } = serviceRegistry
    await forms.deleteExistingForms()
    await fusion.disableResetForms()
}

async function applyFusionAccountReset(serviceRegistry: ServiceRegistry): Promise<void> {
    const { fusion, sources } = serviceRegistry
    await sources.removeProcessingAttribute()
    await fusion.disableResetAccounts()
    await fusion.resetState()
    await sources.resetBatchCumulativeCount()
}

function countManagedAccountsByType(sources: ServiceRegistry['sources']) {
    let authoritative = 0,
        record = 0,
        orphan = 0
    for (const account of sources.run.managedAccountsById.values()) {
        const sourceType = sources.getSourceByNameSafe(account.sourceName)?.sourceType ?? SourceType.Authoritative
        if (sourceType === SourceType.Record) record++
        else if (sourceType === SourceType.Orphan) orphan++
        else authoritative++
    }
    return {
        managedAccountsFound: sources.run.managedAccountsById.size,
        managedAccountsFoundAuthoritative: authoritative,
        managedAccountsFoundRecord: record,
        managedAccountsFoundOrphan: orphan,
    }
}

/**
 * Hydrates out-of-scope identities for correlated orphan managed accounts still on the
 * work queue after refresh. Enables {@link FusionAccount.identityAlias} on new Fusion
 * accounts created from those orphans during the correlated account sweep.
 */
export async function hydrateCorrelatedManagedAccountIdentities(deps: {
    managedAccounts: Iterable<{ identityId?: string; uncorrelated?: boolean }>
    hydrateMissingIdentitiesById: (ids: string[]) => Promise<void>
}): Promise<{ hydrated: number }> {
    const distinctIds = new Set<string>()
    for (const managed of deps.managedAccounts) {
        if (managed.uncorrelated !== false) continue
        const id = managed.identityId
        if (id) distinctIds.add(id)
    }
    if (distinctIds.size === 0) return { hydrated: 0 }

    await deps.hydrateMissingIdentitiesById(Array.from(distinctIds))
    return { hydrated: distinctIds.size }
}

// --- Phase 1: Setup ---

export async function setupPhase(
    serviceRegistry: ServiceRegistry,
    schema: any,
    options: PhaseOptions
): Promise<boolean> {
    const { log, fusion, schemas, sources, definition, config } = serviceRegistry
    const { isPersistent, tracker } = options
    const forceAttributeRefresh = isPersistent && config.forceAttributeRefresh

    if (tracker) fusion.setTracker(tracker)

    await sources.fetchAllSources(isPersistent)
    log.detail({ sources: sources.managedSources.length })
    if (!sources.hasFusionSource) {
        throw new Error(
            'Fusion source not found. The connector instance could not locate its own source in ISC. Verify the connector is properly deployed.'
        )
    }

    const resetAccounts = fusion.isResetAccounts()
    if (isPersistent && !resetAccounts) await sources.setProcessLock()

    if (isPersistent && fusion.isResetForms()) {
        log.detail({ action: 'reset forms flag detected, deleting fusion review forms' })
        await applyFusionFormsReset(serviceRegistry)
    }

    if (resetAccounts) {
        log.detail({ action: 'reset accounts flag detected, clearing state and exiting' })
        if (isPersistent) await applyFusionAccountReset(serviceRegistry)
        return false
    }

    if (forceAttributeRefresh) {
        log.detail({ action: 'force attribute refresh flag detected, disabling flag for next run' })
        await fusion.disableForceAttributeRefresh()
    }

    if (schema) {
        await schemas.setFusionAccountSchema(schema)
    } else {
        await schemas.loadFusionAccountSchemaFromSource()
        log.detail({ action: 'input schema not provided; loaded fusion account schema from source' })
    }
    log.detail({ action: 'fusion account schema set successfully' })

    sources.clearReverseCorrelationReadinessCache()
    const reverseCorrelationOp = log.track('reverseCorrelationSetup')
    const schemaAttrNames = await schemas.getManagedSourceSchemaAttributeNames()
    const reverseCorrelationCount = await sources.setupReverseCorrelationSources(schemaAttrNames)
    if (reverseCorrelationCount > 0) {
        await schemas.setFusionAccountSchema(undefined)
        log.debug('Fusion account schema refreshed after reverse correlation setup')
        log.detail({ action: 'reverse correlation setup completed', sources: reverseCorrelationCount })
        reverseCorrelationOp.done({ sources: reverseCorrelationCount })
    }
    const aggregateManagedSourcesOp = log.track('aggregateManagedSources')
    await sources.aggregateManagedSources()
    log.detail({ action: 'managed sources aggregated' })
    aggregateManagedSourcesOp.done({ sources: sources.managedSources.length })

    await definition.initializeCounters()
    log.detail({ action: 'attribute counters initialized' })
    return true
}

// --- Phase 2: Fetch ---

export async function fetchPhase(serviceRegistry: ServiceRegistry, options: PhaseOptions): Promise<FetchResult> {
    const { log, identities, sources, forms, fusion, workflows } = serviceRegistry
    const { isPersistent } = options
    // Global reviewers must be hydrated during dry-run too so reviewer validation succeeds.
    // Report-on-aggregation owners are only needed for persistent runs (email delivery).
    const ownerIncluded = fusion.fusionOwnerIsGlobalReviewer || (isPersistent && fusion.fusionReportOnAggregation)

    log.detail({ action: 'fetching identities, managed accounts, and dependencies' })

    const ownerIdsPromise = ownerIncluded ? sources.fetchGlobalOwnerIdentityIds() : Promise.resolve([])

    const fetchTasks: Array<Promise<void>> = [
        ownerIdsPromise.then(async (ownerIds) => {
            fusion.cacheGlobalOwnerIdentityIds(ownerIds)
            await identities.fetchIdentities(ownerIds)
        }),
        sources.fetchManagedAccounts(),
        sources.fetchFusionAccounts(),
        forms.fetchFormInstances({ staleFormCleanup: isPersistent }),
    ]
    if (isPersistent && sources.delayedAggregationSources?.length) {
        fetchTasks.push(workflows.fetchDelayedAggregationSender())
    }

    const fetchAllOp = log.track('fetchPhase.parallelFetch')
    await Promise.all(fetchTasks)
    fetchAllOp.done({ taskCount: fetchTasks.length })

    log.detail({ action: 'processing fetched form data' })
    const processFormDataOp = log.track('fetchPhase.processFormData')
    await forms.processFetchedFormData()
    processFormDataOp.done()
    log.detail({
        'fusion-reviews': forms.formsFound,
        'fusion-review-instances': forms.formInstancesFound,
    })

    const counts = countManagedAccountsByType(sources)
    log.detail({
        'fusion-accounts': sources.fusionAccountCount,
        identities: identities.identityCount,
        'managed-accounts': counts.managedAccountsFound,
    })
    return { ...counts, identitiesFound: identities.identityCount }
}

// --- Phase 3: Refresh ---

export async function refreshPhase(serviceRegistry: ServiceRegistry): Promise<void> {
    const { log, fusion } = serviceRegistry
    const ctx = log.getRunContext()
    if (ctx && ctx.phase !== 'Refresh') {
        ctx.phase = 'Refresh'
    }
    log.resetRefreshMetrics()
    log.detail({ action: 'refreshing fusion accounts' })
    await fusion.ensureGlobalReviewerOwnersInScope()
    const refreshOp = log.track('refreshPhase.processFusionAccounts')
    const processedFusionAccounts = await fusion.processFusionAccounts()
    refreshOp.done({ count: processedFusionAccounts.length })
    const summary = log.flushRefreshMetricsSummary()
    if (summary) {
        log.detail({ action: 'refresh workload', ...summary })
    }
    log.detail({ action: 'refresh phase complete' })
}

// --- Phase 4: Process ---

export async function processPhase(serviceRegistry: ServiceRegistry, _options: PhaseOptions): Promise<void> {
    const { log, fusion, identities, sources, forms } = serviceRegistry

    await log.runStep('process-identities', () => fusion.processIdentities(), {
        track: 'FusionService.processIdentities',
        trackDone: () => ({ count: identities.identityCount }),
        endDetail: () => ({ count: identities.identityCount }),
    })

    await log.runStep('process-decisions', () => fusion.processFusionIdentityDecisions(), {
        track: 'FusionService.processFusionIdentityDecisions',
        trackDone: (decisions) => ({ count: decisions.length }),
        endDetail: (decisions) => ({ count: decisions.length }),
    })

    if (!sources.run.isRecordMode) {
        identities.clear()
        log.detail({ action: 'identities cache cleared from memory' })
    } else {
        log.detail({ cache: 'identities retained for recording' })
    }

    await log.runStep('managed-account-init', () => fusion.initializeManagedAccountProcessing(), {
        track: 'FusionService.initializeManagedAccountProcessing',
        endDetail: { remaining: sources.run.managedAccountsById.size },
    })

    await log.runStep(
        'orphan-identity-hydration',
        async () => {
            const hydrationResult = await hydrateCorrelatedManagedAccountIdentities({
                managedAccounts: sources.run.managedAccountsById.values(),
                hydrateMissingIdentitiesById: (ids) => identities.hydrateMissingIdentitiesById(ids),
            })
            log.detail({ hydrated: hydrationResult.hydrated, action: 'orphan correlated identities hydrated' })
            return hydrationResult
        },
        { endDetail: (result) => ({ hydrated: result.hydrated }) }
    )

    await log.runStep('correlated-sweep', () => fusion.processCorrelatedManagedAccounts(), {
        endDetail: { remaining: sources.run.managedAccountsById.size },
    })

    await log.runStep('record-unique-registration', () => fusion.processRecordUniqueRegistration(), {
        track: 'FusionService.processRecordUniqueRegistration',
        trackDone: (result) => ({ registered: result.registered }),
        endDetail: (result) => ({ registered: result.registered }),
    })

    const uncorrelatedCount = sources.run.managedAccountsById.size
    await log.runStep('uncorrelated-sweep', () => fusion.processUncorrelatedManagedAccounts(), {
        startDetail: { accounts: uncorrelatedCount },
        track: 'FusionService.processManagedAccounts',
        trackDone: ({ processed, matchScoringMs }) => ({
            analyzed: processed,
            matchScoring: PhaseTimer.formatElapsed(matchScoringMs),
        }),
        endDetail: ({ processed }) => ({ analyzed: processed }),
    })

    if (sources.run.mandatoryMissingBlockCount > 0) {
        log.warn(
            `Mandatory missing block: ${sources.run.mandatoryMissingBlockCount} account(s) — scored zero identity candidates (missing indexed mandatory attributes)`
        )
    }
    if (sources.run.fullScanFallbackCount > 0) {
        log.warn(
            `Full identity scan fallback: ${sources.run.fullScanFallbackCount} account(s) — ` +
                'candidate blocking unavailable; scored the Fusion identity baseline'
        )
    }
    if (sources.run.identityComparisonCount > 0 || sources.run.identityCandidateSetSizeSum > 0) {
        log.info(
            `Identity comparison summary: identityComparisonCount=${sources.run.identityComparisonCount} ` +
                `identityCandidateSetSizeSum=${sources.run.identityCandidateSetSizeSum}`
        )
    }

    await log.runStep('await-disable-ops', () => fusion.awaitPendingDisableOperations(), {
        startDetail: { pending: fusion.run.pendingDisableOperationsCount },
    })

    await log.runStep('form-reconcile', async () => fusion.reconcilePendingFormState(), {
        endDetail: {
            'forms-created': forms.formsCreated,
            'instances-sent': forms.formInstancesCreated,
        },
    })

    const matchOutcomes = formatMatchOutcomesSegment(log.getCumulativeOutcomes(), true)
    const decisionOutcomes = formatDecisionOutcomesSegment(log.getCumulativeOutcomes(), true)
    const formOutcomes = formatFormOutcomesSegment(forms.formsCreated, forms.formInstancesCreated)
    const phaseCorrelation = log.getRunContext()?.getPhaseCorrelationCounters()
    const correlationSegment = phaseCorrelation
        ? formatCorrelationSummaryValue(phaseCorrelation, { cumulative: true })
        : ''
    log.detail({
        action: 'process phase complete',
        matches: matchOutcomes,
        decisions: decisionOutcomes,
        forms: formOutcomes,
        ...(correlationSegment ? { correlations: correlationSegment } : {}),
    })
}

// --- Phase 5: Output ---

export async function outputPhase(serviceRegistry: ServiceRegistry, options: PhaseOptions): Promise<number> {
    const { log, fusion, forms, sources, definition, workflows, res } = serviceRegistry
    const { isPersistent } = options

    if (!sources.run.isRecordMode) {
        const managedAccountCount = sources.run.managedAccountsById.size
        await log.runStep(
            'clear-managed-accounts',
            async () => {
                sources.clearManagedAccounts()
            },
            {
                startDetail: { accounts: managedAccountCount },
                track: 'outputPhase.clearManagedAccounts',
                endDetail: { cleared: managedAccountCount },
            }
        )
    } else {
        log.detail({ cache: 'managed accounts retained for recording' })
    }

    const { sent } = await log.runStep(
        'send-accounts',
        () =>
            fusion.forEachISCAccount(async (account) => {
                await sendWithBackpressure(res, account)
                if (options.streamProgress) options.streamProgress.sent++
            }, true),
        {
            track: 'outputPhase.sendAccounts',
            trackDone: (result) => ({ sent: result.sent, eligible: result.eligible }),
            endDetail: (result) => ({ sent: result.sent, eligible: result.eligible }),
        }
    )
    log.detail({ sent, action: 'accounts sent to platform' })

    if (!isPersistent) {
        return sent
    }

    await log.runStep('form-cleanup', () => forms.cleanUpForms(), {
        track: 'outputPhase.formCleanup',
    })

    await log.runStep(
        'save-state',
        async () => {
            await definition.saveState()
            await sources.saveBatchCumulativeCount()
        },
        { track: 'outputPhase.savePersistentState' }
    )

    await log.runStep(
        'schedule-aggregations',
        () => sources.aggregateDelayedSources((params) => workflows.scheduleDelayedAggregation(params)),
        { track: 'outputPhase.scheduleDelayedAggregations' }
    )

    await log.runStep('await-form-deletes', () => forms.awaitPendingDeleteOperations())
    log.detail({ action: 'queued form deletions completed' })
    return sent
}

// --- Epilogue ---

interface ReportEpilogueOptions {
    isPersistent: boolean
    dryRun?: DryRunInput
    fetchResult?: FetchResult
    outputCount?: number
    timer: ReturnType<ServiceRegistry['log']['timer']>
    runError?: unknown
}

async function recordMatchingResultsSnapshot(
    serviceRegistry: ServiceRegistry,
    fetchResult: FetchResult | undefined,
    isPersistent: boolean
): Promise<void> {
    const { log, fusion, recording } = serviceRegistry
    if (!recording || !isPersistent) return

    const tracker = fusion.run.getTracker()
    if (!tracker) return

    try {
        const outcomes = log.getCumulativeOutcomes()
        const sweepSummary = {
            processed: fetchResult?.managedAccountsFound,
            exact: outcomes.autoMerged,
            partial: outcomes.formsQueued,
            deferred: outcomes.deferred,
            nonMatch: outcomes.nonMatch,
        }
        const stepId = recording.getCurrentStepId()
        const snapshot = fusion.buildMatchingResultsSnapshot(tracker, {
            sweepSummary,
            stepId,
            operation: 'accountList',
        })
        recording.writeMatchingResults(snapshot)
    } catch (error) {
        log.warn(`Report epilogue: matching results recording failed: ${(error as Error).message}`)
    }
}

async function generateAggregationReportEpilogue(
    serviceRegistry: ServiceRegistry,
    fetchResult: FetchResult,
    timer: ReportEpilogueOptions['timer'],
    outputCount: number | undefined,
    isPersistent: boolean
): Promise<void> {
    const { log, reports, fusion, recording } = serviceRegistry
    if (!isPersistent || !fusion.fusionReportOnAggregation) return

    try {
        log.detail({ action: 'generating aggregation report' })
        const reportOp = log.track('reportPhase.generateReport')
        const aggregationStats = buildReportAggregationStats(
            fetchResult,
            timer,
            serviceRegistry.identities,
            outputCount
        )
        if (recording) {
            const stepId = recording.getCurrentStepId()
            const snapshot = await reports.buildAggregationReportSnapshot(true, aggregationStats)
            recording.writeAggregationReport(snapshot, stepId)
        }
        await generateReport(false, serviceRegistry, aggregationStats)
        reportOp.done()
    } catch (error) {
        log.warn(`Report epilogue: aggregation report failed: ${(error as Error).message}`)
    }
}

async function generateDryRunReportEpilogue(
    serviceRegistry: ServiceRegistry,
    dryRun: DryRunInput,
    fetchResult: FetchResult,
    timer: ReportEpilogueOptions['timer'],
    outputCount: number | undefined
): Promise<string | undefined> {
    const { log, reports } = serviceRegistry
    if (!dryRun.saveFile && !dryRun.sendEmail) return undefined

    try {
        const reportPhaseStartedAt = Date.now()
        const { reportHtmlOutputPath } = await reports.generateDryRunReport({
            aggregationStats: buildReportAggregationStats(fetchResult, timer, serviceRegistry.identities, outputCount),
            reportPhaseStartedAt,
            saveFile: dryRun.saveFile,
            sendEmail: dryRun.sendEmail,
        })
        if (reportHtmlOutputPath) {
            log.detail({ action: 'dry-run HTML report written', path: reportHtmlOutputPath })
        }
        return reportHtmlOutputPath
    } catch (error) {
        log.warn(`Report epilogue: dry-run report failed: ${(error as Error).message}`)
        return undefined
    }
}

function logDryRunRunSummary(
    serviceRegistry: ServiceRegistry,
    dryRun: DryRunInput,
    fetchResult: FetchResult,
    timer: ReportEpilogueOptions['timer'],
    outputCount: number | undefined,
    reportHtmlOutputPath?: string
): void {
    const summary = buildTerminalSummary(
        serviceRegistry,
        { outputCount, fetchResult, timer },
        dryRun,
        reportHtmlOutputPath
    )
    console.log(JSON.stringify(summary, null, 2))
}

export async function reportEpilogue(
    serviceRegistry: ServiceRegistry,
    options: ReportEpilogueOptions
): Promise<unknown | undefined> {
    const { log } = serviceRegistry
    const { isPersistent, dryRun, fetchResult, outputCount, timer } = options

    log.epilogueStart('report')
    const epilogueStartedAt = log.getRunContext()?.epilogueStartedAt ?? Date.now()

    await recordMatchingResultsSnapshot(serviceRegistry, fetchResult, isPersistent)

    if (fetchResult) {
        await generateAggregationReportEpilogue(serviceRegistry, fetchResult, timer, outputCount, isPersistent)
    }

    if (dryRun && fetchResult) {
        const reportHtmlOutputPath = await generateDryRunReportEpilogue(
            serviceRegistry,
            dryRun,
            fetchResult,
            timer,
            outputCount
        )
        logDryRunRunSummary(serviceRegistry, dryRun, fetchResult, timer, outputCount, reportHtmlOutputPath)
    }

    timer.recordElapsed('Report', Date.now() - epilogueStartedAt)
    log.epilogueEnd('report')
    return undefined
}

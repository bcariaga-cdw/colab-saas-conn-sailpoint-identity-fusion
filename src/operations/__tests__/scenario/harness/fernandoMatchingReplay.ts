import * as fs from 'fs'
import * as path from 'path'
import { StandardCommand } from '@sailpoint/connector-sdk'
import { AccountV2025 as Account } from 'sailpoint-api-client'
import { FusionAccount } from '../../../../model/account'
import { FusionConfig, SourceType } from '../../../../model/config'
import { FusionRun, toManagedAccountInfo } from '../../../../model/fusionRun'
import { AggregationTracker } from '../../../../model/aggregationTracker'
import { AccountAssembly } from '../../../../services/accountAssembly'
import { MatchingService } from '../../../../services/matchingService/matchingService'
import { MatchOutcomeDispatcher } from '../../../../services/matchingService/matchOutcomeDispatcher'
import { ManagedAccountAnalysisRecorder } from '../../../../services/fusionService/managedAccountAnalysisRecorder'
import { MappingService } from '../../../../services/mappingService/mappingService'
import { DefinitionService } from '../../../../services/definitionService/definitionService'
import { createUrlContext } from '../../../../utils/url'
import { readSettings as readMatchingSettings } from '../../../../data/config/settings/matchingSettings'
import { readSettings as readAttributeMappingSettings } from '../../../../data/config/settings/attributeMappingDefinitionsSettings'
import { readSettings as readNormalAttributeSettings } from '../../../../data/config/settings/normalAttributeDefinitionsSettings'
import { getInternalConfigFlat } from '../../../../data/config/internal'
import type { MatchingResultsSnapshot } from '../../../../services/recordingService/matchingResultsSnapshot'
import { buildMatchingResultsSnapshot } from '../../../../services/fusionService/fusionReportBuilder'
import { recordingScenarioDir } from '../../../../data/recordingPaths'

export const FERNANDO_SCENARIO_REF = 'company12926-poc/fernando'
const SOURCE_ID = 'fe0b4096bb02418e8225a54806f9b86f'
const SOURCE_NAME = 'Umbrella Corporation'
const REVIEWER_IDENTITY_ID = 'reviewer-identity-id'

function fernandoRecordingDir(): string {
    return recordingScenarioDir(FERNANDO_SCENARIO_REF)
}

export function isFernandoRecordingAvailable(): boolean {
    const dir = fernandoRecordingDir()
    return fs.existsSync(path.join(dir, 'scenario.json')) && fs.existsSync(path.join(dir, 'api-log.ndjson'))
}

function loadFernandoScenarioConfig(): FusionConfig {
    const scenario = JSON.parse(fs.readFileSync(path.join(fernandoRecordingDir(), 'scenario.json'), 'utf8'))
    const raw = { ...scenario.config, ...getInternalConfigFlat() }
    const matching = readMatchingSettings(raw)
    const attributeMaps = readAttributeMappingSettings(raw)
    const normalAttributes = readNormalAttributeSettings(raw)
    return Object.assign({}, raw, matching, attributeMaps, normalAttributes) as FusionConfig
}

function loadManagedAccounts(recordingDir: string): Account[] {
    const apiLines = fs
        .readFileSync(path.join(recordingDir, 'api-log.ndjson'), 'utf8')
        .trim()
        .split('\n')
    for (const line of apiLines) {
        const entry = JSON.parse(line)
        if (entry.method === 'listAccounts' && entry.response?.data?.length === 36) {
            return entry.response.data as Account[]
        }
    }
    throw new Error('Could not find 36 managed accounts in api-log')
}

function loadIdentity(recordingDir: string) {
    const steps = fs
        .readFileSync(path.join(recordingDir, 'steps.ndjson'), 'utf8')
        .trim()
        .split('\n')
    return JSON.parse(steps[0]).stateAfter.identities[0]
}

function buildDispatcher(config: FusionConfig) {
    FusionAccount.configure(config)

    const log = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        crash: vi.fn(),
        assert: vi.fn(),
        detail: vi.fn(),
        recordEvent: vi.fn(),
        getLogLevel: vi.fn().mockReturnValue('info'),
        setProgress: vi.fn(),
    } as any

    const run = new FusionRun(log, config)
    run.sourcesByName.set(SOURCE_NAME, {
        id: SOURCE_ID,
        name: SOURCE_NAME,
        isManaged: true,
        sourceType: SourceType.Authoritative,
        config: { deferredMatching: true },
    } as any)

    // Mirrors FusionService.setReviewerForSource: without a reviewer the manual review path is
    // unavailable and every deferred match is demoted to an authoritative non-match.
    run.reviewersBySourceId.set(SOURCE_ID, new Set([{ identityId: REVIEWER_IDENTITY_ID } as any]))

    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mappingService = new MappingService(config, log)
    const definitionService = new DefinitionService(config, mockSchemas, log, mockLocks)
    const matchingService = new MatchingService(config, log, run)
    const sources = {
        managedAccountInventory: run.managedAccountInventory,
        resolveIscAccountIdForManagedKey: vi.fn((key: string) => key),
    } as any
    const tracker = new AggregationTracker()

    const accountAssembly = new AccountAssembly({
        run,
        sources,
        mappingService,
        definitionService,
        log,
        config,
        commandType: StandardCommand.StdAccountList,
        getTracker: () => tracker,
    })

    run.analysisRecorder = new ManagedAccountAnalysisRecorder({
        log,
        tracker: () => tracker,
        urlContext: createUrlContext(config.baseurl ?? 'https://example.identitynow.com'),
        reportAttributes: config.fusionFormAttributes ?? [],
        sourcesByName: run.sourcesByName,
        config,
        sources,
        run,
        shouldCaptureReportData: () => true,
    })

    const dispatcher = new MatchOutcomeDispatcher({
        config,
        log,
        run,
        matchingService,
        correlationManager: { applyPerSourceCorrelationIfNeeded: vi.fn().mockResolvedValue(undefined) } as any,
        definitionService,
        mappingService,
        accountAssembly,
        forms: {
            createFusionForm: vi.fn(),
            registerFinishedDecision: vi.fn(),
            createAutomaticMergeDecision: vi.fn(),
        } as any,
        decisionProcessor: { processFusionIdentityDecision: vi.fn() },
        commandType: StandardCommand.StdAccountList,
    })

    return { dispatcher, run, tracker, log, sources }
}

/** Replays step-10 deferred matching from api-log and returns a recording snapshot. */
export async function buildFernandoStep10MatchingSnapshot(): Promise<MatchingResultsSnapshot> {
    const recordingDir = fernandoRecordingDir()
    const config = loadFernandoScenarioConfig()
    const accounts = loadManagedAccounts(recordingDir)
    const identity = loadIdentity(recordingDir)
    const { dispatcher, run, tracker, sources } = buildDispatcher(config)

    const fusionIdentity = FusionAccount.fromIdentity(identity)
    await run.registerFusionAccount(fusionIdentity)

    for (const account of accounts) {
        const key = `${account.sourceId}::${account.nativeIdentity}`
        run.managedAccountsById.set(key, account)
        run.managedAccountInventory.set(key, toManagedAccountInfo(account))
    }

    const result = await dispatcher.runMatchSweep(accounts, config.managedAccountsBatchSize ?? 50)

    return buildMatchingResultsSnapshot(
        {
            conflictingFusionIdentityAccounts: tracker.conflictingFusionIdentityAccounts,
            matchAccounts: tracker.matchAccounts,
            failedMatchingAccounts: tracker.failedMatchingAccounts,
            deferredMatchReportData: tracker.deferredMatchReportData,
            analyzedNonMatchReportData: tracker.analyzedNonMatchReportData,
            newManagedAccountsCount: tracker.newManagedAccountsCount,
            urlContext: createUrlContext(config.baseurl ?? 'https://example.identitynow.com'),
            sourcesByName: run.sourcesByName,
            reportAttributes: config.fusionFormAttributes ?? [],
            fusionIdentityComparisonsByAccount: tracker.fusionIdentityComparisonsByAccount,
            sources,
            fusionEnableAutoMerge: config.fusionEnableAutoMerge,
            fusionAutoMergeScore: config.fusionAutoMergeScore,
            fusionMaxCandidatesForForm: config.fusionMaxCandidatesForForm,
        },
        {
            stepId: 'step-10',
            operation: 'accountList',
            sweepSummary: {
                processed: result.processed,
                exact: result.exact,
                partial: result.partial,
                deferred: result.deferred,
                nonMatch: result.nonMatch,
            },
        }
    )
}


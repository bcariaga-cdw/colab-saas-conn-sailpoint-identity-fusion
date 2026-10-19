import * as fs from 'fs'
import * as path from 'path'
import { LogService } from './logService'
import { FusionRun } from '../model/fusionRun'
import { FusionConfig, RecordingConfig } from '../model/config'
import { ApiLogEntry } from './clientService/recordingApiAdapter'
import { forEachNdjsonLine } from '../utils/ndjson'
import { sanitizeForJson } from '../utils/sanitizeForJson'
import type { MatchingResultsSnapshot } from './recordingService/matchingResultsSnapshot'
import {
    loadAggregationReportRecording,
    loadMatchingResultsRecording,
    type AggregationReportRecording,
    type MatchingResultsRecording,
} from './recordingService/reportArtifacts'
import { parseRecordingChainRef, recordingCacheKey } from '../data/recordingPaths'
import {
    getOrCreateRecordingStore,
    RecordingManifest,
    RecordingStore,
    clearRecordingStoreCache,
} from './recordingService/recordingStore'
import { allocateStepIndex, bootstrapStepCounter } from './recordingService/recordingStepCounter'

interface RecordedStep {
    stepId: string
    operation: string
    sweep?: number
    input: unknown
    output: unknown[]
    stateAfter: any
    timestamp: string
    duration: number
}

export interface PhaseRecord {
    phaseNumber: number
    phase: string
    detail?: Record<string, unknown>
    elapsedMs?: number
    timestamp: string
    managedAccounts?: number
    fusionAccounts?: number
    apiCalls?: number
}

const finalizedChains = new Set<string>()
const chainsToFinalize = new Set<string>()
const chainConfigs = new Map<string, FusionConfig>()
const chainLogs = new Map<string, LogService>()
let exitHandlersRegistered = false

function shouldRegisterExitHandlers(): boolean {
    return process.env.VITEST !== 'true' && process.env.VITEST !== '1'
}

async function finalizeAllRecordingChains(): Promise<void> {
    for (const cacheKey of chainsToFinalize) {
        const config = chainConfigs.get(cacheKey)
        const log = chainLogs.get(cacheKey)
        if (config && log) {
            const chainName = config.recording?.chainName ?? cacheKey
            await finalizeRecordingChain(chainName, config, log)
        }
    }
}

async function shutdownRecordingHandler(exitCode?: number): Promise<void> {
    await finalizeAllRecordingChains()
    if (exitCode !== undefined) {
        process.exit(exitCode)
    }
}

function registerExitHandlersOnce(): void {
    if (exitHandlersRegistered || !shouldRegisterExitHandlers()) return
    exitHandlersRegistered = true

    process.on('SIGINT', () => void shutdownRecordingHandler(0))
    process.on('SIGTERM', () => void shutdownRecordingHandler(0))
    process.on('beforeExit', () => void shutdownRecordingHandler())
}

function loadStepsFromDisk(store: RecordingStore): RecordedStep[] {
    const stepsFile = path.join(store.getRecordingDir(), 'steps.ndjson')
    if (!fs.existsSync(stepsFile)) return []

    const byId = new Map<string, RecordedStep>()
    forEachNdjsonLine(stepsFile, (line) => {
        try {
            const step = JSON.parse(line) as RecordedStep
            byId.set(step.stepId, step)
        } catch {
            /* skip malformed lines */
        }
    })

    return Array.from(byId.values()).sort((a, b) => {
        const na = parseInt(a.stepId.replace('step-', ''), 10)
        const nb = parseInt(b.stepId.replace('step-', ''), 10)
        return na - nb
    })
}

function buildScenario(scenarioRef: string, config: FusionConfig, store: RecordingStore, steps: RecordedStep[]): Record<string, unknown> {
    const { scenarioName } = parseRecordingChainRef(scenarioRef, config.baseurl)
    const firstStep = steps[0]
    const firstState = firstStep?.stateAfter
    const initialState = firstState
        ? {
              identities: firstState.identities,
              managedAccounts: firstState.managedAccounts,
              fusionAccounts: firstState.fusionAccounts,
              fusionIdentityAccounts: firstState.fusionIdentityAccounts ?? [],
              fusionIdentityDecisions: firstState.fusionIdentityDecisions,
              finishedFusionDecisions: firstState.finishedFusionDecisions ?? [],
          }
        : {
              identities: [],
              managedAccounts: [],
              fusionAccounts: [],
              fusionIdentityAccounts: [],
              fusionIdentityDecisions: [],
              finishedFusionDecisions: [],
          }

    const scenarioSteps = steps.map((step) => ({
        id: step.stepId,
        operation: step.operation,
        sweep: step.sweep,
        description: `Recorded ${step.operation} — ${step.duration}ms, ${step.output.length} outputs`,
        input: step.input as Record<string, unknown>,
        expectedOutput: step.output.length > 0 ? (step.output.length === 1 ? step.output[0] : step.output) : undefined,
        expectedStateDelta: step.stateAfter,
    }))

    const referenceValues: Record<string, Record<string, unknown>> = {}
    for (const step of steps) {
        referenceValues[step.stepId] = {
            outputCount: step.output.length,
            durationMs: step.duration,
            managedAccountsCount: step.stateAfter.managedAccounts.length,
            fusionAccountsCount:
                step.stateAfter.fusionAccounts.length + (step.stateAfter.fusionIdentityAccounts?.length ?? 0),
            identitiesCount: step.stateAfter.identities.length,
            fusionIdentityDecisionsCount: step.stateAfter.fusionIdentityDecisions.length,
            finishedFusionDecisionsCount: step.stateAfter.finishedFusionDecisions?.length ?? 0,
        }
    }

    const matchingResultsPath = path.join(store.getRecordingDir(), 'reports', 'matching-results.json')

    return {
        version: '1.0.0',
        recordedAt: new Date().toISOString(),
        scenarioName,
        chainName: scenarioName,
        config: sanitizeForJson(config),
        initialState,
        steps: scenarioSteps,
        referenceValues,
        apiLogPath: path.relative(process.cwd(), store.getApiLogPath()),
        ...(fs.existsSync(matchingResultsPath)
            ? { matchingResultsPath: path.relative(process.cwd(), matchingResultsPath) }
            : {}),
    }
}

/** Finalizes a chain from on-disk artifacts (one call per chain per process). */
async function finalizeRecordingChain(
    chainName: string,
    config: FusionConfig,
    log: LogService,
    reportsPath?: string
): Promise<string> {
    const chainRef = parseRecordingChainRef(chainName, config.baseurl).chainRef
    const cacheKey = recordingCacheKey(chainName, config.baseurl)
    if (finalizedChains.has(cacheKey)) return ''
    finalizedChains.add(cacheKey)

    const recConfig: RecordingConfig = config.recording ?? { mode: 'off', store: 'ndjson' }
    const store = getOrCreateRecordingStore(recConfig, chainName, config.baseurl)
    await store.flush()

    const dir = store.getRecordingDir()
    fs.mkdirSync(dir, { recursive: true })

    const steps = loadStepsFromDisk(store)
    const matchingResultsFile = path.join(dir, 'reports', 'matching-results.json')
    const matchingResultsPath = fs.existsSync(matchingResultsFile)
        ? path.relative(process.cwd(), matchingResultsFile)
        : undefined
    const scenario = buildScenario(chainRef, config, store, steps)
    const scenarioPath = path.join(dir, 'scenario.json')
    fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2) + '\n')

    const apiLogPath = store.getApiLogPath()
    const stepsPath = path.join(dir, 'steps.ndjson')
    const phasesPath = path.join(dir, 'phases.ndjson')
    const artifactPaths = [
        path.relative(process.cwd(), scenarioPath),
        path.relative(process.cwd(), apiLogPath),
        path.relative(process.cwd(), stepsPath),
    ]
    if (fs.existsSync(phasesPath)) {
        artifactPaths.push(path.relative(process.cwd(), phasesPath))
    }
    if (reportsPath) {
        artifactPaths.push(path.relative(process.cwd(), reportsPath))
    }
    if (matchingResultsPath) {
        artifactPaths.push(matchingResultsPath)
    }

    const manifest: RecordingManifest = {
        version: '1.0.0',
        store: recConfig.store ?? 'ndjson',
        chainName: chainRef,
        scenarioName: chainRef,
        recordedAt: new Date().toISOString(),
        apiLogPath: path.relative(process.cwd(), apiLogPath),
        apiLogEntryCount: store.getApiLogEntryCount(),
        stepsPath: path.relative(process.cwd(), stepsPath),
        stepCount: steps.length,
        phasesPath: fs.existsSync(phasesPath) ? path.relative(process.cwd(), phasesPath) : undefined,
        phaseCount: store.getPhaseCount(),
        scenarioPath: path.relative(process.cwd(), scenarioPath),
        reportsPath: reportsPath ? path.relative(process.cwd(), reportsPath) : undefined,
        matchingResultsPath,
        artifactPaths,
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    store.close()

    log.info(`Recording "${chainRef}" finalized — ${steps.length} steps, ${manifest.apiLogEntryCount} api-log entries → ${scenarioPath}`)
    return scenarioPath
}

/** Captures ISC API calls and operation steps for chain replay scenarios. */
export class RecordingService {
    private readonly chainName: string
    private readonly store: RecordingStore
    private readonly steps: RecordedStep[] = []
    private currentStep: RecordedStep | null = null

    constructor(
        private readonly log: LogService,
        private readonly config: FusionConfig
    ) {
        const recConfig: RecordingConfig = config.recording ?? { mode: 'off', store: 'ndjson' }
        this.chainName = recConfig.scenarioName ?? recConfig.chainName ?? `recording-${Date.now()}`
        this.store = getOrCreateRecordingStore(recConfig, this.chainName, config.baseurl)
        this.log.info(`RecordingService initialized — scenario "${this.chainName}"`)

        const stepsFile = path.join(this.store.getRecordingDir(), 'steps.ndjson')
        bootstrapStepCounter(this.store.getRecordingDir(), stepsFile)

        const cacheKey = recordingCacheKey(this.chainName, config.baseurl)
        chainsToFinalize.add(cacheKey)
        chainConfigs.set(cacheKey, config)
        chainLogs.set(cacheKey, log)
        registerExitHandlersOnce()
    }

    getStore(): RecordingStore {
        return this.store
    }

    getName(): string {
        return this.chainName
    }

    getRecordingDir(): string {
        return this.store.getRecordingDir()
    }

    onApiCall(entry: ApiLogEntry): void {
        this.store.appendApiCall(entry)
    }

    recordPhaseEnd(record: PhaseRecord): void {
        this.store.append('phases', record)
    }

    writeAggregationReport(report: unknown, stepId?: string): void {
        const reportsDir = path.join(this.store.getRecordingDir(), 'reports')
        fs.mkdirSync(reportsDir, { recursive: true })
        const reportPath = path.join(reportsDir, 'aggregation.json')
        const existing = fs.existsSync(reportPath)
            ? loadAggregationReportRecording(JSON.parse(fs.readFileSync(reportPath, 'utf-8')))
            : { version: '1.1.0' as const, runs: [] }
        const recording: AggregationReportRecording = {
            version: '1.1.0',
            runs: [
                ...existing.runs.filter((run) => run.stepId !== stepId),
                {
                    stepId,
                    recordedAt: new Date().toISOString(),
                    report: report as Record<string, unknown>,
                },
            ],
        }
        fs.writeFileSync(reportPath, JSON.stringify(sanitizeForJson(recording), null, 2) + '\n')
    }

    writeMatchingResults(snapshot: MatchingResultsSnapshot): string {
        const reportsDir = path.join(this.store.getRecordingDir(), 'reports')
        fs.mkdirSync(reportsDir, { recursive: true })
        const reportPath = path.join(reportsDir, 'matching-results.json')
        const existing = fs.existsSync(reportPath)
            ? loadMatchingResultsRecording(JSON.parse(fs.readFileSync(reportPath, 'utf-8')))
            : { version: '1.1.0' as const, runs: [] }
        const recording: MatchingResultsRecording = {
            version: '1.1.0',
            runs: [
                ...existing.runs.filter((run) => run.stepId !== snapshot.stepId),
                snapshot,
            ],
        }
        fs.writeFileSync(reportPath, JSON.stringify(sanitizeForJson(recording), null, 2) + '\n')
        return reportPath
    }

    getCurrentStepId(): string | undefined {
        return this.currentStep?.stepId
    }

    getStepCount(): number {
        return this.steps.length
    }

    getSteps(): RecordedStep[] {
        return [...this.steps]
    }

    startOperation(
        operation: string,
        input: unknown,
        res: { send: (value: unknown) => void },
        run: FusionRun
    ): void {
        const stepIndex = allocateStepIndex(this.store.getRecordingDir())
        this.currentStep = {
            stepId: `step-${stepIndex}`,
            operation,
            sweep: operation === 'accountList' ? stepIndex : undefined,
            input: sanitizeForJson(input),
            output: [],
            stateAfter: run.snapshot() as any,
            timestamp: new Date().toISOString(),
            duration: 0,
        }

        const originalSend = res.send.bind(res)
        res.send = (value: unknown) => {
            this.currentStep?.output.push(sanitizeForJson(value))
            originalSend(value)
        }

        this.log.debug(`Recording step ${stepIndex}: ${operation}`)
        if (this.config.recording?.verbose === true) {
            const sweepInfo = this.currentStep.sweep ? ` (sweep ${this.currentStep.sweep})` : ''
            console.log(`[Recording] → ${operation}${sweepInfo} started`)
        }
    }

    endOperation(run: FusionRun): void {
        if (!this.currentStep) return

        this.currentStep.stateAfter = run.snapshot() as any
        this.currentStep.duration = Date.now() - new Date(this.currentStep.timestamp).getTime()
        this.steps.push({ ...this.currentStep })
        this.store.append('steps', this.currentStep)

        this.log.debug(
            `Recorded step ${this.currentStep.stepId} — ${this.currentStep.output.length} output(s), ${this.currentStep.duration}ms`
        )
        if (this.config.recording?.verbose === true) {
            const sweepInfo = this.currentStep.sweep ? ` (sweep ${this.currentStep.sweep})` : ''
            console.log(
                `[Recording] ← ${this.currentStep.operation}${sweepInfo} completed — ${this.currentStep.duration}ms, ${this.currentStep.output.length} outputs`
            )
        }
        this.currentStep = null
    }

    /** Writes scenario.json and manifest.json once per chain; retains steps.ndjson. */
    async finalizeOnce(): Promise<string> {
        const reportsPath = fs.existsSync(path.join(this.store.getRecordingDir(), 'reports', 'aggregation.json'))
            ? path.join(this.store.getRecordingDir(), 'reports', 'aggregation.json')
            : undefined
        return finalizeRecordingChain(this.chainName, this.config, this.log, reportsPath)
    }
}

/** Resets finalize/cache state (for tests). */
export function resetRecordingLifecycleForTests(): void {
    finalizedChains.clear()
    chainsToFinalize.clear()
    chainConfigs.clear()
    chainLogs.clear()
    exitHandlersRegistered = false
    clearRecordingStoreCache()
}







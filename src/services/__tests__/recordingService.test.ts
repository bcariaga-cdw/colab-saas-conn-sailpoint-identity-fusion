import { RecordingService, resetRecordingLifecycleForTests } from '../recordingService'
import { LogService } from '../logService'
import { FusionConfig } from '../../model/config'
import { FusionRun } from '../../model/fusionRun'
import * as fs from 'fs'
import * as path from 'path'
import { NdjsonRecordingStore } from '../recordingService/ndjsonRecordingStore'
import * as os from 'os'
import { allocateStepIndex } from '../recordingService/recordingStepCounter'
import { recordingChainDir } from '../../data/recordingPaths'

describe('RecordingService', () => {
    afterEach(() => {
        resetRecordingLifecycleForTests()
    })

    it('records operation steps via startOperation/endOperation', async () => {
        const log = new LogService({ spConnDebugLoggingEnabled: false })
        const uniqueConfig = {
            recording: { mode: 'record' as const, chainName: `unit-test-chain-${Date.now()}`, store: 'ndjson' as const },
        } as FusionConfig
        const service = new RecordingService(log, uniqueConfig)
        const run = new FusionRun()
        run.log = log
        const sent: unknown[] = []
        const res = { send: (value: unknown) => sent.push(value) }

        service.startOperation('accountList', { dryRun: true }, res, run)
        res.send({ key: 'acct-1' })
        service.endOperation(run)

        expect(service.getStepCount()).toBe(1)
        expect(service.getSteps()[0].output).toEqual([{ key: 'acct-1' }])

        fs.rmSync(service.getRecordingDir(), { recursive: true, force: true })
    })

    it('finalizeOnce writes scenario.json and manifest.json and retains steps.ndjson', async () => {
        const log = new LogService({ spConnDebugLoggingEnabled: false })
        const chainName = `finalize-test-${Date.now()}`
        const config = {
            recording: { mode: 'record' as const, chainName, store: 'ndjson' as const },
        } as FusionConfig
        const service = new RecordingService(log, config)
        const run = new FusionRun(undefined, config)
        run.log = log
        const res = { send: (_value: unknown) => undefined }

        service.startOperation('testConnection', {}, res, run)
        service.endOperation(run)
        service.onApiCall({
            api: 'accounts',
            method: 'listAccounts',
            args: [{ limit: 1 }],
            response: { data: [] },
            timestamp: new Date().toISOString(),
        })
        await service.getStore().flush()

        const scenarioPath = await service.finalizeOnce()
        const dir = service.getRecordingDir()
        const stepsPath = path.join(dir, 'steps.ndjson')
        const manifestPath = path.join(dir, 'manifest.json')
        const apiLogPath = path.join(dir, 'api-log.ndjson')

        expect(scenarioPath).toContain('scenario.json')
        expect(fs.existsSync(stepsPath)).toBe(true)
        expect(fs.existsSync(manifestPath)).toBe(true)
        expect(fs.existsSync(apiLogPath)).toBe(true)

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        expect(manifest.store).toBe('ndjson')
        expect(manifest.apiLogEntryCount).toBe(1)
        expect(manifest.stepCount).toBe(1)

        const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'))
        expect(scenario.apiLogPath).toContain('api-log.ndjson')
        expect(scenario.chainName).toBe(chainName)
        expect(scenario.steps).toHaveLength(1)

        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('finalizeOnce is idempotent per chain', async () => {
        const log = new LogService({ spConnDebugLoggingEnabled: false })
        const chainName = `idempotent-${Date.now()}`
        const config = {
            recording: { mode: 'record' as const, chainName, store: 'ndjson' as const },
        } as FusionConfig
        const service = new RecordingService(log, config)

        const first = await service.finalizeOnce()
        const second = await service.finalizeOnce()

        expect(first).toContain('scenario.json')
        expect(second).toBe('')

        fs.rmSync(service.getRecordingDir(), { recursive: true, force: true })
    })

    it('accumulates steps across instances and finalizeOnce writes combined scenario from disk', async () => {
        const log = new LogService({ spConnDebugLoggingEnabled: false })
        const chainName = `reload-${Date.now()}`
        const config = {
            recording: { mode: 'record' as const, chainName, store: 'ndjson' as const },
        } as FusionConfig
        const run = new FusionRun(undefined, config)
        run.log = log
        const res = { send: (_value: unknown) => undefined }

        const first = new RecordingService(log, config)
        first.startOperation('testConnection', {}, res, run)
        first.endOperation(run)
        await first.getStore().flush()

        const second = new RecordingService(log, config)
        second.startOperation('accountList', {}, res, run)
        second.endOperation(run)
        await second.getStore().flush()

        const scenarioPath = await second.finalizeOnce()
        const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'))
        expect(scenario.steps).toHaveLength(2)
        expect(scenario.steps[0].operation).toBe('testConnection')
        expect(scenario.steps[1].operation).toBe('accountList')

        fs.rmSync(first.getRecordingDir(), { recursive: true, force: true })
    })

    it('recordPhaseEnd appends to phases.ndjson', async () => {
        const log = new LogService({ spConnDebugLoggingEnabled: false })
        const chainName = `phases-${Date.now()}`
        const config = {
            recording: { mode: 'record' as const, chainName, store: 'ndjson' as const },
        } as FusionConfig
        const service = new RecordingService(log, config)

        service.recordPhaseEnd({
            phaseNumber: 1,
            phase: 'Setup',
            elapsedMs: 42,
            timestamp: new Date().toISOString(),
            managedAccounts: 3,
            fusionAccounts: 1,
            apiCalls: 5,
        })

        await service.getStore().flush()

        const phasesPath = path.join(service.getRecordingDir(), 'phases.ndjson')
        expect(fs.existsSync(phasesPath)).toBe(true)
        const lines = fs.readFileSync(phasesPath, 'utf-8').trim().split('\n')
        expect(lines).toHaveLength(1)
        expect(JSON.parse(lines[0]).phase).toBe('Setup')

        fs.rmSync(service.getRecordingDir(), { recursive: true, force: true })
    })
})

describe('allocateStepIndex', () => {
    it('returns unique indices under concurrent reservation', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-counter-'))
        const ids = new Set<number>()
        for (let i = 0; i < 20; i++) {
            ids.add(allocateStepIndex(dir))
        }
        expect(ids.size).toBe(20)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('writeMatchingResults persists matching-results.json and finalizeOnce references it', async () => {
        const log = new LogService({ spConnDebugLoggingEnabled: false })
        const chainName = `matching-results-${Date.now()}`
        const config = {
            recording: { mode: 'record' as const, chainName, store: 'ndjson' as const },
        } as FusionConfig
        const service = new RecordingService(log, config)

        service.writeMatchingResults({
            version: '1.0.0',
            recordedAt: new Date().toISOString(),
            operation: 'accountList',
            sweepSummary: { processed: 36, deferred: 12, nonMatch: 24 },
            identityMatches: [],
            deferredMatches: [{ accountName: 'Test', accountSource: 'HR', matches: [], deferred: true }],
            nonMatches: [],
            failedMatches: [],
        })

        const run = new FusionRun(undefined, config)
        run.log = log
        const res = { send: (_value: unknown) => undefined }
        service.startOperation('accountList', {}, res, run)
        service.endOperation(run)

        const scenarioPath = await service.finalizeOnce()
        const dir = service.getRecordingDir()
        const matchingResultsPath = path.join(dir, 'reports', 'matching-results.json')
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'))
        const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf-8'))

        expect(fs.existsSync(matchingResultsPath)).toBe(true)
        expect(manifest.matchingResultsPath).toContain('matching-results.json')
        expect(manifest.artifactPaths).toContain(manifest.matchingResultsPath)
        expect(scenario.matchingResultsPath).toContain('matching-results.json')

        const saved = JSON.parse(fs.readFileSync(matchingResultsPath, 'utf-8'))
        expect(saved.version).toBe('1.1.0')
        expect(saved.runs[0].sweepSummary.deferred).toBe(12)

        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('accumulates matching-results runs without overwriting prior accountList captures', () => {
        const log = new LogService({ spConnDebugLoggingEnabled: false })
        const chainName = `matching-accum-${Date.now()}`
        const config = {
            recording: { mode: 'record' as const, chainName, store: 'ndjson' as const },
        } as FusionConfig
        const service = new RecordingService(log, config)

        service.writeMatchingResults({
            version: '1.0.0',
            recordedAt: new Date().toISOString(),
            operation: 'accountList',
            stepId: 'step-1',
            sweepSummary: { processed: 24, nonMatch: 24 },
            identityMatches: [],
            deferredMatches: [],
            nonMatches: [{ accountName: 'A', accountSource: 'HR', matches: [] }],
            failedMatches: [],
        })
        service.writeMatchingResults({
            version: '1.0.0',
            recordedAt: new Date().toISOString(),
            operation: 'accountList',
            stepId: 'step-10',
            sweepSummary: { processed: 36, partial: 11, exact: 1 },
            identityMatches: [{ accountName: 'Auto', accountSource: 'HR', matches: [] }],
            deferredMatches: [],
            nonMatches: [],
            failedMatches: [],
        })

        const saved = JSON.parse(
            fs.readFileSync(path.join(service.getRecordingDir(), 'reports', 'matching-results.json'), 'utf-8')
        )
        expect(saved.runs).toHaveLength(2)
        expect(saved.runs[0].stepId).toBe('step-1')
        expect(saved.runs[1].stepId).toBe('step-10')
        expect(saved.runs[1].sweepSummary?.partial).toBe(11)

        fs.rmSync(service.getRecordingDir(), { recursive: true, force: true })
    })
})

describe('NdjsonRecordingStore', () => {
    it('seeds api-log entry count from an existing file', () => {
        const chainName = `ndjson-seed-${Date.now()}`
        const dir = recordingChainDir(chainName)
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'api-log.ndjson'), '{"api":"a"}\n{"api":"b"}\n')

        const store = new NdjsonRecordingStore(chainName)
        expect(store.getApiLogEntryCount()).toBe(2)

        fs.rmSync(dir, { recursive: true, force: true })
    })

    it('append/load api-log and manifest', () => {
        const chainName = `ndjson-${Date.now()}`
        const store = new NdjsonRecordingStore(chainName)

        store.appendApiCall({
            api: 'search',
            method: 'search',
            args: [{ query: 'test' }],
            response: { results: [] },
            timestamp: '2026-01-01T00:00:00.000Z',
        })

        return store.flush().then(() => {
            const loaded = store.loadApiLog()
            expect(loaded).toHaveLength(1)
            expect(loaded[0].api).toBe('search')
            expect(loaded[0].getter).toBe('search')
            expect(store.getApiLogEntryCount()).toBe(1)

            store.writeManifest({
                version: '1.0.0',
                store: 'ndjson',
                chainName,
                recordedAt: new Date().toISOString(),
                apiLogPath: 'api-log.ndjson',
                apiLogEntryCount: 1,
                stepsPath: 'steps.ndjson',
                stepCount: 0,
                phaseCount: 0,
                scenarioPath: 'scenario.json',
                artifactPaths: [],
            })

            return store.flush()
        }).then(() => {
            expect(fs.existsSync(path.join(store.getRecordingDir(), 'manifest.json'))).toBe(true)
            fs.rmSync(store.getRecordingDir(), { recursive: true, force: true })
        })
    })
})



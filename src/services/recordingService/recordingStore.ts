import * as fs from 'fs'
import * as path from 'path'
import type { RecordingConfig } from '../../model/config'
import type { ApiLogEntry } from '../clientService/recordingApiAdapter'
import { NdjsonRecordingStore } from './ndjsonRecordingStore'
import { recordingCacheKey } from '../../data/recordingPaths'
import { forEachNdjsonLine } from '../../utils/ndjson'

/** Metadata written to manifest.json on finalize. */
export interface RecordingManifest {
    version: string
    store: RecordingConfig['store']
    /** @deprecated Use scenarioName */
    chainName: string
    scenarioName?: string
    recordedAt: string
    apiLogPath: string
    apiLogEntryCount: number
    stepsPath: string
    stepCount: number
    phasesPath?: string
    phaseCount: number
    scenarioPath: string
    reportsPath?: string
    matchingResultsPath?: string
    artifactPaths: string[]
}

/** Read-only api-log access for replay adapters. */
interface ApiLogReader {
    loadApiLog(): ApiLogEntry[]
}

/** Pluggable persistence for record-mode artifacts. */
export interface RecordingStore extends ApiLogReader {
    appendApiCall(entry: ApiLogEntry): void
    append(collection: 'steps' | 'phases', record: unknown): void
    writeManifest(manifest: RecordingManifest): void
    getRecordingDir(): string
    getApiLogPath(): string
    getApiLogEntryCount(): number
    getPhaseCount(): number
    flush(): Promise<void>
    close(): void
}

const storeCache = new Map<string, RecordingStore>()

/** Creates the configured store implementation (default NDJSON). */
function createRecordingStore(config: RecordingConfig, chainName: string, baseurl?: string): RecordingStore {
    const storeType = config.store ?? 'ndjson'
    switch (storeType) {
        case 'ndjson':
            return new NdjsonRecordingStore(chainName, baseurl)
        default:
            throw new Error(`Unsupported recording store: ${storeType}`)
    }
}

/** Returns one store instance per tenant+chain so api-log and counters stay consistent across operations. */
export function getOrCreateRecordingStore(config: RecordingConfig, chainName: string, baseurl?: string): RecordingStore {
    const cacheKey = recordingCacheKey(chainName, baseurl)
    const cached = storeCache.get(cacheKey)
    if (cached) return cached
    const store = createRecordingStore(config, chainName, baseurl)
    storeCache.set(cacheKey, store)
    return store
}

/** Clears cached stores (for tests). */
export function clearRecordingStoreCache(): void {
    storeCache.clear()
}

function parseNdjsonFile(filePath: string): ApiLogEntry[] {
    const entries: ApiLogEntry[] = []
    forEachNdjsonLine(filePath, (line) => {
        entries.push(JSON.parse(line) as ApiLogEntry)
    })
    return entries
}

function readApiLogFromManifest(
    manifestPath: string
): { entries: ApiLogEntry[]; storeType: RecordingConfig['store']; resolved: boolean } | null {
    if (!fs.existsSync(manifestPath)) return null

    try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as RecordingManifest
        const storeType = manifest.store ?? 'ndjson'
        if (!manifest.apiLogPath) return { entries: [], storeType, resolved: false }

        const apiLogPath = path.isAbsolute(manifest.apiLogPath)
            ? manifest.apiLogPath
            : path.join(process.cwd(), manifest.apiLogPath)
        if (!fs.existsSync(apiLogPath)) return { entries: [], storeType, resolved: false }

        return { entries: parseNdjsonFile(apiLogPath), storeType, resolved: true }
    } catch {
        return null
    }
}

/** Loads api-log entries from a chain directory using manifest store type when present. */
export function loadRecordingApiLog(chainDir: string, baseurl?: string): ApiLogEntry[] {
    const manifestPath = path.join(chainDir, 'manifest.json')
    const fromManifest = readApiLogFromManifest(manifestPath)

    if (fromManifest?.resolved) {
        return fromManifest.entries
    }

    const storeType = fromManifest?.storeType ?? 'ndjson'
    const chainName = path.basename(chainDir)
    const store = createRecordingStore({ mode: 'replay', store: storeType, chainName }, chainName, baseurl)
    return store.loadApiLog()
}







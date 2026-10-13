import * as fs from 'fs'
import * as path from 'path'
import { recordingChainDir } from '../../data/recordingPaths'
import type { ApiLogEntry } from '../clientService/recordingApiAdapter'

function normalizeApiLogEntry(raw: ApiLogEntry): ApiLogEntry {
    const api = raw.api ?? raw.getter ?? ''
    const getter = raw.getter ?? raw.api ?? api
    return { ...raw, api, getter }
}

import type { RecordingManifest, RecordingStore } from './recordingStore'

const COLLECTION_FILES = {
    steps: 'steps.ndjson',
    phases: 'phases.ndjson',
} as const

/** Default NDJSON append-only store for record-mode artifacts. */
export class NdjsonRecordingStore implements RecordingStore {
    private readonly recordingDir: string
    private readonly apiLogPath: string
    private apiLogEntryCount = 0
    private phaseCount = 0
    private writeChain: Promise<void> = Promise.resolve()
    private dirReady = false

    constructor(
        private readonly chainName: string,
        baseurl?: string
    ) {
        this.recordingDir = recordingChainDir(chainName, baseurl)
        this.apiLogPath = path.join(this.recordingDir, 'api-log.ndjson')
        this.apiLogEntryCount = this.countLines(this.apiLogPath)
        this.phaseCount = this.countLines(path.join(this.recordingDir, COLLECTION_FILES.phases))
    }

    appendApiCall(entry: ApiLogEntry): void {
        const getter = entry.getter ?? entry.api
        const payload: Record<string, unknown> = {
            api: entry.api,
            getter,
            method: entry.method,
            args: entry.args,
            timestamp: entry.timestamp,
        }
        if (entry.error != null) {
            payload.error = entry.error
        } else {
            payload.response = entry.response
        }
        const line = JSON.stringify(payload) + '\n'
        this.enqueueWrite(this.apiLogPath, line)
        this.apiLogEntryCount++
    }

    append(collection: 'steps' | 'phases', record: unknown): void {
        const filePath = path.join(this.recordingDir, COLLECTION_FILES[collection])
        this.enqueueWrite(filePath, JSON.stringify(record) + '\n')
        if (collection === 'phases') {
            this.phaseCount++
        }
    }

    loadApiLog(): ApiLogEntry[] {
        if (!fs.existsSync(this.apiLogPath)) return []
        const content = fs.readFileSync(this.apiLogPath, 'utf-8').trim()
        if (!content) return []
        return content.split('\n').map((line) => normalizeApiLogEntry(JSON.parse(line) as ApiLogEntry))
    }

    writeManifest(manifest: RecordingManifest): void {
        const manifestPath = path.join(this.recordingDir, 'manifest.json')
        this.writeChain = this.writeChain.then(async () => {
            await this.ensureDir()
            await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
        })
    }

    getRecordingDir(): string {
        return this.recordingDir
    }

    getApiLogPath(): string {
        return this.apiLogPath
    }

    getApiLogEntryCount(): number {
        return this.apiLogEntryCount
    }

    getPhaseCount(): number {
        return this.phaseCount
    }

    async flush(): Promise<void> {
        await this.writeChain
    }

    close(): void {
        /* writes drain via flush() before close */
    }

    private enqueueWrite(filePath: string, line: string): void {
        this.writeChain = this.writeChain.then(async () => {
            await this.ensureDir()
            await fs.promises.appendFile(filePath, line)
        })
    }

    private async ensureDir(): Promise<void> {
        if (this.dirReady) return
        await fs.promises.mkdir(this.recordingDir, { recursive: true })
        this.dirReady = true
    }

    private countLines(filePath: string): number {
        if (!fs.existsSync(filePath)) return 0
        const content = fs.readFileSync(filePath, 'utf-8').trim()
        if (!content) return 0
        return content.split('\n').filter(Boolean).length
    }
}



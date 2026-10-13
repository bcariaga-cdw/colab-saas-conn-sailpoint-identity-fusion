import { Configuration } from 'sailpoint-api-client'
import * as fs from 'fs'
import { IscApiAdapter } from './iscApiAdapter'
import { ApiLogEntry } from './recordingApiAdapter'
import { ConnectorError } from '@sailpoint/connector-sdk'
import { isWriteMethod, stableApiCallKey } from './apiWriteClassification'
import { loadRecordingApiLog } from '../recordingService/recordingStore'

function stableKey(apiName: string, method: string, args: unknown[]): string {
    return stableApiCallKey(apiName, method, args)
}

function normalizeApiLogEntry(raw: ApiLogEntry): ApiLogEntry {
    const api = raw.api ?? raw.getter ?? ''
    const getter = raw.getter ?? raw.api ?? api
    return { ...raw, api, getter }
}

export class ReplayApiAdapter implements IscApiAdapter {
    public readonly config: Configuration
    /** FIFO queues for repeated read calls that share the same stable key. */
    private readonly readQueues = new Map<string, ApiLogEntry[]>()
    private readonly readCursors = new Map<string, number>()
    private readonly writeLog: ApiLogEntry[] = []
    private readonly consumedWrites = new Set<number>()
    private readonly orderedEntries: ApiLogEntry[]

    constructor(entries: ApiLogEntry[], config?: Configuration) {
        this.config = config ?? ({} as Configuration)
        this.orderedEntries = entries.map(normalizeApiLogEntry)

        for (const entry of this.orderedEntries) {
            const key = stableKey(entry.api, entry.method, entry.args)
            if (isWriteMethod(entry.method)) {
                this.writeLog.push(entry)
            } else {
                const queue = this.readQueues.get(key) ?? []
                queue.push(entry)
                this.readQueues.set(key, queue)
            }
        }
    }

    /**
     * Positions read/write cursors as if all api-log entries before `timestamp` were already consumed.
     * Aligns replay with the ISC state at the start of a recorded step.
     */
    seekBefore(timestamp: string): void {
        this.readCursors.clear()
        this.consumedWrites.clear()

        for (let i = 0; i < this.orderedEntries.length; i++) {
            const entry = this.orderedEntries[i]
            if (!entry.timestamp || entry.timestamp >= timestamp) {
                break
            }

            const key = stableKey(entry.api, entry.method, entry.args)
            if (isWriteMethod(entry.method)) {
                const writeIndex = this.writeLog.indexOf(entry)
                if (writeIndex >= 0) {
                    this.consumedWrites.add(writeIndex)
                }
            } else {
                const cursor = this.readCursors.get(key) ?? 0
                this.readCursors.set(key, cursor + 1)
            }
        }
    }

    private findUnconsumedWriteIndex(apiName: string, method: string, key: string): number {
        return this.writeLog.findIndex(
            (e, i) =>
                e.api === apiName &&
                e.method === method &&
                stableKey(e.api, e.method, e.args as unknown[]) === key &&
                !this.consumedWrites.has(i)
        )
    }

    private resolveRecordedEntry(entry: ApiLogEntry, apiName: string, method: string): Promise<unknown> {
        if (entry.error != null) {
            return Promise.reject(
                new ConnectorError(`Replay: recorded API failure: ${apiName}.${method}: ${entry.error}`)
            )
        }
        return Promise.resolve(entry.response)
    }

    private assertRecordedResponse(apiName: string, method: string, args: unknown[], key: string): Promise<unknown> {
        const queue = this.readQueues.get(key)
        const cursor = this.readCursors.get(key) ?? 0
        if (!queue || cursor >= queue.length) {
            throw new ConnectorError(
                `Replay: unrecorded API call: ${apiName}.${method}(${JSON.stringify(args)})`
            )
        }
        this.readCursors.set(key, cursor + 1)
        return this.resolveRecordedEntry(queue[cursor], apiName, method)
    }

    private resolveReplayCall(apiName: string, method: string, args: unknown[]): Promise<unknown> {
        const key = stableKey(apiName, method, args)

        if (isWriteMethod(method)) {
            const idx = this.findUnconsumedWriteIndex(apiName, method, key)
            if (idx === -1) {
                throw new ConnectorError(
                    `Replay: unrecorded write call: ${apiName}.${method}(${JSON.stringify(args)})`
                )
            }
            this.consumedWrites.add(idx)
            return this.resolveRecordedEntry(this.writeLog[idx], apiName, method)
        }

        return this.assertRecordedResponse(apiName, method, args, key)
    }

    private createApiProxy(apiName: string): Record<string, unknown> {
        return new Proxy(
            {} as Record<string, unknown>,
            {
                get: (_target: unknown, method: string): unknown => {
                    return (...args: unknown[]) => this.resolveReplayCall(apiName, method, args)
                },
            }
        ) as Record<string, unknown>
    }

    get accountsApi() { return this.createApiProxy('accounts') as any }
    get identitiesApi() { return this.createApiProxy('identities') as any }
    get searchApi() { return this.createApiProxy('search') as any }
    get sourcesApi() { return this.createApiProxy('sources') as any }
    get customFormsApi() { return this.createApiProxy('customForms') as any }
    get workflowsApi() { return this.createApiProxy('workflows') as any }
    get entitlementsApi() { return this.createApiProxy('entitlements') as any }
    get transformsApi() { return this.createApiProxy('transforms') as any }
    get governanceGroupsApi() { return this.createApiProxy('governanceGroups') as any }
    get taskManagementApi() { return this.createApiProxy('taskManagement') as any }
    get identityProfilesApi() { return this.createApiProxy('identityProfiles') as any }
    get identityAttributesApi() { return this.createApiProxy('identityAttributes') as any }
    get machineAccountsApi() { return this.createApiProxy('machineAccounts') as any }
}

export function loadApiLog(fileOrDirPath: string): ApiLogEntry[] {
    if (fs.existsSync(fileOrDirPath)) {
        const stat = fs.statSync(fileOrDirPath)
        if (stat.isDirectory()) {
            return loadRecordingApiLog(fileOrDirPath)
        }
    }

    if (!fs.existsSync(fileOrDirPath)) return []
    const content = fs.readFileSync(fileOrDirPath, 'utf-8').trim()
    if (!content) return []
    return content.split('\n').map((line) => JSON.parse(line))
}







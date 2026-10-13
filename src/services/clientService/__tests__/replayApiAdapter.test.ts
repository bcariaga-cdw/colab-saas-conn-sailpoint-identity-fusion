import { describe, it, expect } from 'vitest'
import { ReplayApiAdapter, loadApiLog } from '../replayApiAdapter'
import { ApiLogEntry } from '../recordingApiAdapter'
import { ConnectorError } from '@sailpoint/connector-sdk'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('ReplayApiAdapter', () => {
    it('serves recorded response for known read call', async () => {
        const entries: ApiLogEntry[] = [
            {
                api: 'accounts',
                method: 'listAccounts',
                args: [{ limit: 10 }],
                response: { data: [{ id: '1', name: 'test' }] },
                timestamp: '2026-01-01T00:00:00.000Z',
            },
        ]
        const adapter = new ReplayApiAdapter(entries)

        const accountsApi = adapter.accountsApi as any
        const result = await accountsApi.listAccounts({ limit: 10 })
        expect(result).toEqual({ data: [{ id: '1', name: 'test' }] })
    })

    it('throws ConnectorError for unrecorded read call — drift detection', () => {
        const adapter = new ReplayApiAdapter([])

        const accountsApi = adapter.accountsApi as any
        expect(() => {
            accountsApi.listAccounts({ limit: 10 })
        }).toThrow(ConnectorError)
    })

    it('throws ConnectorError for unrecorded write call', () => {
        const adapter = new ReplayApiAdapter([])

        const formsApi = adapter.customFormsApi as any
        expect(() => {
            formsApi.createFormDefinition({ name: 'test' })
        }).toThrow(ConnectorError)
    })

    it('serves write response and consumes from write queue', async () => {
        const entries: ApiLogEntry[] = [
            {
                api: 'customForms',
                method: 'createFormDefinition',
                args: [{ name: 'form-1' }],
                response: { id: 'f1', status: 'created' },
                timestamp: '2026-01-01T00:00:00.000Z',
            },
        ]
        const adapter = new ReplayApiAdapter(entries)

        const formsApi = adapter.customFormsApi as any
        const result = await formsApi.createFormDefinition({ name: 'form-1' })
        expect(result).toEqual({ id: 'f1', status: 'created' })
    })

    it('rejects with the recorded error for a failed write entry', async () => {
        const entries: ApiLogEntry[] = [
            {
                api: 'machineAccounts',
                method: 'updateMachineAccount',
                args: [{ id: 'acct-1' }],
                error: 'Request failed with status code 400 [400: 400.1]',
                timestamp: '2026-01-01T00:00:00.000Z',
            },
        ]
        const adapter = new ReplayApiAdapter(entries)
        const machineAccountsApi = adapter.machineAccountsApi as any

        await expect(machineAccountsApi.updateMachineAccount({ id: 'acct-1' })).rejects.toThrow(
            /recorded API failure.*400\.1/
        )
    })

    it('does not treat a failed write as a successful response for a later matching call', async () => {
        const entries: ApiLogEntry[] = [
            {
                api: 'machineAccounts',
                method: 'updateMachineAccount',
                args: [{ id: 'acct-1' }],
                error: 'Request failed with status code 400 [400: 400.1]',
                timestamp: '2026-01-01T00:00:00.000Z',
            },
            {
                api: 'machineAccounts',
                method: 'updateMachineAccount',
                args: [{ id: 'acct-1' }],
                response: { data: { id: 'acct-1', ownerIdentity: { id: 'id-1' } } },
                timestamp: '2026-01-01T00:00:01.000Z',
            },
        ]
        const adapter = new ReplayApiAdapter(entries)
        const machineAccountsApi = adapter.machineAccountsApi as any

        await expect(machineAccountsApi.updateMachineAccount({ id: 'acct-1' })).rejects.toThrow(/recorded API failure/)
        await expect(machineAccountsApi.updateMachineAccount({ id: 'acct-1' })).resolves.toEqual({
            data: { id: 'acct-1', ownerIdentity: { id: 'id-1' } },
        })
    })

    it('throws on second write call when only one was recorded', async () => {
        const entries: ApiLogEntry[] = [
            {
                api: 'customForms',
                method: 'createFormDefinition',
                args: [{ name: 'form-1' }],
                response: { id: 'f1' },
                timestamp: '2026-01-01T00:00:00.000Z',
            },
        ]
        const adapter = new ReplayApiAdapter(entries)
        const formsApi = adapter.customFormsApi as any

        await formsApi.createFormDefinition({ name: 'form-1' })

        expect(() => {
            formsApi.createFormDefinition({ name: 'form-1' })
        }).toThrow(ConnectorError)
    })

    it('serves repeated read calls in FIFO order', async () => {
        const entries: ApiLogEntry[] = [
            {
                api: 'search',
                method: 'searchPost',
                args: [{ search: { query: { query: 'status:active' } } }],
                response: { data: [{ id: 'first' }] },
                timestamp: '2026-01-01T00:00:00.000Z',
            },
            {
                api: 'search',
                method: 'searchPost',
                args: [{ search: { query: { query: 'status:active' } } }],
                response: { data: [{ id: 'second' }] },
                timestamp: '2026-01-01T00:00:01.000Z',
            },
        ]
        const adapter = new ReplayApiAdapter(entries)
        const searchApi = adapter.searchApi as any

        await expect(searchApi.searchPost({ search: { query: { query: 'status:active' } } })).resolves.toEqual({
            data: [{ id: 'first' }],
        })
        await expect(searchApi.searchPost({ search: { query: { query: 'status:active' } } })).resolves.toEqual({
            data: [{ id: 'second' }],
        })
        expect(() => {
            searchApi.searchPost({ search: { query: { query: 'status:active' } } })
        }).toThrow(ConnectorError)
    })

    it('seeks cursors before a step timestamp', async () => {
        const entries: ApiLogEntry[] = [
            {
                api: 'accounts',
                method: 'listAccounts',
                args: [{ limit: 10 }],
                response: { data: [{ id: 'first' }] },
                timestamp: '2026-01-01T00:00:00.000Z',
            },
            {
                api: 'accounts',
                method: 'listAccounts',
                args: [{ limit: 10 }],
                response: { data: [{ id: 'second' }] },
                timestamp: '2026-01-01T00:00:02.000Z',
            },
        ]
        const adapter = new ReplayApiAdapter(entries)
        const accountsApi = adapter.accountsApi as any

        adapter.seekBefore('2026-01-01T00:00:02.000Z')
        await expect(accountsApi.listAccounts({ limit: 10 })).resolves.toEqual({ data: [{ id: 'second' }] })
    })

    it('exposes all 12 IscApiAdapter getters', () => {
        const adapter = new ReplayApiAdapter([])

        expect(adapter.accountsApi).toBeDefined()
        expect(adapter.identitiesApi).toBeDefined()
        expect(adapter.searchApi).toBeDefined()
        expect(adapter.sourcesApi).toBeDefined()
        expect(adapter.customFormsApi).toBeDefined()
        expect(adapter.workflowsApi).toBeDefined()
        expect(adapter.entitlementsApi).toBeDefined()
        expect(adapter.transformsApi).toBeDefined()
        expect(adapter.governanceGroupsApi).toBeDefined()
        expect(adapter.taskManagementApi).toBeDefined()
        expect(adapter.identityProfilesApi).toBeDefined()
        expect(adapter.identityAttributesApi).toBeDefined()
        expect(adapter.machineAccountsApi).toBeDefined()
    })
})

describe('loadApiLog', () => {
    it('returns empty array for non-existent file', () => {
        const result = loadApiLog('/nonexistent/path/api-log.ndjson')
        expect(result).toEqual([])
    })

    it('returns empty array for empty file', () => {
        const tmpFile = path.join(os.tmpdir(), `replay-test-empty-${Date.now()}.ndjson`)
        fs.writeFileSync(tmpFile, '')
        try {
            const result = loadApiLog(tmpFile)
            expect(result).toEqual([])
        } finally {
            fs.unlinkSync(tmpFile)
        }
    })

    it('parses NDJSON lines into ApiLogEntry array', () => {
        const tmpFile = path.join(os.tmpdir(), `replay-test-${Date.now()}.ndjson`)
        const entries: ApiLogEntry[] = [
            { api: 'accounts', method: 'listAccounts', args: [{ limit: 5 }], response: [], timestamp: 't1' },
            { api: 'identities', method: 'listIdentities', args: [{ limit: 10 }], response: [], timestamp: 't2' },
        ]
        const ndjson = entries.map((e) => JSON.stringify(e)).join('\n')
        fs.writeFileSync(tmpFile, ndjson + '\n')
        try {
            const result = loadApiLog(tmpFile)
            expect(result).toHaveLength(2)
            expect(result[0].api).toBe('accounts')
            expect(result[1].api).toBe('identities')
        } finally {
            fs.unlinkSync(tmpFile)
        }
    })

    it('loads from chain directory via manifest', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-dir-'))
        const apiLogPath = path.join(tmpDir, 'api-log.ndjson')
        fs.writeFileSync(
            apiLogPath,
            JSON.stringify({
                api: 'sources',
                method: 'listSources',
                args: [{}],
                response: [],
                timestamp: 't1',
            }) + '\n'
        )
        fs.writeFileSync(
            path.join(tmpDir, 'manifest.json'),
            JSON.stringify({
                version: '1.0.0',
                store: 'ndjson',
                chainName: 'chain',
                recordedAt: new Date().toISOString(),
                apiLogPath: path.relative(process.cwd(), apiLogPath),
                apiLogEntryCount: 1,
                stepsPath: 'steps.ndjson',
                stepCount: 0,
                phaseCount: 0,
                scenarioPath: 'scenario.json',
                artifactPaths: [],
            })
        )

        try {
            const result = loadApiLog(tmpDir)
            expect(result).toHaveLength(1)
            expect(result[0].api).toBe('sources')
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true })
        }
    })
})




import { RecordingApiAdapter } from '../recordingApiAdapter'

describe('RecordingApiAdapter', () => {
    it('returns API responses without waiting for recording persistence', async () => {
        let recordingStarted = false

        const inner = {
            config: {} as any,
            accountsApi: {
                listAccounts: vi.fn(async () => {
                    expect(recordingStarted).toBe(false)
                    await new Promise((r) => setTimeout(r, 5))
                    return { data: [{ id: 'a1' }] }
                }),
            },
        }

        const adapter = new RecordingApiAdapter(inner as any, () => {
            recordingStarted = true
        })

        const started = Date.now()
        const result = await adapter.accountsApi.listAccounts({ limit: 1 })
        const elapsed = Date.now() - started

        expect(result).toEqual({ data: [{ id: 'a1' }] })
        expect(elapsed).toBeLessThan(50)
        expect(recordingStarted).toBe(true)
    })

    it('records axios-style responses without circular reference errors', async () => {
        const recorded: unknown[] = []
        const axiosResponse: Record<string, unknown> = {
            data: [{ id: 'src-1' }],
            status: 200,
            statusText: 'OK',
        }
        axiosResponse.request = axiosResponse

        const inner = {
            config: {} as any,
            sourcesApi: {
                listSources: vi.fn(async () => axiosResponse),
            },
        }

        const adapter = new RecordingApiAdapter(inner as any, (entry) => {
            recorded.push(entry)
        })

        await adapter.sourcesApi.listSources({})

        await new Promise((r) => setTimeout(r, 0))
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({
            api: 'sources',
            method: 'listSources',
            response: { data: [{ id: 'src-1' }], status: 200, statusText: 'OK' },
        })
    })

    it('records rejected API calls with an error field and rethrows', async () => {
        const recorded: unknown[] = []
        const failure = Object.assign(new Error('Request failed with status code 400'), {
            response: { status: 400, data: { detailCode: '400.1', message: 'Illegal update attempt' } },
        })

        const inner = {
            config: {} as any,
            machineAccountsApi: {
                updateMachineAccount: vi.fn(async () => {
                    throw failure
                }),
            },
        }

        const adapter = new RecordingApiAdapter(inner as any, (entry) => {
            recorded.push(entry)
        })

        await expect(
            adapter.machineAccountsApi.updateMachineAccount({
                id: 'acct-1',
                requestBody: [{ op: 'add', path: '/ownerIdentity', value: { type: 'IDENTITY', id: 'id-1' } }],
            })
        ).rejects.toBe(failure)

        await new Promise((r) => setTimeout(r, 0))
        expect(recorded).toHaveLength(1)
        expect(recorded[0]).toMatchObject({
            api: 'machineAccounts',
            method: 'updateMachineAccount',
            error: expect.stringContaining('400'),
        })
        expect(recorded[0]).not.toHaveProperty('response')
    })
})

import { FormService } from '../formService'
import { FusionRun } from '../../../model/fusionRun'
import { FusionAccount } from '../../../model/account'
import { SourceType } from '../../../model/config'
import { analyzeFormInstances, extractAccountIdFromInstance } from '../formInstanceAnalyzer'

/** Minimal client.call mock that supports sequential pagination used by form instance fetch. */
function createFormClientCallMock(customFormsMock: Record<string, unknown>) {
    return async (
        fn: (api: { customForms: typeof customFormsMock }, params?: unknown) => Promise<unknown>,
        policy?: {
            paginate?: { mode: string; baseParams?: Record<string, unknown> }
            onPageProgress?: (loaded: number, total?: number) => void
        }
    ) => {
        const api = { customForms: customFormsMock }
        if (policy?.paginate?.mode === 'sequential') {
            const params = { ...(policy.paginate.baseParams ?? {}), limit: 250, offset: 0 }
            const page = (await fn(api, params)) as { data?: unknown[] }
            const items = page?.data ?? []
            policy.onPageProgress?.(items.length)
            return items
        }
        const result = await fn(api)
        if (result && typeof result === 'object' && 'data' in result) {
            const data = (result as { data: unknown }).data
            if (Array.isArray(data)) return data
            if (data && typeof data === 'object' && 'results' in data) {
                return (data as { results: unknown[] }).results
            }
        }
        return result
    }
}

function toggleLabelFromDefinition(formElements: Array<{ key?: string; config?: any }>): string | undefined {
    const identitiesSection = formElements.find((element) => element.key === 'identitiesSection')
    return identitiesSection?.config?.formElements?.[0]?.config?.columns?.[0]?.[0]?.config?.label
}

function buildManagedAccountAndReviewer(reviewerId: string) {
    FusionAccount.configure({ sources: ['Source A'] } as any)
    const fusionAccount = FusionAccount.fromManagedAccount({
        id: 'acct-1',
        nativeIdentity: 'native-1',
        name: 'Test User',
        sourceId: 'source-a-id',
        sourceName: 'Source A',
        attributes: { email: 'user@example.com' },
    } as any)
    fusionAccount.layers.addFusionMatch({
        fusionIdentity: {
            identityId: 'candidate-1',
            attributes: { displayName: 'Candidate One', email: 'candidate@example.com' },
        },
        scores: [{ attribute: 'email', algorithm: 'lig3', score: 85, fusionScore: 50 }],
    } as any)
    const reviewer = FusionAccount.fromIdentity({
        id: reviewerId,
        name: 'Reviewer',
        attributes: { email: 'reviewer@example.com' },
    } as any)
    return { fusionAccount, reviewer }
}

function buildLocalizedCreateFusionFormHarness(options: {
    enableLocalization?: boolean
    defaultLanguage?: string
    getRecipientLocale?: (id: string | undefined) => Promise<string>
    existingDefinitions?: Array<{ id: string; name: string; description?: string; formElements?: unknown[] }>
    existingInstancesByDefinitionId?: Record<string, unknown[]>
    /** Definition ids that the search returns but that no longer exist (stale search index). */
    missingByKeyDefinitionIds?: string[]
}) {
    FusionAccount.configure({ sources: ['Source A'] } as any)
    const createFormDefinition = vi.fn().mockImplementation(async (req: { body: { name: string } }) => ({
        data: { id: `form-def-${createFormDefinition.mock.calls.length}`, name: req.body.name },
    }))
    const createFormInstance = vi.fn().mockImplementation(async () => ({
        data: {
            id: `inst-${createFormInstance.mock.calls.length}`,
            standAloneFormUrl: `https://review/${createFormInstance.mock.calls.length}`,
        },
    }))
    const patchFormDefinition = vi.fn()
    const deleteFormDefinition = vi.fn().mockResolvedValue({})
    const existingDefinitions = options.existingDefinitions ?? []
    const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({
        data: { results: existingDefinitions },
    })
    const searchFormInstancesByTenant = vi.fn().mockImplementation(async (params?: { filters?: string }) => {
        const filter = params?.filters ?? ''
        const match = /formDefinitionId eq "([^"]+)"/.exec(filter)
        const byId = options.existingInstancesByDefinitionId
        if (match && byId) {
            return { data: byId[match[1]] ?? [] }
        }
        return { data: [] }
    })
    const customFormsMock = {
        createFormDefinition,
        createFormInstance,
        patchFormDefinition,
        deleteFormDefinition,
        searchFormDefinitionsByTenant,
        searchFormInstancesByTenant,
        getFormDefinitionByKey: vi.fn().mockImplementation(async (params: { formDefinitionID: string }) => {
            if (options.missingByKeyDefinitionIds?.includes(params.formDefinitionID)) {
                throw Object.assign(new Error('Form definition not found'), { status: 404 })
            }
            const found = existingDefinitions.find((definition) => definition.id === params.formDefinitionID)
            return { data: found }
        }),
    }
    const email = options.getRecipientLocale ? { getRecipientLocale: vi.fn(options.getRecipientLocale) } : undefined
    const run = new FusionRun()
    const service = new FormService(
        {
            fusionFormNamePattern: 'Fusion Review',
            fusionFormExpirationDays: 7,
            fusionFormAttributes: ['Email'],
            fusionMaxCandidatesForForm: 10,
            enableLocalization: options.enableLocalization ?? true,
            defaultLanguage: options.defaultLanguage,
        } as any,
        { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() } as any,
        {
            customFormsApi: customFormsMock,
            call: createFormClientCallMock(customFormsMock),
        } as any,
        {
            fusionSourceId: 'fusion-src',
            fusionSourceOwner: { id: 'owner-1', type: 'IDENTITY' },
            getSourceByNameSafe: vi.fn().mockReturnValue({ sourceType: SourceType.Authoritative }),
        } as any,
        undefined,
        email as any,
        run
    )
    return { service, run, createFormDefinition, createFormInstance, patchFormDefinition, deleteFormDefinition }
}

describe('FormService fetchFormInstancesByDefinitionId', () => {
    it('filters out instances with mismatched formDefinitionId', async () => {
        const warn = vi.fn()
        const debug = vi.fn()
        const fakeInstances = [
            { id: '1', formDefinitionId: 'fd-1' },
            { id: '2', formDefinitionId: 'fd-2' },
            { id: '3', formDefinitionId: 'fd-1' },
        ]

        const customFormsMock = {
            searchFormInstancesByTenant: vi.fn().mockResolvedValue({ data: fakeInstances }),
        }

        const service = new FormService(
            {} as any,
            { warn, debug } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {} as any
        )

        const result = await service.fetchFormInstancesByDefinitionId('fd-1')

        expect(result).toHaveLength(2)
        expect(result.map((x) => x.id)).toEqual(['1', '3'])
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('returned 1 instance(s) outside requested formDefinitionId=fd-1')
        )
    })

    it('warns when API returns page-size ceiling of 250', async () => {
        const warn = vi.fn()
        const instances = Array.from({ length: 250 }, (_, i) => ({
            id: `i-${i}`,
            formDefinitionId: 'fd-1',
        }))

        const customFormsMock = {
            searchFormInstancesByTenant: vi.fn().mockResolvedValue({ data: instances }),
        }

        const service = new FormService(
            {} as any,
            { warn, debug: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {} as any
        )

        await service.fetchFormInstancesByDefinitionId('fd-1')

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('returned 250 instance(s) for formDefinitionId=fd-1'))
    })

    it('reports instance fetch progress via onInstancesLoaded callback', async () => {
        const customFormsMock = {
            searchFormInstancesByTenant: vi.fn().mockResolvedValue({
                data: [
                    { id: '1', formDefinitionId: 'fd-1' },
                    { id: '2', formDefinitionId: 'fd-1' },
                ],
            }),
        }

        const service = new FormService(
            {} as any,
            { warn: vi.fn(), debug: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {} as any
        )

        const deltas: number[] = []
        await service.fetchFormInstancesByDefinitionId('fd-1', (delta) => deltas.push(delta))

        expect(deltas).toEqual([2])
    })
})

describe('FormService fetchFormInstances logging', () => {
    it('emits a collapsed summary and metric instead of per-definition debug lines', async () => {
        const debug = vi.fn()
        const info = vi.fn()
        const trackDone = vi.fn()
        const track = vi.fn(() => ({ done: trackDone }))
        const setProgress = vi.fn()
        const forms = [
            { id: 'form-1', name: 'Fusion Review - 1' },
            { id: 'form-2', name: 'Fusion Review - 2' },
        ]

        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({
            data: { results: forms },
        })
        const searchFormInstancesByTenant = vi
            .fn()
            .mockResolvedValueOnce({ data: [{ id: 'inst-1', formDefinitionId: 'form-1' }] })
            .mockResolvedValueOnce({
                data: [
                    { id: 'inst-2', formDefinitionId: 'form-2' },
                    { id: 'inst-3', formDefinitionId: 'form-2' },
                ],
            })

        const customFormsMock = {
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
        }

        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review' } as any,
            { warn: vi.fn(), info, debug, track, setProgress } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {} as any
        )

        await service.fetchFormInstances()

        expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('Fetching instances for form definition'))
        expect(debug).not.toHaveBeenCalledWith(expect.stringContaining('Fetched 1 instance(s) for form definition'))
        expect(debug).toHaveBeenCalledWith('Fetched 3 instance(s) from 2 form definition(s)')
        expect(track).toHaveBeenCalledWith('FormService.fetchFormInstances')
        expect(trackDone).toHaveBeenCalledWith({ definitions: 2, instances: 3 })
        expect(setProgress).toHaveBeenCalledWith(1, 2, 'forms')
        expect(setProgress).toHaveBeenCalledWith(2, 2, 'forms')
    })
})

describe('FormService stale-form cleanup queue', () => {
    it('queues stale forms for deletion and skips instance fetch for those definitions', async () => {
        const now = Date.now()
        const staleDate = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString()
        const freshDate = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString()
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({
            data: {
                results: [
                    { id: 'form-stale', name: 'Fusion stale', created: staleDate },
                    { id: 'form-fresh', name: 'Fusion fresh', created: freshDate },
                ],
            },
        })

        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })
        const deleteFormDefinition = vi.fn().mockResolvedValue({})

        const customFormsMock = {
            searchFormInstancesByTenant,
            searchFormDefinitionsByTenant,
            deleteFormDefinition,
        }

        const setProgress = vi.fn()
        const track = vi.fn(() => ({ done: vi.fn() }))
        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion',
                fusionFormExpirationDays: 7,
            } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), setProgress, track } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
                execute: async (fn: () => Promise<any>) => fn(),
            } as any,
            {} as any
        )

        await service.fetchFormInstances({ staleFormCleanup: true })
        await service.cleanUpForms()
        await service.awaitPendingDeleteOperations()

        expect(searchFormInstancesByTenant).toHaveBeenCalledTimes(1)
        expect(searchFormInstancesByTenant).toHaveBeenCalledWith(
            expect.objectContaining({ filters: 'formDefinitionId eq "form-fresh"' })
        )
        expect(setProgress).toHaveBeenCalledWith(1, 1, 'forms')
        expect(deleteFormDefinition).toHaveBeenCalledTimes(1)
        expect(deleteFormDefinition).toHaveBeenCalledWith({ formDefinitionID: 'form-stale' })
    })

    it('does not block while queued deletions are still running', async () => {
        let resolveDelete: (() => void) | undefined
        const deleteFormDefinition = vi.fn().mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    resolveDelete = resolve
                })
        )

        const customFormsMock = {
            deleteFormDefinition,
            searchFormInstancesByTenant: vi.fn().mockResolvedValue({ data: [] }),
        }

        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion',
                fusionFormExpirationDays: 7,
            } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {} as any
        )

        ;(service as any).addFormToDelete('form-stale')

        await service.cleanUpForms()
        expect(deleteFormDefinition).toHaveBeenCalledTimes(1)

        let drained = false
        const drainPromise = service.awaitPendingDeleteOperations().then(() => {
            drained = true
        })
        await Promise.resolve()
        expect(drained).toBe(false)

        resolveDelete?.()
        await drainPromise
        expect(drained).toBe(true)
    })
})

describe('FormService deleteExistingForms', () => {
    it('resetForms only deletes forms and continues', async () => {
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({
            data: { results: [{ id: 'form-1', name: 'Fusion Review - A' }] },
        })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({
            data: [
                { id: 'open-1', formDefinitionId: 'form-1', state: 'ASSIGNED' },
                { id: 'done-1', formDefinitionId: 'form-1', state: 'COMPLETED' },
            ],
        })
        const deleteFormDefinition = vi.fn().mockResolvedValue({})
        const patchFormInstance = vi.fn().mockResolvedValue({ data: { id: 'open-1', state: 'CANCELLED' } })

        const customFormsMock = {
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
            deleteFormDefinition,
            patchFormInstance,
        }

        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 7 } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {} as any
        )

        await service.deleteExistingForms()

        expect(deleteFormDefinition).toHaveBeenCalledWith({ formDefinitionID: 'form-1' })
        expect(patchFormInstance).toHaveBeenCalledWith(
            expect.objectContaining({
                formInstanceID: 'open-1',
                body: expect.arrayContaining([expect.objectContaining({ path: '/state', value: 'CANCELLED' })]),
            })
        )
        expect(patchFormInstance).not.toHaveBeenCalledWith(expect.objectContaining({ formInstanceID: 'done-1' }))
    })

    it('Reset forms deletes French and German variants for the same account', async () => {
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({
            data: {
                results: [
                    { id: 'form-fr', name: 'Fusion Review - Test User [Source A] (source-a-id::native-1) [fr]' },
                    { id: 'form-de', name: 'Fusion Review - Test User [Source A] (source-a-id::native-1) [de]' },
                ],
            },
        })
        const searchFormInstancesByTenant = vi.fn().mockImplementation(async (params?: { filters?: string }) => {
            if (params?.filters?.includes('form-fr')) {
                return {
                    data: [{ id: 'open-fr', formDefinitionId: 'form-fr', state: 'ASSIGNED' }],
                }
            }
            return {
                data: [{ id: 'open-de', formDefinitionId: 'form-de', state: 'ASSIGNED' }],
            }
        })
        const deleteFormDefinition = vi.fn().mockResolvedValue({})
        const patchFormInstance = vi.fn().mockResolvedValue({ data: { state: 'CANCELLED' } })
        const customFormsMock = {
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
            deleteFormDefinition,
            patchFormInstance,
        }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 7 } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {} as any
        )

        await service.deleteExistingForms()

        expect(deleteFormDefinition).toHaveBeenCalledWith({ formDefinitionID: 'form-fr' })
        expect(deleteFormDefinition).toHaveBeenCalledWith({ formDefinitionID: 'form-de' })
        expect(patchFormInstance).toHaveBeenCalledWith(expect.objectContaining({ formInstanceID: 'open-fr' }))
        expect(patchFormInstance).toHaveBeenCalledWith(expect.objectContaining({ formInstanceID: 'open-de' }))
    })

    it('Reset forms retains the deleted definition name', async () => {
        const run = new FusionRun()
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({
            data: { results: [{ id: 'form-1', name: 'Fusion Review - Ada [HR] (hr::ada)' }] },
        })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })
        const deleteFormDefinition = vi.fn().mockResolvedValue({})
        const customFormsMock = { searchFormDefinitionsByTenant, searchFormInstancesByTenant, deleteFormDefinition }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 7 } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            { customFormsApi: customFormsMock, call: createFormClientCallMock(customFormsMock) } as any,
            {} as any,
            undefined,
            undefined,
            run
        )

        await service.deleteExistingForms()

        expect(run.deletedFusionReviewForms).toEqual([
            { formDefinitionId: 'form-1', formName: 'Fusion Review - Ada [HR] (hr::ada)' },
        ])
    })

    it('Cleanup delete is retained', async () => {
        const run = new FusionRun()
        const deleteFormDefinition = vi.fn().mockResolvedValue({})
        const customFormsMock = { deleteFormDefinition }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 7 } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            { customFormsApi: customFormsMock, call: createFormClientCallMock(customFormsMock) } as any,
            {} as any,
            undefined,
            undefined,
            run
        )
        run.rememberFusionReviewFormName('form-done', 'Fusion Review - Done [HR] (hr::done)')
        run.formsToDelete.add('form-done')

        await service.cleanUpForms()
        await service.awaitPendingDeleteOperations()

        expect(run.deletedFusionReviewForms).toEqual([
            { formDefinitionId: 'form-done', formName: 'Fusion Review - Done [HR] (hr::done)' },
        ])
    })

    it('Failed delete is not retained', async () => {
        const run = new FusionRun()
        const deleteFormDefinition = vi.fn().mockRejectedValue(new Error('delete failed'))
        const customFormsMock = {
            searchFormDefinitionsByTenant: vi.fn().mockResolvedValue({
                data: { results: [{ id: 'form-1', name: 'Fusion Review - Ada [HR] (hr::ada)' }] },
            }),
            searchFormInstancesByTenant: vi.fn().mockResolvedValue({ data: [] }),
            deleteFormDefinition,
        }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 7 } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            { customFormsApi: customFormsMock, call: createFormClientCallMock(customFormsMock) } as any,
            {} as any,
            undefined,
            undefined,
            run
        )

        await expect(service.deleteExistingForms()).rejects.toThrow('delete failed')
        expect(run.deletedFusionReviewForms).toEqual([])
    })

    it('Cancelled instance is not a deletion', async () => {
        const run = new FusionRun()
        const customFormsMock = {
            searchFormDefinitionsByTenant: vi.fn().mockResolvedValue({
                data: { results: [{ id: 'form-1', name: 'Fusion Review - Ada [HR] (hr::ada)' }] },
            }),
            searchFormInstancesByTenant: vi.fn().mockResolvedValue({
                data: [{ id: 'open-1', formDefinitionId: 'form-1', state: 'ASSIGNED' }],
            }),
            deleteFormDefinition: vi.fn().mockResolvedValue({}),
            patchFormInstance: vi.fn().mockResolvedValue({ data: { id: 'open-1', state: 'CANCELLED' } }),
        }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 7 } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            { customFormsApi: customFormsMock, call: createFormClientCallMock(customFormsMock) } as any,
            {} as any,
            undefined,
            undefined,
            run
        )

        await service.deleteExistingForms()

        expect(run.deletedFusionReviewForms).toEqual([
            { formDefinitionId: 'form-1', formName: 'Fusion Review - Ada [HR] (hr::ada)' },
        ])
        expect(run.deletedFusionReviewForms.map((entry) => entry.formDefinitionId)).not.toContain('open-1')
    })
})

describe('FormService stale cleanup with simulated replay time', () => {
    const simulatedTime = '2026-07-31T08:24:12.899Z'
    const simulatedMs = Date.parse(simulatedTime)

    function buildService(forms: Array<{ id: string; name: string; created: string }>) {
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({
            data: { results: forms },
        })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })
        const customFormsMock = {
            searchFormInstancesByTenant,
            searchFormDefinitionsByTenant,
            deleteFormDefinition: vi.fn().mockResolvedValue({}),
        }
        const run = new FusionRun()
        run.setSimulatedTime(simulatedTime)

        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion',
                fusionFormExpirationDays: 7,
            } as any,
            {
                warn: vi.fn(),
                info: vi.fn(),
                debug: vi.fn(),
                setProgress: vi.fn(),
                track: vi.fn(() => ({ done: vi.fn() })),
            } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
                execute: async (fn: () => Promise<any>) => fn(),
            } as any,
            {} as any,
            undefined,
            undefined,
            run
        )

        return { service, searchFormInstancesByTenant, run }
    }

    it('treats form as active when created 3 days before simulated replay time', async () => {
        const created = new Date(simulatedMs - 3 * 24 * 60 * 60 * 1000).toISOString()
        const { service, searchFormInstancesByTenant, run } = buildService([
            { id: 'form-active', name: 'Fusion active', created },
        ])

        await service.fetchFormInstances({ staleFormCleanup: true })

        expect(searchFormInstancesByTenant).toHaveBeenCalledTimes(1)
        expect(run.formsFound).toBe(1)
    })

    it('treats form as stale when created 10 days before simulated replay time', async () => {
        const created = new Date(simulatedMs - 10 * 24 * 60 * 60 * 1000).toISOString()
        const { service, searchFormInstancesByTenant, run } = buildService([
            { id: 'form-stale', name: 'Fusion stale', created },
        ])

        await service.fetchFormInstances({ staleFormCleanup: true })

        expect(searchFormInstancesByTenant).not.toHaveBeenCalled()
        expect(run.formsFound).toBe(0)
    })
})

describe('FormService managed work queue synchronization', () => {
    it('removes account from managedAccountsByIdentityId when account is removed from managedAccountsById', () => {
        const managedKey = 'source-a-id::native-sync-1'
        const identityId = 'identity-sync-1'
        const managedAccount = {
            id: 'acct-sync-1',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            nativeIdentity: 'native-sync-1',
            identityId,
            name: 'Sync User',
        } as any

        const managedAccountsById = new Map([[managedKey, managedAccount]])
        const managedAccountInventory = new Map([
            [
                managedKey,
                {
                    id: managedAccount.id,
                    name: managedAccount.name,
                    sourceName: managedAccount.sourceName,
                    sourceId: managedAccount.sourceId,
                    nativeIdentity: managedAccount.nativeIdentity,
                },
            ],
        ])
        const managedAccountsByIdentityId = new Map([[identityId, new Set([managedKey])]])

        const run = {
            managedAccountsById,
            managedAccountInventory,
            managedAccountsByIdentityId,
            hasManagedAccount: (key: string) => managedAccountInventory.has(key),
            getManagedAccountInfo: (key: string) => managedAccountInventory.get(key),
            claimAccount: vi.fn((key: string, identityId?: string) => {
                const deleted = managedAccountsById.delete(key)
                if (identityId) {
                    const idSet = managedAccountsByIdentityId.get(identityId)
                    if (idSet) {
                        idSet.delete(key)
                        if (idSet.size === 0) {
                            managedAccountsByIdentityId.delete(identityId)
                        }
                    }
                }
                return deleted
            }),
        } as any

        const sources = {
            run,
            getSourceByNameSafe: vi.fn(() => undefined),
        } as any

        const service = new FormService(
            {} as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {} as any,
            sources,
            undefined,
            undefined,
            run
        )

        const accountInfo = (service as any).extractAccountInfoOverride(managedKey, true)

        expect(accountInfo).toEqual({
            id: managedKey,
            iscAccountId: 'acct-sync-1',
            name: 'Sync User',
            sourceName: 'Source A',
            sourceId: 'source-a-id',
            nativeIdentity: 'native-sync-1',
        })
        expect(managedAccountsById.has(managedKey)).toBe(false)
        expect(managedAccountsByIdentityId.has(identityId)).toBe(false)
    })

    it('claims pending review account using normalized form account id', () => {
        const managedKey = 'source-a-id::native-sync-1'
        const identityId = 'identity-sync-1'
        const managedAccount = {
            id: 'acct-sync-1',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            nativeIdentity: 'native-sync-1',
            identityId,
            name: 'Sync User',
        } as any

        const managedAccountsById = new Map([[managedKey, managedAccount]])
        const managedAccountInventory = new Map([
            [
                managedKey,
                {
                    id: managedAccount.id,
                    name: managedAccount.name,
                    sourceName: managedAccount.sourceName,
                    sourceId: managedAccount.sourceId,
                    nativeIdentity: managedAccount.nativeIdentity,
                    identityId,
                },
            ],
        ])
        const managedAccountsByIdentityId = new Map([[identityId, new Set([managedKey])]])
        const claimAccount = vi.fn((key: string, claimIdentityId?: string) => {
            managedAccountsById.delete(key)
            if (claimIdentityId) {
                const idSet = managedAccountsByIdentityId.get(claimIdentityId)
                idSet?.delete(key)
                if (idSet && idSet.size === 0) {
                    managedAccountsByIdentityId.delete(claimIdentityId)
                }
            }
            return true
        })

        const run = {
            managedAccountsById,
            managedAccountInventory,
            managedAccountsByIdentityId,
            hasManagedAccount: (key: string) => managedAccountInventory.has(key),
            getManagedAccountInfo: (key: string) => managedAccountInventory.get(key),
            claimAccount,
        } as any

        const service = new FormService(
            {} as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {} as any,
            { run, getSourceByNameSafe: vi.fn(() => undefined) } as any,
            undefined,
            undefined,
            run
        )

        const accountInfo = (service as any).extractAccountInfoOverride(' source-a-id::native-sync-1 ', true)

        expect(accountInfo?.id).toBe(managedKey)
        expect(claimAccount).toHaveBeenCalledWith(managedKey, identityId)
        expect(managedAccountsById.has(managedKey)).toBe(false)
    })

    it('returns inventory metadata after prior pending-review claim in the same batch', () => {
        const managedKey = 'source-a-id::native-sync-1'
        const identityId = 'identity-sync-1'
        const inventoryInfo = {
            id: 'acct-sync-1',
            name: 'Sync User',
            sourceName: 'Source A',
            sourceId: 'source-a-id',
            nativeIdentity: 'native-sync-1',
            identityId,
        }
        const managedAccountsById = new Map<string, any>()
        const managedAccountInventory = new Map([[managedKey, inventoryInfo]])
        const run = {
            managedAccountsById,
            managedAccountInventory,
            managedAccountsByIdentityId: new Map(),
            hasManagedAccount: (key: string) => managedAccountInventory.has(key),
            getManagedAccountInfo: (key: string) => managedAccountInventory.get(key),
            claimAccount: vi.fn(),
        } as any

        const service = new FormService(
            {} as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {} as any,
            { run, getSourceByNameSafe: vi.fn(() => undefined) } as any,
            undefined,
            undefined,
            run
        )

        const accountInfo = (service as any).extractAccountInfoOverride(managedKey, true)

        expect(accountInfo).toEqual({
            id: managedKey,
            iscAccountId: 'acct-sync-1',
            name: 'Sync User',
            sourceName: 'Source A',
            sourceId: 'source-a-id',
            nativeIdentity: 'native-sync-1',
        })
        expect(run.claimAccount).not.toHaveBeenCalled()
    })
})

describe('FormService processFetchedFormData pending review queue depletion', () => {
    it('removes pending-review account from work queue while retaining inventory', async () => {
        const managedKey = 'source-a-id::native-sync-1'
        const run = new FusionRun()
        run.setManagedAccount(managedKey, {
            id: 'acct-sync-1',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            nativeIdentity: 'native-sync-1',
            identityId: 'identity-sync-1',
            name: 'Sync User',
        } as any)

        const service = new FormService(
            {} as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {} as any,
            { run, getSourceByNameSafe: vi.fn(() => undefined) } as any,
            undefined,
            undefined,
            run
        )

        ;(service as any).fetchedFormInstances = [
            [
                {
                    id: 'instance-1',
                    state: 'PENDING',
                    formDefinitionId: 'form-def-1',
                    formInput: {
                        account: managedKey,
                        name: 'Sync User',
                        source: 'Source A',
                    },
                },
            ],
        ]

        await service.processFetchedFormData()

        expect(run.managedAccountsById.has(managedKey)).toBe(false)
        expect(run.hasManagedAccount(managedKey)).toBe(true)
        expect(run.getManagedAccountInfo(managedKey)?.identityId).toBe('identity-sync-1')
    })
})

describe('FormService createFusionForm', () => {
    it('awaits form instance creation before returning so run counters stay aligned', async () => {
        FusionAccount.configure({ sources: ['Source A'] } as any)

        const createFormDefinition = vi.fn().mockResolvedValue({ data: { id: 'form-def-1', name: 'Fusion Review' } })
        const createFormInstance = vi.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    setTimeout(() => resolve({ data: { id: 'inst-1', standAloneFormUrl: 'https://review/1' } }), 30)
                })
        )
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({ data: { results: [] } })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })

        const customFormsMock = {
            createFormDefinition,
            createFormInstance,
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
        }

        const run = new FusionRun()
        const sources = {
            fusionSourceId: 'fusion-src',
            fusionSourceOwner: { id: 'owner-1', type: 'IDENTITY' },
            getSourceByNameSafe: vi.fn().mockReturnValue({ sourceType: SourceType.Authoritative }),
        }

        const fusionAccount = FusionAccount.fromManagedAccount({
            id: 'acct-1',
            nativeIdentity: 'native-1',
            name: 'Test User',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            attributes: { email: 'user@example.com' },
        } as any)
        fusionAccount.layers.addFusionMatch({
            fusionIdentity: {
                identityId: 'candidate-1',
                attributes: { displayName: 'Candidate One', email: 'candidate@example.com' },
            },
            scores: [{ attribute: 'email', algorithm: 'lig3', score: 85, fusionScore: 50 }],
        } as any)

        const reviewer = FusionAccount.fromIdentity({
            id: 'reviewer-1',
            name: 'Reviewer',
            attributes: { email: 'reviewer@example.com' },
        } as any)

        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion Review',
                fusionFormExpirationDays: 7,
                fusionFormAttributes: ['Email'],
                fusionMaxCandidatesForForm: 10,
            } as any,
            { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            sources as any,
            undefined,
            undefined,
            run
        )

        const outcome = await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(outcome).toEqual({ formDefinitionReady: true, newReviewInstancesQueued: 1 })
        expect(run.formsCreated).toBe(1)
        expect(run.formInstancesCreated).toBe(1)
        expect(createFormInstance).toHaveBeenCalledTimes(1)
    })

    it('builds localized form definition when localization is enabled with defaultLanguage fr', async () => {
        FusionAccount.configure({ sources: ['Source A'] } as any)

        const createFormDefinition = vi.fn().mockResolvedValue({ data: { id: 'form-def-1', name: 'Fusion Review' } })
        const createFormInstance = vi.fn().mockResolvedValue({
            data: { id: 'inst-1', standAloneFormUrl: 'https://review/1' },
        })
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({ data: { results: [] } })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })

        const customFormsMock = {
            createFormDefinition,
            createFormInstance,
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
        }

        const run = new FusionRun()
        const sources = {
            fusionSourceId: 'fusion-src',
            fusionSourceOwner: { id: 'owner-1', type: 'IDENTITY' },
            getSourceByNameSafe: vi.fn().mockReturnValue({ sourceType: SourceType.Authoritative }),
        }

        const fusionAccount = FusionAccount.fromManagedAccount({
            id: 'acct-1',
            nativeIdentity: 'native-1',
            name: 'Test User',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            attributes: { email: 'user@example.com' },
        } as any)
        fusionAccount.layers.addFusionMatch({
            fusionIdentity: {
                identityId: 'candidate-1',
                attributes: { displayName: 'Candidate One', email: 'candidate@example.com' },
            },
            scores: [{ attribute: 'email', algorithm: 'lig3', score: 85, fusionScore: 50 }],
        } as any)

        const reviewer = FusionAccount.fromIdentity({
            id: 'reviewer-1',
            name: 'Reviewer',
            attributes: { email: 'reviewer@example.com' },
        } as any)

        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion Review',
                fusionFormExpirationDays: 7,
                fusionFormAttributes: ['Email'],
                fusionMaxCandidatesForForm: 10,
                enableLocalization: true,
                defaultLanguage: 'fr',
            } as any,
            { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            sources as any,
            undefined,
            undefined,
            run
        )

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(createFormDefinition).toHaveBeenCalledTimes(1)
        const formBody = createFormDefinition.mock.calls[0][0].body
        const identitiesSection = formBody.formElements.find(
            (element: { key?: string }) => element.key === 'identitiesSection'
        )
        const toggle = identitiesSection?.config?.formElements?.[0]?.config?.columns?.[0]?.[0]
        expect(toggle?.config?.label).toBe('Nouvelle identité')
        expect(formBody.description).toMatch(/^fusion-locale:\d+:fr\|/)
        expect(formBody.name).toMatch(/ \[fr\]$/)
    })

    it('builds formInput HTML links from UrlContext', async () => {
        FusionAccount.configure({ sources: ['Source A'] } as any)

        const createFormDefinition = vi.fn().mockResolvedValue({ data: { id: 'form-def-1', name: 'Fusion Review' } })
        const createFormInstance = vi.fn().mockResolvedValue({
            data: { id: 'inst-1', standAloneFormUrl: 'https://review/1' },
        })
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({ data: { results: [] } })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })

        const customFormsMock = {
            createFormDefinition,
            createFormInstance,
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
        }

        const fusionAccount = FusionAccount.fromManagedAccount({
            id: 'acct-1',
            nativeIdentity: 'native-1',
            name: 'Test User',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            attributes: { email: 'user@example.com' },
        } as any)
        fusionAccount.layers.addFusionMatch({
            fusionIdentity: {
                identityId: 'candidate-1',
                attributes: { displayName: 'Candidate One', email: 'candidate@example.com' },
            },
            scores: [{ attribute: 'email', algorithm: 'lig3', score: 85, fusionScore: 50, isMatch: true }],
        } as any)

        const reviewer = FusionAccount.fromIdentity({
            id: 'reviewer-1',
            name: 'Reviewer',
            attributes: { email: 'reviewer@example.com' },
        } as any)

        const service = new FormService(
            {
                baseurl: 'https://example.api.identitynow.com',
                fusionFormNamePattern: 'Fusion Review',
                fusionFormExpirationDays: 7,
                fusionFormAttributes: ['Email'],
                fusionMaxCandidatesForForm: 10,
            } as any,
            { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {
                fusionSourceId: 'fusion-src',
                fusionSourceOwner: { id: 'owner-1', type: 'IDENTITY' },
                getSourceByNameSafe: vi.fn().mockReturnValue({ sourceType: SourceType.Authoritative }),
            } as any,
            undefined,
            undefined,
            new FusionRun()
        )

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        const formInput = createFormInstance.mock.calls[0][0].body.formInput
        expect(formInput.accountHtml).toContain('accounts-management/human-accounts/acct-1')
        expect(formInput.candidatesHtml).toContain('identities/candidate-1/details/attributes')
        expect(formInput.accountHtml).toContain('target="_blank"')
        const formElements = createFormDefinition.mock.calls[0][0].body.formElements
        const allKeys = JSON.stringify(formElements)
        expect(allKeys).not.toContain('"elementType":"TEXT"')
        expect(allKeys).toContain('newIdentity')
        expect(allKeys).toContain('identities')
    })

    it('builds English form definition when localization is disabled despite defaultLanguage fr', async () => {
        FusionAccount.configure({ sources: ['Source A'] } as any)

        const createFormDefinition = vi.fn().mockResolvedValue({ data: { id: 'form-def-1', name: 'Fusion Review' } })
        const createFormInstance = vi.fn().mockResolvedValue({
            data: { id: 'inst-1', standAloneFormUrl: 'https://review/1' },
        })
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({ data: { results: [] } })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })

        const customFormsMock = {
            createFormDefinition,
            createFormInstance,
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
        }

        const run = new FusionRun()
        const sources = {
            fusionSourceId: 'fusion-src',
            fusionSourceOwner: { id: 'owner-1', type: 'IDENTITY' },
            getSourceByNameSafe: vi.fn().mockReturnValue({ sourceType: SourceType.Authoritative }),
        }

        const fusionAccount = FusionAccount.fromManagedAccount({
            id: 'acct-1',
            nativeIdentity: 'native-1',
            name: 'Test User',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            attributes: { email: 'user@example.com' },
        } as any)
        fusionAccount.layers.addFusionMatch({
            fusionIdentity: {
                identityId: 'candidate-1',
                attributes: { displayName: 'Candidate One', email: 'candidate@example.com' },
            },
            scores: [{ attribute: 'email', algorithm: 'lig3', score: 85, fusionScore: 50 }],
        } as any)

        const reviewer = FusionAccount.fromIdentity({
            id: 'reviewer-1',
            name: 'Reviewer',
            attributes: { email: 'reviewer@example.com' },
        } as any)

        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion Review',
                fusionFormExpirationDays: 7,
                fusionFormAttributes: ['Email'],
                fusionMaxCandidatesForForm: 10,
                enableLocalization: false,
                defaultLanguage: 'fr',
            } as any,
            { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            sources as any,
            undefined,
            undefined,
            run
        )

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(createFormDefinition).toHaveBeenCalledTimes(1)
        const formElements = createFormDefinition.mock.calls[0][0].body.formElements
        const identitiesSection = formElements.find((element: { key?: string }) => element.key === 'identitiesSection')
        const toggle = identitiesSection?.config?.formElements?.[0]?.config?.columns?.[0]?.[0]
        expect(toggle?.config?.label).toBe('New identity')
        expect(createFormDefinition.mock.calls[0][0].body.description).toContain('Review potential matching identity')
    })

    it('creates a new localized form definition instead of reusing a legacy English definition', async () => {
        FusionAccount.configure({ sources: ['Source A'] } as any)

        const legacyEnglishDefinition = {
            id: 'form-def-legacy',
            name: 'Fusion Review - Test User [Source A] (source-a-id::native-1)',
            description:
                'Review potential matching identity and decide whether to create a new identity or merge with an existing one',
        }
        const createFormDefinition = vi.fn().mockResolvedValue({ data: { id: 'form-def-fr', name: 'localized' } })
        const patchFormDefinition = vi.fn()
        const createFormInstance = vi.fn().mockResolvedValue({
            data: { id: 'inst-1', standAloneFormUrl: 'https://review/1' },
        })
        const searchFormDefinitionsByTenant = vi
            .fn()
            .mockResolvedValue({ data: { results: [legacyEnglishDefinition] } })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({ data: [] })

        const customFormsMock = {
            createFormDefinition,
            patchFormDefinition,
            createFormInstance,
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
        }

        const run = new FusionRun()
        const sources = {
            fusionSourceId: 'fusion-src',
            fusionSourceOwner: { id: 'owner-1', type: 'IDENTITY' },
            getSourceByNameSafe: vi.fn().mockReturnValue({ sourceType: SourceType.Authoritative }),
        }

        const fusionAccount = FusionAccount.fromManagedAccount({
            id: 'acct-1',
            nativeIdentity: 'native-1',
            name: 'Test User',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            attributes: { email: 'user@example.com' },
        } as any)
        fusionAccount.layers.addFusionMatch({
            fusionIdentity: {
                identityId: 'candidate-1',
                attributes: { displayName: 'Candidate One', email: 'candidate@example.com' },
            },
            scores: [{ attribute: 'email', algorithm: 'lig3', score: 85, fusionScore: 50 }],
        } as any)

        const reviewer = FusionAccount.fromIdentity({
            id: 'reviewer-1',
            name: 'Reviewer',
            attributes: { email: 'reviewer@example.com' },
        } as any)

        const info = vi.fn()
        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion Review',
                fusionFormExpirationDays: 7,
                fusionFormAttributes: ['Email'],
                fusionMaxCandidatesForForm: 10,
                enableLocalization: true,
                defaultLanguage: 'fr',
            } as any,
            { warn: vi.fn(), debug: vi.fn(), info, error: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            sources as any,
            undefined,
            undefined,
            run
        )

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(createFormDefinition).toHaveBeenCalledTimes(1)
        expect(patchFormDefinition).not.toHaveBeenCalled()
        const formBody = createFormDefinition.mock.calls[0][0].body
        expect(formBody.name).toBe('Fusion Review - Test User [Source A] (source-a-id::native-1) [fr]')
        const identitiesSection = formBody.formElements.find(
            (element: { key?: string }) => element.key === 'identitiesSection'
        )
        const toggle = identitiesSection?.config?.formElements?.[0]?.config?.columns?.[0]?.[0]
        expect(toggle?.config?.label).toBe('Nouvelle identité')
        expect(info).toHaveBeenCalledWith(expect.stringContaining('Creating fusion form definition'))
        expect(info).toHaveBeenCalledWith(expect.stringContaining('toggle label="Nouvelle identité"'))
    })

    it('Restyle does not migrate pending instances without Reset forms', async () => {
        FusionAccount.configure({ sources: ['Source A'] } as any)
        const existingDefinition = {
            id: 'form-pending',
            name: 'Fusion Review - Test User [Source A] (source-a-id::native-1)',
        }
        const createFormDefinition = vi.fn()
        const deleteFormDefinition = vi.fn()
        const patchFormDefinition = vi.fn()
        const createFormInstance = vi.fn().mockResolvedValue({
            data: { id: 'inst-1', standAloneFormUrl: 'https://review/1' },
        })
        const searchFormDefinitionsByTenant = vi.fn().mockResolvedValue({ data: { results: [existingDefinition] } })
        const searchFormInstancesByTenant = vi.fn().mockResolvedValue({
            data: [{ id: 'pending-1', formDefinitionId: 'form-pending', state: 'ASSIGNED', recipients: [] }],
        })

        const customFormsMock = {
            createFormDefinition,
            deleteFormDefinition,
            patchFormDefinition,
            createFormInstance,
            searchFormDefinitionsByTenant,
            searchFormInstancesByTenant,
        }

        const fusionAccount = FusionAccount.fromManagedAccount({
            id: 'acct-1',
            nativeIdentity: 'native-1',
            name: 'Test User',
            sourceId: 'source-a-id',
            sourceName: 'Source A',
            attributes: { email: 'user@example.com' },
        } as any)
        fusionAccount.layers.addFusionMatch({
            fusionIdentity: {
                identityId: 'candidate-1',
                attributes: { displayName: 'Candidate One', email: 'candidate@example.com' },
            },
            scores: [{ attribute: 'email', algorithm: 'lig3', score: 85, fusionScore: 50 }],
        } as any)

        const reviewer = FusionAccount.fromIdentity({
            id: 'reviewer-1',
            name: 'Reviewer',
            attributes: { email: 'reviewer@example.com' },
        } as any)

        const service = new FormService(
            {
                fusionFormNamePattern: 'Fusion Review',
                fusionFormExpirationDays: 7,
                fusionFormAttributes: ['Email'],
                fusionMaxCandidatesForForm: 10,
                enableLocalization: false,
            } as any,
            { warn: vi.fn(), debug: vi.fn(), info: vi.fn() } as any,
            {
                customFormsApi: customFormsMock,
                call: createFormClientCallMock(customFormsMock),
            } as any,
            {
                fusionSourceId: 'fusion-src',
                fusionSourceOwner: { id: 'owner-1', type: 'IDENTITY' },
                getSourceByNameSafe: vi.fn().mockReturnValue({ sourceType: SourceType.Authoritative }),
            } as any,
            undefined,
            undefined,
            new FusionRun()
        )

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(createFormDefinition).not.toHaveBeenCalled()
        expect(deleteFormDefinition).not.toHaveBeenCalled()
        expect(patchFormDefinition).not.toHaveBeenCalled()
        expect(createFormInstance).toHaveBeenCalled()
    })

    it('Reviewer language attribute sets form locale', async () => {
        const { service, createFormDefinition, createFormInstance } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: undefined,
            getRecipientLocale: async () => 'ja',
        })
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-ja')

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        const formBody = createFormDefinition.mock.calls[0][0].body
        expect(formBody.name).toMatch(/ \[ja\]$/)
        expect(toggleLabelFromDefinition(formBody.formElements)).toBe('新規アイデンティティ')
        expect(createFormInstance.mock.calls[0][0].body.formInput.candidatesHtml).toContain('しきい値')
    })

    it('Review forms use reviewer locale', async () => {
        const { service, createFormDefinition } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'ja',
            getRecipientLocale: async () => 'en',
        })
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-en')

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        const formBody = createFormDefinition.mock.calls[0][0].body
        expect(toggleLabelFromDefinition(formBody.formElements)).toBe('New identity')
        expect(formBody.name).toMatch(/ \[en\]$/)
        expect(formBody.name).not.toMatch(/ \[ja\]$/)
    })

    it('Localization enabled with French defaultLanguage', async () => {
        const { service, createFormDefinition } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'fr',
        })
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-1')

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        const formBody = createFormDefinition.mock.calls[0][0].body
        expect(toggleLabelFromDefinition(formBody.formElements)).toBe('Nouvelle identité')
        expect(formBody.description).toMatch(/^fusion-locale:\d+:fr\|/)
    })

    it('Unsupported defaultLanguage falls back to English', async () => {
        const { service, createFormDefinition } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'xx',
        })
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-1')

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        const formBody = createFormDefinition.mock.calls[0][0].body
        expect(toggleLabelFromDefinition(formBody.formElements)).toBe('New identity')
        expect(formBody.name).toMatch(/ \[en\]$/)
    })

    it('Two reviewers with different language attributes get two definitions', async () => {
        const { service, createFormDefinition, createFormInstance } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'en',
            getRecipientLocale: async (id) => (id === 'reviewer-fr' ? 'fr' : 'de'),
        })
        const { fusionAccount } = buildManagedAccountAndReviewer('unused')
        const reviewerFr = FusionAccount.fromIdentity({
            id: 'reviewer-fr',
            name: 'French Reviewer',
            attributes: { preferredLanguage: 'fr' },
        } as any)
        const reviewerDe = FusionAccount.fromIdentity({
            id: 'reviewer-de',
            name: 'German Reviewer',
            attributes: { preferredLanguage: 'de' },
        } as any)

        await service.createFusionForm(fusionAccount, new Set([reviewerFr, reviewerDe]))

        expect(createFormDefinition).toHaveBeenCalledTimes(2)
        const names = createFormDefinition.mock.calls.map((call) => call[0].body.name)
        expect(names.some((name: string) => name.endsWith(' [fr]'))).toBe(true)
        expect(names.some((name: string) => name.endsWith(' [de]'))).toBe(true)
        const frBody = createFormDefinition.mock.calls.find((call) => call[0].body.name.endsWith(' [fr]'))[0].body
        const deBody = createFormDefinition.mock.calls.find((call) => call[0].body.name.endsWith(' [de]'))[0].body
        expect(toggleLabelFromDefinition(frBody.formElements)).toBe('Nouvelle identité')
        expect(toggleLabelFromDefinition(deBody.formElements)).toBe('Neue Identität')
        expect(createFormInstance).toHaveBeenCalledTimes(2)
        const frInstance = createFormInstance.mock.calls.find((call) => call[0].body.recipients[0].id === 'reviewer-fr')
        const deInstance = createFormInstance.mock.calls.find((call) => call[0].body.recipients[0].id === 'reviewer-de')
        expect(frInstance[0].body.formInput.candidatesHtml).toContain('Seuil')
        expect(deInstance[0].body.formInput.candidatesHtml).toContain('Schwellenwert')
    })

    it('Localization disabled uses one English definition with no suffix', async () => {
        const { service, createFormDefinition } = buildLocalizedCreateFusionFormHarness({
            enableLocalization: false,
            defaultLanguage: 'fr',
        })
        const { fusionAccount } = buildManagedAccountAndReviewer('unused')
        const reviewerA = FusionAccount.fromIdentity({
            id: 'reviewer-a',
            name: 'A',
            attributes: { preferredLanguage: 'de' },
        } as any)
        const reviewerB = FusionAccount.fromIdentity({
            id: 'reviewer-b',
            name: 'B',
            attributes: { preferredLanguage: 'fr' },
        } as any)

        await service.createFusionForm(fusionAccount, new Set([reviewerA, reviewerB]))

        expect(createFormDefinition).toHaveBeenCalledTimes(1)
        const formBody = createFormDefinition.mock.calls[0][0].body
        expect(formBody.name).not.toMatch(/ \[[a-z]{2}\]$/)
        expect(toggleLabelFromDefinition(formBody.formElements)).toBe('New identity')
    })

    it('Distinct reviewers on different locale groups are not duplicate reviews', async () => {
        const accountPrefix = 'Fusion Review - Test User [Source A] (source-a-id::native-1)'
        const { service, createFormInstance } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'en',
            getRecipientLocale: async (id) => (id === 'reviewer-a' ? 'fr' : 'de'),
            existingDefinitions: [
                {
                    id: 'form-fr',
                    name: `${accountPrefix} [fr]`,
                    description: 'fusion-locale:3:fr|French description',
                    formElements: [{ key: 'newIdentity', config: { label: 'Nouvelle identité' } }],
                },
                {
                    id: 'form-de',
                    name: `${accountPrefix} [de]`,
                    description: 'fusion-locale:3:de|German description',
                    formElements: [{ key: 'newIdentity', config: { label: 'Neue Identität' } }],
                },
            ],
            existingInstancesByDefinitionId: {
                'form-fr': [
                    {
                        id: 'inst-fr',
                        formDefinitionId: 'form-fr',
                        state: 'ASSIGNED',
                        recipients: [{ id: 'reviewer-a' }],
                    },
                ],
                'form-de': [
                    {
                        id: 'inst-de',
                        formDefinitionId: 'form-de',
                        state: 'ASSIGNED',
                        recipients: [{ id: 'reviewer-b' }],
                    },
                ],
            },
        })
        const { fusionAccount } = buildManagedAccountAndReviewer('unused')
        const reviewerA = FusionAccount.fromIdentity({ id: 'reviewer-a', name: 'A', attributes: {} } as any)
        const reviewerB = FusionAccount.fromIdentity({ id: 'reviewer-b', name: 'B', attributes: {} } as any)

        const outcome = await service.createFusionForm(fusionAccount, new Set([reviewerA, reviewerB]))

        expect(createFormInstance).not.toHaveBeenCalled()
        expect(outcome.newReviewInstancesQueued).toBe(0)
    })

    it('Language attribute change does not reissue an in-flight review', async () => {
        const accountPrefix = 'Fusion Review - Test User [Source A] (source-a-id::native-1)'
        const { service, createFormInstance } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'en',
            getRecipientLocale: async () => 'de',
            existingDefinitions: [
                {
                    id: 'form-fr',
                    name: `${accountPrefix} [fr]`,
                    description: 'fusion-locale:3:fr|French description',
                    formElements: [{ key: 'newIdentity', config: { label: 'Nouvelle identité' } }],
                },
            ],
            existingInstancesByDefinitionId: {
                'form-fr': [
                    {
                        id: 'inst-fr',
                        formDefinitionId: 'form-fr',
                        state: 'ASSIGNED',
                        recipients: [{ id: 'reviewer-1' }],
                    },
                ],
            },
        })
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-1')

        const outcome = await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(createFormInstance).not.toHaveBeenCalled()
        expect(outcome.newReviewInstancesQueued).toBe(0)
    })

    it('French definition is not refreshed for a German defaultLanguage', async () => {
        const accountPrefix = 'Fusion Review - Test User [Source A] (source-a-id::native-1)'
        const frenchDefinition = {
            id: 'form-fr',
            name: `${accountPrefix} [fr]`,
            description: 'fusion-locale:3:fr|French description',
            formElements: [{ key: 'newIdentity', config: { label: 'Nouvelle identité' } }],
        }
        const { service, createFormDefinition, patchFormDefinition, deleteFormDefinition } =
            buildLocalizedCreateFusionFormHarness({
                defaultLanguage: 'de',
                getRecipientLocale: async () => 'fr',
                existingDefinitions: [frenchDefinition],
            })
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-fr')

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(createFormDefinition).not.toHaveBeenCalled()
        expect(patchFormDefinition).not.toHaveBeenCalled()
        expect(deleteFormDefinition).not.toHaveBeenCalled()
    })

    it.each([['CANCELLED'], ['COMPLETED']])(
        'reissues a review when the reviewer only has a %s instance',
        async (state) => {
            const accountPrefix = 'Fusion Review - Test User [Source A] (source-a-id::native-1)'
            const { service, createFormInstance } = buildLocalizedCreateFusionFormHarness({
                defaultLanguage: 'fr',
                getRecipientLocale: async () => 'fr',
                existingDefinitions: [
                    {
                        id: 'form-fr',
                        name: `${accountPrefix} [fr]`,
                        description: 'fusion-locale:3:fr|French description',
                        formElements: [{ key: 'newIdentity', config: { label: 'Nouvelle identité' } }],
                    },
                ],
                existingInstancesByDefinitionId: {
                    'form-fr': [
                        {
                            id: 'inst-fr',
                            formDefinitionId: 'form-fr',
                            state,
                            recipients: [{ id: 'reviewer-1' }],
                        },
                    ],
                },
            })
            const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-1')

            const outcome = await service.createFusionForm(fusionAccount, new Set([reviewer]))

            expect(createFormInstance).toHaveBeenCalledTimes(1)
            expect(createFormInstance.mock.calls[0][0].body.recipients[0].id).toBe('reviewer-1')
            expect(outcome.newReviewInstancesQueued).toBe(1)
        }
    )

    it('creates a new definition when the search returns a definition that was already deleted', async () => {
        const accountPrefix = 'Fusion Review - Test User [Source A] (source-a-id::native-1)'
        const { service, createFormDefinition, createFormInstance } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'fr',
            getRecipientLocale: async () => 'fr',
            existingDefinitions: [
                {
                    id: 'form-deleted',
                    name: `${accountPrefix} [fr]`,
                    description: 'fusion-locale:3:fr|French description',
                },
            ],
            missingByKeyDefinitionIds: ['form-deleted'],
        })
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-1')

        const outcome = await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(createFormDefinition).toHaveBeenCalledTimes(1)
        expect(createFormInstance).toHaveBeenCalledTimes(1)
        expect(outcome.formDefinitionReady).toBe(true)
        expect(outcome.newReviewInstancesQueued).toBe(1)
    })

    it('replaces a form definition already marked for deletion before issuing a review', async () => {
        const accountPrefix = 'Fusion Review - Test User [Source A] (source-a-id::native-1)'
        const { service, run, createFormDefinition, createFormInstance, deleteFormDefinition } =
            buildLocalizedCreateFusionFormHarness({
                defaultLanguage: 'fr',
                getRecipientLocale: async () => 'fr',
                existingDefinitions: [
                    {
                        id: 'form-fr',
                        name: `${accountPrefix} [fr]`,
                        description: 'fusion-locale:3:fr|French description',
                        formElements: [{ key: 'newIdentity', config: { label: 'Nouvelle identité' } }],
                    },
                ],
                existingInstancesByDefinitionId: {
                    'form-fr': [
                        {
                            id: 'inst-fr',
                            formDefinitionId: 'form-fr',
                            state: 'CANCELLED',
                            recipients: [{ id: 'reviewer-1' }],
                        },
                    ],
                },
            })
        run.formsToDelete.add('form-fr')
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-1')

        const outcome = await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(deleteFormDefinition).toHaveBeenCalledWith({ formDefinitionID: 'form-fr' })
        expect(createFormDefinition).toHaveBeenCalledTimes(1)
        const newDefinitionId = createFormDefinition.mock.results[0].value
        expect(createFormInstance.mock.calls[0][0].body.formDefinitionId).toBe((await newDefinitionId).data.id)
        expect(run.formsToDelete.has('form-fr')).toBe(false)
        expect(outcome.newReviewInstancesQueued).toBe(1)
    })

    it('Replace-before-recreate delete is retained', async () => {
        const accountPrefix = 'Fusion Review - Test User [Source A] (source-a-id::native-1)'
        const formName = `${accountPrefix} [fr]`
        const { service, run } = buildLocalizedCreateFusionFormHarness({
            defaultLanguage: 'fr',
            getRecipientLocale: async () => 'fr',
            existingDefinitions: [
                {
                    id: 'form-fr',
                    name: formName,
                    description: 'fusion-locale:3:fr|French description',
                    formElements: [{ key: 'newIdentity', config: { label: 'Nouvelle identité' } }],
                },
            ],
            existingInstancesByDefinitionId: {
                'form-fr': [
                    {
                        id: 'inst-fr',
                        formDefinitionId: 'form-fr',
                        state: 'CANCELLED',
                        recipients: [{ id: 'reviewer-1' }],
                    },
                ],
            },
        })
        run.formsToDelete.add('form-fr')
        run.rememberFusionReviewFormName('form-fr', formName)
        const { fusionAccount, reviewer } = buildManagedAccountAndReviewer('reviewer-1')

        await service.createFusionForm(fusionAccount, new Set([reviewer]))

        expect(run.deletedFusionReviewForms).toEqual([{ formDefinitionId: 'form-fr', formName }])
    })
})

describe('FormService getOrCreateFormDefinition conflict recovery', () => {
    it('recreates localized definition when one already exists for the same name', async () => {
        FusionAccount.configure({ sources: [] } as any)
        const existingDefinition = {
            id: 'form-existing',
            name: 'Fusion Test Form [fr]',
            description:
                'Review potential matching identity and decide whether to create a new identity or merge with an existing one',
        }
        const createdDefinition = {
            id: 'form-new',
            name: 'Fusion Test Form [fr]',
            description: 'fusion-locale:3:fr|French description',
        }
        const getFormDefinitionByName = vi.fn().mockResolvedValue(existingDefinition)
        const deleteFormDefinition = vi.fn().mockResolvedValue(undefined)
        const buildFusionFormDefinition = vi.fn().mockResolvedValue(createdDefinition)
        const refreshFusionFormDefinition = vi.fn()

        const service = new FormService(
            { enableLocalization: true, defaultLanguage: 'fr' } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {} as any,
            {} as any
        )
        ;(service as any).getFormDefinitionByName = getFormDefinitionByName
        ;(service as any).getFormDefinitionByKeySafe = vi.fn().mockResolvedValue(existingDefinition)
        ;(service as any).deleteFormDefinition = deleteFormDefinition
        ;(service as any).buildFusionFormDefinition = buildFusionFormDefinition
        ;(service as any).refreshFusionFormDefinition = refreshFusionFormDefinition

        const result = await (service as any).getOrCreateFormDefinition(
            'Fusion Test Form [fr]',
            FusionAccount.fromManagedAccount({
                id: 'acct-1',
                nativeIdentity: 'native-1',
                name: 'Managed Account',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as any),
            [],
            'fr'
        )

        expect(result).toEqual(createdDefinition)
        expect(deleteFormDefinition).toHaveBeenCalledWith('form-existing', 'Fusion Test Form [fr]')
        expect(buildFusionFormDefinition).toHaveBeenCalledTimes(1)
        expect(refreshFusionFormDefinition).not.toHaveBeenCalled()
    })

    it('patches definition recovered after duplicate-name create conflict when localized', async () => {
        FusionAccount.configure({ sources: [] } as any)
        const existingDefinition = {
            id: 'form-existing',
            name: 'Fusion Test Form [fr]',
            description:
                'Review potential matching identity and decide whether to create a new identity or merge with an existing one',
        }
        const patchedDefinition = {
            id: 'form-existing',
            name: 'Fusion Test Form [fr]',
            description: 'fusion-locale:3:fr|French description',
        }
        const getFormDefinitionByName = vi
            .fn()
            .mockResolvedValueOnce(existingDefinition)
            .mockResolvedValueOnce(existingDefinition)
        const deleteFormDefinition = vi.fn().mockResolvedValue(undefined)
        const buildFusionFormDefinition = vi.fn().mockRejectedValue({
            response: { status: 409, data: { detailCode: '400.1.409' } },
        })
        const refreshFusionFormDefinition = vi.fn().mockResolvedValue(patchedDefinition)

        const service = new FormService(
            { enableLocalization: true, defaultLanguage: 'fr' } as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {} as any,
            {} as any
        )
        ;(service as any).getFormDefinitionByName = getFormDefinitionByName
        ;(service as any).getFormDefinitionByKeySafe = vi.fn().mockResolvedValue(existingDefinition)
        ;(service as any).deleteFormDefinition = deleteFormDefinition
        ;(service as any).buildFusionFormDefinition = buildFusionFormDefinition
        ;(service as any).refreshFusionFormDefinition = refreshFusionFormDefinition

        const result = await (service as any).getOrCreateFormDefinition(
            'Fusion Test Form [fr]',
            FusionAccount.fromManagedAccount({
                id: 'acct-1',
                nativeIdentity: 'native-1',
                name: 'Managed Account',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as any),
            [],
            'fr'
        )

        expect(result).toEqual(patchedDefinition)
        expect(refreshFusionFormDefinition).toHaveBeenCalledTimes(1)
    })

    it('reuses existing definition after duplicate-name create conflict', async () => {
        FusionAccount.configure({ sources: [] } as any)
        const existingDefinition = { id: 'form-existing', name: 'Fusion Test Form' }
        const getFormDefinitionByName = vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValueOnce(existingDefinition)
        const buildFusionFormDefinition = vi.fn().mockRejectedValue({
            response: { status: 409, data: { detailCode: '400.1.409' } },
        })

        const service = new FormService(
            {} as any,
            { warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any,
            {} as any,
            {} as any
        )
        ;(service as any).getFormDefinitionByName = getFormDefinitionByName
        ;(service as any).buildFusionFormDefinition = buildFusionFormDefinition

        const result = await (service as any).getOrCreateFormDefinition(
            'Fusion Test Form',
            FusionAccount.fromManagedAccount({
                id: 'acct-1',
                nativeIdentity: 'native-1',
                name: 'Managed Account',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as any),
            [],
            'en'
        )

        expect(result).toEqual(existingDefinition)
        expect(getFormDefinitionByName).toHaveBeenCalledTimes(2)
        expect(buildFusionFormDefinition).toHaveBeenCalledTimes(1)
    })
})

describe('formInstanceAnalyzer', () => {
    it('extractAccountIdFromInstance normalizes composite managed account keys', () => {
        const accountId = extractAccountIdFromInstance({
            formInput: { account: 'source-a::native-1' },
        } as any)
        expect(accountId).toBe('source-a::native-1')
    })

    it('analyzeFormInstances marks form for deletion when a response instance exists', () => {
        const log = { debug: vi.fn(), info: vi.fn() } as any
        const result = analyzeFormInstances(
            [{ id: 'fi-1', state: 'COMPLETED', formDefinitionId: 'fd-1', formInput: {} } as any],
            { log, hasManagedAccount: () => true }
        )
        expect(result.shouldDeleteForm).toBe(true)
        expect(result.instancesToProcess).toHaveLength(1)
    })
})
describe('FormService finished decision reporting metadata', () => {
    it('stores iscAccountId when registering finished decisions', () => {
        const managedKey = 'source-a-id::native-report-1'
        const managedAccountInventory = new Map<string, any>([
            [managedKey, { id: 'isc-report-1', name: 'Report User', sourceName: 'Source A' }],
        ])
        const run = {
            fusionIdentityDecisions: [],
            addFinishedFusionDecision: vi.fn(),
            addDecision: vi.fn(),
            managedAccountsById: new Map(),
            managedAccountInventory,
            hasManagedAccount: (key: string) => managedAccountInventory.has(key),
            getManagedAccountInfo: (key: string) => managedAccountInventory.get(key),
            getFusionAccountByManagedKey: vi.fn(() => undefined),
            getFusionIdentity: vi.fn(() => undefined),
            allFusionAccounts: [],
            allFusionIdentities: [],
        }
        const sources = {
            resolveIscAccountIdForManagedKey: vi.fn((key: string) => managedAccountInventory.get(key)?.id),
        }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 1 } as any,
            { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
            {} as any,
            sources as any,
            undefined,
            undefined,
            run as any
        )

        ;(service as any).registerFinishedDecision({
            submitter: { id: 'system', email: '', name: 'System (automatic merge)' },
            account: { id: managedKey, name: 'Report User', sourceName: 'Source A' },
            newIdentity: false,
            identityId: 'identity-report-1',
            comments: 'Automatically merged',
            finished: true,
            automaticMerge: true,
        })

        expect((service as any).finishedFusionDecisionsValue[0].account.iscAccountId).toBe('isc-report-1')
    })

    it('stores isMachine when registering a finished machine-account decision', () => {
        const managedKey = 'source-a-id::machine-report-1'
        const managedAccountInventory = new Map<string, any>([
            [managedKey, { id: 'isc-machine-1', name: 'Batch Bot', sourceName: 'Source A', isMachine: true }],
        ])
        const run = {
            fusionIdentityDecisions: [],
            addFinishedFusionDecision: vi.fn(),
            addDecision: vi.fn(),
            managedAccountsById: new Map(),
            managedAccountInventory,
            hasManagedAccount: (key: string) => managedAccountInventory.has(key),
            getManagedAccountInfo: (key: string) => managedAccountInventory.get(key),
            getFusionAccountByManagedKey: vi.fn(() => undefined),
            getFusionIdentity: vi.fn(() => undefined),
            allFusionAccounts: [],
            allFusionIdentities: [],
        }
        const sources = {
            resolveIscAccountIdForManagedKey: vi.fn((key: string) => managedAccountInventory.get(key)?.id),
        }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 1 } as any,
            { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
            {} as any,
            sources as any,
            undefined,
            undefined,
            run as any
        )

        ;(service as any).registerFinishedDecision({
            submitter: { id: 'system', email: '', name: 'System (automatic merge)' },
            account: { id: managedKey, name: 'Batch Bot', sourceName: 'Source A' },
            newIdentity: false,
            identityId: 'identity-report-1',
            comments: 'Automatically merged',
            finished: true,
            automaticMerge: true,
        })

        expect((service as any).finishedFusionDecisionsValue[0].account.isMachine).toBe(true)
        expect((service as any).finishedFusionDecisionsValue[0].account.iscAccountId).toBe('isc-machine-1')
    })

    it('resolves sourceType from the managed source when the form input omits it', async () => {
        const run = {
            fusionIdentityDecisions: [],
            addFinishedFusionDecision: vi.fn(),
            addDecision: vi.fn(),
            managedAccountsById: new Map(),
            managedAccountInventory: new Map(),
            hasManagedAccount: vi.fn(() => false),
            getManagedAccountInfo: vi.fn(() => undefined),
            getFusionAccountByManagedKey: vi.fn(() => undefined),
            getFusionIdentity: vi.fn(() => undefined),
            allFusionAccounts: [],
            allFusionIdentities: [],
        }
        const sources = {
            resolveIscAccountIdForManagedKey: vi.fn(() => undefined),
            getSourceByNameSafe: vi.fn(() => ({ sourceType: SourceType.Orphan })),
        }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 1 } as any,
            { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogLevel: vi.fn(() => 'info') } as any,
            {} as any,
            sources as any,
            undefined,
            undefined,
            run as any
        )

        await (service as any).createDecisionsFromInstances(
            [
                {
                    id: 'fi-orphan',
                    state: 'COMPLETED',
                    formDefinitionId: 'fd-1',
                    recipients: [{ id: 'reviewer-1', type: 'IDENTITY' }],
                    formInput: { account: 'src-m::machine-1', name: 'Machine', source: 'Machines' },
                    formData: { newIdentity: true },
                },
            ],
            undefined
        )

        expect((service as any).finishedFusionDecisionsValue[0].sourceType).toBe(SourceType.Orphan)
    })
})
describe('FormService finished decision reviewer metadata', () => {
    it('stores submitter display name when registering finished decisions', () => {
        const reviewerId = 'reviewer-report-1'
        const identities = {
            getIdentityById: vi.fn((id?: string) => (id === reviewerId ? { id, name: 'Reviewer Display' } : undefined)),
        }
        const run = {
            fusionIdentityDecisions: [],
            addFinishedFusionDecision: vi.fn(),
            addDecision: vi.fn(),
            managedAccountsById: new Map(),
            managedAccountInventory: new Map(),
            hasManagedAccount: vi.fn(() => false),
            getManagedAccountInfo: vi.fn(() => undefined),
            getFusionAccountByManagedKey: vi.fn(() => undefined),
            getFusionIdentity: vi.fn(() => undefined),
            allFusionAccounts: [],
            allFusionIdentities: [],
        }
        const sources = { resolveIscAccountIdForManagedKey: vi.fn(() => undefined) }
        const service = new FormService(
            { fusionFormNamePattern: 'Fusion Review', fusionFormExpirationDays: 1 } as any,
            { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
            {} as any,
            sources as any,
            identities as any,
            undefined,
            run as any
        )

        ;(service as any).registerFinishedDecision({
            submitter: { id: reviewerId, email: '', name: '' },
            account: { id: 'source-a-id::native-1', name: 'User', sourceName: 'Source A' },
            newIdentity: false,
            identityId: 'identity-1',
            comments: '',
            finished: true,
        })

        expect((service as any).finishedFusionDecisionsValue[0].submitter.name).toBe('Reviewer Display')
    })
})

import { SourceService } from '../sourceService'
import { buildIdentityAttributeCreateErrorMessage } from '../sourceReverseCorrelationErrors'
import { SourceInfo } from '../types'
import { OrphanProcessingMode, SourceType } from '../../../model/config'
import { FusionRun } from '../../../model/fusionRun'

const createService = (sourceConfigOverrides: Record<string, unknown> = {}) => {
    const config: any = {
        sources: [
            {
                name: 'HR Source',
                sourceType: SourceType.Authoritative,
                ...sourceConfigOverrides,
            },
        ],
        spConnectorInstanceId: 'fusion-id',
        concurrencyCheckEnabled: true,
        batchCumulativeCount: {},
        attributeMaps: [],
        normalAttributeDefinitions: [],
        uniqueAttributeDefinitions: [],
    }
    const log: any = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        detail: vi.fn(),
        setProgress: vi.fn(),
        setFetchPopulationProgress: vi.fn(),
    }
    const client: any = {
        execute: async (fn: () => Promise<any>) => fn(),
        call: vi.fn((fn: any, policy?: any) => {
            const api = {
                accounts: client.accountsApi,
                sources: client.sourcesApi,
                taskManagement: client.taskManagementApi,
                governanceGroups: client.governanceGroupsApi,
                identityProfiles: client.identityProfilesApi,
                identityAttributes: client.identityAttributesApi,
                machineAccounts: client.machineAccountsApi,
                search: client.searchApi,
                identities: client.identitiesApi,
                customForms: client.customFormsApi,
                workflows: client.workflowsApi,
            }
            if (policy?.paginate) {
                if (policy.paginate.mode === 'parallel') {
                    return client.paginateParallel(
                        (params: any) => fn(api, params),
                        policy.paginate.baseParams ?? {},
                        policy.priority,
                        policy.context,
                        policy.abortSignal,
                        policy.paginate.limit
                    )
                }
                return client.paginate(
                    (params: any) => fn(api, params),
                    policy.paginate.baseParams ?? {},
                    policy.priority,
                    policy.context
                )
            }
            return fn(api)
        }),
        paginate: vi.fn(),
        paginateParallel: vi.fn(),
        accountsApi: { listAccounts: vi.fn() },
        sourcesApi: { importAccounts: vi.fn() },
        taskManagementApi: { getTaskStatus: vi.fn() },
        identityProfilesApi: {},
        identityAttributesApi: {},
        machineAccountsApi: {
            updateMachineAccount: vi.fn().mockResolvedValue({ data: {} }),
            listMachineAccounts: vi.fn().mockResolvedValue({ data: [] }),
        },
    }

    const run = new FusionRun()
    const service = new SourceService(config, log, client, run)
    const sourceInfo: SourceInfo = {
        id: 'managed-source-id',
        name: 'HR Source',
        isManaged: true,
        sourceType: (sourceConfigOverrides.sourceType as SourceInfo['sourceType']) ?? SourceType.Authoritative,
        config: config.sources[0],
    }
    ;(service as any).allSourcesValue = [sourceInfo]
    ;(service as any).sourcesById = new Map([[sourceInfo.id, sourceInfo]])
    ;(service.run as any).sourcesByName = new Map([[sourceInfo.name, sourceInfo]])

    return { service, client, sourceInfo, log }
}

describe('SourceService Accounts JMESPath filter', () => {
    it('filters managed accounts page-wise during fetchManagedAccounts', async () => {
        const { service, sourceInfo } = createService({
            accountJmespathFilter: 'accounts[?attributes.department == `Engineering`]',
        })

        vi.spyOn(service, 'fetchAccountsBySourceIdGenerator').mockImplementation(async function* () {
            yield [
                {
                    id: 'a1',
                    identityId: 'i1',
                    sourceId: 'managed-source-id',
                    nativeIdentity: 'eng-1',
                    attributes: { department: 'Engineering' },
                } as any,
                {
                    id: 'a2',
                    identityId: 'i2',
                    sourceId: 'managed-source-id',
                    nativeIdentity: 'fin-1',
                    attributes: { department: 'Finance' },
                } as any,
            ]
        })
        ;(service as any).allSourcesValue = [sourceInfo]
        await service.fetchManagedAccounts()

        expect((service as any).run.managedAccountsById.size).toBe(1)
        expect((service as any).run.managedAccountsById.has('managed-source-id::eng-1')).toBe(true)
        expect((service as any).run.managedAccountsById.has('managed-source-id::fin-1')).toBe(false)
    })

    it('updates aggregate fetch progress on each page progress callback', async () => {
        const { service, sourceInfo, log } = createService()

        vi.spyOn(service, 'fetchAccountsBySourceIdGenerator').mockImplementation(
            async function* (_sourceId, _abort, _limit, onPageProgress) {
                onPageProgress?.(100, 300)
                yield [{ id: 'a1', nativeIdentity: 'n1', sourceId: sourceInfo.id } as any]
                onPageProgress?.(200, 300)
                yield [{ id: 'a2', nativeIdentity: 'n2', sourceId: sourceInfo.id } as any]
                onPageProgress?.(300, 300)
            }
        )
        ;(service as any).allSourcesValue = [sourceInfo]

        await service.fetchManagedAccounts()

        expect(log.setFetchPopulationProgress).toHaveBeenNthCalledWith(1, 'managed-accounts', 1, 300)
        expect(log.setFetchPopulationProgress).toHaveBeenNthCalledWith(2, 'managed-accounts', 2, 300)
        expect(log.setProgress).not.toHaveBeenCalled()
    })

    it('aggregates fetch progress across concurrent managed sources on each page callback', async () => {
        const config: any = {
            sources: [
                { name: 'Source A', sourceType: SourceType.Authoritative },
                { name: 'Source B', sourceType: SourceType.Authoritative },
            ],
            spConnectorInstanceId: 'fusion-id',
            concurrencyCheckEnabled: true,
            batchCumulativeCount: {},
            attributeMaps: [],
            normalAttributeDefinitions: [],
            uniqueAttributeDefinitions: [],
        }
        const log: any = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            setProgress: vi.fn(),
            setFetchPopulationProgress: vi.fn(),
        }
        const client: any = {
            execute: async (fn: () => Promise<any>) => fn(),
            call: vi.fn(),
            paginate: vi.fn(),
            paginateParallel: vi.fn(),
            accountsApi: { listAccounts: vi.fn() },
            sourcesApi: { importAccounts: vi.fn() },
            taskManagementApi: { getTaskStatus: vi.fn() },
            identityProfilesApi: {},
            identityAttributesApi: {},
        }
        const run = new FusionRun()
        const service = new SourceService(config, log, client, run)
        const sourceA: SourceInfo = {
            id: 'source-a-id',
            name: 'Source A',
            isManaged: true,
            sourceType: SourceType.Authoritative,
            config: config.sources[0],
        }
        const sourceB: SourceInfo = {
            id: 'source-b-id',
            name: 'Source B',
            isManaged: true,
            sourceType: SourceType.Authoritative,
            config: config.sources[1],
        }
        ;(service as any).allSourcesValue = [sourceA, sourceB]
        ;(service as any).sourcesById = new Map([
            [sourceA.id, sourceA],
            [sourceB.id, sourceB],
        ])
        ;(service.run as any).sourcesByName = new Map([
            [sourceA.name, sourceA],
            [sourceB.name, sourceB],
        ])

        vi.spyOn(service, 'fetchAccountsBySourceIdGenerator').mockImplementation(
            async function* (sourceId, _abort, _limit, onPageProgress) {
                if (sourceId === sourceA.id) {
                    onPageProgress?.(100, 200)
                    yield [{ id: 'a1', nativeIdentity: 'a1', sourceId: sourceA.id } as any]
                    await new Promise((resolve) => setTimeout(resolve, 10))
                    onPageProgress?.(200, 200)
                } else if (sourceId === sourceB.id) {
                    await new Promise((resolve) => setTimeout(resolve, 5))
                    onPageProgress?.(150, 300)
                    yield [{ id: 'b1', nativeIdentity: 'b1', sourceId: sourceB.id } as any]
                    onPageProgress?.(300, 300)
                }
            }
        )

        await service.fetchManagedAccounts()

        expect(log.setFetchPopulationProgress).toHaveBeenCalledWith('managed-accounts', 1, 1)
        expect(log.setFetchPopulationProgress).toHaveBeenCalledWith('managed-accounts', 2, 500)
        expect(log.setProgress).not.toHaveBeenCalled()
    })

    it('rejects invalid JMESPath expressions in validation', () => {
        const { service } = createService({
            accountJmespathFilter: 'accounts[?',
        })

        expect(() => service.validateAccountJmespathFilters()).toThrow(
            'Invalid Accounts JMESPath filter for source "HR Source"'
        )
    })
})

describe('SourceService Ownership fetch registration', () => {
    const ownershipSource = {
        sourceType: SourceType.Orphan,
        orphanProcessingMode: OrphanProcessingMode.Ownership,
        accountLimit: 1,
    }

    function mockBatch(service: SourceService, accounts: Record<string, unknown>[]) {
        vi.spyOn(service, 'fetchAccountsBySourceIdGenerator').mockImplementation(async function* () {
            yield accounts as any
        })
    }

    it('registers a correlated unowned machine account', async () => {
        const { service } = createService(ownershipSource)
        mockBatch(service, [
            {
                id: 'owned-first',
                sourceId: 'managed-source-id',
                nativeIdentity: 'owned-1',
                isMachine: true,
                ownerIdentity: { type: 'IDENTITY', id: 'owner-1' },
            },
            {
                id: 'correlated',
                sourceId: 'managed-source-id',
                nativeIdentity: 'machine-1',
                isMachine: true,
                identityId: 'ident-1',
                uncorrelated: false,
            },
        ])

        await service.fetchManagedAccounts()

        expect(service.run.managedAccountsById.has('managed-source-id::machine-1')).toBe(true)
        expect(service.run.managedAccountsById.has('managed-source-id::owned-1')).toBe(false)
    })

    it('registers an unowned uncorrelated machine account', async () => {
        const { service } = createService(ownershipSource)
        mockBatch(service, [
            {
                id: 'uncorrelated',
                sourceId: 'managed-source-id',
                nativeIdentity: 'machine-2',
                isMachine: true,
                uncorrelated: true,
                ownerIdentity: { type: 'IDENTITY', id: '   ' },
            },
        ])

        await service.fetchManagedAccounts()

        expect(service.run.managedAccountsById.has('managed-source-id::machine-2')).toBe(true)
    })

    it('skips a machine account with an established owner identity', async () => {
        const { service } = createService(ownershipSource)
        const disableSpy = vi.spyOn(service.run, 'queueDisableOperation')
        mockBatch(service, [
            {
                id: 'owned',
                sourceId: 'managed-source-id',
                nativeIdentity: 'owned-1',
                isMachine: true,
                ownerIdentity: { type: 'IDENTITY', id: 'owner-1' },
            },
        ])

        await service.fetchManagedAccounts()

        expect(service.run.managedAccountsById.size).toBe(0)
        expect(disableSpy).not.toHaveBeenCalled()
    })

    it('skips a non-machine account on an Ownership source', async () => {
        const { service } = createService(ownershipSource)
        const disableSpy = vi.spyOn(service.run, 'queueDisableOperation')
        mockBatch(service, [
            {
                id: 'human',
                sourceId: 'managed-source-id',
                nativeIdentity: 'human-1',
                isMachine: false,
            },
            {
                id: 'eligible',
                sourceId: 'managed-source-id',
                nativeIdentity: 'machine-3',
                isMachine: true,
            },
        ])

        await service.fetchManagedAccounts()

        expect(service.run.managedAccountsById.has('managed-source-id::human-1')).toBe(false)
        expect(service.run.managedAccountsById.has('managed-source-id::machine-3')).toBe(true)
        expect(disableSpy).not.toHaveBeenCalled()
    })

    it('discards a machine account on an Assignment-mode Orphan source', async () => {
        const { service } = createService({ sourceType: SourceType.Orphan })
        mockBatch(service, [
            {
                id: 'machine',
                sourceId: 'managed-source-id',
                nativeIdentity: 'machine-4',
                isMachine: true,
            },
            {
                id: 'human',
                sourceId: 'managed-source-id',
                nativeIdentity: 'human-2',
                isMachine: false,
            },
        ])

        await service.fetchManagedAccounts()

        expect(service.run.managedAccountsById.has('managed-source-id::machine-4')).toBe(false)
        expect(service.run.managedAccountsById.has('managed-source-id::human-2')).toBe(true)
    })

    it('discards a machine account on an Authoritative source', async () => {
        const { service } = createService()
        mockBatch(service, [
            {
                id: 'machine',
                sourceId: 'managed-source-id',
                nativeIdentity: 'machine-5',
                isMachine: true,
            },
        ])

        await service.fetchManagedAccounts()

        expect(service.run.managedAccountsById.has('managed-source-id::machine-5')).toBe(false)
    })
})

describe('SourceService.fetchFusionAccounts bulk ingest', () => {
    it('registers each page before requesting the next and reports Fusion population progress', async () => {
        const { service, log } = createService()
        ;(service as any).fusionSourceIdValue = 'fusion-source-id'
        const setImmediateSpy = vi.spyOn(global, 'setImmediate')

        vi.spyOn(service, 'fetchAccountsBySourceIdGenerator').mockImplementation(
            async function* (_sourceId, _abort, _limit, onPageProgress) {
                onPageProgress?.(2, 3)
                yield [{ id: 'f1', nativeIdentity: 'native-1' } as any, { id: 'f2', nativeIdentity: 'native-2' } as any]
                expect(service.fusionAccountsByNativeIdentity?.has('native-1')).toBe(true)
                onPageProgress?.(3, 3)
                yield [{ id: 'f3', nativeIdentity: 'native-3' } as any]
            }
        )

        await service.fetchFusionAccounts()

        expect(Array.from(service.fusionAccountsByNativeIdentity?.keys() ?? [])).toEqual([
            'native-1',
            'native-2',
            'native-3',
        ])
        expect(setImmediateSpy).toHaveBeenCalledTimes(2)
        expect(log.detail).toHaveBeenCalledWith({ action: 'ingesting fusion-accounts', count: 3 })
        expect(log.setFetchPopulationProgress).toHaveBeenLastCalledWith('fusion-accounts', 3, 3)
        expect(log.setProgress).not.toHaveBeenCalled()
        setImmediateSpy.mockRestore()
    })

    it('replaces the previous map and omits Fusion population progress when empty', async () => {
        const { service, log } = createService()
        ;(service as any).fusionSourceIdValue = 'fusion-source-id'
        service.fusionAccountsByNativeIdentity = new Map([['stale', { id: 'stale', nativeIdentity: 'stale' } as any]])
        vi.spyOn(service, 'fetchAccountsBySourceIdGenerator').mockImplementation(async function* () {
            yield* []
        })

        await service.fetchFusionAccounts()

        expect(service.fusionAccountsByNativeIdentity.size).toBe(0)
        expect(log.setFetchPopulationProgress).not.toHaveBeenCalledWith(
            'fusion-accounts',
            expect.anything(),
            expect.anything()
        )
        expect(log.detail).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'ingesting fusion-accounts' }))
    })
})

describe('SourceService per-source aggregation polling', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('on zero-minute timeout performs one status check then warns with timeout fields', async () => {
        vi.useFakeTimers({ now: 0 })
        const { service, client } = createService({
            aggregationMode: 'before',
            aggregationTimeout: 0,
        })

        client.sourcesApi.importAccounts.mockResolvedValue({
            data: { task: { id: 'task-1' } },
        })
        client.taskManagementApi.getTaskStatus.mockResolvedValue({
            data: { completed: false, completionStatus: 'IN_PROGRESS' },
        })

        const promise = (service as any).aggregateManagedSource('managed-source-id', false, true)
        await Promise.resolve()
        await promise

        expect(client.taskManagementApi.getTaskStatus).toHaveBeenCalledTimes(1)
        expect((service as any).log.warn).toHaveBeenCalledWith(
            expect.stringMatching(/timeoutMinutes=0, pollIntervalMs=30000, pollsExecuted=1/)
        )
    })

    it('after one poll interval hits timeout with two polls executed', async () => {
        vi.useFakeTimers({ now: 0 })
        const { service, client } = createService({
            aggregationMode: 'before',
            aggregationTimeout: 1,
        })

        client.sourcesApi.importAccounts.mockResolvedValue({
            data: { task: { id: 'task-1' } },
        })
        client.taskManagementApi.getTaskStatus.mockResolvedValue({
            data: { completed: false, completionStatus: 'IN_PROGRESS' },
        })

        const promise = (service as any).aggregateManagedSource('managed-source-id', false, true)
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(30_000)
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(30_000)
        await Promise.resolve()
        await promise

        expect(client.taskManagementApi.getTaskStatus).toHaveBeenCalledTimes(2)
        expect((service as any).log.warn).toHaveBeenCalledWith(
            expect.stringMatching(/timeoutMinutes=1, pollIntervalMs=30000, pollsExecuted=2/)
        )
    })

    it('stops polling when task completes before timeout', async () => {
        vi.useFakeTimers({ now: 0 })
        const { service, client } = createService({
            aggregationMode: 'before',
            aggregationTimeout: 10,
        })

        client.sourcesApi.importAccounts.mockResolvedValue({
            data: { task: { id: 'task-1' } },
        })
        client.taskManagementApi.getTaskStatus
            .mockResolvedValueOnce({
                data: { completed: false, completionStatus: 'IN_PROGRESS' },
            })
            .mockResolvedValueOnce({
                data: { completed: true, completionStatus: 'SUCCESS' },
            })

        const promise = (service as any).aggregateManagedSource('managed-source-id', false, true)
        await Promise.resolve()
        await vi.advanceTimersByTimeAsync(30_000)
        await Promise.resolve()
        await promise

        expect(client.taskManagementApi.getTaskStatus).toHaveBeenCalledTimes(2)
        expect((service as any).log.warn).not.toHaveBeenCalled()
    })
})

describe('SourceService fetchManagedAccount (sourceId + nativeIdentity)', () => {
    it('warns and skips when sourceId is not a configured managed source', async () => {
        const { service, log } = createService()

        await service.fetchManagedAccount('unknown-source-id', 'user-1')

        expect((service as any).run.managedAccountsById.size).toBe(0)
        expect(log.warn).toHaveBeenCalledWith(
            expect.stringContaining('non-configured or non-managed source "unknown-source-id"')
        )
    })

    it('loads one account via filtered listAccounts and indexes by composite key', async () => {
        const { service, client } = createService()
        client.accountsApi.listAccounts.mockResolvedValue({
            data: [
                {
                    id: 'plat-1',
                    identityId: 'id-1',
                    sourceId: 'managed-source-id',
                    nativeIdentity: 'user-1',
                    sourceName: 'HR Source',
                } as any,
            ],
        })

        await service.fetchManagedAccount('managed-source-id', 'user-1')

        expect(client.accountsApi.listAccounts).toHaveBeenCalledWith(
            expect.objectContaining({
                filters: expect.stringContaining('nativeIdentity eq "user-1"'),
            })
        )
        expect((service as any).run.managedAccountsById.size).toBe(1)
        expect((service as any).run.managedAccountsById.get('managed-source-id::user-1')).toBeDefined()
        expect(service.run.managedAccountsByIdentityId.get('id-1')?.has('managed-source-id::user-1')).toBe(true)
    })

    it('leaves inventory empty when listAccounts returns no accounts (e.g. accountFilter mismatch)', async () => {
        const { service, client } = createService({ accountFilter: 'nativeIdentity sw "ad_"' })
        client.accountsApi.listAccounts.mockResolvedValue({ data: [] })

        await service.fetchManagedAccount('managed-source-id', 'bob')

        expect((service as any).run.managedAccountsById.size).toBe(0)
    })

    it('leaves inventory empty when JMESPath filter discards the candidate', async () => {
        const { service, client } = createService({
            accountJmespathFilter: 'accounts[?attributes.department == `Engineering`]',
        })
        client.accountsApi.listAccounts.mockResolvedValue({
            data: [
                {
                    id: 'a1',
                    sourceId: 'managed-source-id',
                    nativeIdentity: 'fin-1',
                    sourceName: 'HR Source',
                    attributes: { department: 'Finance' },
                } as any,
            ],
        })

        await service.fetchManagedAccount('managed-source-id', 'fin-1')

        expect((service as any).run.managedAccountsById.size).toBe(0)
    })
})

describe('SourceService.fetchAllSources', () => {
    it('syncs discovered sources back to service state', async () => {
        const { service, client } = createService()
        ;(service as any).allSourcesValue = undefined
        ;(service as any).fusionSourceIdValue = undefined
        ;(service as any).sourcesById = new Map()
        service.run.sourcesByName.clear()

        client.paginate.mockResolvedValue([
            { id: 'managed-source-id', name: 'HR Source', connectorAttributes: {} },
            {
                id: 'fusion-source-id',
                name: 'Fusion Source',
                owner: { id: 'owner-id', type: 'IDENTITY' },
                connectorAttributes: { spConnectorInstanceId: 'fusion-id' },
            },
        ])

        await service.fetchAllSources()

        expect(service.managedSources).toHaveLength(1)
        expect(service.managedSources[0].name).toBe('HR Source')
        expect(service.hasFusionSource).toBe(true)
        expect(service.fusionSourceId).toBe('fusion-source-id')
        expect(service.getSourceByNameSafe('HR Source')?.id).toBe('managed-source-id')
    })

    it('populates allSourcesValue, sourcesById, and run.sourcesByName with the same SourceInfo references', async () => {
        const { service, client } = createService()
        ;(service as any).allSourcesValue = undefined
        ;(service as any).fusionSourceIdValue = undefined
        ;(service as any).sourcesById = new Map()
        service.run.sourcesByName.clear()

        client.paginate.mockResolvedValue([
            { id: 'managed-source-id', name: 'HR Source', connectorAttributes: {} },
            {
                id: 'fusion-source-id',
                name: 'Fusion Source',
                owner: { id: 'owner-id', type: 'IDENTITY' },
                connectorAttributes: { spConnectorInstanceId: 'fusion-id' },
            },
        ])

        await service.fetchAllSources()

        const managedFromList = service.allSources.find((s) => s.name === 'HR Source')
        const fusionFromList = service.allSources.find((s) => s.name === 'Fusion Source')
        const managedFromId = service.getSourceById('managed-source-id')
        const fusionFromId = service.getSourceById('fusion-source-id')
        const managedFromName = service.getSourceByName('HR Source')
        const fusionFromName = service.getSourceByName('Fusion Source')

        expect(managedFromList).toBeDefined()
        expect(fusionFromList).toBeDefined()
        expect(managedFromList).toBe(managedFromId)
        expect(managedFromList).toBe(managedFromName)
        expect(fusionFromList).toBe(fusionFromId)
        expect(fusionFromList).toBe(fusionFromName)
    })
})

describe('SourceService source lookup boundaries', () => {
    it('returns undefined for missing or blank source names via safe lookup', () => {
        const { service } = createService()

        expect(service.getSourceByNameSafe(undefined)).toBeUndefined()
        expect(service.getSourceByNameSafe(null)).toBeUndefined()
        expect(service.getSourceByNameSafe('')).toBeUndefined()
        expect(service.getSourceByNameSafe('   ')).toBeUndefined()
    })
})

describe('SourceService account pagination sorter stability', () => {
    it('uses sorters=id for paginated fetch by source id', async () => {
        const { service, client } = createService()
        client.paginate.mockResolvedValue([])

        await service.fetchAccountsBySourceId('managed-source-id')

        expect(client.paginate).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({ sorters: 'id' }),
            expect.anything(),
            expect.any(String)
        )
    })

    it('uses sorters=id for generator-based fetch by source id', async () => {
        const { service, client } = createService()
        client.paginateParallel.mockImplementation(async function* () {
            yield []
        })

        for await (const _batch of service.fetchAccountsBySourceIdGenerator('managed-source-id')) {
            // consume generator
        }

        expect(client.call).toHaveBeenCalledWith(
            expect.any(Function),
            expect.objectContaining({
                paginate: expect.objectContaining({ mode: 'parallel' }),
                priority: expect.anything(),
                context: expect.any(String),
            })
        )
    })
})

describe('SourceService reverse correlation setup hardening', () => {
    it('attempts one repair pass and succeeds when consistency is restored', async () => {
        const { service } = createService({
            correlationMode: 'reverse',
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        })

        ;(service as any).fusionSourceIdValue = 'fusion-source-id'
        service.run.sourcesByName.set('Fusion Source', {
            id: 'fusion-source-id',
            name: 'Fusion Source',
            isManaged: false,
            sourceType: SourceType.Authoritative,
            config: undefined,
        })
        service.run.sourcesByName.set('HR Source', {
            id: 'managed-source-id',
            name: 'HR Source',
            isManaged: true,
            sourceType: SourceType.Authoritative,
            config: {
                name: 'HR Source',
                correlationMode: 'reverse',
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            },
        })

        vi.spyOn(service, 'validateNoAttributeOverlap').mockImplementation(() => {})
        const phasesSpy = vi.spyOn(service as any, 'ensureReverseCorrelationSetupPhases').mockResolvedValue(undefined)
        const statusSpy = vi.spyOn(service as any, 'getReverseCorrelationSetupStatus')
        statusSpy
            .mockResolvedValueOnce({
                isConsistent: false,
                missingArtifacts: ['identity_attribute'],
            })
            .mockResolvedValueOnce({
                isConsistent: true,
                missingArtifacts: [],
            })
        const repairSpy = vi.spyOn(service as any, 'repairReverseCorrelationSetup').mockResolvedValue(undefined)

        await service.ensureReverseCorrelationSetup(
            {
                name: 'HR Source',
                correlationMode: 'reverse',
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            } as any,
            new Set()
        )

        expect(phasesSpy).toHaveBeenCalledTimes(1)
        expect(repairSpy).toHaveBeenCalledTimes(1)
        expect(statusSpy).toHaveBeenCalledTimes(2)
    })

    it('throws when setup remains inconsistent after one repair pass', async () => {
        const { service } = createService({
            correlationMode: 'reverse',
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        })

        service.run.sourcesByName.set('HR Source', {
            id: 'managed-source-id',
            name: 'HR Source',
            isManaged: true,
            sourceType: SourceType.Authoritative,
            config: {
                name: 'HR Source',
                correlationMode: 'reverse',
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            },
        })
        vi.spyOn(service, 'validateNoAttributeOverlap').mockImplementation(() => {})
        vi.spyOn(service as any, 'ensureReverseCorrelationSetupPhases').mockResolvedValue(undefined)
        vi.spyOn(service as any, 'repairReverseCorrelationSetup').mockResolvedValue(undefined)
        vi.spyOn(service as any, 'getReverseCorrelationSetupStatus').mockResolvedValue({
            isConsistent: false,
            missingArtifacts: ['identity_profile_mapping'],
        })

        await expect(
            service.ensureReverseCorrelationSetup(
                {
                    name: 'HR Source',
                    correlationMode: 'reverse',
                    correlationAttribute: 'reverseNativeIdentity',
                    correlationDisplayName: 'Reverse Native Identity',
                } as any,
                new Set()
            )
        ).rejects.toThrow('Reverse correlation setup is inconsistent')
    })

    it.each(['record', 'orphan'] as const)(
        'runs minimal reverse correlation phases for sourceType=%s (identity attribute + managed correlation only)',
        async (sourceType) => {
            const { service } = createService({
                correlationMode: 'reverse',
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
                sourceType,
            })

            ;(service as any).fusionSourceIdValue = 'fusion-source-id'
            service.run.sourcesByName.set('Fusion Source', {
                id: 'fusion-source-id',
                name: 'Fusion Source',
                isManaged: false,
                sourceType: SourceType.Authoritative,
                config: undefined,
            })
            const hrConfig = {
                name: 'HR Source',
                sourceType,
                correlationMode: 'reverse' as const,
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            }
            service.run.sourcesByName.set('HR Source', {
                id: 'managed-source-id',
                name: 'HR Source',
                isManaged: true,
                sourceType,
                config: hrConfig,
            })

            vi.spyOn(service, 'validateNoAttributeOverlap').mockImplementation(() => {})
            const fusionSpy = vi.spyOn(service as any, 'ensureFusionSchemaAttribute').mockResolvedValue(undefined)
            const identitySpy = vi.spyOn(service as any, 'ensureIdentityAttribute').mockResolvedValue(undefined)
            const profileSpy = vi.spyOn(service as any, 'ensureIdentityProfileMapping').mockResolvedValue(undefined)
            const managedSpy = vi.spyOn(service as any, 'ensureManagedSourceCorrelation').mockResolvedValue(undefined)
            vi.spyOn(service as any, 'getReverseCorrelationSetupStatus').mockResolvedValue({
                isConsistent: true,
                missingArtifacts: [],
            })

            await service.ensureReverseCorrelationSetup(hrConfig as any, new Set())

            expect(fusionSpy).not.toHaveBeenCalled()
            expect(profileSpy).not.toHaveBeenCalled()
            expect(identitySpy).toHaveBeenCalledWith('reverseNativeIdentity', 'Reverse Native Identity')
            expect(managedSpy).toHaveBeenCalledWith('reverseNativeIdentity', 'managed-source-id')
        }
    )
})

describe('SourceService authoritative reverse correlation identity profile mapping', () => {
    it('does not PATCH identity profile when a transform for the correlation attribute already exists', async () => {
        const { service, client } = createService({
            correlationMode: 'reverse',
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        })
        const fusionSource: SourceInfo = {
            id: 'fusion-source-id',
            name: 'Fusion Source',
            isManaged: false,
            sourceType: SourceType.Authoritative,
            config: undefined,
        }
        const managedSource = service.run.sourcesByName.get('HR Source')
        ;(service as any).fusionSourceIdValue = 'fusion-source-id'
        ;(service as any).sourcesById = new Map([
            [fusionSource.id, fusionSource],
            [managedSource.id, managedSource],
        ])

        client.identityProfilesApi = {
            updateIdentityProfile: vi.fn().mockResolvedValue({ data: { id: 'profile-1' } }),
        }
        client.paginate = vi.fn().mockResolvedValue([
            {
                id: 'profile-1',
                authoritativeSource: { id: 'fusion-source-id' },
                identityAttributeConfig: {
                    attributeTransforms: [
                        {
                            identityAttributeName: 'reverseNativeIdentity',
                            transformDefinition: {
                                type: 'rule',
                                attributes: { name: 'CustomRule' },
                            },
                        },
                    ],
                },
            },
        ])

        await (service as any).ensureIdentityProfileMapping('reverseNativeIdentity', {
            name: 'HR Source',
            sourceType: SourceType.Authoritative,
        } as any)

        expect(client.identityProfilesApi.updateIdentityProfile).not.toHaveBeenCalled()
    })

    it('adds default accountAttribute mapping when profile has no transform for that identity attribute', async () => {
        const { service, client } = createService({
            correlationMode: 'reverse',
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        })
        const fusionSource: SourceInfo = {
            id: 'fusion-source-id',
            name: 'Fusion Source',
            isManaged: false,
            sourceType: SourceType.Authoritative,
            config: undefined,
        }
        const managedSource = service.run.sourcesByName.get('HR Source')
        ;(service as any).fusionSourceIdValue = 'fusion-source-id'
        ;(service as any).sourcesById = new Map([
            [fusionSource.id, fusionSource],
            [managedSource.id, managedSource],
        ])

        client.identityProfilesApi = {
            updateIdentityProfile: vi.fn().mockResolvedValue({ data: { id: 'profile-1' } }),
        }
        client.paginate = vi.fn().mockResolvedValue([
            {
                id: 'profile-1',
                authoritativeSource: { id: 'fusion-source-id' },
                identityAttributeConfig: { attributeTransforms: [] },
            },
        ])
        vi.spyOn(service as any, 'waitForIdentityProfileMapping').mockResolvedValue(true)

        await (service as any).ensureIdentityProfileMapping('reverseNativeIdentity', {
            name: 'HR Source',
            sourceType: SourceType.Authoritative,
        } as any)

        expect(client.identityProfilesApi.updateIdentityProfile).toHaveBeenCalledTimes(1)
    })
})

describe('SourceService reverse correlation readiness cache', () => {
    it('assertReverseCorrelationReady calls getReverseCorrelationSetupStatus only once per source until cleared', async () => {
        const { service } = createService({
            correlationMode: 'reverse',
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        })
        const statusSpy = vi.spyOn(service as any, 'getReverseCorrelationSetupStatus').mockResolvedValue({
            isConsistent: true,
            missingArtifacts: [],
        })
        const sourceConfig = {
            name: 'HR Source',
            correlationMode: 'reverse' as const,
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        }
        await service.assertReverseCorrelationReady(sourceConfig as any)
        await service.assertReverseCorrelationReady(sourceConfig as any)
        expect(statusSpy).toHaveBeenCalledTimes(1)

        service.clearReverseCorrelationReadinessCache()
        await service.assertReverseCorrelationReady(sourceConfig as any)
        expect(statusSpy).toHaveBeenCalledTimes(2)
    })

    it('ensureReverseCorrelationSetup seeds cache so assertReverseCorrelationReady skips status checks', async () => {
        const { service } = createService({
            correlationMode: 'reverse',
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        })
        vi.spyOn(service, 'validateNoAttributeOverlap').mockImplementation(() => {})
        vi.spyOn(service as any, 'ensureReverseCorrelationSetupPhases').mockResolvedValue(undefined)
        const statusSpy = vi.spyOn(service as any, 'getReverseCorrelationSetupStatus').mockResolvedValue({
            isConsistent: true,
            missingArtifacts: [],
        })

        await service.ensureReverseCorrelationSetup(
            {
                name: 'HR Source',
                correlationMode: 'reverse',
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            } as any,
            new Set()
        )

        statusSpy.mockClear()
        await service.assertReverseCorrelationReady({
            name: 'HR Source',
            correlationMode: 'reverse',
            correlationAttribute: 'reverseNativeIdentity',
            correlationDisplayName: 'Reverse Native Identity',
        } as any)

        expect(statusSpy).not.toHaveBeenCalled()
    })
})

describe('SourceService identity attribute create error mapping', () => {
    it('maps searchable-limit API errors to actionable guidance', () => {
        const error = {
            response: {
                data: {
                    detailCode: '400.1 Bad request content',
                    messages: [{ text: '"searchable" count exceeded max limit of 15 for "identity attributes".' }],
                },
            },
        }
        const message = buildIdentityAttributeCreateErrorMessage('blackmesa-id', error)
        expect(message).toContain('ISC tenant limit reached for searchable identity attributes')
        expect(message).toContain('blackmesa-id')
    })
})

describe('ensureIdentityAttribute', () => {
    const setupIdentityAttributesApi = (
        overrides: {
            existing?: { searchable: boolean }
            updated?: any
            created?: any
            conflict?: boolean
        } = {}
    ) => {
        const getIdentityAttribute = vi.fn().mockResolvedValue({ data: overrides.existing ?? null })
        const putIdentityAttribute = vi.fn().mockResolvedValue({ data: overrides.updated ?? { name: 'attr' } })
        const createIdentityAttribute = vi.fn().mockImplementation(async (payload: any) => {
            if (overrides.conflict) {
                const error: any = new Error('already exists')
                error.response = { data: { detailMessage: 'already exists' } }
                throw error
            }
            return { data: overrides.created ?? { name: payload.identityAttributeV2025.name } }
        })

        return { getIdentityAttribute, putIdentityAttribute, createIdentityAttribute }
    }

    const createServiceWithIdentityApi = (api: ReturnType<typeof setupIdentityAttributesApi>) => {
        const { service } = createService()
        ;(service as any).client.identityAttributesApi = api
        return service
    }

    const expectedPayload = {
        name: 'customAttr',
        displayName: 'Custom Attribute',
        searchable: true,
        type: 'string',
        multi: false,
        standard: false,
        system: false,
    }

    it('updates an existing non-searchable attribute with the searchable payload', async () => {
        const api = setupIdentityAttributesApi({ existing: { searchable: false } })
        const service = createServiceWithIdentityApi(api)

        await (service as any).ensureIdentityAttribute('customAttr', 'Custom Attribute')

        expect(api.putIdentityAttribute).toHaveBeenCalledWith({
            name: 'customAttr',
            identityAttributeV2025: expectedPayload,
        })
    })

    it('creates a new searchable attribute with the same payload', async () => {
        const api = setupIdentityAttributesApi()
        const service = createServiceWithIdentityApi(api)

        await (service as any).ensureIdentityAttribute('customAttr', 'Custom Attribute')

        expect(api.createIdentityAttribute).toHaveBeenCalledWith({
            identityAttributeV2025: expectedPayload,
        })
    })

    it('retries as update with the same payload when create reports a conflict', async () => {
        const api = setupIdentityAttributesApi({ conflict: true })
        const service = createServiceWithIdentityApi(api)

        await (service as any).ensureIdentityAttribute('customAttr', 'Custom Attribute')

        expect(api.putIdentityAttribute).toHaveBeenCalledWith({
            name: 'customAttr',
            identityAttributeV2025: expectedPayload,
        })
    })
})

describe('SourceService fetchGlobalOwnerIdentityIds', () => {
    it('expands GOVERNANCE_GROUP source owners to member identity IDs', async () => {
        const { service, client } = createService()
        ;(service as any).fusionSourceOwnerValue = { id: 'owner-workgroup', type: 'GOVERNANCE_GROUP' }
        client.governanceGroupsApi = {
            listWorkgroupMembers: vi.fn().mockResolvedValue({
                data: [{ id: 'member-1' }, { id: 'member-2' }],
            }),
        }

        const ids = await service.fetchGlobalOwnerIdentityIds()

        expect(ids).toEqual(['member-1', 'member-2'])
        expect(client.governanceGroupsApi.listWorkgroupMembers).toHaveBeenCalledWith({
            workgroupId: 'owner-workgroup',
            limit: 250,
        })
    })

    it('uses identity owner ID directly when owner type is IDENTITY', async () => {
        const { service, client } = createService()
        ;(service as any).fusionSourceOwnerValue = { id: 'owner-identity', type: 'IDENTITY' }
        client.governanceGroupsApi = { listWorkgroupMembers: vi.fn() }

        const ids = await service.fetchGlobalOwnerIdentityIds()

        expect(ids).toEqual(['owner-identity'])
        expect(client.governanceGroupsApi.listWorkgroupMembers).not.toHaveBeenCalled()
    })
})

describe('SourceService.setMachineAccountOwnerIdentity', () => {
    const target = { id: 'src-m::machine-1', sourceId: 'src-m', nativeIdentity: 'machine-1' }

    it('patches ownerIdentity on the fetched account id', async () => {
        const { service, client, log } = createService()
        service.run.setManagedAccount('src-m::machine-1', {
            id: 'fetched-id',
            sourceId: 'src-m',
            nativeIdentity: 'machine-1',
        } as any)

        await service.setMachineAccountOwnerIdentity(target, 'identity-9')

        expect(client.machineAccountsApi.updateMachineAccount).toHaveBeenCalledTimes(1)
        expect(client.machineAccountsApi.updateMachineAccount).toHaveBeenCalledWith({
            id: 'fetched-id',
            requestBody: [{ op: 'add', path: '/ownerIdentity', value: { type: 'IDENTITY', id: 'identity-9' } }],
        })
        expect(client.call).toHaveBeenCalledWith(expect.any(Function), {
            priority: expect.anything(),
            context: 'SourceService>setMachineAccountOwnerIdentity',
            throwOnError: true,
        })
        expect(client.machineAccountsApi.updateMachineAccount.mock.calls[0]).toHaveLength(1)
        expect(JSON.stringify(client.machineAccountsApi.updateMachineAccount.mock.calls[0][0])).not.toContain('identityId')
        expect(log.error).not.toHaveBeenCalled()
    })

    it('resolves an unknown id by source id and nativeIdentity', async () => {
        const { service, client } = createService()
        service.run.setManagedAccount('src-m::machine-1', {
            id: 'fetched-id',
            sourceId: 'src-m',
            nativeIdentity: 'machine-1',
        } as any)
        client.machineAccountsApi.updateMachineAccount
            .mockRejectedValueOnce({ response: { status: 404 } })
            .mockResolvedValueOnce({ data: { id: 'resolved-id' } })
        client.machineAccountsApi.listMachineAccounts.mockResolvedValue({ data: [{ id: 'resolved-id' }] })

        await service.setMachineAccountOwnerIdentity(target, 'identity-9')

        expect(client.machineAccountsApi.listMachineAccounts).toHaveBeenCalledWith({
            filters: 'source.id eq "src-m" and nativeIdentity eq "machine-1"',
            limit: 1,
        })
        expect(client.machineAccountsApi.updateMachineAccount).toHaveBeenNthCalledWith(2, {
            id: 'resolved-id',
            requestBody: [{ op: 'add', path: '/ownerIdentity', value: { type: 'IDENTITY', id: 'identity-9' } }],
        })
    })

    it('logs a failed owner write and does not fail the caller', async () => {
        const { service, client, log } = createService()
        service.run.setManagedAccount('src-m::machine-1', {
            id: 'fetched-id',
            sourceId: 'src-m',
            nativeIdentity: 'machine-1',
        } as any)
        client.machineAccountsApi.updateMachineAccount.mockRejectedValue(new Error('boom'))

        await expect(service.setMachineAccountOwnerIdentity(target, 'identity-9')).resolves.toBeUndefined()

        expect(log.error).toHaveBeenCalledWith(
            'Failed to set owner identity for machine account "machine-1": boom'
        )
        expect(client.machineAccountsApi.listMachineAccounts).not.toHaveBeenCalled()
    })

    it('logs when the client swallows the write failure as undefined', async () => {
        const { service, client, log } = createService()
        service.run.setManagedAccount('src-m::machine-1', {
            id: 'fetched-id',
            sourceId: 'src-m',
            nativeIdentity: 'machine-1',
        } as any)
        client.call.mockResolvedValueOnce(undefined)

        await expect(service.setMachineAccountOwnerIdentity(target, 'identity-9')).resolves.toBeUndefined()

        expect(log.error).toHaveBeenCalledWith(
            expect.stringContaining('Failed to set owner identity for machine account "machine-1"')
        )
        expect(client.machineAccountsApi.listMachineAccounts).not.toHaveBeenCalled()
    })
})

describe('SourceService.removeProcessingAttribute', () => {
    function withFusionSource() {
        const harness = createService()
        ;(harness.service as any).fusionSourceIdValue = 'fusion-source-id'
        harness.client.sourcesApi.getSource = vi.fn()
        harness.client.sourcesApi.updateSource = vi.fn().mockResolvedValue({ data: {} })
        return harness
    }

    it('removes the processing connector attribute when it is present', async () => {
        const { service, client } = withFusionSource()
        ;(service as any).processLockAcquired = true
        client.sourcesApi.getSource.mockResolvedValue({
            data: { connectorAttributes: { processing: false, resetAccounts: true } },
        })

        await service.removeProcessingAttribute()

        expect(client.sourcesApi.updateSource).toHaveBeenCalledWith({
            id: 'fusion-source-id',
            jsonPatchOperationV2025: [{ op: 'remove', path: '/connectorAttributes/processing' }],
        })

        client.sourcesApi.updateSource.mockClear()
        await service.releaseProcessLock()
        expect(client.sourcesApi.updateSource).not.toHaveBeenCalled()
    })

    it('does not patch when the processing attribute is absent', async () => {
        const { service, client } = withFusionSource()
        ;(service as any).processLockAcquired = true
        client.sourcesApi.getSource.mockResolvedValue({
            data: { connectorAttributes: { resetAccounts: true } },
        })

        await service.removeProcessingAttribute()

        expect(client.sourcesApi.updateSource).not.toHaveBeenCalled()
        await service.releaseProcessLock()
        expect(client.sourcesApi.updateSource).not.toHaveBeenCalled()
    })
})

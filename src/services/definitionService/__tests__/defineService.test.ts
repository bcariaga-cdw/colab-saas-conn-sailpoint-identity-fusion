import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest'
import { DefinitionService } from '../definitionService'
import { FusionAccount } from '../../../model/account'
import { FusionConfig, SourceType } from '../../../model/config'
import { FusionAction } from '../../../model/fusionAction'
import { StatusEntitlement } from '../../../model/statusEntitlement'
import { InMemoryLockService } from '../../lockService'
import * as templateEvaluator from '../templateEvaluator'
import * as formatting from '../formatting'
import * as velocityCallerContext from '../velocityCallerContext'

describe('DefinitionService', () => {
    const mockLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogLevel: vi.fn(() => 'info') } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any
    const config = {
        normalAttributeDefinitions: [],
        uniqueAttributeDefinitions: [],
        attributeMaps: [],
    } as any

    it('is instantiable', () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        expect(service).toBeDefined()
    })
})

describe('DefinitionService.saveState', () => {
    const mockLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogLevel: vi.fn(() => 'info') } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any
    const config = {
        normalAttributeDefinitions: [],
        uniqueAttributeDefinitions: [],
        attributeMaps: [],
    } as any

    it('persists the counter state to the fusion source connector attributes', async () => {
        const patchSourceConfig = vi.fn().mockResolvedValue(undefined)
        const mockSources = { fusionSourceId: 'fusion-src', patchSourceConfig } as any
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks, mockSources)
        service.setStateWrapper({ NetID: 8 })

        await service.saveState()

        expect(patchSourceConfig).toHaveBeenCalledWith(
            'fusion-src',
            '/connectorAttributes/fusionState',
            { NetID: 8 },
            'DefinitionService>saveState'
        )
    })

    it('throws when no SourceService is configured', async () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        service.setStateWrapper({ NetID: 8 })

        await expect(service.saveState()).rejects.toThrow(/SourceService is not configured/)
    })
})

describe('DefinitionService.applyDisplayAttributeOverride', () => {
    const mockLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogLevel: vi.fn(() => 'info') } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any
    const config = {
        normalAttributeDefinitions: [],
        uniqueAttributeDefinitions: [],
        attributeMaps: [],
    } as any

    beforeAll(() => {
        const minimalConfig = {
            sources: [
                { name: 'Source A', id: 'src-a', type: 'authoritative' },
                { name: 'Source B', id: 'src-b', type: 'record' },
            ],
            fusionAccountRefreshThresholdInSeconds: 3600,
            maxHistoryMessages: 50,
            resetAccounts: false,
            resetForms: false,
        } as unknown as FusionConfig
        FusionAccount.configure(minimalConfig)
    })

    function buildAccountWithIdentity(displayName: string, loginName: string): FusionAccount {
        const acc = FusionAccount.fromIdentity({ id: 'id-1', name: loginName, displayName } as any)
        acc.setNeedsReset(true)
        return acc
    }

    it('writes IdentityDocument.name (identity alias) to the display attribute when an identity is linked', () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        const acc = buildAccountWithIdentity('Alice Anderson', 'aanderson')
        acc.attributeBag.current['name'] = 'persisted-old-value'
        service.applyDisplayAttributeOverride(acc)
        expect(acc.attributeBag.current['name']).toBe('aanderson')
    })

    it('uses the login even when displayName differs', () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        const acc = buildAccountWithIdentity('Display Name', 'login')
        acc.attributeBag.current['name'] = undefined
        service.applyDisplayAttributeOverride(acc)
        expect(acc.attributeBag.current['name']).toBe('login')
        expect(acc.attributeBag.current['name']).not.toBe('Display Name')
    })

    it('skips the override when isIdentity is false', () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        const acc = FusionAccount.fromManagedAccount({
            id: 'src-b::acc-1',
            name: 'source-name',
            sourceId: 'src-b',
            nativeIdentity: 'acc-1',
        } as any)
        acc.attributeBag.current['name'] = 'persisted'
        service.applyDisplayAttributeOverride(acc)
        expect(acc.attributeBag.current['name']).toBe('persisted')
    })

    it('skips the override for uncorrelated managed accounts even after addIdentityLayer', () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        const acc = FusionAccount.fromManagedAccount({
            id: 'src-a::acc-1',
            name: 'source-name',
            sourceId: 'src-a',
            nativeIdentity: 'acc-1',
            uncorrelated: true,
        } as any)
        acc.attributeBag.current['name'] = 'Mapped Display Name'
        acc.addIdentityLayer({
            id: 'identity-1',
            name: 'login',
            displayName: 'Identity Alias',
            attributes: {},
        } as any)
        expect(acc.isIdentity).toBe(false)
        service.applyDisplayAttributeOverride(acc)
        expect(acc.attributeBag.current['name']).toBe('Mapped Display Name')
    })

    it('still overrides for correlated managed-account origins (source uncorrelated=false)', () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        const acc = FusionAccount.fromManagedAccount({
            id: 'src-a::acc-1',
            name: 'source-name',
            sourceId: 'src-a',
            nativeIdentity: 'acc-1',
            uncorrelated: false,
            identityId: 'identity-1',
        } as any)
        acc.attributeBag.current['name'] = 'source-name'
        acc.addIdentityLayer({
            id: 'identity-1',
            name: 'login',
            displayName: 'Alice Anderson',
            attributes: { displayName: 'Alice Anderson' },
        } as any)
        expect(acc.isIdentity).toBe(true)
        service.applyDisplayAttributeOverride(acc)
        expect(acc.attributeBag.current['name']).toBe('login')
    })

    it('evaluates the display attribute definition for uncorrelated managed accounts even when source attributes seed previous', async () => {
        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [{ name: 'name', expression: 'Definition Display Name' }],
                uniqueAttributeDefinitions: [],
                attributeMaps: [],
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )
        const acc = FusionAccount.fromManagedAccount({
            id: 'src-a::acc-1',
            name: 'source-name',
            sourceId: 'src-a',
            nativeIdentity: 'acc-1',
            uncorrelated: true,
            attributes: { name: 'Source Attribute Name', employeeId: 'E1' },
        } as any)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current['name']).toBe('Definition Display Name')
    })

    it('keeps persisted fusion display values immutable for existing Fusion accounts', async () => {
        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [{ name: 'name', expression: 'New Definition Value' }],
                uniqueAttributeDefinitions: [],
                attributeMaps: [],
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted Name',
            sourceName: 'Identity Fusion NG',
            attributes: {
                name: 'Persisted Display Name',
                employeeId: 'E1',
            },
        } as any)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current['name']).toBe('Persisted Display Name')
    })

    it('preserves display attribute from a normal definition through refresh and output override', async () => {
        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [{ name: 'name', expression: 'Definition Display Name' }],
                uniqueAttributeDefinitions: [],
                attributeMaps: [],
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )
        const acc = FusionAccount.fromManagedAccount({
            id: 'src-a::acc-1',
            name: 'source-name',
            sourceId: 'src-a',
            nativeIdentity: 'acc-1',
            uncorrelated: true,
        } as any)
        acc.addIdentityLayer({
            id: 'identity-1',
            name: 'login',
            displayName: 'Identity Alias',
            attributes: {},
        } as any)

        await service.refreshNormalAttributes(acc)
        await service.refreshUniqueAttributes(acc)
        service.applyDisplayAttributeOverride(acc)

        expect(acc.attributeBag.current['name']).toBe('Definition Display Name')
    })

    it('skips the override for persisted uncorrelated Fusion accounts after addIdentityLayer', () => {
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted Non Match',
            sourceName: 'Identity Fusion NG',
            uncorrelated: true,
            identityId: 'identity-1',
            attributes: {
                name: 'Mapped Display Name',
                identityId: 'identity-1',
                statuses: ['nonMatched', 'uncorrelated'],
            },
        } as any)
        acc.addIdentityLayer({
            id: 'identity-1',
            name: 'login',
            displayName: 'Identity Alias',
            attributes: { displayName: 'Identity Alias' },
        } as any)
        expect(acc.isIdentity).toBe(false)
        service.applyDisplayAttributeOverride(acc)
        expect(acc.attributeBag.current['name']).toBe('Mapped Display Name')
    })

})


describe('DefinitionService.refreshUniqueAttributes preservation', () => {
    const mockLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogLevel: vi.fn(() => 'info') } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any

    const createService = (uniqueAttributeDefinitions: any[]) => {
        const config = {
            normalAttributeDefinitions: [],
            uniqueAttributeDefinitions,
            attributeMaps: [],
            skipAccountsWithMissingId: false,
            forceAttributeRefresh: false,
            maxAttempts: 20,
        } as any
        const service = new DefinitionService(config, mockSchemas, mockLog, mockLocks)
        service.setStateWrapper({})
        return service
    }

    const createFusionAccount = (attrs: Record<string, any>, options: { needsReset?: boolean } = {}) => {
        const attributeBag = {
            current: { ...attrs },
            previous: Object.keys(attrs).length > 0 ? { ...attrs } : {},
            identity: {},
            accounts: [],
            sources: new Map<string, Record<string, any>[]>(),
        }

        const fusionAccount: any = {
            type: 'managed',
            needsRefresh: true,
            needsReset: options.needsReset ?? false,
            name: 'neo-1',
            sourceName: 'HR',
            fromIdentity: false,
            isIdentity: false,
            sources: ['HR'],
            history: [],
            importHistory: vi.fn(),
            attributeBag,
        }

        Object.defineProperty(fusionAccount, 'attributes', {
            get: () => attributeBag.current,
            set: (value) => {
                attributeBag.current = value
            },
        })

        return fusionAccount
    }

    it('generates a missing unique attribute when needsRefresh is false', async () => {
        const service = createService([
            {
                name: 'UID',
                expression: 'generated',
                useIncrementalCounter: false,
                normalize: false,
                spaces: false,
                trim: false,
            },
        ])

        const account = createFusionAccount({ UID: '   ' })
        account.needsRefresh = false
        await service.refreshUniqueAttributes(account)

        expect(account.attributes.UID).toBe('generated')
    })

    it('preserves existing unique values when needsRefresh is true but needsReset is false', async () => {
        const service = createService([
            {
                name: 'UID',
                expression: 'WD$counter',
                useIncrementalCounter: true,
                digits: 6,
                counterStart: 1,
            },
        ])
        await service.initializeCounters()

        const existing = createFusionAccount({ UID: 'WD000015' })
        await service.registerUniqueAttributes(existing)
        await service.refreshUniqueAttributes(existing)

        expect(existing.attributes.UID).toBe('WD000015')
        expect(mockLog.error).not.toHaveBeenCalled()
    })

    it('seeds the persistent counter from existing incremental values', async () => {
        const service = createService([
            {
                name: 'UID',
                expression: 'NG$counter',
                useIncrementalCounter: true,
                digits: 3,
                counterStart: 1,
            },
        ])
        await service.initializeCounters()

        const existing = createFusionAccount({ UID: 'NG015' })
        await service.refreshUniqueAttributes(existing)

        expect(await service.getStateObject()).toEqual({ UID: 15 })

        const next = createFusionAccount({})
        await service.refreshUniqueAttributes(next)

        expect(next.attributes.UID).toBe('NG016')
        expect(await service.getStateObject()).toEqual({ UID: 16 })
    })

    it('regenerates unique values when needsReset is true', async () => {
        const service = createService([
            {
                name: 'UID',
                expression: 'generated-$counter',
                useIncrementalCounter: false,
                digits: 1,
            },
        ])

        const account = createFusionAccount({ UID: 'old-value' }, { needsReset: true })
        await service.registerUniqueAttributes(account)
        await service.refreshUniqueAttributes(account)

        expect(account.attributes.UID).not.toBe('old-value')
    })

    it('Refresh unique register does not enter unique lock', async () => {
        const uniqueLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
        const config = {
            normalAttributeDefinitions: [],
            uniqueAttributeDefinitions: [
                {
                    name: 'UID',
                    expression: 'WD$counter',
                    useIncrementalCounter: true,
                    digits: 6,
                    counterStart: 1,
                },
            ],
            attributeMaps: [],
            skipAccountsWithMissingId: false,
            forceAttributeRefresh: false,
            maxAttempts: 20,
        } as any
        const service = new DefinitionService(config, mockSchemas, mockLog, uniqueLocks)
        service.setStateWrapper({})

        const existing = createFusionAccount({ UID: 'WD000015' })
        await service.registerUniqueAttributes(existing)

        expect(uniqueLocks.withLock.mock.calls.some(([key]: [string]) => key === 'unique:UID')).toBe(false)
        expect((service as any).getUniqueValues('UID').has('WD000015')).toBe(true)
    })
})

describe('DefinitionService.refreshNormalAttributes clearing', () => {
    const mockLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogLevel: vi.fn(() => 'info') } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any

    beforeAll(() => {
        const minimalConfig = {
            sources: [{ name: 'HR', id: 'src-hr', type: 'authoritative' }],
            fusionAccountRefreshThresholdInSeconds: 3600,
            maxHistoryMessages: 50,
            resetAccounts: false,
            resetForms: false,
        } as unknown as FusionConfig
        FusionAccount.configure(minimalConfig)
    })

    const createService = (normalAttributeDefinitions: any[], configOverrides: Record<string, unknown> = {}) =>
        new DefinitionService(
            {
                normalAttributeDefinitions,
                uniqueAttributeDefinitions: [],
                attributeMaps: [],
                skipAccountsWithMissingId: false,
                forceAttributeRefresh: false,
                ...configOverrides,
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )

    const createRefreshableAccount = (attrs: Record<string, any> = {}) => {
        const acc = FusionAccount.fromManagedAccount({
            id: 'src-hr::acc-1',
            name: 'neo-1',
            sourceId: 'src-hr',
            nativeIdentity: 'acc-1',
            uncorrelated: true,
            attributes: { ...attrs },
        } as any)
        acc.setNeedsRefresh(true)
        return acc
    }

    it('clears existing normal attribute when template evaluates to empty output', async () => {
        const service = createService([
            {
                name: 'formattedDate',
                expression: '$Datefns.format($Datefns.parse($INACTIVE_DATE, "yyyy-MM-dd"))',
            },
        ])
        const acc = createRefreshableAccount({ formattedDate: '2024-01-15' })

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.formattedDate).toBeUndefined()
    })

    it('removes cleared attribute from velocity context for downstream definitions', async () => {
        const service = createService([
            {
                name: 'formattedDate',
                expression: '$Datefns.format($Datefns.parse($INACTIVE_DATE, "yyyy-MM-dd"))',
            },
            {
                name: 'derived',
                expression: 'prefix-$!{formattedDate}-suffix',
            },
        ])
        const acc = createRefreshableAccount({
            formattedDate: '2024-01-15',
            derived: '2024-01-15',
        })

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.formattedDate).toBeUndefined()
        expect(acc.attributeBag.current.derived).toBe('prefix--suffix')
    })

    it('clears existing normal attribute when template evaluation returns error', async () => {
        const service = createService([{ name: 'department', expression: '' }])
        const acc = createRefreshableAccount({ department: 'Engineering' })

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.department).toBeUndefined()
        expect(mockLog.error).toHaveBeenCalled()
    })

    it('applies safe default for display attribute on falsy output instead of clearing', async () => {
        const service = createService([
            { name: 'name', expression: '$Datefns.format($Datefns.parse($missingDate, "yyyy-MM-dd"))' },
        ])
        const acc = createRefreshableAccount()

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.name).toBe('neo-1')
    })

    it('applies safe default for identity attribute on falsy output instead of clearing', async () => {
        const service = createService([
            { name: 'id', expression: '$Datefns.format($Datefns.parse($missingDate, "yyyy-MM-dd"))' },
        ])
        const acc = createRefreshableAccount()

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        )
    })

    it('static definition with existing value skips evaluation on existing Fusion accounts', async () => {
        const service = createService([
            { name: 'department', expression: 'New Value', static: true },
        ])
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted Name',
            sourceName: 'Identity Fusion NG',
            attributes: {
                department: 'Engineering',
                employeeId: 'E1',
            },
        } as any)
        acc.setNeedsRefresh(true)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.department).toBe('Engineering')
    })

    it('non-nullish rendered value overwrites existing value', async () => {
        const service = createService([{ name: 'fullName', expression: 'Jane Smith' }])
        const acc = createRefreshableAccount({ fullName: 'Jane Doe' })

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.fullName).toBe('Jane Smith')
    })

    it('later Normal definition sees an earlier write', async () => {
        const service = createService([
            { name: 'first', expression: 'Ada' },
            { name: 'full', expression: '$first' },
        ])
        const acc = createRefreshableAccount()

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.full).toBe('Ada')
    })

    it('reads an existing source attribute in a Normal definition', async () => {
        const service = createService([{ name: 'full', expression: '${firstname} ${lastname}' }])
        const acc = createRefreshableAccount({ firstname: 'Ada', lastname: 'Lovelace' })

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.full).toBe('Ada Lovelace')
    })

    it('Normal definition cannot read identity attributes when identity scope is disabled', async () => {
        const service = createService(
            [{ name: 'identityDepartment', expression: '$!identity.department' }],
            { includeIdentities: false }
        )
        const acc = createRefreshableAccount()
        acc.addIdentityLayer({
            id: 'identity-jane',
            name: 'jane.identity',
            attributes: { department: 'Identity HR' },
        } as any)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.identityDepartment).toBeUndefined()
    })

    it('special context keys override current bag names', async () => {
        const service = createService([{ name: 'identityName', expression: '$identity.name' }])
        const acc = createRefreshableAccount({ identity: 'not-the-identity-object' })
        acc.addIdentityLayer({
            id: 'identity-jane',
            name: 'Jane',
            attributes: { name: 'Jane' },
        } as any)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributeBag.current.identityName).toBe('Jane')
    })
})

describe('DefinitionService.refreshUniqueAttributes unique-registry lock', () => {
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any

    const createFusionAccount = (attrs: Record<string, any> = {}) => {
        const attributeBag = {
            current: { ...attrs },
            previous: {},
            identity: {},
            accounts: [],
            sources: new Map<string, Record<string, any>[]>(),
        }
        const fusionAccount: any = {
            type: 'managed',
            needsRefresh: true,
            needsReset: false,
            name: 'neo-1',
            sourceName: 'HR',
            fromIdentity: false,
            isIdentity: false,
            isMatch: false,
            sources: ['HR'],
            history: [],
            importHistory: vi.fn(),
            attributeBag,
        }
        Object.defineProperty(fusionAccount, 'attributes', {
            get: () => attributeBag.current,
            set: (value) => {
                attributeBag.current = value
            },
        })
        return fusionAccount
    }

    it('does not hold unique:${name} during evaluateAttributeTemplate', async () => {
        let uniqueLockHeld = false
        let evaluatedOutsideUniqueLock = false
        const originalEvaluate = templateEvaluator.evaluateAttributeTemplate
        const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate').mockImplementation((...args) => {
            if (!uniqueLockHeld) evaluatedOutsideUniqueLock = true
            return originalEvaluate(...args)
        })

        const mockLog = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            getLogLevel: vi.fn(() => 'info'),
        } as any
        const mockLocks = {
            withLock: vi.fn(async (key: string, fn: () => Promise<any>) => {
                if (String(key).startsWith('unique:')) {
                    uniqueLockHeld = true
                    try {
                        return await fn()
                    } finally {
                        uniqueLockHeld = false
                    }
                }
                return fn()
            }),
        } as any

        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [],
                uniqueAttributeDefinitions: [
                    {
                        name: 'UID',
                        expression: 'STATIC-UID',
                        useIncrementalCounter: false,
                        digits: 1,
                    },
                ],
                attributeMaps: [],
                skipAccountsWithMissingId: false,
                forceAttributeRefresh: false,
                maxAttempts: 20,
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )
        service.setStateWrapper({})

        await service.refreshUniqueAttributes(createFusionAccount())

        expect(evaluateSpy).toHaveBeenCalled()
        expect(evaluatedOutsideUniqueLock).toBe(true)
        evaluateSpy.mockRestore()
    })

    it('two concurrent refreshUniqueAttributes calls for the same unique attribute store distinct values', async () => {
        const mockLog = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            getLogLevel: vi.fn(() => 'info'),
        } as any
        const locks = new InMemoryLockService(mockLog)
        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [],
                uniqueAttributeDefinitions: [
                    {
                        name: 'UID',
                        expression: 'USER',
                        useIncrementalCounter: false,
                        digits: 1,
                    },
                ],
                attributeMaps: [],
                skipAccountsWithMissingId: false,
                forceAttributeRefresh: false,
                maxAttempts: 20,
            } as any,
            mockSchemas,
            mockLog,
            locks
        )
        service.setStateWrapper({})

        const first = createFusionAccount()
        first.name = 'neo-1'
        const second = createFusionAccount()
        second.name = 'neo-2'

        await Promise.all([service.refreshUniqueAttributes(first), service.refreshUniqueAttributes(second)])

        expect(first.attributes.UID).toBeTruthy()
        expect(second.attributes.UID).toBeTruthy()
        expect(first.attributes.UID).not.toBe(second.attributes.UID)
        const registered = (service as any).getUniqueValues('UID') as Set<string>
        expect(registered.has(String(first.attributes.UID))).toBe(true)
        expect(registered.has(String(second.attributes.UID))).toBe(true)
    })

    it('uses empty $counter on the first collision-strategy attempt', async () => {
        const mockLog = {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            getLogLevel: vi.fn(() => 'info'),
        } as any
        const locks = new InMemoryLockService(mockLog)
        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [],
                uniqueAttributeDefinitions: [
                    {
                        name: 'UID',
                        expression: 'USER',
                        useIncrementalCounter: false,
                        digits: 1,
                    },
                ],
                attributeMaps: [],
                skipAccountsWithMissingId: false,
                forceAttributeRefresh: false,
                maxAttempts: 20,
            } as any,
            mockSchemas,
            mockLog,
            locks
        )
        service.setStateWrapper({})

        const seed = createFusionAccount()
        seed.name = 'seed'
        await service.refreshUniqueAttributes(seed)
        expect(seed.attributes.UID).toBe('USER')

        const counters: string[] = []
        const originalEvaluate = templateEvaluator.evaluateAttributeTemplate
        const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate').mockImplementation((...args) => {
            const context = args[1] as { counter?: string }
            counters.push(context.counter ?? '')
            return originalEvaluate(...args)
        })

        const colliding = createFusionAccount()
        colliding.name = 'colliding'
        await service.refreshUniqueAttributes(colliding)

        expect(counters[0]).toBe('')
        expect(colliding.attributes.UID).toBe('USER1')
        evaluateSpy.mockRestore()
    })
})

describe('refresh flag semantics', () => {
    const mockLog = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getLogLevel: vi.fn(() => 'info'),
    } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any

    beforeAll(() => {
        FusionAccount.configure({
            sources: [{ name: 'HR', id: 'src-hr', type: 'authoritative' }],
            fusionAccountRefreshThresholdInSeconds: 3600,
            maxHistoryMessages: 50,
            resetAccounts: false,
            resetForms: false,
        } as unknown as FusionConfig)
    })

    const createService = (normalAttributeDefinitions: any[], configOverrides: Record<string, unknown> = {}) =>
        new DefinitionService(
            {
                normalAttributeDefinitions,
                uniqueAttributeDefinitions: [],
                attributeMaps: [],
                skipAccountsWithMissingId: false,
                forceAttributeRefresh: false,
                ...configOverrides,
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )

    const createPersistedAccount = (attrs: Record<string, any>) => {
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted Account',
            sourceName: 'Identity Fusion NG',
            uncorrelated: true,
            attributes: { ...attrs },
        } as any)
        acc.setNeedsRefresh(false)
        acc.setNeedsReset(false)
        return acc
    }

    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('refresh false skips unchanged account', async () => {
        const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate')
        const service = createService([
            { name: 'department', expression: 'should-not-run', refresh: false },
        ])
        const acc = createPersistedAccount({ department: 'Engineering' })

        await service.refreshNormalAttributes(acc)

        expect(evaluateSpy).not.toHaveBeenCalled()
        expect(acc.attributeBag.current.department).toBe('Engineering')
    })

        it('refresh true runs every aggregation', async () => {
            const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate')
            const service = createService([
                { name: 'department', expression: 'refreshed-value', refresh: true },
            ])
            const acc = createPersistedAccount({ department: 'Engineering' })

            await service.refreshNormalAttributes(acc)

            expect(evaluateSpy).toHaveBeenCalled()
            expect(acc.attributeBag.current.department).toBe('refreshed-value')
        })

        it('hasEligibleAlwaysRecalculate matches Always recalculate eligibility', () => {
            const refreshService = createService([
                { name: 'department', expression: 'refreshed-value', refresh: true },
            ])
            const skipService = createService([
                { name: 'department', expression: 'should-not-run', refresh: false },
            ])
            const acc = createPersistedAccount({ department: 'Engineering' })

            expect(refreshService.hasEligibleAlwaysRecalculate(acc)).toBe(true)
            expect(skipService.hasEligibleAlwaysRecalculate(acc)).toBe(false)
        })

    it('needsRefresh triggers refresh false definitions', async () => {
        const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate')
        const service = createService([
            { name: 'department', expression: 'recalculated', refresh: false },
        ])
        const acc = createPersistedAccount({ department: 'Engineering' })
        acc.setNeedsRefresh(true)

        await service.refreshNormalAttributes(acc)

        expect(evaluateSpy).toHaveBeenCalled()
        expect(acc.attributeBag.current.department).toBe('recalculated')
    })

    it('force attribute refresh triggers refresh false definitions', async () => {
        const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate')
        const service = createService(
            [{ name: 'department', expression: 'forced', refresh: false }],
            { forceAttributeRefresh: true }
        )
        const acc = createPersistedAccount({ department: 'Engineering' })

        await service.refreshNormalAttributes(acc)

        expect(evaluateSpy).toHaveBeenCalled()
        expect(acc.attributeBag.current.department).toBe('forced')
    })

    it('stale account skips Define when no refresh true definitions apply', async () => {
        const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate')
        const service = createService([
            { name: 'department', expression: 'should-not-run', refresh: false },
            { name: 'title', expression: 'also-skip', refresh: false },
        ])
        const acc = createPersistedAccount({ department: 'Engineering', title: 'Engineer' })
        const stats: { evaluated: number; skipped: number }[] = []

        await service.refreshNormalAttributes(acc, (s) => stats.push(s))

        expect(evaluateSpy).not.toHaveBeenCalled()
        expect(stats[0]).toEqual({ evaluated: 0, skipped: 2 })
        expect(acc.attributeBag.current.department).toBe('Engineering')
        expect(acc.attributeBag.current.title).toBe('Engineer')
    })

    it('refresh false skips unchanged account when a sibling definition has refresh true', async () => {
        const evaluateSpy = vi.spyOn(templateEvaluator, 'evaluateAttributeTemplate')
        const service = createService([
            { name: 'department', expression: 'should-not-run', refresh: false },
            { name: 'computed', expression: 'fresh', refresh: true },
        ])
        const acc = createPersistedAccount({ department: 'Engineering', computed: 'stale' })

        await service.refreshNormalAttributes(acc)

        expect(evaluateSpy).toHaveBeenCalledTimes(1)
        expect(evaluateSpy.mock.calls[0][0].name).toBe('computed')
        expect(acc.attributeBag.current.department).toBe('Engineering')
        expect(acc.attributeBag.current.computed).toBe('fresh')
    })

    it('later definition sees earlier write without per-eval full copy', async () => {
        const copySpy = vi.spyOn(formatting, 'createRenderContextForPass')
        const service = createService([
            { name: 'first', expression: 'alpha', refresh: true },
            { name: 'second', expression: '${first}-beta', refresh: true },
        ])
        const acc = createPersistedAccount({ first: 'old', second: 'old' })

        await service.refreshNormalAttributes(acc)

        expect(copySpy).toHaveBeenCalledTimes(1)
        expect(Object.getPrototypeOf(copySpy.mock.results[0].value)).toBeNull()
        expect(acc.attributeBag.current.first).toBe('alpha')
        expect(acc.attributeBag.current.second).toBe('alpha-beta')
    })

    it('copies caller context once per refresh pass with 3 definitions', async () => {
        const copySpy = vi.spyOn(velocityCallerContext, 'copyVelocityCallerContext')
        const passSpy = vi.spyOn(formatting, 'createRenderContextForPass')
        const service = createService([
            { name: 'one', expression: '1', refresh: true },
            { name: 'two', expression: '2', refresh: true },
            { name: 'three', expression: '3', refresh: true },
        ])
        const acc = createPersistedAccount({ one: 'a', two: 'b', three: 'c' })

        await service.refreshNormalAttributes(acc)

        expect(passSpy).toHaveBeenCalledTimes(1)
        expect(copySpy).toHaveBeenCalledTimes(1)
        expect(acc.attributeBag.current.one).toBe('1')
        expect(acc.attributeBag.current.two).toBe('2')
        expect(acc.attributeBag.current.three).toBe('3')
    })

    it('tenant-like mix skips refresh-false defs on unchanged accounts', async () => {
        const refreshTrue = Array.from({ length: 17 }, (_, i) => ({
            name: `dyn${i}`,
            expression: `dyn-${i}`,
            refresh: true,
        }))
        const refreshFalse = Array.from({ length: 5 }, (_, i) => ({
            name: `stable${i}`,
            expression: `should-not-run-${i}`,
            refresh: false,
        }))
        const attrs: Record<string, string> = {}
        for (const def of [...refreshTrue, ...refreshFalse]) {
            attrs[def.name] = `prior-${def.name}`
        }
        const service = createService([...refreshFalse, ...refreshTrue])
        const acc = createPersistedAccount(attrs)
        const stats: { evaluated: number; skipped: number }[] = []

        await service.refreshNormalAttributes(acc, (s) => stats.push(s))

        expect(stats[0]).toEqual({ evaluated: 17, skipped: 5 })
        expect(acc.attributeBag.current.stable0).toBe('prior-stable0')
        expect(acc.attributeBag.current.dyn0).toBe('dyn-0')
    })

    it('refreshAllAttributes reuses one render context for Normal definitions', async () => {
        const copySpy = vi.spyOn(velocityCallerContext, 'copyVelocityCallerContext')
        const service = createService([
            { name: 'first', expression: 'alpha', refresh: true },
            { name: 'second', expression: '${first}-beta', refresh: true },
        ])
        const acc = createPersistedAccount({ first: 'old', second: 'old' })
        acc.setNeedsRefresh(true)

        await service.refreshAllAttributes(acc)

        expect(copySpy).toHaveBeenCalledTimes(1)
        expect(acc.attributeBag.current.first).toBe('alpha')
        expect(acc.attributeBag.current.second).toBe('alpha-beta')
    })
})

describe('Disabled identity scope excludes identity data from Define', () => {
    const mockLog = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        getLogLevel: vi.fn(() => 'info'),
    } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any

    const identityScopeConfig = {
        sources: [
            { name: 'Source A', id: 'src-a', type: 'authoritative' },
            { name: 'Source B', id: 'src-b', type: 'record' },
        ],
        fusionAccountRefreshThresholdInSeconds: 3600,
        maxHistoryMessages: 50,
        resetAccounts: false,
        resetForms: false,
    } as unknown as FusionConfig

    beforeAll(() => {
        FusionAccount.configure(identityScopeConfig)
    })

    const createService = (configOverrides: Record<string, unknown> = {}) => {
        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [],
                uniqueAttributeDefinitions: [],
                attributeMaps: [],
                skipAccountsWithMissingId: false,
                forceAttributeRefresh: false,
                maxAttempts: 20,
                includeIdentities: false,
                ...configOverrides,
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )
        service.setStateWrapper({})
        return service
    }

    /** Managed-origin account whose originating managed source account is correlated (`uncorrelated === false`). */
    const createCorrelatedManagedAccount = (attrs: Record<string, any> = {}) =>
        FusionAccount.fromManagedAccount({
            id: 'src-a::acc-1',
            name: 'source-name',
            sourceId: 'src-a',
            nativeIdentity: 'acc-1',
            uncorrelated: false,
            identityId: 'identity-1',
            attributes: { ...attrs },
        } as any)

    const createUncorrelatedManagedAccount = (attrs: Record<string, any> = {}) =>
        FusionAccount.fromManagedAccount({
            id: 'src-a::acc-2',
            name: 'other-source-name',
            sourceId: 'src-a',
            nativeIdentity: 'acc-2',
            uncorrelated: true,
            attributes: { ...attrs },
        } as any)

    const applyIdentityLayer = (acc: FusionAccount, alias = 'aanderson') =>
        acc.addIdentityLayer({
            id: 'identity-1',
            name: alias,
            displayName: 'Alice Anderson',
            attributes: { displayName: 'Alice Anderson', department: 'Identity HR' },
        } as any)

    it('Identities origin snapshot stays excluded from Velocity when identity scope is disabled', async () => {
        const definitions = [{ name: 'snapshotDepartment', expression: '$!{sources.Identities[0].department}' }]
        const excluded = createCorrelatedManagedAccount()
        excluded.attributeBag.sources.set('Identities', [{ department: 'Identity HR' }])
        const included = createCorrelatedManagedAccount()
        included.attributeBag.sources.set('Identities', [{ department: 'Identity HR' }])

        await createService({ normalAttributeDefinitions: definitions }).refreshNormalAttributes(excluded)
        await createService({
            normalAttributeDefinitions: definitions,
            includeIdentities: true,
        }).refreshNormalAttributes(included)

        expect(included.attributes.snapshotDepartment).toBe('Identity HR')
        expect(excluded.attributes.snapshotDepartment).toBeUndefined()
    })

    it('Identity alias is not a Velocity value for managed-origin accounts when identity scope is disabled', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'aliasFromContext', expression: '$!{identity.name}' }],
        })
        const acc = createCorrelatedManagedAccount()
        applyIdentityLayer(acc)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.aliasFromContext).not.toBe('aanderson')
        expect(acc.attributes.aliasFromContext).toBeUndefined()
    })

    it('Alias overrides a Unique display definition when identity scope is disabled', async () => {
        const service = createService({
            uniqueAttributeDefinitions: [
                { name: 'name', expression: 'generated-display', useIncrementalCounter: false, digits: 1 },
            ],
        })
        const acc = createCorrelatedManagedAccount()
        applyIdentityLayer(acc)

        await service.refreshUniqueAttributes(acc)

        expect(acc.attributes.name).toBe('aanderson')
    })

    it('Alias overrides a Normal display definition when identity scope is disabled', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'name', expression: 'Definition Display Name' }],
        })
        const acc = createCorrelatedManagedAccount()
        applyIdentityLayer(acc)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.name).toBe('aanderson')
    })

    it('Unavailable alias falls through to a non-empty Normal definition', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'name', expression: 'Definition Display Name' }],
        })
        const acc = createCorrelatedManagedAccount()

        expect(acc.isIdentity).toBe(true)
        expect(acc.identityAlias).toBeUndefined()

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.name).toBe('Definition Display Name')
    })

    it('Unavailable alias falls through to the safe default when the Normal definition is empty', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'name', expression: '$!{missingAttribute}' }],
        })
        const acc = createCorrelatedManagedAccount()

        expect(acc.identityAlias).toBeUndefined()

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.name).toBe('source-name')
    })

    it('Unavailable alias does not skip Unique display generation', async () => {
        const service = createService({
            uniqueAttributeDefinitions: [
                { name: 'name', expression: 'generated-display', useIncrementalCounter: false, digits: 1 },
            ],
        })
        const acc = createCorrelatedManagedAccount()

        expect(acc.identityAlias).toBeUndefined()

        await service.refreshUniqueAttributes(acc)

        expect(acc.attributes.name).toBe('generated-display')
    })

    it('Correlated authoritative account name beats a Unique display definition without an identity document', async () => {
        FusionAccount.configure({
            ...identityScopeConfig,
            sources: [{ name: 'HR', id: 'src-hr', sourceType: SourceType.Authoritative }],
        } as unknown as FusionConfig)

        try {
            const service = createService({
                uniqueAttributeDefinitions: [
                    {
                        name: 'name',
                        expression: '$account.schema.name [$account.source.name]',
                        useIncrementalCounter: false,
                        digits: 1,
                    },
                ],
            })
            const acc = FusionAccount.fromManagedAccount({
                id: 'src-hr::1018',
                name: 'vincent.mccoy',
                sourceId: 'src-hr',
                sourceName: 'HR',
                nativeIdentity: '1018',
                uncorrelated: false,
                identityId: 'identity-vincent',
                attributes: {},
            } as any)

            await service.refreshUniqueAttributes(acc)

            expect(acc.attributes.name).toBe('vincent.mccoy')
        } finally {
            FusionAccount.configure(identityScopeConfig)
        }
    })

    it('Uncorrelated managed origin still uses definition output when identity scope is disabled', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'name', expression: 'Definition Display Name' }],
        })
        const acc = createUncorrelatedManagedAccount()
        applyIdentityLayer(acc)

        expect(acc.isIdentity).toBe(false)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.name).toBe('Definition Display Name')
    })

    it('Persisted managed-origin Fusion account stays override-ineligible while identity flag follows identity origin', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'name', expression: 'New Definition Value' }],
        })
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted Name',
            sourceName: 'Identity Fusion NG',
            uncorrelated: false,
            identityId: 'identity-1',
            attributes: {
                name: 'Definition Display Name',
                identityId: 'identity-1',
            },
        } as any)
        applyIdentityLayer(acc)
        acc.setNeedsRefresh(true)

        expect(acc.isIdentity).toBe(false)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.name).toBe('Definition Display Name')
    })

    it('Identity scope enabled still applies the alias on a correlated managed origin', () => {
        const service = createService({ includeIdentities: true })
        const acc = createCorrelatedManagedAccount()
        applyIdentityLayer(acc)

        service.applyDisplayAttributeOverride(acc)

        expect(acc.attributes.name).toBe('aanderson')
    })

    it('Identity-origin support account retains identity context when identity scope is disabled', async () => {
        const service = createService({
            normalAttributeDefinitions: [
                { name: 'identityDepartment', expression: '$!identity.department' },
                { name: 'name', expression: 'Definition Display Name' },
            ],
        })
        const reviewerIdentity = {
            id: 'identity-reviewer',
            name: 'greviewer',
            displayName: 'Global Reviewer',
            attributes: { department: 'Identity HR' },
        } as any
        const acc = FusionAccount.fromIdentity(reviewerIdentity)
        acc.addIdentityLayer(reviewerIdentity)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.identityDepartment).toBe('Identity HR')
        expect(acc.attributes.name).toBe('greviewer')
    })
})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REVIEWER_GATED_ID = '#if($statuses.includes("reviewer"))$UUID#end'

describe('DefinitionService live collection state in Velocity context', () => {
    const mockLog = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogLevel: vi.fn(() => 'info') } as any
    const mockLocks = { withLock: vi.fn((_key: string, fn: () => Promise<any>) => fn()) } as any
    const mockSchemas = { fusionIdentityAttribute: 'id', fusionDisplayAttribute: 'name' } as any

    beforeAll(() => {
        FusionAccount.configure({
            sources: [{ name: 'HR', id: 'src-hr', type: 'authoritative' }],
            fusionAccountRefreshThresholdInSeconds: 3600,
            maxHistoryMessages: 50,
            resetAccounts: false,
            resetForms: false,
        } as unknown as FusionConfig)
    })

    const createService = (configOverrides: Record<string, unknown> = {}) => {
        const service = new DefinitionService(
            {
                normalAttributeDefinitions: [],
                uniqueAttributeDefinitions: [],
                attributeMaps: [],
                skipAccountsWithMissingId: false,
                forceAttributeRefresh: false,
                maxAttempts: 20,
                ...configOverrides,
            } as any,
            mockSchemas,
            mockLog,
            mockLocks
        )
        service.setStateWrapper({})
        return service
    }

    const createIdentityOriginAccount = () =>
        FusionAccount.fromIdentity({
            id: 'identity-1',
            name: 'ada.lovelace',
            displayName: 'Ada Lovelace',
            attributes: {},
        } as any)

    it('Unique definition reads a status applied during the current run', async () => {
        const service = createService({
            uniqueAttributeDefinitions: [{ name: 'id', expression: REVIEWER_GATED_ID }],
        })
        const acc = createIdentityOriginAccount()
        acc.collections.statuses.add(StatusEntitlement.Reviewer)

        await service.refreshUniqueAttributes(acc)

        expect(acc.attributes.id).toMatch(UUID_PATTERN)
    })

    it('Unique definition renders empty for an account without the status', async () => {
        const service = createService({
            uniqueAttributeDefinitions: [{ name: 'id', expression: REVIEWER_GATED_ID }],
            skipAccountsWithMissingId: true,
        })
        const acc = createIdentityOriginAccount()

        await service.refreshUniqueAttributes(acc)

        expect(acc.attributes.id).toBeUndefined()
    })

    it('Reset regenerates a unique value from live collection state', async () => {
        const service = createService({
            uniqueAttributeDefinitions: [{ name: 'id', expression: REVIEWER_GATED_ID }],
        })
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted Reviewer',
            sourceName: 'Identity Fusion NG',
            attributes: {
                id: 'old-id',
                name: 'Persisted Reviewer',
                statuses: [StatusEntitlement.Reviewer],
            },
        } as any)
        acc.setNeedsReset(true)

        await service.refreshUniqueAttributes(acc)

        expect(acc.attributes.id).toMatch(UUID_PATTERN)
        expect(acc.attributes.id).not.toBe('old-id')
    })

    it('Reviews with no pending forms render as an empty list', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'reviewCount', expression: '$reviews.size()' }],
        })
        const acc = createIdentityOriginAccount()
        expect(acc.attributes.reviews).toBeUndefined()
        expect(acc.reviews).toEqual([])

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.reviewCount).toBe('0')
    })

    it('Define does not persist collection state into the attribute bag', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'statusCount', expression: '$statuses.size()' }],
            uniqueAttributeDefinitions: [{ name: 'id', expression: REVIEWER_GATED_ID }],
        })
        const acc = createIdentityOriginAccount()
        acc.collections.statuses.add(StatusEntitlement.Reviewer)
        expect(acc.attributes.statuses).toBeUndefined()

        await service.refreshNormalAttributes(acc)
        await service.refreshUniqueAttributes(acc)

        expect(acc.attributes.statuses).toBeUndefined()
        expect(acc.attributes.statusCount).toBeDefined()
        expect(acc.attributes.id).toMatch(UUID_PATTERN)
    })

    it('Previous attributes still expose the prior collection snapshot', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'priorStatusCount', expression: '$previous.statuses.size()' }],
        })
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted',
            sourceName: 'Identity Fusion NG',
            attributes: {
                name: 'Persisted',
                statuses: [StatusEntitlement.Baseline],
            },
        } as any)
        acc.setNeedsRefresh(true)
        acc.collections.statuses.add(StatusEntitlement.Reviewer)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.priorStatusCount).toBe('1')
        expect(acc.statuses).toEqual(expect.arrayContaining([StatusEntitlement.Baseline, StatusEntitlement.Reviewer]))
    })

    it('Live collection keys override the persisted collection snapshot', async () => {
        const service = createService({
            normalAttributeDefinitions: [{ name: 'liveStatusCount', expression: '$statuses.size()' }],
        })
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted',
            sourceName: 'Identity Fusion NG',
            attributes: {
                name: 'Persisted',
                statuses: [StatusEntitlement.Baseline],
            },
        } as any)
        acc.setNeedsRefresh(true)
        acc.attributeBag.current.statuses = [StatusEntitlement.Baseline]
        acc.collections.statuses.add(StatusEntitlement.Reviewer)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.liveStatusCount).toBe('2')
    })

    it('Normal definition named after a live collection key wins for later definitions', async () => {
        const service = createService({
            normalAttributeDefinitions: [
                { name: 'statuses', expression: 'custom' },
                { name: 'copy', expression: '$statuses' },
            ],
        })
        const acc = createIdentityOriginAccount()
        acc.collections.statuses.add(StatusEntitlement.Reviewer)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.copy).toBe('custom')
    })

    it('Normal definition sees a persisted reviewer action', async () => {
        const reviewerAction = `${FusionAction.ReviewerPrefix}src-hr`
        const service = createService({
            normalAttributeDefinitions: [
                {
                    name: 'hasReviewerAction',
                    expression: `#if($actions.includes("${reviewerAction}"))present#{else}absent#end`,
                },
            ],
        })
        const acc = FusionAccount.fromFusionAccount({
            nativeIdentity: 'fusion-native-1',
            name: 'Persisted Reviewer',
            sourceName: 'Identity Fusion NG',
            attributes: {
                name: 'Persisted Reviewer',
                actions: [reviewerAction],
            },
        } as any)
        acc.setNeedsRefresh(true)

        await service.refreshNormalAttributes(acc)

        expect(acc.attributes.hasReviewerAction).toBe('present')
    })

    it('Normal definition does not see global reviewer status on the creating run', async () => {
        const service = createService({
            normalAttributeDefinitions: [
                {
                    name: 'sawReviewer',
                    expression: '#if($statuses.includes("reviewer"))present#{else}absent#end',
                },
            ],
            uniqueAttributeDefinitions: [{ name: 'id', expression: REVIEWER_GATED_ID }],
        })
        const acc = createIdentityOriginAccount()

        await service.refreshNormalAttributes(acc)
        expect(acc.attributes.sawReviewer).toBe('absent')

        acc.collections.statuses.add(StatusEntitlement.Reviewer)
        await service.refreshUniqueAttributes(acc)

        expect(acc.attributes.id).toMatch(UUID_PATTERN)
    })
})

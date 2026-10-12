import type { AccountV2025 as Account } from 'sailpoint-api-client'
import { FusionAttribute } from '../../../data/schema'
import type { FusionAccount } from '../../../model/account'
import type { SourceConfig } from '../../../model/config'
import { createFusionServiceTestContext, type FusionServiceTestContext } from './fusionService.testFixtures'

const FUSION_MODIFIED = '2024-06-01T12:00:00.000Z'
const STALE_MODIFIED = '2024-01-01T00:00:00.000Z'
const ORIGIN_KEY = 'src-origin::origin-1'
const LIVE_KEY = 'src-a::live-1'
const LATER_KEY = 'src-b::later-1'
const EARLIER_KEY = 'src-a::earlier'
const BLEND_LATER_KEY = 'src-a::later'

function managedAccount(sourceId: string, nativeIdentity: string, sourceName: string): Account {
    return {
        id: `isc-${sourceId}-${nativeIdentity}`,
        sourceId,
        nativeIdentity,
        sourceName,
        name: `${sourceName} ${nativeIdentity}`,
        modified: STALE_MODIFIED,
        attributes: {},
    } as Account
}

function useWorkQueue(ctx: FusionServiceTestContext, accounts: Account[]): void {
    const queue = new Map<string, Account>()
    vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(queue)
    vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
    for (const account of accounts) {
        ctx.run.setManagedAccount(`${account.sourceId}::${account.nativeIdentity}`, account)
    }
}

type ProcessOptions = {
    accounts?: string[]
    mainAccount?: string
    originSource?: string
    originAccount?: string
    identityId?: string
    statuses?: string[]
    linked?: Account[]
    sources?: Array<Pick<SourceConfig, 'name'>>
    toggle?: boolean
    omitToggle?: boolean
    originIdentityInScope?: boolean
    onMap?: (account: FusionAccount) => void
}

async function processFusionAccount(ctx: FusionServiceTestContext, options: ProcessOptions = {}) {
    ctx.mockConfig.sources = (options.sources ?? []) as SourceConfig[]
    ctx.mockConfig.fusionAccountRefreshThresholdInSeconds = 3600
    ctx.mockConfig.forceAttributeRefresh = false
    if (options.omitToggle) {
        delete (ctx.mockConfig as { promoteMainAccountWhenOriginMissing?: boolean }).promoteMainAccountWhenOriginMissing
    } else {
        ctx.mockConfig.promoteMainAccountWhenOriginMissing = options.toggle ?? true
    }

    useWorkQueue(ctx, options.linked ?? [])
    ctx.mockMappingService.mapAttributes.mockImplementation((account: FusionAccount) => {
        options.onMap?.(account)
        return account
    })
    ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue(undefined)
    ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue(undefined)
    ctx.mockDefinitionService.hasEligibleAlwaysRecalculate.mockReturnValue(false)
    ctx.mockIdentities.resolveOriginIdentityInScope.mockResolvedValue(undefined)

    const attributes: Record<string, unknown> = {
        accounts: options.accounts ?? [],
        originSource: options.originSource ?? 'HR',
        originAccount: options.originAccount ?? ORIGIN_KEY,
    }
    if (options.mainAccount !== undefined) attributes.mainAccount = options.mainAccount
    if (options.statuses) attributes.statuses = options.statuses
    if (options.identityId) attributes.identityId = options.identityId

    return ctx.fusionService.processFusionAccount(
        {
            nativeIdentity: 'fusion-1',
            id: 'isc-fusion-1',
            name: 'Fusion One',
            sourceName: 'Identity Fusion',
            modified: FUSION_MODIFIED,
            identityId: options.identityId,
            attributes,
        } as unknown as Account,
        undefined,
        options.originIdentityInScope
    )
}

describe('promoteMainAccountWhenOriginMissing', () => {
    let ctx: FusionServiceTestContext

    beforeEach(() => {
        ctx = createFusionServiceTestContext()
    })

    it('Managed-origin account promotes the first live managed account', async () => {
        const result = await processFusionAccount(ctx, {
            accounts: [LIVE_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A')],
            mainAccount: 'src-old::stored',
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe(LIVE_KEY)
        expect(result.originAccountId).toBe(ORIGIN_KEY)
        expect(result.needsRefresh).toBe(true)
        const handoffLines = result.history.filter((line) => line.includes('mainAccount'))
        expect(handoffLines).toHaveLength(1)
        expect(handoffLines[0]).toContain('src-old::stored')
        expect(handoffLines[0]).toContain(LIVE_KEY)
    })

    it('First live managed account follows configured source order', async () => {
        const later = managedAccount('src-b', 'later-1', 'Source B')
        const earlier = managedAccount('src-a', 'live-1', 'Source A')
        later.modified = '2024-06-01T14:00:00.000Z'
        earlier.modified = '2024-06-01T14:00:00.000Z'

        const result = await processFusionAccount(ctx, {
            accounts: [LATER_KEY, LIVE_KEY],
            linked: [later, earlier],
            sources: [{ name: 'Source A' }, { name: 'Source B' }],
            mainAccount: LATER_KEY,
        })

        expect(result.attributeBag.sources.get('Source A')?.length).toBeGreaterThan(0)
        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe(LIVE_KEY)
    })

    it('First live managed account follows blend order within one source', async () => {
        const result = await processFusionAccount(ctx, {
            accounts: [EARLIER_KEY, BLEND_LATER_KEY],
            linked: [managedAccount('src-a', 'earlier', 'Source A'), managedAccount('src-a', 'later', 'Source A')],
            mainAccount: BLEND_LATER_KEY,
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe(EARLIER_KEY)
    })

    it('Identity bag is not the first live managed account', async () => {
        const result = await processFusionAccount(ctx, {
            originSource: 'Identities',
            originAccount: 'identity-1',
            identityId: 'identity-1',
            statuses: ['baseline'],
            accounts: [LIVE_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A')],
            originIdentityInScope: false,
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe(LIVE_KEY)
        expect(result.getStringAttribute(FusionAttribute.MainAccount)).not.toBe('identity-1')
        expect(result.statuses).not.toContain('orphan')
    })

    it('No live managed account clears mainAccount', async () => {
        const result = await processFusionAccount(ctx, {
            accounts: [],
            mainAccount: 'src-old::stored',
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBeUndefined()
        expect(result.attributes[FusionAttribute.MainAccount]).toBeUndefined()
        expect(result.needsRefresh).toBe(true)
    })

    it('Unchanged mainAccount does not force refresh', async () => {
        const result = await processFusionAccount(ctx, {
            accounts: [LIVE_KEY, LATER_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A'), managedAccount('src-b', 'later-1', 'Source B')],
            sources: [{ name: 'Source A' }, { name: 'Source B' }],
            mainAccount: LIVE_KEY,
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe(LIVE_KEY)
        expect(result.needsRefresh).toBe(false)
        expect(result.history.some((line) => line.includes('mainAccount'))).toBe(false)
    })

    it('Managed-origin account clears a stored mainAccount while the origin key remains', async () => {
        const result = await processFusionAccount(ctx, {
            accounts: [ORIGIN_KEY, LIVE_KEY],
            linked: [managedAccount('src-origin', 'origin-1', 'HR'), managedAccount('src-a', 'live-1', 'Source A')],
            mainAccount: LIVE_KEY,
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBeUndefined()
        expect(result.accountIds).toContain(ORIGIN_KEY)
        expect(result.needsRefresh).toBe(true)
    })

    it('Identity-origin account clears mainAccount when the origin identity is in scope', async () => {
        const result = await processFusionAccount(ctx, {
            originSource: 'Identities',
            originAccount: 'identity-1',
            identityId: 'identity-1',
            statuses: ['baseline'],
            accounts: [LIVE_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A')],
            mainAccount: LIVE_KEY,
            originIdentityInScope: true,
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBeUndefined()
    })

    it('Origin returns on a later run and clears mainAccount', async () => {
        const result = await processFusionAccount(ctx, {
            accounts: [ORIGIN_KEY, LIVE_KEY],
            linked: [managedAccount('src-origin', 'origin-1', 'HR'), managedAccount('src-a', 'live-1', 'Source A')],
            mainAccount: LIVE_KEY,
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBeUndefined()
        expect(result.history.some((line) => line.includes('cleared') && line.includes(LIVE_KEY))).toBe(true)
    })

    it('Toggle off leaves mainAccount unchanged when the origin key is gone', async () => {
        const result = await processFusionAccount(ctx, {
            toggle: false,
            accounts: [LIVE_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A')],
            mainAccount: 'src-old::stored',
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe('src-old::stored')
    })

    it('Absent key leaves mainAccount unchanged', async () => {
        const result = await processFusionAccount(ctx, {
            omitToggle: true,
            accounts: [LIVE_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A')],
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBeUndefined()
    })

    it('Skipped refresh does not promote from a missing origin snapshot', async () => {
        const result = await processFusionAccount(ctx, {
            accounts: [ORIGIN_KEY, LIVE_KEY],
            linked: [managedAccount('src-origin', 'origin-1', 'HR'), managedAccount('src-a', 'live-1', 'Source A')],
        })

        expect(result.attributeBag.sources.get('HR')).toBeUndefined()
        expect(result.accountIds).toContain(ORIGIN_KEY)
        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBeUndefined()
    })

    it('Unresolved identity scope does not change mainAccount', async () => {
        const result = await processFusionAccount(ctx, {
            originSource: 'Identities',
            originAccount: 'identity-1',
            identityId: 'identity-1',
            statuses: ['baseline'],
            accounts: [LIVE_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A')],
            mainAccount: 'src-old::stored',
        })

        expect(result.originIdentityInScope).toBeUndefined()
        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe('src-old::stored')
    })

    it('Turning the toggle off leaves a previously promoted mainAccount in place', async () => {
        const result = await processFusionAccount(ctx, {
            toggle: false,
            accounts: [ORIGIN_KEY, LIVE_KEY],
            linked: [managedAccount('src-origin', 'origin-1', 'HR'), managedAccount('src-a', 'live-1', 'Source A')],
            mainAccount: LIVE_KEY,
        })

        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe(LIVE_KEY)
    })

    it('Explicit map wins over the handoff in the same run', async () => {
        let mainAccountAtMap: string | undefined
        const result = await processFusionAccount(ctx, {
            accounts: [LIVE_KEY],
            linked: [managedAccount('src-a', 'live-1', 'Source A')],
            onMap: (account) => {
                mainAccountAtMap = account.getStringAttribute(FusionAttribute.MainAccount)
                account.attributes[FusionAttribute.MainAccount] = 'mapped-value'
            },
        })

        expect(mainAccountAtMap).toBe(LIVE_KEY)
        expect(result.getStringAttribute(FusionAttribute.MainAccount)).toBe('mapped-value')
    })
})

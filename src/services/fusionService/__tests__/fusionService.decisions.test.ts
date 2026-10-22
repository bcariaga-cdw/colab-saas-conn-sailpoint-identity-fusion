import { createFusionServiceTestContext, seedRunInventory, type FusionServiceTestContext } from './fusionService.testFixtures'
import { FusionAccount } from '../../../model/account'
import { OrphanProcessingMode, SourceType } from '../../../model/config'
import { StatusEntitlement } from '../../../model/statusEntitlement'
import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'

describe('FusionService — decisions', () => {
    let ctx: FusionServiceTestContext

    beforeEach(() => {
        ctx = createFusionServiceTestContext()
    })

    describe('processFusionIdentityDecision sourceType branches', () => {
        it('updates the existing fusion identity account for authorized decisions', async () => {
            const existingIdentity = {
                id: 'identity-1',
                name: 'Existing Identity',
                accounts: [],
                attributes: {},
            } as unknown as IdentityDocument
            const existingFusionAccount = FusionAccount.fromIdentity(existingIdentity)
            existingFusionAccount.collections.statuses.setNonMatched(existingFusionAccount.name, existingFusionAccount.sourceName)
            ctx.fusionService.setFusionAccount(existingFusionAccount)

            const managedAccount = {
                id: 'acct-authz-existing-1',
                name: 'LH2 User',
                sourceId: 'src-lh2',
                nativeIdentity: 'lh2-authz-existing',
                sourceName: 'LH2',
                attributes: {},
            } as Account
            const managedKey = 'src-lh2::lh2-authz-existing'
            const managedMap = new Map<string, Account>([[managedKey, managedAccount]])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[managedKey, managedAccount]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockIdentities.getIdentityById.mockReturnValue(existingIdentity)
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)
            vi.spyOn(ctx.mockSources, 'getSourceConfig').mockReturnValue({
                name: 'LH2',
                correlationMode: 'correlate',
                sourceType: 'authoritative',
            } as any)

            const decision = {
                submitter: { id: 'reviewer-1', email: 'reviewer@example.com', name: 'Reviewer' },
                account: {
                    id: managedKey,
                    name: 'LH2 User',
                    sourceName: 'LH2',
                    sourceId: 'src-lh2',
                    nativeIdentity: 'lh2-authz-existing',
                },
                newIdentity: false,
                identityId: 'identity-1',
                comments: 'Assign into existing identity',
                finished: true,
                sourceType: 'authoritative',
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(result).toBe(existingFusionAccount)
            expect(result?.needsReset).toBe(false)
            expect(result?.statuses).toContain('authorized')
            expect(result?.statuses).not.toContain('auto')
            expect(result?.statuses).not.toContain('nonMatched')
            expect(result?.history.some((h) => h.includes('into Existing Identity by Reviewer'))).toBe(true)
            expect(result?.history.some((h) => h.includes('Associated managed account LH2 User [LH2]'))).toBe(false)
            expect(ctx.mockIdentities.correlateAccounts).toHaveBeenCalledWith(existingFusionAccount, [managedKey], 'merge')
            expect(ctx.fusionService.getFusionIdentity('identity-1')).toBe(existingFusionAccount)
        })

        it('writes auto-merge history for system automatic-assignment decisions', async () => {
            const existingIdentity = {
                id: 'identity-2',
                name: 'Existing Identity Two',
                accounts: [],
                attributes: {},
            } as unknown as IdentityDocument
            const existingFusionAccount = FusionAccount.fromIdentity(existingIdentity)
            ctx.fusionService.setFusionAccount(existingFusionAccount)

            const managedAccount = {
                id: 'acct-auto-1',
                name: 'LH2 User',
                sourceId: 'src-lh2',
                nativeIdentity: 'lh2-auto',
                sourceName: 'LH2',
                attributes: {},
            } as Account
            const managedKeyAuto = 'src-lh2::lh2-auto'
            const managedMap = new Map<string, Account>([[managedKeyAuto, managedAccount]])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[managedKeyAuto, managedAccount]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockIdentities.getIdentityById.mockReturnValue(existingIdentity)
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)
            vi.spyOn(ctx.mockSources, 'getSourceConfig').mockReturnValue({
                name: 'LH2',
                correlationMode: 'none',
                sourceType: 'authoritative',
            } as any)

            const decision = {
                submitter: { id: 'system', email: '', name: 'System (automatic merge)' },
                account: {
                    id: managedKeyAuto,
                    name: 'LH2 User',
                    sourceName: 'LH2',
                    sourceId: 'src-lh2',
                    nativeIdentity: 'lh2-auto',
                },
                newIdentity: false,
                identityId: 'identity-2',
                comments: 'Automatically assigned: exact attribute match (all rules 100, none skipped)',
                finished: true,
                sourceType: 'authoritative',
                automaticMerge: true,
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)
            ctx.mockDefinitionService.getSimpleKey.mockReturnValue({ simple: { id: 'identity-2' } })
            ctx.mockSchemas.getFusionAttributeSubset.mockImplementation((attributes) => ({ ...attributes }))
            const output = await ctx.fusionService.getISCAccount(result!)

            expect(output?.attributes.statuses).toContain('auto')
            expect(output?.attributes.statuses).not.toContain('authorized')
            expect(output?.attributes['missing-accounts']).toContain(managedKeyAuto)
            expect(output?.attributes.actions).not.toContain('correlated')
            expect(result?.history.some((h) => h.includes('Auto-merged LH2 User [LH2] into Existing Identity Two'))).toBe(
                true
            )
            expect(result?.history.some((h) => h.includes('Associated managed account LH2 User [LH2]'))).toBe(false)
            expect(ctx.mockIdentities.correlateAccounts).not.toHaveBeenCalled()
        })

        it('system automatic merge still PATCHes accounts when source correlationMode is correlate', async () => {
            const existingIdentity = {
                id: 'identity-auto-corr',
                name: 'Identity Auto Corr',
                accounts: [],
                attributes: {},
            } as unknown as IdentityDocument
            const existingFusionAccount = FusionAccount.fromIdentity(existingIdentity)
            ctx.fusionService.setFusionAccount(existingFusionAccount)

            const managedAccount = {
                id: 'acct-auto-corr-1',
                name: 'User',
                sourceId: 'src-lh2',
                nativeIdentity: 'lh2-auto-corr',
                sourceName: 'LH2',
                attributes: {},
            } as Account
            const managedKeyAutoCorr = 'src-lh2::lh2-auto-corr'
            const managedMap = new Map<string, Account>([[managedKeyAutoCorr, managedAccount]])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[managedKeyAutoCorr, managedAccount]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockIdentities.getIdentityById.mockReturnValue(existingIdentity)
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)
            vi.spyOn(ctx.mockSources, 'getSourceConfig').mockReturnValue({
                name: 'LH2',
                correlationMode: 'correlate',
                sourceType: 'authoritative',
            } as any)

            const decision = {
                submitter: { id: 'system', email: '', name: 'System (automatic merge)' },
                account: {
                    id: managedKeyAutoCorr,
                    name: 'User',
                    sourceName: 'LH2',
                    sourceId: 'src-lh2',
                    nativeIdentity: 'lh2-auto-corr',
                },
                newIdentity: false,
                identityId: 'identity-auto-corr',
                comments: 'Automatically assigned: exact attribute match (all rules 100, none skipped)',
                finished: true,
                sourceType: 'authoritative',
                automaticMerge: true,
            } as any

            await ctx.fusionService.processFusionIdentityDecision(decision)
            expect(ctx.mockIdentities.correlateAccounts).toHaveBeenCalledWith(
                expect.any(FusionAccount),
                [managedKeyAutoCorr],
                'merge'
            )
        })

        it('suppresses generic association history for authorized decisions without identityId', async () => {
            const managedAccount = {
                id: 'acct-authz-no-id-1',
                name: 'LH2 User',
                sourceId: 'src-lh2',
                nativeIdentity: 'lh2-authz-noid',
                sourceName: 'LH2',
                attributes: {},
            } as Account
            const managedKeyNoId = 'src-lh2::lh2-authz-noid'
            const managedMap = new Map<string, Account>([[managedKeyNoId, managedAccount]])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[managedKeyNoId, managedAccount]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const decision = {
                submitter: { id: 'reviewer-1', email: 'reviewer@example.com', name: 'Reviewer' },
                account: {
                    id: managedKeyNoId,
                    name: 'LH2 User',
                    sourceName: 'LH2',
                    sourceId: 'src-lh2',
                    nativeIdentity: 'lh2-authz-noid',
                },
                newIdentity: false,
                identityId: undefined,
                comments: 'Assign into existing identity',
                finished: true,
                sourceType: 'authoritative',
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)
            expect(result?.history.some((h) => h.includes('into existing identity by Reviewer'))).toBe(true)
            expect(result?.history.some((h) => h.includes('Associated managed account LH2 User [LH2]'))).toBe(false)
        })

        it('correlates accounts for authorized decisions to the selected identity in the same ctx.run', async () => {
            const managedAccount = {
                id: 'acct-authz-1',
                name: 'Authorized User',
                sourceId: 'src-auth-src',
                nativeIdentity: 'auth-src-native-1',
                sourceName: 'Authoritative Source',
                attributes: {},
            } as Account
            const managedKeyAuthz = 'src-auth-src::auth-src-native-1'
            const managedMap = new Map<string, Account>([[managedKeyAuthz, managedAccount]])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[managedKeyAuthz, managedAccount]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockIdentities.getIdentityById.mockReturnValue(undefined as any)
            ctx.mockIdentities.fetchIdentityById.mockResolvedValue({
                id: 'identity-1',
                name: 'Identity One',
                accounts: [],
                attributes: {},
            } as unknown as IdentityDocument)
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)
            vi.spyOn(ctx.mockSources, 'getSourceConfig').mockReturnValue({
                name: 'Authoritative Source',
                correlationMode: 'correlate',
                sourceType: 'authoritative',
            } as any)

            const decision = {
                submitter: { id: 'reviewer-1', email: 'reviewer@example.com', name: 'Reviewer' },
                account: {
                    id: managedKeyAuthz,
                    name: 'Authorized User',
                    sourceName: 'Authoritative Source',
                    sourceId: 'src-auth-src',
                    nativeIdentity: 'auth-src-native-1',
                },
                newIdentity: false,
                identityId: 'identity-1',
                comments: 'Assign into existing identity',
                finished: true,
                sourceType: 'authoritative',
            } as any

            await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(ctx.mockIdentities.correlateAccounts).toHaveBeenCalledTimes(1)
            expect(ctx.mockIdentities.correlateAccounts).toHaveBeenCalledWith(
                expect.any(FusionAccount),
                [managedKeyAuthz],
                'merge'
            )
        })

        it('registers unique attributes and skips output for record no-match decisions', async () => {
            const managedKey = 'src-record-src::record-native-1'
            const managedAccount = {
                id: managedKey,
                name: 'Record User',
                sourceName: 'Record Source',
                sourceId: 'src-record-src',
                nativeIdentity: 'record-native-1',
                attributes: {},
            } as Account
            const managedMap = new Map<string, Account>([[managedKey, managedAccount]])
            Object.defineProperty(ctx.run, 'managedAccountsById', {
                get: () => managedMap,
                configurable: true,
            })
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[managedKey, managedAccount]]))
            ctx.run.sourcesByName.set('Record Source', {
                id: 'src-record-src',
                name: 'Record Source',
                sourceType: 'record',
                config: {},
            })
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()
            const registerRecordSpy = vi
                .spyOn(ctx.mockDefinitionService, 'registerUniqueValuesFromRecordManagedAccount')
                .mockResolvedValue(undefined)

            const decision = {
                submitter: { id: 'reviewer-1', email: 'reviewer@example.com', name: 'Reviewer' },
                account: {
                    id: managedKey,
                    name: 'Record User',
                    sourceName: 'Record Source',
                    sourceId: 'src-record-src',
                    nativeIdentity: 'record-native-1',
                },
                newIdentity: true,
                identityId: undefined,
                comments: 'No matching identity',
                finished: true,
                sourceType: 'record',
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(result).toBeUndefined()
            expect(registerRecordSpy).toHaveBeenCalledWith(managedAccount, ctx.mockMappingService, ctx.run)
            expect(ctx.mockDefinitionService.registerUniqueAttributes).not.toHaveBeenCalled()
        })

        it('safely skips orphan disable queue when account is no longer in managed map', async () => {
            const managedKeyOrphan = 'src-orphan-1::orphan-native-1'
            const managedMap = new Map<string, Account>()

            Object.defineProperty(ctx.run, 'managedAccountsById', {
                get: () => managedMap,
                configurable: true,
            })
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map())
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ;(ctx.fusionService as any).run.sourcesByName.set('Orphan Source', {
                id: 'src-orphan-1',
                name: 'Orphan Source',
                sourceType: 'orphan',
                config: { disableNonMatchingAccounts: true },
            })

            const queueDisableSpy = vi.spyOn(ctx.fusionService.run, 'queueDisableOperation').mockImplementation(() => {})
            const decision = {
                submitter: { id: 'reviewer-1', email: 'reviewer@example.com', name: 'Reviewer' },
                account: {
                    id: managedKeyOrphan,
                    name: 'Orphan User',
                    sourceName: 'Orphan Source',
                    sourceId: 'src-orphan-1',
                    nativeIdentity: 'orphan-native-1',
                },
                newIdentity: true,
                identityId: undefined,
                comments: 'Reject orphan match',
                finished: true,
                sourceType: 'orphan',
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(result).toBeUndefined()
            expect(queueDisableSpy).not.toHaveBeenCalled()
        })

        it('registers a new fusion account for authoritative new-identity decisions', async () => {
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(new Map())
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map())
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const setFusionAccountSpy = vi.spyOn(ctx.fusionService.run, 'registerFusionAccount')
            const decision = {
                submitter: { id: 'reviewer-1', email: 'reviewer@example.com', name: 'Reviewer' },
                account: {
                    id: 'src-auth-src::auth-new-native-1',
                    name: 'Auth User',
                    sourceName: 'Authoritative Source',
                    sourceId: 'src-auth-src',
                    nativeIdentity: 'auth-new-native-1',
                },
                newIdentity: true,
                identityId: undefined,
                comments: 'Create new identity',
                finished: true,
                sourceType: 'authoritative',
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(result).toBeDefined()
            expect(setFusionAccountSpy).toHaveBeenCalledTimes(1)
        })
    })

    describe('history consistency safeguards', () => {
        it('does not duplicate set-history messages on no-op add', () => {
            const fusionAccount = FusionAccount.fromManagedAccount({
                id: 'acct-history-noop-1',
                name: 'History User',
                sourceId: 'src-history',
                nativeIdentity: 'hist-noop',
                sourceName: 'History Source',
                attributes: {},
            } as Account)

            fusionAccount.collections.statuses.add(StatusEntitlement.Candidate, 'Set candidate status')
            fusionAccount.collections.statuses.add(StatusEntitlement.Candidate, 'Set candidate status')

            const duplicateMessages = fusionAccount.history.filter((h) => h.includes('Set candidate status'))
            expect(duplicateMessages).toHaveLength(1)
        })

        it('normalizes imported history by trimming and removing blank entries', () => {
            const fusionAccount = FusionAccount.fromManagedAccount({
                id: 'acct-history-import-1',
                name: 'History User',
                sourceId: 'src-history',
                nativeIdentity: 'hist-import',
                sourceName: 'History Source',
                attributes: {},
            } as Account)

            fusionAccount.collections.historyOps.importFromArray(['   ', 'first-entry', 'first-entry', '  second-entry  '])

            expect(fusionAccount.history).toEqual(['first-entry', 'second-entry'])
        })

        it('resolves reviewer and merge-target ids to display names in history', async () => {
            const targetIdentityId = '9d86f225e3a24b1a9e3d10d92ec12005'
            const reviewerId = 'reviewer-out-of-scope'
            const existingIdentity = {
                id: targetIdentityId,
                name: 'Albert Wesker',
                accounts: [],
                attributes: { displayName: 'Albert Wesker' },
            } as unknown as IdentityDocument
            const existingFusionAccount = FusionAccount.fromIdentity(existingIdentity)
            ctx.fusionService.setFusionAccount(existingFusionAccount)

            const managedAccount = {
                id: 'acct-id-resolve-1',
                name: 'Sergei Vladimir',
                sourceId: 'src-umbrella',
                nativeIdentity: 'sv-1',
                sourceName: 'Umbrella Corporation',
                attributes: {},
            } as Account
            const managedKey = 'src-umbrella::sv-1'
            const managedMap = new Map<string, Account>([[managedKey, managedAccount]])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[managedKey, managedAccount]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockIdentities.getIdentityById.mockImplementation((id?: string) => {
                if (id === targetIdentityId) return existingIdentity
                return undefined
            })
            ctx.mockIdentities.fetchIdentityById.mockImplementation(async (id?: string) => {
                if (id === reviewerId) {
                    return {
                        id: reviewerId,
                        name: 'Chris Redfield',
                        attributes: { displayName: 'Chris Redfield' },
                    } as IdentityDocument
                }
                if (id === targetIdentityId) return existingIdentity
                return undefined
            })
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)
            vi.spyOn(ctx.mockSources, 'getSourceConfig').mockReturnValue({
                name: 'Umbrella Corporation',
                correlationMode: 'correlate',
                sourceType: 'authoritative',
            } as any)

            const decision = {
                submitter: { id: reviewerId, email: '', name: reviewerId },
                account: {
                    id: managedKey,
                    name: 'Sergei Vladimir',
                    sourceName: 'Umbrella Corporation',
                    sourceId: 'src-umbrella',
                    nativeIdentity: 'sv-1',
                },
                newIdentity: false,
                identityId: targetIdentityId,
                identityName: targetIdentityId,
                comments: 'Merge into existing identity',
                finished: true,
                sourceType: 'authoritative',
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(
                result?.history.some((h) =>
                    h.includes(
                        'Merged Sergei Vladimir [Umbrella Corporation] into Albert Wesker by Chris Redfield'
                    )
                )
            ).toBe(true)
            expect(result?.history.some((h) => h.includes(targetIdentityId))).toBe(false)
        })

        it('uses fallback labels when decision names are blank', async () => {
            const managedAccount = {
                id: 'acct-history-fallback-1',
                name: 'LH2 User',
                sourceId: 'src-lh2',
                nativeIdentity: 'hist-fallback',
                sourceName: 'LH2',
                attributes: {},
            } as Account
            const histKey = 'src-lh2::hist-fallback'
            const managedMap = new Map<string, Account>([[histKey, managedAccount]])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map([[histKey, managedAccount]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const decision = {
                submitter: { id: 'reviewer-1', email: ' ', name: ' ' },
                account: {
                    id: histKey,
                    name: '  ',
                    sourceName: '  ',
                    sourceId: 'src-lh2',
                    nativeIdentity: 'hist-fallback',
                },
                newIdentity: false,
                comments: 'Assign into existing identity',
                finished: true,
                sourceType: 'authoritative',
            } as any

            const result = await ctx.fusionService.processFusionIdentityDecision(decision)
            expect(
                result?.history.some((h) =>
                    h.includes('Merged Unknown account [Unknown source] into existing identity by Unknown reviewer')
                )
            ).toBe(true)
        })
    })

    describe('Ownership mode decisions', () => {
        function ownershipDecision(overrides: Record<string, unknown> = {}) {
            return {
                submitter: { id: 'reviewer-1', email: 'reviewer@example.com', name: 'Reviewer' },
                account: {
                    id: 'src-m::machine-1',
                    iscAccountId: 'fetched-id',
                    name: 'Build Bot',
                    sourceName: 'Machines',
                    sourceId: 'src-m',
                    nativeIdentity: 'machine-1',
                },
                newIdentity: false,
                identityId: 'identity-1',
                comments: 'Choose owner',
                finished: true,
                sourceType: 'orphan',
                ...overrides,
            } as any
        }

        function seedOwnershipSource(disableNonMatchingAccounts = false) {
            ctx.fusionService.run.sourcesByName.set('Machines', {
                id: 'src-m',
                name: 'Machines',
                isManaged: true,
                sourceType: SourceType.Orphan,
                config: {
                    orphanProcessingMode: OrphanProcessingMode.Ownership,
                    correlationMode: 'correlate',
                    disableNonMatchingAccounts,
                },
            })
        }

        it('writes the owner identity for an automatic merge', async () => {
            seedOwnershipSource()
            const setOwner = vi.spyOn(ctx.mockSources, 'setMachineAccountOwnerIdentity').mockResolvedValue(undefined)
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)

            const decision = ownershipDecision({
                submitter: { id: 'system', email: '', name: 'System (automatic merge)' },
                automaticMerge: true,
            })
            const result = await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(result).toBeUndefined()
            expect(setOwner).toHaveBeenCalledWith(decision.account, 'identity-1')
            expect(ctx.mockIdentities.correlateAccounts).not.toHaveBeenCalled()
        })

        it('writes the owner identity for a reviewer selection', async () => {
            const existingIdentity = {
                id: 'identity-1',
                name: 'Existing Identity',
                accounts: [],
                attributes: {},
            } as unknown as IdentityDocument
            const existingFusionAccount = FusionAccount.fromIdentity(existingIdentity)
            ctx.fusionService.setFusionAccount(existingFusionAccount)
            seedOwnershipSource()
            const setOwner = vi.spyOn(ctx.mockSources, 'setMachineAccountOwnerIdentity').mockResolvedValue(undefined)
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)

            const decision = ownershipDecision()
            const result = await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(result).toBeUndefined()
            expect(setOwner).toHaveBeenCalledWith(decision.account, 'identity-1')
            expect(ctx.mockIdentities.correlateAccounts).not.toHaveBeenCalled()
            expect(ctx.fusionService.getFusionIdentity('identity-1')).toBe(existingFusionAccount)
        })

        it('claims the managed account off the work queue after writing the owner identity', async () => {
            seedOwnershipSource()
            vi.spyOn(ctx.mockSources, 'setMachineAccountOwnerIdentity').mockResolvedValue(undefined)
            const machineAccount = {
                id: 'fetched-id',
                nativeIdentity: 'machine-1',
                sourceId: 'src-m',
                sourceName: 'Machines',
            } as Account
            const managedKey = 'src-m::machine-1'
            const workQueue = new Map<string, Account>([[managedKey, machineAccount]])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)

            const result = await ctx.fusionService.processFusionIdentityDecision(ownershipDecision())

            expect(result).toBeUndefined()
            // Claiming prevents the same run's uncorrelated sweep from re-scoring the
            // stale (owner-less) snapshot and opening a duplicate review form.
            expect(workQueue.has(managedKey)).toBe(false)
        })

        it('still correlates an Assignment-mode reviewer selection', async () => {
            ctx.fusionService.run.sourcesByName.set('Orphans', {
                id: 'src-o',
                name: 'Orphans',
                isManaged: true,
                sourceType: SourceType.Orphan,
                config: { orphanProcessingMode: OrphanProcessingMode.Assignment, correlationMode: 'correlate' },
            })
            const setOwner = vi.spyOn(ctx.mockSources, 'setMachineAccountOwnerIdentity').mockResolvedValue(undefined)
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)
            vi.spyOn(ctx.mockSources, 'getSourceConfig').mockReturnValue({
                name: 'Orphans',
                correlationMode: 'correlate',
                sourceType: SourceType.Orphan,
                orphanProcessingMode: OrphanProcessingMode.Assignment,
            } as any)
            const managedKey = 'src-o::human-1'
            seedRunInventory(ctx.run, new Map([[managedKey, { id: 'acct-h', nativeIdentity: 'human-1', sourceId: 'src-o' } as Account]]))
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const decision = ownershipDecision({
                account: {
                    id: managedKey,
                    name: 'Human',
                    sourceName: 'Orphans',
                    sourceId: 'src-o',
                    nativeIdentity: 'human-1',
                },
            })
            await ctx.fusionService.processFusionIdentityDecision(decision)

            expect(setOwner).not.toHaveBeenCalled()
            expect(ctx.mockIdentities.correlateAccounts).toHaveBeenCalled()
        })

        function seedManagedAccount(account: Account) {
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(
                new Map([['src-m::machine-1', account]])
            )
        }

        it('does not set an owner identity or disable a reviewer no-match', async () => {
            seedOwnershipSource(false)
            const setOwner = vi.spyOn(ctx.mockSources, 'setMachineAccountOwnerIdentity').mockResolvedValue(undefined)
            const disableSpy = vi.spyOn(ctx.fusionService.run, 'queueDisableOperation')
            seedManagedAccount({
                id: 'fetched-id',
                nativeIdentity: 'machine-1',
                sourceId: 'src-m',
                sourceName: 'Machines',
            } as Account)

            const result = await ctx.fusionService.processFusionIdentityDecision(ownershipDecision({ newIdentity: true, identityId: undefined }))

            expect(result).toBeUndefined()
            expect(setOwner).not.toHaveBeenCalled()
            expect(disableSpy).not.toHaveBeenCalled()
        })

        it('queues disable for a reviewer no-match when configured', async () => {
            seedOwnershipSource(true)
            const setOwner = vi.spyOn(ctx.mockSources, 'setMachineAccountOwnerIdentity').mockResolvedValue(undefined)
            const disableSpy = vi.spyOn(ctx.fusionService.run, 'queueDisableOperation').mockImplementation(() => {})
            const account = {
                id: 'fetched-id',
                nativeIdentity: 'machine-1',
                sourceId: 'src-m',
                sourceName: 'Machines',
            } as Account
            seedManagedAccount(account)

            const result = await ctx.fusionService.processFusionIdentityDecision(ownershipDecision({ newIdentity: true, identityId: undefined }))

            expect(result).toBeUndefined()
            expect(setOwner).not.toHaveBeenCalled()
            expect(disableSpy).toHaveBeenCalledWith(account)
        })
    })

})



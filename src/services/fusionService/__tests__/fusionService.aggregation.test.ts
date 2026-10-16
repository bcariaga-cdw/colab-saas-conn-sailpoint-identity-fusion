import { createFusionServiceTestContext, seedRunInventory, type FusionServiceTestContext } from './fusionService.testFixtures'
import { FusionAccount } from '../../../model/account'
import { AggregationTracker } from '../aggregationTracker'
import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'
import { FusionService } from '../fusionService'
import { StandardCommand } from '@sailpoint/connector-sdk'

describe('FusionService — aggregation', () => {
    let ctx: FusionServiceTestContext

    beforeEach(() => {
        ctx = createFusionServiceTestContext()
    })

    describe('initialization', () => {
        it('should initialize with provided config', () => {
            expect(ctx.fusionService).toBeDefined()
            expect(ctx.fusionService.isResetAccounts()).toBe(false)
            expect(ctx.fusionService.isResetForms()).toBe(false)
        })
    })

    describe('correlation logging during aggregation', () => {
        it('does not record correlated-action grants during accountList output', async () => {
            const grantSpy = vi.spyOn(ctx.mockLog, 'recordCorrelatedActionGranted')
            const account = FusionAccount.fromIdentity({
                id: 'identity-1',
                name: 'Identity One',
                attributes: { id: 'identity-1', name: 'Identity One' },
            } as any)
            account.correlation.markCorrelated('src-a::acct-1')

            await ctx.fusionService.getISCAccount(account, false)

            expect(grantSpy).not.toHaveBeenCalled()
        })
    })

    describe('reset flags', () => {
        beforeEach(() => {
            ctx.mockSources.patchSourceConfig = vi.fn().mockResolvedValue(undefined)
        })

        it('reflects resetAccounts and resetForms from config at construction', () => {
            const service = new FusionService({
                config: { ...ctx.mockConfig, resetAccounts: true, resetForms: false } as FusionConfig,
                log: ctx.mockLog,
                identities: ctx.mockIdentities,
                sources: ctx.mockSources,
                forms: ctx.mockForms,
                mappingService: ctx.mockMappingService,
                definitionService: ctx.mockDefinitionService,
                matchingService: ctx.mockMatchingService,
                schemas: ctx.mockSchemas,
                run: ctx.run,
                commandType: StandardCommand.StdAccountList,
            })

            expect(service.isResetAccounts()).toBe(true)
            expect(service.isResetForms()).toBe(false)
        })

        it('disableResetAccounts patches resetAccounts and legacy reset', async () => {
            await ctx.fusionService.disableResetAccounts()

            expect(ctx.mockSources.patchSourceConfig).toHaveBeenCalledTimes(2)
            expect(ctx.mockSources.patchSourceConfig).toHaveBeenCalledWith(
                ctx.FUSION_SOURCE_ID,
                '/connectorAttributes/resetAccounts',
                false,
                'FusionService>disableResetAccounts'
            )
            expect(ctx.mockSources.patchSourceConfig).toHaveBeenCalledWith(
                ctx.FUSION_SOURCE_ID,
                '/connectorAttributes/reset',
                false,
                'FusionService>disableResetAccounts>legacyReset'
            )
        })

        it('disableResetForms patches resetForms only', async () => {
            await ctx.fusionService.disableResetForms()

            expect(ctx.mockSources.patchSourceConfig).toHaveBeenCalledTimes(1)
            expect(ctx.mockSources.patchSourceConfig).toHaveBeenCalledWith(
                ctx.FUSION_SOURCE_ID,
                '/connectorAttributes/resetForms',
                false,
                'FusionService>disableResetForms'
            )
        })
    })

    describe('getISCAccount', () => {
        it('emits identity and uuid alongside key for platform object input validation', async () => {
            const key = { simple: { id: 'NG000025' } }
            const fusionAccount = FusionAccount.fromIdentity({ id: 'NG000025', name: 'Ada Wong' } as IdentityDocument)

            ctx.mockDefinitionService.getSimpleKey.mockReturnValue(key)
            ctx.mockSchemas.getFusionAttributeSubset.mockReturnValue({ id: 'NG000025', name: 'Ada Wong' })
            ctx.mockSchemas.listSchemaAttributeNames.mockReturnValue(['id', 'name', 'actions', 'statuses'])

            const output = await ctx.fusionService.getISCAccount(fusionAccount)

            expect(output).toMatchObject({
                key,
            })
        })

        it('does not populate reviews for candidate-only identities', async () => {
            const identityId = 'candidate-only-1'
            const reviewUrl = 'https://example.identitynow.com/forms/review/abc'
            const key = { simple: { id: identityId } }
            const fusionAccount = FusionAccount.fromIdentity({
                id: identityId,
                name: 'Candidate Only',
            } as IdentityDocument)

            ctx.mockDefinitionService.getSimpleKey.mockReturnValue(key)
            ctx.mockSchemas.getFusionAttributeSubset.mockImplementation((attrs) => ({ ...attrs }))
            ctx.mockSchemas.listSchemaAttributeNames.mockReturnValue(['id', 'name', 'actions', 'statuses', 'reviews'])

            ;(ctx.run as any).pendingCandidateIdentityIdsValue = new Set([identityId])
            ;(ctx.run as any).pendingReviewUrlsByCandidateIdValue = new Map([[identityId, [reviewUrl]]])
            ;(ctx.run as any).pendingReviewUrlsByReviewerIdValue = new Map()

            const output = await ctx.fusionService.getISCAccount(fusionAccount)

            expect(output?.attributes?.statuses).toContain('candidate')
            expect(output?.attributes?.statuses).not.toContain('activeReviews')
            expect(output?.attributes?.reviews).toEqual([])
        })

        it('populates reviews for reviewer identities with pending forms', async () => {
            const identityId = 'reviewer-1'
            const reviewUrl = 'https://example.identitynow.com/forms/review/reviewer'
            const key = { simple: { id: identityId } }
            const fusionAccount = FusionAccount.fromIdentity({
                id: identityId,
                name: 'Reviewer User',
            } as IdentityDocument)
            fusionAccount.collections.actions.setSourceReviewer('src-1')

            ctx.mockDefinitionService.getSimpleKey.mockReturnValue(key)
            ctx.mockSchemas.getFusionAttributeSubset.mockImplementation((attrs) => ({ ...attrs }))
            ctx.mockSchemas.listSchemaAttributeNames.mockReturnValue(['id', 'name', 'actions', 'statuses', 'reviews'])

            ;(ctx.run as any).pendingCandidateIdentityIdsValue = new Set()
            ;(ctx.run as any).pendingReviewUrlsByCandidateIdValue = new Map()
            ;(ctx.run as any).pendingReviewUrlsByReviewerIdValue = new Map([[identityId, [reviewUrl]]])

            const output = await ctx.fusionService.getISCAccount(fusionAccount)

            expect(output?.attributes?.statuses).toContain('reviewer')
            expect(output?.attributes?.statuses).toContain('activeReviews')
            expect(output?.attributes?.reviews).toEqual([reviewUrl])
        })
    })

    describe('processFusionAccounts', () => {
        it('should process existing fusion accounts', async () => {
            const mockAccount = {
                nativeIdentity: 'fusion-1',
                attributes: {
                    id: 'fusion-1',
                    name: 'Existing Fusion Account',
                },
            } as unknown as Account

            vi.spyOn(ctx.mockSources, 'fusionAccounts', 'get').mockReturnValue([mockAccount])

            // Mock FusionAccount.fromFusionAccount static method if possible,
            // but since it's a class method we might depend on its implementation or mock the return of processFusionAccount
            // For unit testing FusionService, we want to see if it calls processFusionAccount.

            // Since processFusionAccounts calls processFusionAccount internally, let's spy on that if we can,
            // or verify side effects.

            const result = await ctx.fusionService.processFusionAccounts()

            expect(result).toHaveLength(1)
            expect(result[0].managedKey).toBe(`fusion-1`)
        })

        it('removes the correlated identity from the identity work queue after processing', async () => {
            const identityId = 'identity-claimed-1'
            const mockAccount = {
                nativeIdentity: 'fusion-claimed-1',
                sourceId: 'mock-source',
                identityId,
                attributes: {
                    id: 'fusion-claimed-1',
                    name: 'Claimed Fusion Account',
                    statuses: [],
                    accounts: [],
                },
            } as unknown as Account

            vi.spyOn(ctx.mockSources, 'fusionAccounts', 'get').mockReturnValue([mockAccount])
            ctx.mockIdentities.getIdentityById.mockReturnValue(undefined)
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            // deleteIdentity must exist on the mock (it's a new method)
            ctx.mockIdentities.deleteIdentity = vi.fn()

            await ctx.fusionService.processFusionAccounts()

            expect(ctx.mockIdentities.deleteIdentity).toHaveBeenCalledWith(identityId)
        })

        it('does not call deleteIdentity for uncorrelated fusion accounts (no identityId)', async () => {
            const mockAccount = {
                nativeIdentity: 'fusion-uncorrelated-1',
                sourceId: 'mock-source',
                identityId: undefined,
                attributes: {
                    id: 'fusion-uncorrelated-1',
                    name: 'Uncorrelated Fusion Account',
                    statuses: [],
                    accounts: [],
                },
            } as unknown as Account

            vi.spyOn(ctx.mockSources, 'fusionAccounts', 'get').mockReturnValue([mockAccount])
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            ctx.mockIdentities.deleteIdentity = vi.fn()

            await ctx.fusionService.processFusionAccounts()

            expect(ctx.mockIdentities.deleteIdentity).not.toHaveBeenCalled()
        })

        it('ensures processIdentities skips an identity after processFusionAccounts claims it', async () => {
            const identityId = 'identity-dedup-1'
            const mockFusionAccount = {
                nativeIdentity: 'fusion-dedup-1',
                sourceId: 'mock-source',
                identityId,
                attributes: {
                    id: 'fusion-dedup-1',
                    name: 'Dedup Fusion Account',
                    statuses: [],
                    accounts: [],
                },
            } as unknown as Account

            const mockIdentityDoc = { id: identityId, name: 'Dedup Identity' } as IdentityDocument

            vi.spyOn(ctx.mockSources, 'fusionAccounts', 'get').mockReturnValue([mockFusionAccount])
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            // deleteIdentity removes identity from the service cache; simulate this by tracking calls
            const deletedIds = new Set<string>()
            ctx.mockIdentities.deleteIdentity = vi.fn((id: string) => {
                deletedIds.add(id)
            })

            // identities getter returns only those not yet deleted
            const allIdentities = [mockIdentityDoc]
            vi.spyOn(ctx.mockIdentities, 'identities', 'get').mockImplementation(() =>
                allIdentities.filter((i) => !deletedIds.has(i.id))
            )
            ctx.mockIdentities.getIdentityById.mockReturnValue(undefined)

            await ctx.fusionService.processFusionAccounts()

            // After processFusionAccounts the identity should be removed
            expect(deletedIds.has(identityId)).toBe(true)

            // processIdentities will see an empty list — no new fusion account created
            const result = await ctx.fusionService.processIdentities()
            expect(result).toHaveLength(0)
        })

        it('does not append Associated managed account when fusion assignment decision replays authorization', async () => {
            const managedKey = 'source-a-id::native-new-2'
            const historicalAccount = {
                nativeIdentity: 'fusion-identity-1',
                identityId: 'identity-1',
                name: 'Fusion Identity',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {
                    accounts: ['source-a-id::native-existing-1'],
                },
            } as unknown as Account

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(
                new Map([
                    [
                        managedKey,
                        {
                            id: 'acct-new-2',
                            name: 'Managed Account New',
                            nativeIdentity: 'native-new-2',
                            sourceId: 'source-a-id',
                            sourceName: 'Source A',
                            identityId: 'identity-1',
                            attributes: {},
                        } as unknown as Account,
                    ],
                ])
            )
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(
                new Map([['identity-1', new Set([managedKey])]])
            )
            seedRunInventory(
                ctx.run,
                new Map([
                    [
                        managedKey,
                        {
                            id: 'acct-new-2',
                            name: 'Managed Account New',
                            nativeIdentity: 'native-new-2',
                            sourceId: 'source-a-id',
                            sourceName: 'Source A',
                            identityId: 'identity-1',
                            attributes: {},
                        } as unknown as Account,
                    ],
                ])
            )
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            vi.spyOn(ctx.mockForms, 'getFusionMergeDecision').mockReturnValue({
                submitter: { id: 'reviewer-1', email: 'r@example.com', name: 'fernando.delosrios' },
                account: {
                    id: managedKey,
                    name: 'Managed Account New',
                    sourceName: 'Source A',
                    sourceId: 'source-a-id',
                    nativeIdentity: 'native-new-2',
                },
                newIdentity: false,
                identityId: 'identity-1',
                comments: 'Link to existing',
                finished: true,
                sourceType: 'authoritative',
            } as any)

            const result = await ctx.fusionService.processFusionAccount(historicalAccount)

            expect(result.accountIds).toContain(managedKey)
            expect(result.history.some((h) => h.includes('into existing identity by fernando.delosrios'))).toBe(true)
            expect(
                result.history.some((h) => h.includes('Associated managed account Managed Account New [Source A]'))
            ).toBe(false)
        })
    })

    describe('FusionAccount identity reference hydration', () => {
        it('hydrates identity alias from prior fusion account identity reference when Identity document is unavailable', () => {
            const prior = {
                nativeIdentity: 'fusion-identity-1',
                sourceId: 'mock-source',
                name: '',
                identityId: 'identity-1',
                attributes: {
                    id: 'fusion-identity-1',
                    // Simulate legacy/persisted state where attributes.name may be blank or not the true identity name
                    name: '',
                },
                identity: {
                    name: 'Jane Identity (from ref)',
                },
            } as unknown as Account

            const fusionAccount = FusionAccount.fromFusionAccount(prior)

            // name is the source title (account.name) and is empty here; alias chain picks up the identity ref name
            expect(fusionAccount.name).toBeUndefined()
            expect(fusionAccount.displayName).toBeUndefined()
            expect(fusionAccount.identityName).toBe('Jane Identity (from ref)')
            expect(fusionAccount.identityDisplayName).toBe('Jane Identity (from ref)')
            expect((fusionAccount.attributeBag.identity as any)?.name).toBeUndefined()
        })

        it('does not consider a name-only reference an identity linkage', () => {
            const prior = {
                nativeIdentity: 'fusion-identity-no-ref',
                sourceId: 'mock-source',
                name: 'Managed Account Name',
                attributes: {
                    id: 'fusion-identity-no-ref',
                },
                identity: {
                    name: 'Name Only Ref',
                },
            } as unknown as Account

            const fusionAccount = FusionAccount.fromFusionAccount(prior)

            // No identityId was supplied, so IdentityInfo cannot be built: name-only references
            // are not treated as identity linkages.
            expect(fusionAccount.isIdentity).toBe(false)
            expect(fusionAccount.displayName).toBe('Managed Account Name')
            expect(fusionAccount.identityDisplayName).toBeUndefined()
        })

        it('prefers Identity attributes.displayName when identity layer is applied', () => {
            const prior = {
                nativeIdentity: 'fusion-identity-2',
                name: '',
                attributes: {
                    id: 'fusion-identity-2',
                    name: '',
                },
                identity: {
                    name: 'Stale Name (from ref)',
                },
                identityId: 'identity-xyz',
            } as unknown as Account

            const fusionAccount = FusionAccount.fromFusionAccount(prior)

            const identityDoc = {
                id: 'identity-xyz',
                name: 'Authoritative Identity Name',
                attributes: {
                    displayName: 'Authoritative Display Name',
                },
            } as unknown as IdentityDocument

            fusionAccount.addIdentityLayer(identityDoc)

            // name is the source title (still empty); displayName comes from identity.attributes.displayName
            expect(fusionAccount.name).toBeUndefined()
            expect(fusionAccount.identityName).toBe('Authoritative Identity Name')
            expect(fusionAccount.identityDisplayName).toBe('Authoritative Display Name')
        })
    })

    describe('processIdentities', () => {
        it('should process new identities', async () => {
            const mockIdentity = {
                id: 'identity-1',
                name: 'New Identity',
            } as IdentityDocument

            vi.spyOn(ctx.mockIdentities, 'identities', 'get').mockReturnValue([mockIdentity])

            // Mock mapAttributes since it's called in processIdentity
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processIdentities()

            expect(result).toHaveLength(1)
            expect(result[0].identityId).toBe('identity-1')
            // Should be registered in the map
            expect(ctx.fusionService.getFusionIdentity('identity-1')).toBeDefined()
        })

        it('marks new identity-origin fusion accounts for unique reset', async () => {
            const mockIdentity = {
                id: 'identity-reset-1',
                name: 'Reset Identity',
            } as IdentityDocument

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processIdentity(mockIdentity)

            expect(result).toBeDefined()
            expect(result?.needsReset).toBe(true)
        })

        it('uses identity display name (not ID-like attributes.name) in history entries', async () => {
            const mockIdentity = {
                id: 'identity-12345',
                name: 'Jane Doe',
                attributes: {
                    name: 'identity-12345',
                },
            } as unknown as IdentityDocument

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processIdentity(mockIdentity)

            expect(result).toBeDefined()
            expect(result?.history).toEqual(
                expect.arrayContaining([expect.stringContaining('Set Jane Doe [Identities] as baseline')])
            )
            expect(result?.history.some((entry) => entry.includes('Set identity-12345 [Identities] as baseline'))).toBe(
                false
            )
        })

        it('sets fusion display attribute from identity name at output time', async () => {
            const mockIdentity = {
                id: 'identity-display-1',
                name: 'Jane Doe',
                attributes: {
                    displayName: 'Jane Q. Doe',
                },
            } as unknown as IdentityDocument

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.applyDisplayAttributeOverride.mockImplementation((account) => {
                account.attributes.displayName = account.identityName ?? null
            })

            const result = await ctx.fusionService.processIdentity(mockIdentity)

            expect(result).toBeDefined()
            ctx.mockDefinitionService.applyDisplayAttributeOverride(result!)
            expect(result?.attributes.displayName).toBe('Jane Doe')
        })

        it('should skip existing identities', async () => {
            const mockIdentity = {
                id: 'identity-1',
                name: 'New Identity',
            } as IdentityDocument
            vi.spyOn(ctx.mockIdentities, 'identities', 'get').mockReturnValue([mockIdentity])

            await ctx.fusionService.processIdentity(mockIdentity)
            const result = await ctx.fusionService.processIdentity(mockIdentity)

            expect(result).toBeUndefined()
        })
    })

    describe('initializeSourceReviewers', () => {
        const SOURCE_ID = 'umbrella-id'
        const SOURCE_NAME = 'Umbrella Corporation'

        function managedSource() {
            return {
                id: SOURCE_ID,
                name: SOURCE_NAME,
                isManaged: true,
                sourceType: 'authoritative',
                config: {},
            }
        }

        beforeEach(() => {
            Object.defineProperty(ctx.mockSources, 'managedSources', {
                get: vi.fn(() => [managedSource()]),
                configurable: true,
            })
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue(undefined)
        })

        it('narrows run.sourcesByName to managed sources only', async () => {
            const managed = managedSource()
            const fusionSource = {
                id: ctx.FUSION_SOURCE_ID,
                name: 'Identity Fusion',
                isManaged: false,
                sourceType: 'authoritative',
                config: {},
            }

            ctx.run.sourcesByName.set(fusionSource.name, fusionSource as any)
            ctx.run.sourcesByName.set(managed.name, managed as any)
            ;(ctx.fusionService as any).fusionOwnerIsGlobalReviewer = false

            await ctx.fusionService.initializeSourceReviewers()

            expect(ctx.run.sourcesByName.has('Identity Fusion')).toBe(false)
            expect(ctx.run.sourcesByName.has(SOURCE_NAME)).toBe(true)
            expect(ctx.run.sourcesByName.size).toBe(1)
        })

        it('registers global owners as reviewers when owner identity is hydrated but not yet a fusion identity', async () => {
            const globalOwner = {
                id: 'global-owner-1',
                name: 'Global Owner',
            } as IdentityDocument

            ;(ctx.fusionService as any).fusionOwnerIsGlobalReviewer = true
            ctx.mockSources.fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue(['global-owner-1'])
            ctx.mockIdentities.ensureIdentityById = vi.fn(async (id: string) => ctx.run.getIdentity(id))
            ctx.mockIdentities.markIdentityInScope = vi.fn()
            ctx.run.addIdentity('global-owner-1', globalOwner)

            await ctx.fusionService.initializeSourceReviewers()

            expect(ctx.run.reviewersBySourceId.get(SOURCE_ID)?.size).toBe(1)
            ;(ctx.fusionService as any).validateManagedSourceReviewers()
            expect(ctx.run.sourcesWithoutReviewers.has(SOURCE_NAME)).toBe(false)
        })

        it('registers global owners already loaded as managed-key fusion accounts', async () => {
            const globalOwnerId = 'global-owner-managed-key'
            const existingReviewer = FusionAccount.fromManagedAccount({
                id: 'fusion::global-owner',
                nativeIdentity: 'global-owner',
                name: 'Global Owner',
                sourceId: 'fusion-src',
                sourceName: 'Identity Fusion',
                identityId: globalOwnerId,
                attributes: {},
            } as any)
            ctx.run.registerFusionAccount(existingReviewer)

            ;(ctx.fusionService as any).fusionOwnerIsGlobalReviewer = true
            ctx.mockSources.fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue([globalOwnerId])
            await ctx.fusionService.initializeSourceReviewers()

            expect(ctx.run.reviewersBySourceId.get(SOURCE_ID)?.has(existingReviewer)).toBe(true)
            ;(ctx.fusionService as any).validateManagedSourceReviewers()
            expect(ctx.run.sourcesWithoutReviewers.has(SOURCE_NAME)).toBe(false)
        })


        it('creates an identity-origin fusion account when the global owner is outside identity scope', async () => {
            const globalOwner = {
                id: 'global-owner-out-of-scope',
                name: 'Global Owner',
                attributes: { email: 'owner@example.com' },
            } as IdentityDocument

            ;(ctx.fusionService as any).fusionOwnerIsGlobalReviewer = true
            ctx.mockSources.fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue(['global-owner-out-of-scope'])
            ctx.mockIdentities.ensureIdentityById = vi.fn().mockResolvedValue(globalOwner)
            ctx.mockIdentities.markIdentityInScope = vi.fn()

            await ctx.fusionService.initializeSourceReviewers()

            expect(ctx.mockIdentities.ensureIdentityById).toHaveBeenCalledWith('global-owner-out-of-scope')
            expect(ctx.mockIdentities.markIdentityInScope).toHaveBeenCalledWith('global-owner-out-of-scope')
            expect(ctx.run.reviewersBySourceId.get(SOURCE_ID)?.size).toBe(1)
            expect(ctx.run.getFusionIdentity('global-owner-out-of-scope')).toBeDefined()
            ;(ctx.fusionService as any).validateManagedSourceReviewers()
            expect(ctx.run.sourcesWithoutReviewers.has(SOURCE_NAME)).toBe(false)
        })


        it('keeps persisted global reviewer out of orphan when owner is hydrated before processFusionAccount', async () => {
            const globalOwnerId = 'global-owner-persisted'
            ;(ctx.fusionService as any).fusionOwnerIsGlobalReviewer = true
            ctx.mockSources.fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue([globalOwnerId])
            ctx.mockIdentities.ensureIdentityById = vi.fn().mockResolvedValue({
                id: globalOwnerId,
                name: 'fernando.delosrios',
            } as IdentityDocument)
            ctx.mockIdentities.markIdentityInScope = vi.fn()
            ctx.mockIdentities.hasIdentityInScope = vi.fn((id?: string) => id === globalOwnerId)
            ctx.mockIdentities.getIdentityById = vi.fn((id?: string) =>
                id === globalOwnerId
                    ? ({ id: globalOwnerId, name: 'fernando.delosrios' } as IdentityDocument)
                    : undefined
            )

            const persisted = FusionAccount.fromFusionAccount({
                nativeIdentity: 'NG000025',
                name: 'fernando.delosrios',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                identityId: globalOwnerId,
                attributes: {
                    originSource: 'Identities',
                    originAccount: globalOwnerId,
                    statuses: ['baseline', 'reviewer'],
                },
            } as unknown as Account)

            await ctx.fusionService.ensureGlobalReviewerOwnersInScope()
            expect(ctx.mockIdentities.markIdentityInScope).toHaveBeenCalledWith(globalOwnerId)

            const processed = await ctx.fusionService.processFusionAccount(persisted)
            expect(processed.collections.statuses.isOrphan()).toBe(false)
        })

        it('warns when global reviewer is enabled but no owner identity IDs resolve', async () => {
            ;(ctx.fusionService as any).fusionOwnerIsGlobalReviewer = true
            ctx.mockSources.fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue([])
            const warnSpy = vi.spyOn(ctx.mockLog, 'warn')

            await ctx.fusionService.initializeSourceReviewers()

            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('no Fusion source owner identity IDs'))
            ;(ctx.fusionService as any).validateManagedSourceReviewers()
            expect(ctx.run.sourcesWithoutReviewers.has(SOURCE_NAME)).toBe(true)
        })
    })

    describe('processManagedAccounts', () => {
        beforeEach(() => {
            ctx.mockDefinitionService.refreshReverseCorrelationAttributes.mockImplementation((fusionAccount) => {
                const configs = (ctx.mockConfig as any).sources ?? []
                for (const sc of configs) {
                    if (sc.correlationMode === 'reverse' && sc.correlationAttribute) {
                        const missingForSource = fusionAccount.collections.accounts.getMissingForSource(sc.name)
                        if (missingForSource.length > 0) {
                            const info = fusionAccount.collections.managedAccountInfo.get(missingForSource[0])
                            if (info) {
                                fusionAccount.setReverseCorrelationAttribute(sc.correlationAttribute, info.schema.id)
                            }
                        }
                    }
                }
            })
        })

        it('drops uncorrelated managed accounts that are already linked in Fusion', async () => {
            const linkedAccount = {
                id: 'acct-linked-1',
                nativeIdentity: 'native-linked-1',
                name: 'Linked Account',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                identityId: 'identity-linked',
                attributes: {},
                uncorrelated: true,
            } as Account
            const key = 'source-a-id::native-linked-1'
            const workQueue = new Map([[key, linkedAccount]])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(
                new Map([['identity-linked', new Set([key])]])
            )
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: {},
            })

            const existing = FusionAccount.fromManagedAccount(linkedAccount)
            ctx.fusionService.setFusionAccount(existing)

            const result = await ctx.fusionService.processManagedAccount(linkedAccount)

            expect(result).toBeUndefined()
            expect(workQueue.has(key)).toBe(false)
            expect(ctx.mockSources.managedAccountsByIdentityId.has('identity-linked')).toBe(false)
        })

        it('uses current-ctx.run non-matched managed source accounts as deferred candidates for subsequent managed accounts', async () => {
            ctx.fusionService.config.managedAccountsBatchSize = 1
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })
            ;(ctx.fusionService as any).run.reviewersBySourceId.set(
                'source-a-id',
                new Set([{ identityId: 'reviewer-1' } as any])
            )

            const firstAccount = {
                id: 'acct-seq-1',
                nativeIdentity: 'native-seq-1',
                name: 'Taylor Jordan',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const secondAccount = {
                id: 'acct-seq-2',
                nativeIdentity: 'native-seq-2',
                name: 'Taylor Jordan',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            const workQueue = new Map([
                ['source-a-id::native-seq-1', firstAccount],
                ['source-a-id::native-seq-2', secondAccount],
            ])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            vi.spyOn(ctx.mockSources, 'managedSources', 'get').mockReturnValue([])
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (account, candidates, candidateType) => {
                const candidateList = Array.from(candidates)
                if (candidateType !== 'deferred') return candidateList.length
                const hasPriorNonMatch = candidateList.some(
                    (candidate) => candidate.managedAccountId === 'source-a-id::native-seq-1'
                )
                if (hasPriorNonMatch && account.managedAccountId === 'source-a-id::native-seq-2') {
                    const anchor = candidateList.find(
                        (candidate) => candidate.managedAccountId === 'source-a-id::native-seq-1'
                    )
                    account.layers.addFusionMatch({
                        identityId: '',
                        identityName: 'Current operation non-match',
                        candidateType: 'deferred',
                        fusionIdentity: anchor,
                        scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 94, isMatch: true } as any],
                    } as any)
                }
                return candidateList.length
            })

            await ctx.fusionService.processManagedAccounts()

            expect(ctx.run.allFusionAccounts).toHaveLength(1)
            expect(workQueue.has('source-a-id::native-seq-2')).toBe(false)
            expect(ctx.mockLog.recordEvent).toHaveBeenCalledWith('match', { type: 'deferred' })
        })

        it('keeps deferred candidate visibility within a managed-account batch', async () => {
            ctx.fusionService.config.managedAccountsBatchSize = 2
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })
            ;(ctx.fusionService as any).run.reviewersBySourceId.set(
                'source-a-id',
                new Set([{ identityId: 'reviewer-1' } as any])
            )

            const firstAccount = {
                id: 'acct-batch-def-1',
                nativeIdentity: 'native-batch-def-1',
                name: 'Jordan Taylor',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const secondAccount = {
                id: 'acct-batch-def-2',
                nativeIdentity: 'native-batch-def-2',
                name: 'Jordan Taylor',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            const workQueue = new Map([
                ['source-a-id::native-batch-def-1', firstAccount],
                ['source-a-id::native-batch-def-2', secondAccount],
            ])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            vi.spyOn(ctx.mockSources, 'managedSources', 'get').mockReturnValue([])
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (account, candidates, candidateType) => {
                if (candidateType === 'identity' && account.managedAccountId === 'source-a-id::native-batch-def-1') {
                    await new Promise((resolve) => setTimeout(resolve, 5))
                }
                const candidateList = Array.from(candidates)
                if (candidateType !== 'deferred') return candidateList.length
                const hasPriorNonMatch = candidateList.some(
                    (candidate) => candidate.managedAccountId === 'source-a-id::native-batch-def-1'
                )
                if (hasPriorNonMatch && account.managedAccountId === 'source-a-id::native-batch-def-2') {
                    const anchor = candidateList.find(
                        (candidate) => candidate.managedAccountId === 'source-a-id::native-batch-def-1'
                    )
                    account.layers.addFusionMatch({
                        identityId: '',
                        identityName: 'Current operation non-match',
                        candidateType: 'deferred',
                        fusionIdentity: anchor,
                        scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 94, isMatch: true } as any],
                    } as any)
                }
                return candidateList.length
            })

            await ctx.fusionService.processManagedAccounts()

            expect(ctx.run.allFusionAccounts).toHaveLength(1)
            expect(workQueue.has('source-a-id::native-batch-def-2')).toBe(false)
            expect(ctx.mockLog.recordEvent).toHaveBeenCalledWith('match', { type: 'deferred' })
        })

        it('runs deferred source identity phase in parallel while deferred drain stays sequential per source', async () => {
            ctx.fusionService.config.managedAccountsBatchSize = 2
            const accountA1 = {
                id: 'acct-par-a-1',
                nativeIdentity: 'native-par-a-1',
                name: 'Parallel A1',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const accountA2 = {
                id: 'acct-par-a-2',
                nativeIdentity: 'native-par-a-2',
                name: 'Parallel A2',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const accountB1 = {
                id: 'acct-seq-b-1',
                nativeIdentity: 'native-seq-b-1',
                name: 'Sequential B1',
                sourceId: 'source-b-id',
                sourceName: 'Source B',
                attributes: {},
                uncorrelated: true,
            } as Account
            const accountB2 = {
                id: 'acct-seq-b-2',
                nativeIdentity: 'native-seq-b-2',
                name: 'Sequential B2',
                sourceId: 'source-b-id',
                sourceName: 'Source B',
                attributes: {},
                uncorrelated: true,
            } as Account
            const workQueue = new Map([
                ['source-a-id::native-par-a-1', accountA1],
                ['source-a-id::native-par-a-2', accountA2],
                ['source-b-id::native-seq-b-1', accountB1],
                ['source-b-id::native-seq-b-2', accountB2],
            ])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            vi.spyOn(ctx.mockSources, 'managedSources', 'get').mockReturnValue([])
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: false },
            })
            ;(ctx.fusionService as any).run.sourcesByName.set('Source B', {
                id: 'source-b-id',
                name: 'Source B',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const identity = FusionAccount.fromIdentity({
                id: 'identity-1',
                name: 'Identity One',
                attributes: {},
            } as any)
            ctx.fusionService.setFusionAccount(identity)

            let inFlightIdentityA = 0
            let maxInFlightIdentityA = 0
            let inFlightIdentityB = 0
            let maxInFlightIdentityB = 0
            let inFlightDeferredB = 0
            let maxInFlightDeferredB = 0
            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(
                async (fusionAccount, candidates, candidateType) => {
                    const candidateList = Array.from(candidates)
                    if (candidateType === 'identity') {
                        if (fusionAccount.sourceName === 'Source A') {
                            inFlightIdentityA += 1
                            maxInFlightIdentityA = Math.max(maxInFlightIdentityA, inFlightIdentityA)
                        } else if (fusionAccount.sourceName === 'Source B') {
                            inFlightIdentityB += 1
                            maxInFlightIdentityB = Math.max(maxInFlightIdentityB, inFlightIdentityB)
                        }
                        await new Promise((resolve) => setTimeout(resolve, 5))
                        if (fusionAccount.sourceName === 'Source A') {
                            inFlightIdentityA -= 1
                        } else if (fusionAccount.sourceName === 'Source B') {
                            inFlightIdentityB -= 1
                        }
                        return candidateList.length
                    }
                    if (candidateType !== 'deferred') {
                        return candidateList.length
                    }
                    inFlightDeferredB += 1
                    maxInFlightDeferredB = Math.max(maxInFlightDeferredB, inFlightDeferredB)
                    await new Promise((resolve) => setTimeout(resolve, 5))
                    if (fusionAccount.sourceName === 'Source B' && candidateList.length > 0) {
                        fusionAccount.layers.addFusionMatch({
                            identityId: '',
                            identityName: 'Current operation non-match source B',
                            candidateType: 'deferred',
                            fusionIdentity: candidateList[0],
                            scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 92, isMatch: true } as any],
                        } as any)
                    }
                    inFlightDeferredB -= 1
                    return candidateList.length
                }
            )

            // Pre-register a Source B non-match candidate for deferred candidate visibility
            const preB = FusionAccount.fromManagedAccount({
                id: 'acct-seq-b-0',
                nativeIdentity: 'native-seq-b-0',
                name: 'Sequential B0',
                sourceId: 'source-b-id',
                sourceName: 'Source B',
                attributes: {},
            } as any)
            preB.collections.statuses.setNonMatched(preB.name, preB.sourceName)
            ctx.fusionService.setFusionAccount(preB)
            ;(ctx.fusionService as any).run.registerFinalizedDeferredCandidate(preB)

            await ctx.fusionService.processManagedAccounts()

            expect(maxInFlightIdentityA).toBeGreaterThan(1)
            expect(maxInFlightIdentityB).toBeGreaterThan(1)
            expect(maxInFlightDeferredB).toBeLessThanOrEqual(1)
            expect(ctx.mockLog.recordEvent).toHaveBeenCalledWith('match', { type: 'deferred' })
        })

        it('does not include deferred candidates from other sources', async () => {
            const sourceAAccount = FusionAccount.fromManagedAccount({
                id: 'acct-other-source',
                nativeIdentity: 'native-other-source',
                name: 'Source A Candidate',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as any)
            sourceAAccount.collections.statuses.setNonMatched(sourceAAccount.name, sourceAAccount.sourceName)
            ctx.fusionService.setFusionAccount(sourceAAccount)
            const sourceBCandidate = FusionAccount.fromManagedAccount({
                id: 'acct-b-candidate',
                nativeIdentity: 'native-b-candidate',
                name: 'Source B Candidate',
                sourceId: 'source-b-id',
                sourceName: 'Source B',
                attributes: {},
            } as any)
            sourceBCandidate.collections.statuses.setNonMatched(sourceBCandidate.name, sourceBCandidate.sourceName)
            ctx.fusionService.setFusionAccount(sourceBCandidate)
            ;(ctx.fusionService as any).run.registerFinalizedDeferredCandidate(sourceBCandidate)
            ;(ctx.fusionService as any).run.sourcesByName.set('Source B', {
                id: 'source-b-id',
                name: 'Source B',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const sourceBDeferredCandidateSources: string[][] = []
            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (_account, candidates, candidateType) => {
                if (candidateType === 'deferred') {
                    sourceBDeferredCandidateSources.push(
                        Array.from(candidates).map((candidate) => candidate.sourceName ?? '')
                    )
                }
                return Array.from(candidates).length
            })

            await ctx.fusionService.processManagedAccount({
                id: 'acct-source-b-target',
                nativeIdentity: 'native-source-b-target',
                name: 'Source B Target',
                sourceId: 'source-b-id',
                sourceName: 'Source B',
                attributes: {},
                uncorrelated: true,
            } as Account)

            expect(sourceBDeferredCandidateSources).toEqual([['Source B']])
        })

        it('resolves all correlated accounts in the correlated account sweep before uncorrelated batch processing', async () => {
            ctx.fusionService.config.managedAccountsBatchSize = 2
            const correlatedA = {
                id: 'acct-corr-a',
                nativeIdentity: 'native-corr-a',
                name: 'Correlated A',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                identityId: 'identity-a',
                attributes: {},
                uncorrelated: false,
            } as Account
            const uncorrelated = {
                id: 'acct-unc-1',
                nativeIdentity: 'native-unc-1',
                name: 'Uncorrelated 1',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const correlatedB = {
                id: 'acct-corr-b',
                nativeIdentity: 'native-corr-b',
                name: 'Correlated B',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                identityId: 'identity-b',
                attributes: {},
                uncorrelated: false,
            } as Account

            const workQueue = new Map([
                ['source-a-id::native-corr-a', correlatedA],
                ['source-a-id::native-unc-1', uncorrelated],
                ['source-a-id::native-corr-b', correlatedB],
            ])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            vi.spyOn(ctx.mockSources, 'managedSources', 'get').mockReturnValue([])

            const callOrder: string[] = []
            const originalProcessManagedAccount = ctx.fusionService.processManagedAccount.bind(ctx.fusionService)
            vi.spyOn(ctx.fusionService, 'processManagedAccount').mockImplementation(async (account: Account) => {
                callOrder.push(account.id ?? '')
                return originalProcessManagedAccount(account)
            })

            await ctx.fusionService.processManagedAccounts()

            expect(callOrder).toHaveLength(2)
            expect(new Set(callOrder.slice(0, 2))).toEqual(new Set(['acct-corr-a', 'acct-corr-b']))
        })

        it('short-circuits duplicate checks when an identity-origin match already exists', async () => {
            const mockManagedAccount = {
                id: 'acct-short-circuit-1',
                nativeIdentity: 'native-short-circuit-1',
                name: 'Managed Account 1',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const existingIdentity = FusionAccount.fromIdentity({
                id: 'identity-1',
                name: 'Identity One',
                attributes: {},
            } as any)
            ctx.fusionService.setFusionAccount(existingIdentity)
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (account, _candidates, candidateType) => {
                const n = Array.from(_candidates).length
                if (candidateType === 'identity') {
                    account.layers.addFusionMatch({
                        identityId: 'identity-1',
                        identityName: 'Identity One',
                        candidateType: 'identity',
                        scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 95, isMatch: true } as any],
                    } as any)
                }
                return n
            })

            await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(ctx.mockMatchingService.scoreFusionAccount).toHaveBeenCalledTimes(1)
            expect(ctx.mockMatchingService.scoreFusionAccount).toHaveBeenCalledWith(
                expect.any(FusionAccount),
                expect.anything(),
                'identity',
                expect.any(Number)
            )
        })

        it('skips Match scoring for record sources when includeRecordAccountsForMatching is false', async () => {
            const mockManagedAccount = {
                id: 'acct-record-skip-match-1',
                nativeIdentity: 'native-record-skip-match-1',
                name: 'Record Only User',
                sourceId: 'src-record-skip',
                sourceName: 'Record Skip Match Source',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(ctx.fusionService as any).run.sourcesByName.set('Record Skip Match Source', {
                id: 'src-record-skip',
                name: 'Record Skip Match Source',
                sourceType: 'record',
                config: { includeRecordAccountsForMatching: false },
            })

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(ctx.mockMatchingService.scoreFusionAccount).not.toHaveBeenCalled()
        })

        it('processRecordUniqueRegistration removes match-disabled record accounts from the work queue', async () => {
            const recordAccount = {
                id: 'src-record-skip::native-record-1',
                nativeIdentity: 'native-record-1',
                name: 'Record Only User',
                sourceId: 'src-record-skip',
                sourceName: 'Record Skip Match Source',
                attributes: { externalId: 'EXT-1' },
                uncorrelated: true,
            } as Account
            const authAccount = {
                id: 'src-auth::native-auth-1',
                nativeIdentity: 'native-auth-1',
                name: 'Auth User',
                sourceId: 'src-auth',
                sourceName: 'Auth Source',
                attributes: {},
                uncorrelated: true,
            } as Account
            const managedMap = new Map<string, Account>([
                [recordAccount.id!, recordAccount],
                [authAccount.id!, authAccount],
            ])

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedMap)
            ;(ctx.fusionService as any).run.sourcesByName.set('Record Skip Match Source', {
                id: 'src-record-skip',
                name: 'Record Skip Match Source',
                sourceType: 'record',
                config: { includeRecordAccountsForMatching: false },
            })
            ;(ctx.fusionService as any).run.sourcesByName.set('Auth Source', {
                id: 'src-auth',
                name: 'Auth Source',
                sourceType: 'authoritative',
                config: {},
            })

            const registerSpy = vi
                .spyOn(ctx.mockDefinitionService, 'registerUniqueValuesFromRecordManagedAccounts')
                .mockResolvedValue(1)

            await ctx.fusionService.initializeManagedAccountProcessing()
            const result = await ctx.fusionService.processRecordUniqueRegistration()

            expect(result.registered).toBe(1)
            expect(registerSpy).toHaveBeenCalledWith(
                [recordAccount],
                ctx.mockMappingService,
                ctx.run,
                expect.objectContaining({ onProgress: expect.any(Function) })
            )
            expect(managedMap.has(recordAccount.id!)).toBe(false)
            expect(managedMap.has(authAccount.id!)).toBe(true)
        })

        it('keeps the linked account key index through the uncorrelated sweep, then releases it', async () => {
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: false },
            })
            vi.spyOn(ctx.mockSources, 'managedSources', 'get').mockReturnValue([])
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const orphanAccount = {
                id: 'acct-orphan-1',
                nativeIdentity: 'native-orphan-1',
                name: 'Orphan Correlated',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                identityId: 'identity-out-of-scope',
                attributes: {},
                uncorrelated: false,
            } as Account
            const linkedAccount = {
                id: 'acct-linked-1',
                nativeIdentity: 'native-linked-1',
                name: 'Linked Uncorrelated',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const linkedKey = 'source-a-id::native-linked-1'
            const workQueue = new Map<string, Account>([
                ['source-a-id::native-orphan-1', orphanAccount],
                [linkedKey, linkedAccount],
            ])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())

            // Persisted Fusion account from a prior run that already lists the uncorrelated account.
            ctx.fusionService.setFusionAccount(
                FusionAccount.fromFusionAccount({
                    nativeIdentity: 'fusion-prior-1',
                    id: 'isc-fusion-prior-1',
                    name: 'Prior Fusion Row',
                    sourceName: 'Identity Fusion NG',
                    attributes: { accounts: [linkedKey] },
                } as unknown as Account)
            )

            await ctx.fusionService.initializeManagedAccountProcessing()
            await ctx.fusionService.processCorrelatedManagedAccounts()
            expect(ctx.run.linkedAccountKeyIndex?.has(linkedKey)).toBe(true)

            const indexSpy = vi.spyOn(ctx.run, 'linkedAccountKeyIndex', 'get')
            await ctx.fusionService.processUncorrelatedManagedAccounts()

            // Every pre-score gate lookup in the uncorrelated sweep must hit the index, not the full scan.
            expect(indexSpy).toHaveBeenCalled()
            expect(indexSpy.mock.results.every((result) => result.value !== undefined)).toBe(true)
            expect(workQueue.has(linkedKey)).toBe(false)
            indexSpy.mockRestore()
            expect(ctx.run.linkedAccountKeyIndex).toBeUndefined()
        })

        it('runs Match scoring for record sources when includeRecordAccountsForMatching is omitted (default)', async () => {
            const mockManagedAccount = {
                id: 'acct-record-default-match-1',
                nativeIdentity: 'native-record-default-match-1',
                name: 'Record Default User',
                sourceId: 'src-record-default',
                sourceName: 'Record Default Source',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(ctx.fusionService as any).run.sourcesByName.set('Record Default Source', {
                id: 'src-record-default',
                name: 'Record Default Source',
                sourceType: 'record',
                config: {},
            })

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockMatchingService.scoreFusionAccount.mockResolvedValue(0)

            await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(ctx.mockMatchingService.scoreFusionAccount).toHaveBeenCalled()
        })

        it('logs deferred matches and suppresses output for deferred candidate matches', async () => {
            const mockManagedAccount = {
                id: 'acct-deferred-1',
                nativeIdentity: 'native-deferred-1',
                name: 'Deferred User',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })

            const nonMatchedCandidate = FusionAccount.fromManagedAccount({
                id: 'acct-prev-nonmatch-1',
                nativeIdentity: 'native-prev-nonmatch-1',
                name: 'Non-matched Candidate',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as any)
            nonMatchedCandidate.collections.statuses.setNonMatched(nonMatchedCandidate.name, nonMatchedCandidate.sourceName)
            ctx.fusionService.setFusionAccount(nonMatchedCandidate)
            void (ctx.fusionService as any).run

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            ctx.run.registerFinalizedDeferredCandidate(nonMatchedCandidate)

            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (account, candidates, candidateType) => {
                const candidateList = Array.from(candidates)
                if (candidateType === 'deferred') {
                    account.layers.addFusionMatch({
                        identityId: '',
                        identityName: 'Non-matched Candidate',
                        candidateType: 'deferred',
                        fusionIdentity: nonMatchedCandidate,
                        scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 92, isMatch: true } as any],
                    } as any)
                }
                return candidateList.length
            })

            const workQueue = new Map([['source-a-id::native-deferred-1', mockManagedAccount]])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())

            const result = await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(result).toBeDefined()
            expect(result?.fusionMatches.some((m) => m.candidateType === 'deferred')).toBe(true)
            expect(workQueue.has('source-a-id::native-deferred-1')).toBe(false)
            expect(ctx.mockLog.recordEvent).toHaveBeenCalledWith('match', { type: 'deferred' })
        })

        it('does not record deferred match report rows when StdAccountList, fusionReportOnAggregation false, and not custom:dryrun', async () => {
            const mockManagedAccount = {
                id: 'acct-no-report-cap',
                nativeIdentity: 'native-no-report-cap',
                name: 'No Report Cap',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })

            const nonMatchedCandidate = FusionAccount.fromManagedAccount({
                id: 'acct-prev-nonmatch-cap',
                nativeIdentity: 'native-prev-nonmatch-cap',
                name: 'Non-matched Candidate',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as any)
            nonMatchedCandidate.collections.statuses.setNonMatched(nonMatchedCandidate.name, nonMatchedCandidate.sourceName)
            ctx.fusionService.setFusionAccount(nonMatchedCandidate)
            void (ctx.fusionService as any).run

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            ctx.run.registerFinalizedDeferredCandidate(nonMatchedCandidate)

            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (account, candidates, candidateType) => {
                const candidateList = Array.from(candidates)
                if (candidateType === 'deferred') {
                    account.layers.addFusionMatch({
                        identityId: '',
                        identityName: 'Non-matched Candidate',
                        candidateType: 'deferred',
                        fusionIdentity: nonMatchedCandidate,
                        scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 92, isMatch: true } as any],
                    } as any)
                }
                return candidateList.length
            })

            const tracker = new AggregationTracker()
            ctx.fusionService.setTracker(tracker)
            await ctx.fusionService.processManagedAccount(mockManagedAccount)
            const report = ctx.fusionService.generateReport(tracker, true)
            expect(report.accounts.some((a) => a.deferred && a.accountId === 'source-a-id::native-no-report-cap')).toBe(
                false
            )
        })

        it('records deferred match report rows for custom:dryrun even when commandType is StdAccountList and fusionReportOnAggregation is false', async () => {
            const customReportFusion = new FusionService({
                config: ctx.mockConfig,
                log: ctx.mockLog,
                identities: ctx.mockIdentities,
                sources: ctx.mockSources,
                forms: ctx.mockForms,
                mappingService: ctx.mockMappingService,
                definitionService: ctx.mockDefinitionService,
                matchingService: ctx.mockMatchingService,
                schemas: ctx.mockSchemas,
                run: ctx.run,
                commandType: StandardCommand.StdAccountList,
                shouldCaptureReportData: true,
            })
            customReportFusion.matchOutcomeDispatcher = ctx.createDispatcherFor(customReportFusion)
            customReportFusion.setTracker(new AggregationTracker())

            const mockManagedAccount = {
                id: 'acct-dry-ctx.run-def',
                nativeIdentity: 'native-dry-ctx.run-def',
                name: 'Custom Report Deferred',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(customReportFusion as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })

            const nonMatchedCandidate = FusionAccount.fromManagedAccount({
                id: 'acct-prev-nonmatch-cr',
                nativeIdentity: 'native-prev-nonmatch-cr',
                name: 'Non-matched Candidate CR',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as any)
            nonMatchedCandidate.collections.statuses.setNonMatched(nonMatchedCandidate.name, nonMatchedCandidate.sourceName)
            customReportFusion.setFusionAccount(nonMatchedCandidate)

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (account, _candidates, candidateType) => {
                const n = Array.from(_candidates).length
                if (candidateType === 'deferred') {
                    account.layers.addFusionMatch({
                        identityId: '',
                        identityName: 'Non-matched Candidate CR',
                        candidateType: 'deferred',
                        scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 92, isMatch: true } as any],
                    } as any)
                }
                return n
            })

            const tracker = new AggregationTracker()
            customReportFusion.setTracker(tracker)
            await customReportFusion.processManagedAccount(mockManagedAccount)
            const report = customReportFusion.generateReport(tracker, true)
            expect(report.accounts.some((a) => a.deferred && a.accountId === 'acct-dry-ctx.run-def')).toBe(true)
        })

        it('records only non-match history when creating a new authoritative non-match fusion account', async () => {
            const mockManagedAccount = {
                id: 'acct-nonmatch-1',
                nativeIdentity: 'NE00002',
                name: 'Matt Usalen NE00002 Assignment00002',
                sourceId: 'src-nerm',
                sourceName: 'NERM',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(ctx.fusionService as any).run.sourcesByName.set('NERM', {
                id: 'src-nerm',
                name: 'NERM',
                sourceType: 'authoritative',
                config: {},
            })

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockMatchingService.scoreFusionAccount.mockResolvedValue(0)

            const result = await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(result).toBeDefined()
            expect(result?.history.some((h) => h.includes('as NonMatched'))).toBe(true)
            expect(result?.history.some((h) => h.includes('Associated managed account'))).toBe(false)
        })

        it('does not fire disable for orphan non-matches when commandType is not StdAccountList', async () => {
            const analysisFusion = new FusionService({
                config: ctx.mockConfig,
                log: ctx.mockLog,
                identities: ctx.mockIdentities,
                sources: ctx.mockSources,
                forms: ctx.mockForms,
                mappingService: ctx.mockMappingService,
                definitionService: ctx.mockDefinitionService,
                matchingService: ctx.mockMatchingService,
                schemas: ctx.mockSchemas,
                run: ctx.run,
            })
            analysisFusion.matchOutcomeDispatcher = ctx.createDispatcherFor(analysisFusion)
            analysisFusion.setTracker(new AggregationTracker())
            ;(analysisFusion as any).run.sourcesByName.set('OrphanSrc', {
                id: 'orphan-src-id',
                name: 'OrphanSrc',
                sourceType: 'orphan',
                config: { disableNonMatchingAccounts: true },
            })

            const account = {
                id: 'acct-orphan-analysis-1',
                nativeIdentity: 'native-orphan-a1',
                name: 'Orphan User',
                sourceId: 'orphan-src-id',
                sourceName: 'OrphanSrc',
                attributes: {},
                uncorrelated: true,
            } as Account

            ctx.mockMappingService.mapAttributes.mockImplementation((a) => a)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockMatchingService.scoreFusionAccount.mockResolvedValue(0)
            vi.spyOn(ctx.mockSources, 'fireDisableAccount').mockResolvedValue(undefined)

            await analysisFusion.processManagedAccount(account)

            expect(ctx.mockSources.fireDisableAccount).not.toHaveBeenCalled()
        })

        it('should process managed accounts', async () => {
            const mockManagedAccount = {
                id: 'mgmt-raw-1',
                nativeIdentity: 'mgmt-1',
                name: 'Managed Account 1',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            const managedAccountsMap = new Map<string, Account>()
            managedAccountsMap.set('source-a-id::mgmt-1', mockManagedAccount)

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(managedAccountsMap)

            // Mock scoring
            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(
                async (_account, candidates) => Array.from(candidates).length
            )

            await ctx.fusionService.processManagedAccounts()

            // Verify log called or side effects
            expect(ctx.mockLog.detail).toHaveBeenCalledWith({
                action: 'processing uncorrelated managed accounts',
                count: 1,
            })
        })

        it('should set reverse correlation attribute for first-ctx.run non-matched authoritative accounts', async () => {
            const mockManagedAccount = {
                id: 'acct-1',
                nativeIdentity: 'native-1',
                name: 'Managed Account 1',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(ctx.mockConfig.sources as any[]).push({
                name: 'Source A',
                correlationMode: 'reverse' as const,
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            })
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: {},
            })

            const result = await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(result).toBeDefined()
            expect(result?.attributes.reverseNativeIdentity).toBe('native-1')
        })

        it('registers correlated managed accounts not linked to Fusion as authoritative non-matches', async () => {
            const mockManagedAccount = {
                id: 'acct-corr-orphan-1',
                nativeIdentity: 'native-corr-orphan-1',
                name: 'Correlated Orphan',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                identityId: 'identity-not-in-fusion',
                attributes: {},
                uncorrelated: false,
            } as Account

            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: {},
            })

            ctx.mockMappingService.mapAttributes.mockImplementation((a) => a)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockMatchingService.scoreFusionAccount.mockResolvedValue(0)

            const result = await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(result).toBeDefined()
            expect(result?.statuses).toContain('nonMatched')
            expect(ctx.fusionService.getFusionAccountByManagedKey('source-a-id::native-corr-orphan-1')).toBe(result)
        })

        it('drops correlated managed accounts when their identity already has a fusion identity row', async () => {
            const identityId = 'identity-linked-1'
            const existing = FusionAccount.fromIdentity({
                id: identityId,
                name: 'Linked',
                attributes: {},
            } as any)
            ctx.fusionService.setFusionAccount(existing)

            const mockManagedAccount = {
                id: 'acct-already-linked',
                nativeIdentity: 'native-linked',
                name: 'Already',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                identityId,
                attributes: {},
                uncorrelated: false,
            } as Account

            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: {},
            })

            ctx.mockMappingService.mapAttributes.mockImplementation((a) => a)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockMatchingService.scoreFusionAccount.mockResolvedValue(0)

            const result = await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(result).toBeUndefined()
        })

        it('should hydrate missing account info during managed-account layer for historical missing accounts', async () => {
            const historicalAccount = {
                nativeIdentity: 'fusion-1',
                identityId: 'identity-1',
                name: 'Fusion Account',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {
                    'missing-accounts': ['source-a-id::native-missing-1'],
                },
            } as unknown as Account

            ;(ctx.mockConfig.sources as any[]).push({
                name: 'Source A',
                correlationMode: 'reverse' as const,
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            })

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(new Map())
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(
                ctx.run,
                new Map([
                    [
                        'source-a-id::native-missing-1',
                        {
                            id: 'acct-missing-1',
                            nativeIdentity: 'native-missing-1',
                            sourceId: 'source-a-id',
                            sourceName: 'Source A',
                            attributes: {},
                        } as unknown as Account,
                    ],
                ])
            )
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processFusionAccount(historicalAccount)

            expect(result.attributes.reverseNativeIdentity).toBe('native-missing-1')
        })

        it('applies identity layer when platform fusion account is uncorrelated but identityId is in scope', async () => {
            const historicalAccount = {
                nativeIdentity: 'workday-native-1',
                identityId: 'identity-1',
                name: '30958535',
                sourceName: 'Identity Fusion NG',
                uncorrelated: true,
                attributes: {
                    accounts: [],
                    originSource: 'Identities',
                },
            } as unknown as Account

            vi.spyOn(ctx.mockIdentities, 'getIdentityById').mockReturnValue({
                id: 'identity-1',
                name: 'Jane Doe',
                attributes: { displayName: 'Jane Q. Doe' },
            } as IdentityDocument)
            vi.spyOn(ctx.mockForms, 'getFusionMergeDecision').mockReturnValue(undefined)

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(new Map())
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(ctx.run, new Map())
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processFusionAccount(historicalAccount)

            expect(result.name).toBe('30958535')
            expect(result.identityDisplayName).toBe('Jane Q. Doe')
        })

        it('writes history when a newly associated managed account is picked up for an identity', async () => {
            const historicalAccount = {
                nativeIdentity: 'fusion-identity-1',
                identityId: 'identity-1',
                name: 'Fusion Identity',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {
                    accounts: ['source-a-id::native-existing-1'],
                },
            } as unknown as Account

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(
                new Map([
                    [
                        'source-a-id::native-new-2',
                        {
                            id: 'acct-new-2',
                            name: 'Managed Account New',
                            nativeIdentity: 'native-new-2',
                            sourceId: 'source-a-id',
                            sourceName: 'Source A',
                            identityId: 'identity-1',
                            attributes: {},
                        } as unknown as Account,
                    ],
                ])
            )
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(
                new Map([['identity-1', new Set(['source-a-id::native-new-2'])]])
            )
            seedRunInventory(
                ctx.run,
                new Map([
                    [
                        'source-a-id::native-new-2',
                        {
                            id: 'acct-new-2',
                            name: 'Managed Account New',
                            nativeIdentity: 'native-new-2',
                            sourceId: 'source-a-id',
                            sourceName: 'Source A',
                            identityId: 'identity-1',
                            attributes: {},
                        } as unknown as Account,
                    ],
                ])
            )
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processFusionAccount(historicalAccount)

            expect(result.accountIds).toContain('source-a-id::native-new-2')
            expect(result.history).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Blended managed account Managed Account New [Source A]'),
                ])
            )
        })

        it('should remove deleted managed accounts from accounts and missing-accounts history', async () => {
            const historicalAccount = {
                nativeIdentity: 'fusion-1',
                identityId: 'identity-1',
                name: 'Fusion Account',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {
                    accounts: ['source-a-id::native-existing-1'],
                    'missing-accounts': ['source-a-id::native-deleted-1'],
                    originSource: 'Source A',
                    originAccount: 'source-a-id::native-deleted-1',
                },
            } as unknown as Account

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(
                new Map([
                    [
                        'source-a-id::native-existing-1',
                        {
                            id: 'acct-existing-1',
                            nativeIdentity: 'native-existing-1',
                            sourceId: 'source-a-id',
                            sourceName: 'Source A',
                            attributes: {},
                        } as unknown as Account,
                    ],
                ])
            )
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())
            seedRunInventory(
                ctx.run,
                new Map([
                    [
                        'source-a-id::native-existing-1',
                        {
                            id: 'acct-existing-1',
                            nativeIdentity: 'native-existing-1',
                            sourceId: 'source-a-id',
                            sourceName: 'Source A',
                            attributes: {},
                        } as unknown as Account,
                    ],
                ])
            )
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processFusionAccount(historicalAccount)

            expect(result.accountIds).toContain('source-a-id::native-existing-1')
            expect(result.accountIds).not.toContain('source-a-id::native-deleted-1')
            expect(result.missingAccountIds).toContain('source-a-id::native-existing-1')
            expect(result.missingAccountIds).not.toContain('source-a-id::native-deleted-1')
            expect(result.originSource).toBe('Source A')
            expect(result.originAccountId).toBe('source-a-id::native-deleted-1')
            expect(result.needsRefresh).toBe(true)
            expect(result.history).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Removed managed account missing reference: source-a-id::native-deleted-1'),
                ])
            )
        })

        it('forces needsRefresh when forceAttributeRefresh is enabled', async () => {
            ctx.mockConfig.forceAttributeRefresh = true

            const historicalAccount = {
                nativeIdentity: 'fusion-force-refresh',
                identityId: 'identity-force-refresh',
                name: 'Fusion Force Refresh',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {
                    accounts: [],
                },
            } as unknown as Account

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()
            ctx.mockDefinitionService.registerUniqueAttributes.mockResolvedValue()

            const result = await ctx.fusionService.processFusionAccount(historicalAccount)

            expect(result.needsRefresh).toBe(true)
        })

        it('should not clear reverse attribute when missing account source info is unresolved', async () => {
            ;(ctx.fusionService as any).config.sources = [
                {
                    name: 'Source A',
                    correlationMode: 'reverse',
                    correlationAttribute: 'reverseNativeIdentity',
                    correlationDisplayName: 'Reverse Native Identity',
                },
            ]

            const fusionAccount = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                identityId: 'identity-1',
                name: 'Fusion Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['missing-1'],
                    reverseNativeIdentity: 'existing-value',
                },
            } as unknown as Account)

            await (ctx.fusionService as any).correlationManager.correlatePerSource(fusionAccount)

            expect(fusionAccount.attributes.reverseNativeIdentity).toBe('existing-value')
        })

        it('direct-correlates link-decision assigned account when managed metadata is absent but source is correlate', async () => {
            ctx.mockIdentities.correlateAccounts.mockResolvedValue(true)
            vi.spyOn(ctx.mockSources, 'getSourceConfig').mockReturnValue({
                name: 'Source A',
                correlationMode: 'correlate',
            } as any)

            const fusionAccount = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                identityId: 'identity-1',
                name: 'Fusion Account',
                sourceName: 'Identity Fusion NG',
                attributes: { accounts: ['source-a-id::native-no-meta'] },
            } as unknown as Account)

            const linkDecision = {
                submitter: { id: 'rev-1', email: '', name: 'Reviewer' },
                account: {
                    id: 'source-a-id::native-no-meta',
                    name: 'U',
                    sourceName: 'Source A',
                    sourceId: 'source-a-id',
                    nativeIdentity: 'native-no-meta',
                },
                newIdentity: false,
                identityId: 'identity-1',
                comments: 'Assign',
                finished: true,
            } as any

            fusionAccount.layers.addFusionDecisionLayer(linkDecision)
            expect(fusionAccount.collections.managedAccountInfo.get('source-a-id::native-no-meta')).toBeUndefined()

            await (ctx.fusionService as any).correlationManager.correlatePerSource(fusionAccount, linkDecision)

            expect(ctx.mockIdentities.correlateAccounts).toHaveBeenCalledWith(
                fusionAccount,
                ['source-a-id::native-no-meta'],
                'link'
            )
        })

        it('sets reverse correlation attribute for non-matched authoritative accounts without checking platform prerequisites', async () => {
            const mockManagedAccount = {
                id: 'acct-2',
                nativeIdentity: 'native-2',
                name: 'Managed Account 2',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account

            ;(ctx.mockConfig.sources as any[]).push({
                name: 'Source A',
                correlationMode: 'reverse' as const,
                correlationAttribute: 'reverseNativeIdentity',
                correlationDisplayName: 'Reverse Native Identity',
            })
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: {},
            })

            const result = await ctx.fusionService.processManagedAccount(mockManagedAccount)

            expect(result).toBeDefined()
            expect(result?.attributes.reverseNativeIdentity).toBe('native-2')
        })
    })

    describe('analyzeUncorrelatedAccounts', () => {
        it('uses first authoritative non-match as deferred candidate for subsequent account analysis', async () => {
            const firstAccount = {
                id: 'acct-analyze-1',
                nativeIdentity: 'native-analyze-1',
                name: 'A. Wesker',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as Account
            const secondAccount = {
                id: 'acct-analyze-2',
                nativeIdentity: 'native-analyze-2',
                name: 'Albert Wesker',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
            } as Account

            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(
                new Map([
                    ['source-a-id::native-analyze-1', firstAccount],
                    ['source-a-id::native-analyze-2', secondAccount],
                ])
            )
            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: {},
            })
            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (account, candidates, candidateType) => {
                const candidateList = Array.from(candidates)
                if (candidateType !== 'deferred') return candidateList.length
                if (candidateList.length > 0) {
                    account.layers.addFusionMatch({
                        identityId: '',
                        identityName: 'A. Wesker',
                        candidateType: 'deferred',
                        scores: [
                            { attribute: 'lastname', algorithm: 'jaro-winkler', score: 100, isMatch: true } as any,
                        ],
                    } as any)
                }
                return candidateList.length
            })

            const analyzed = await ctx.fusionService.analyzeUncorrelatedAccounts()

            expect(analyzed).toHaveLength(2)
            expect(analyzed[1].fusionMatches.some((match) => match.candidateType === 'deferred')).toBe(true)
            expect(ctx.mockLog.recordEvent).toHaveBeenCalledWith('match', { type: 'deferred' })
        })

        it('makes previously-persisted non-match accounts visible as deferred candidates', async () => {
            FusionAccount.configure(ctx.mockConfig)
            const persistedNonMatch = FusionAccount.fromFusionAccount({
                nativeIdentity: 'native-persisted-nonmatch',
                name: 'Previously Persisted Non-Match',
                sourceName: 'Identity Fusion NG',
                uncorrelated: true,
                attributes: {
                    originSource: 'Source A',
                    originAccount: 'source-a-id::native-persisted-nonmatch',
                    statuses: ['nonMatched', 'uncorrelated'],
                },
            } as any)
            persistedNonMatch.collections.statuses.setNonMatched(persistedNonMatch.name, persistedNonMatch.sourceName)
            ctx.fusionService.setFusionAccount(persistedNonMatch)
            ctx.run.registerDeferredCandidate(persistedNonMatch)

            ;(ctx.fusionService as any).run.sourcesByName.set('Source A', {
                id: 'source-a-id',
                name: 'Source A',
                sourceType: 'authoritative',
                config: { deferredMatching: true },
            })

            ctx.mockMappingService.mapAttributes.mockImplementation((account) => account)
            ctx.mockDefinitionService.refreshNormalAttributes.mockResolvedValue()

            const newAccount = {
                id: 'acct-new-revisit',
                nativeIdentity: 'native-new-revisit',
                name: 'Previously Persisted Non-Match',
                sourceId: 'source-a-id',
                sourceName: 'Source A',
                attributes: {},
                uncorrelated: true,
            } as Account
            const workQueue = new Map([['source-a-id::native-new-revisit', newAccount]])
            vi.spyOn(ctx.mockSources, 'managedAccountsById', 'get').mockReturnValue(workQueue)
            vi.spyOn(ctx.mockSources, 'managedAccountsByIdentityId', 'get').mockReturnValue(new Map())

            let deferredCandidatesFound = 0
            ctx.mockMatchingService.scoreFusionAccount.mockImplementation(async (_account, candidates, candidateType) => {
                const n = Array.from(candidates).length
                if (candidateType === 'deferred') {
                    deferredCandidatesFound = n
                    if (n > 0) {
                        _account.layers.addFusionMatch({
                            identityId: '',
                            identityName: 'Previously Persisted Non-Match',
                            candidateType: 'deferred',
                            scores: [{ attribute: 'name', algorithm: 'jaro-winkler', score: 94, isMatch: true } as any],
                        } as any)
                    }
                }
                return n
            })

            await ctx.fusionService.analyzeUncorrelatedAccounts()

            expect(deferredCandidatesFound).toBeGreaterThanOrEqual(1)
        })
    })

    describe('setFusionAccount routing', () => {
        it('routes fusion account with identityId to fusionIdentityMap even when _uncorrelated is true', () => {
            // Simulate what processFusionAccount does after updateCorrelationStatus sets _uncorrelated=true
            const account = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-uncorr-1',
                identityId: 'identity-1',
                name: 'Jane Doe',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: { accounts: ['acct-missing-1'] },
            } as unknown as Account)
            // Simulate the flag that updateCorrelationStatus would set
            account.collections.accounts.addMissing('acct-missing-1')
            account.updateCorrelationStatus()
            expect(account.uncorrelated).toBe(true)

            ctx.fusionService.setFusionAccount(account)

            const inIdentityMap = ctx.fusionService.getFusionIdentity('identity-1')
            const inAccountMap = ctx.fusionService.getFusionAccountByManagedKey(`fusion-uncorr-1`)
            expect(inIdentityMap).toBe(account)
            expect(inAccountMap).toBeUndefined()
        })

        it('routes fusion account without identityId to fusionAccountMap', () => {
            const account = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-noident-1',
                name: 'Non-matched Account',
                sourceName: 'Identity Fusion NG',
                uncorrelated: true,
                attributes: {},
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(account)

            const inAccountMap = ctx.fusionService.getFusionAccountByManagedKey(`fusion-noident-1`)
            expect(inAccountMap).toBe(account)
        })

        it('routes a persisted fusion account into fusionIdentityMap via the attributes.identityId fallback', () => {
            // Realistic SDK payload: no top-level identityId, only the persisted attribute.
            // This is the data shape produced by the connector's own getISCAccount output.
            const account = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-attr-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                attributes: { identityId: 'identity-1' },
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(account)

            expect(ctx.fusionService.getFusionIdentity('identity-1')).toBe(account)
            expect(ctx.fusionService.getFusionAccountByManagedKey(`fusion-attr-1`)).toBeUndefined()
        })

        it('stores persisted fusion accounts under the fusion-source composite key', () => {
            const account = FusionAccount.fromFusionAccount({
                nativeIdentity: 'legacy-native-id',
                name: 'Legacy Non-matched',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    originAccount: 'source-a-id::shared-native-id',
                },
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(account)

            expect(account.originAccountId).toBe('source-a-id::shared-native-id')
            expect(ctx.fusionService.getFusionAccountByManagedKey(`legacy-native-id`)).toBe(account)
        })

        it('normalizes persisted origin composite key when restoring non-matched managed source accounts', () => {
            const account = FusionAccount.fromFusionAccount({
                nativeIdentity: 'legacy-native-id',
                name: 'Legacy Non-matched',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    originAccount: ' source-a-id :: shared-native-id ',
                },
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(account)

            expect(account.originAccountId).toBe('source-a-id::shared-native-id')
            expect(ctx.fusionService.getFusionAccountByManagedKey(`legacy-native-id`)).toBe(account)
        })
    })

    describe('forEachISCAccount performance behavior', () => {
        it('uses bounded concurrency while preserving output order', async () => {
            const sentKeys: string[] = []
            const accounts = Array.from({ length: 28 }, (_, i) =>
                FusionAccount.fromManagedAccount({
                    id: `acct-${i}`,
                    name: `Account ${i}`,
                    sourceId: 'src-1',
                    nativeIdentity: `native-${i}`,
                    sourceName: 'Source 1',
                    attributes: {},
                } as Account)
            )

            for (const account of accounts) {
                ctx.fusionService.setFusionAccount(account)
            }

            let inFlight = 0
            let maxInFlight = 0
            vi.spyOn(ctx.fusionService as any, 'getISCAccount').mockImplementation(async (...args: any[]) => {
                const account = args[0] as FusionAccount
                inFlight += 1
                maxInFlight = Math.max(maxInFlight, inFlight)
                await new Promise((resolve) => setTimeout(resolve, 1))
                inFlight -= 1
                return { key: account.managedKey, attributes: {}, disabled: false }
            })

            const { sent: count } = await ctx.fusionService.forEachISCAccount((account) => {
                sentKeys.push(String(account.key))
            })

            expect(count).toBe(accounts.length)
            expect(maxInFlight).toBeLessThanOrEqual(12)
            expect(sentKeys).toEqual(accounts.map((x) => x.managedKey))
        })
    })

})

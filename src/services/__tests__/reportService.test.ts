import { SourceType } from '../../model/config'
import { ReportService } from '../reportService'

describe('ReportService', () => {
    const createService = (overrides: Partial<any> = {}) => {
        const log = {
            getAggregationIssueSummary: vi.fn(() => ({
                warningCount: 1,
                errorCount: 2,
                warningSamples: ['w1'],
                errorSamples: ['e1'],
            })),
            timer: vi.fn(() => ({
                recordElapsed: vi.fn(),
                getPhaseBreakdown: vi.fn(() => []),
            })),
        }
        const sources = {
            fusionAccountCount: 7,
            getSourceByNameSafe: vi.fn((name?: string) =>
                name ? { sourceType: SourceType.Authoritative } : undefined
            ),
            resolveIscAccountIdForManagedKey: vi.fn((managedKey?: string) => {
                const inventory =
                    (overrides.run as any)?.managedAccountInventory ??
                    (overrides.sources as any)?.managedAccountInventory ??
                    new Map<string, any>()
                const info = managedKey ? inventory.get(managedKey) : undefined
                const iscId = info?.id
                if (iscId && iscId !== managedKey) return iscId
                if (managedKey && !managedKey.includes('::')) return managedKey
                return undefined
            }),
        }
        const identities = {
            getIdentityById: vi.fn((id?: string) => (id ? { id, displayName: `Name ${id}` } : undefined)),
            hydrateMissingIdentitiesById: vi.fn(async () => undefined),
            ensureIdentityById: vi.fn(async (id?: string) => (id ? { id, displayName: `Name ${id}` } : undefined)),
        }
        const forms = {
            finishedFusionDecisions: [],
            formsCreated: 1,
            formInstancesCreated: 2,
            formsFound: 3,
            formInstancesFound: 4,
            answeredFormInstancesProcessed: 5,
        }
        const fusion = {
            generateReport: vi.fn(() => ({ accounts: [], matches: 0 })),
            getFusionIdentity: vi.fn(() => undefined),
            getFusionAccountByManagedKey: vi.fn(() => undefined),
        }
        const email = {
            sendEmail: vi.fn(async () => undefined),
            getRecipientEmails: vi.fn(async () => ['owner@example.com']),
            buildEmailHeaderSubtitle: vi.fn(() => 'example.identitynow.com - Fusion-NG'),
        }
        const run = {
            getTracker: vi.fn(() => ({})),
            allFusionIdentities: [],
            ...{
                managedAccountInventory:
                    (overrides.run as any)?.managedAccountInventory ??
                    (overrides.sources as any)?.managedAccountInventory ??
                    new Map<string, any>(),
                hasManagedAccount: (key: string) =>
                    (
                        (overrides.run as any)?.managedAccountInventory ??
                        (overrides.sources as any)?.managedAccountInventory ??
                        new Map<string, any>()
                    ).has(key),
                getManagedAccountInfo: (key: string) =>
                    (
                        (overrides.run as any)?.managedAccountInventory ??
                        (overrides.sources as any)?.managedAccountInventory ??
                        new Map<string, any>()
                    ).get(key),
            },
            ...(overrides.run ?? {}),
        }
        return {
            service: new ReportService(
                'https://example.api.identitynow.com',
                log as any,
                { ...sources, ...(overrides.sources ?? {}) } as any,
                { ...identities, ...(overrides.identities ?? {}) } as any,
                { ...forms, ...(overrides.forms ?? {}) } as any,
                { ...fusion, ...(overrides.fusion ?? {}) } as any,
                { ...email, ...(overrides.email ?? {}) } as any,
                run as any
            ),
            deps: { log, sources, identities, forms, fusion, email },
        }
    }

    it('builds fusion review decision DTOs with reviewer metadata and account resolution', () => {
        const { service } = createService({
            forms: {
                finishedFusionDecisions: [
                    {
                        id: 'd1',
                        identityId: 'id-100',
                        identityName: 'Target Identity',
                        newIdentity: false,
                        submitter: { id: 'rev-1', name: 'Reviewer Name' },
                        account: {
                            id: 'src-a::native-1',
                            iscAccountId: 'acc-1',
                            name: 'Target Account',
                            sourceName: 'Source Alpha',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions).toHaveLength(1)
        expect(decisions[0]).toEqual({
            reviewerId: 'rev-1',
            reviewerName: 'Reviewer Name',
            reviewerUrl: 'https://example.identitynow.com/ui/a/admin/identities/rev-1/details/attributes',
            reviewerEmail: undefined,
            managedAccountKey: 'src-a::native-1',
            accountName: 'Target Account',
            accountUrl: 'https://example.identitynow.com/ui/a/admin/accounts-management/human-accounts/acc-1',
            accountSource: 'Source Alpha',
            sourceType: SourceType.Authoritative,
            decision: 'merge-existing-identity',
            decisionLabel: 'Merged into existing identity',
            selectedIdentityId: 'id-100',
            selectedIdentityName: 'Target Identity',
            selectedIdentityUrl: 'https://example.identitynow.com/ui/a/admin/identities/id-100/details/attributes',
            comments: undefined,
            formUrl: undefined,
            automaticMerge: undefined,
        })
    })

    it('resolves reviewer display name from identity.name when displayName is absent', () => {
        const reviewerId = '9d86f225e3a24b1a9e3d10d92ec12005'
        const { service } = createService({
            identities: {
                getIdentityById: vi.fn((id?: string) =>
                    id === reviewerId ? { id, name: 'fernando.delosrios' } : undefined
                ),
            },
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-100',
                        newIdentity: false,
                        submitter: { id: reviewerId, name: '' },
                        account: {
                            id: 'src-a::native-1',
                            iscAccountId: 'isc-1',
                            name: 'Target Account',
                            sourceName: 'Source Alpha',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions[0].reviewerName).toBe('fernando.delosrios')
        expect(decisions[0].reviewerName).not.toBe(reviewerId)
    })

    it('resolves reviewer display name from identity cache when submitter name equals reviewer id', () => {
        const reviewerId = '9d86f225e3a24b1a9e3d10d92ec12005'
        const { service } = createService({
            identities: {
                getIdentityById: vi.fn((id?: string) =>
                    id === reviewerId ? { id, displayName: 'Ada Wong' } : undefined
                ),
            },
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-100',
                        newIdentity: false,
                        submitter: { id: reviewerId, name: reviewerId },
                        account: {
                            id: 'acc-1',
                            name: 'Ada Wong',
                            sourceName: 'Umbrella Corporation',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions).toHaveLength(1)
        expect(decisions[0].reviewerName).toBe('Ada Wong')
    })

    it('resolves review decision account URL from managed account inventory when caches are cleared', () => {
        const managedAccountKey = 'src-a::native-1'
        const managedAccountInventory = new Map<string, any>([
            [managedAccountKey, { id: 'isc-account-1', name: 'Target Account' }],
        ])

        const { service } = createService({
            sources: { managedAccountInventory },
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-100',
                        newIdentity: false,
                        submitter: { id: 'rev-1', name: 'Reviewer Name' },
                        account: {
                            id: managedAccountKey,
                            name: 'Target Account',
                            sourceName: 'Source Alpha',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions[0].accountUrl).toBe(
            'https://example.identitynow.com/ui/a/admin/accounts-management/human-accounts/isc-account-1'
        )
        expect(decisions[0].accountUrl).not.toContain('::')
    })

    it('uses stored iscAccountId for automatic merge review decisions after managed account caches clear', () => {
        const { service } = createService({
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-auto',
                        newIdentity: false,
                        automaticMerge: true,
                        submitter: { id: 'system', name: 'System (automatic merge)' },
                        account: {
                            id: 'src-a::native-auto',
                            iscAccountId: 'isc-auto-1',
                            name: 'Auto User',
                            sourceName: 'Source Auto',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions[0].accountUrl).toBe(
            'https://example.identitynow.com/ui/a/admin/accounts-management/human-accounts/isc-auto-1'
        )
    })

    it('links a machine account to machine-accounts after managed account caches clear', () => {
        const { service } = createService({
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-machine',
                        newIdentity: false,
                        submitter: { id: 'rev-m', name: 'Reviewer Machine' },
                        account: {
                            id: 'src-a::machine-1',
                            iscAccountId: 'isc-machine-1',
                            isMachine: true,
                            name: 'Batch Bot',
                            sourceName: 'Orphan Source',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions[0].accountUrl).toBe(
            'https://example.identitynow.com/ui/a/admin/accounts-management/machine-accounts/isc-machine-1'
        )
    })

    it('links a machine account from managed account inventory when the decision does not store isMachine', () => {
        const managedAccountKey = 'src-a::machine-2'
        const managedAccountInventory = new Map<string, any>([
            [managedAccountKey, { id: 'isc-machine-2', name: 'Nightly Job', isMachine: true }],
        ])

        const { service } = createService({
            sources: { managedAccountInventory },
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-machine-2',
                        newIdentity: false,
                        submitter: { id: 'rev-m2', name: 'Reviewer Two' },
                        account: {
                            id: managedAccountKey,
                            name: 'Nightly Job',
                            sourceName: 'Orphan Source',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions[0].accountUrl).toBe(
            'https://example.identitynow.com/ui/a/admin/accounts-management/machine-accounts/isc-machine-2'
        )
    })

    it('does not emit account URL when only a composite managed account key is available', () => {
        const { service } = createService({
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-500',
                        newIdentity: false,
                        submitter: { id: 'rev-5', name: 'Reviewer Five' },
                        account: {
                            id: 'src-a::native-orphan',
                            name: 'Orphan Account',
                            sourceName: 'Source Epsilon',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions[0].accountUrl).toBeUndefined()
    })

    it('prefers managed account display name over raw managed account key when building review decisions', () => {
        const managedAccountInventory = new Map<string, any>([
            ['key-1', { id: 'key-1', name: 'Human Account Display Name' }],
        ])

        const { service } = createService({
            sources: {
                managedAccountInventory,
            },
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-200',
                        identityName: 'Correlated Identity',
                        newIdentity: false,
                        submitter: { id: 'rev-2', name: 'Reviewer Two' },
                        account: {
                            id: 'key-1',
                            name: 'key-1',
                            sourceName: 'Source Beta',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions).toHaveLength(1)
        expect(decisions[0].accountName).toBe('Human Account Display Name')
    })

    it('prefers correlated identity display name over managed account name fallback for merge-existing decisions', () => {
        const managedAccountInventory = new Map<string, any>([['key-1', { id: 'key-1', name: 'Raw Managed Name' }]])

        const { service } = createService({
            sources: {
                managedAccountInventory,
            },
            identities: {
                getIdentityById: vi.fn((id?: string) =>
                    id ? { id, displayName: 'Correlated Identity Name' } : undefined
                ),
            },
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-300',
                        correlatedIdentityId: 'id-300',
                        identityName: 'Correlated Identity Name',
                        newIdentity: false,
                        submitter: { id: 'rev-3', name: 'Reviewer Three' },
                        account: {
                            id: 'key-1',
                            name: 'Raw Managed Name',
                            sourceName: 'Source Gamma',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions).toHaveLength(1)
        expect(decisions[0].accountName).toBe('Correlated Identity Name')
    })

    it('uses fallback managed account key when account name matches managed account key exactly', () => {
        const { service } = createService({
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-400',
                        newIdentity: true,
                        submitter: { id: 'rev-4', name: 'Reviewer Four' },
                        account: {
                            id: 'key-only',
                            name: 'key-only',
                            sourceName: 'Source Delta',
                        },
                    },
                ],
            },
        })

        const decisions = service.buildFusionReviewDecisions()

        expect(decisions).toHaveLength(1)
        expect(decisions[0].accountName).toBe('key-only')
    })

    it('builds dry-run initialize stats from fetch-phase counters', () => {
        const { service } = createService()

        const { stats } = service.initializeDryRunReport({
            fetchResult: {
                identitiesFound: 42,
                managedAccountsFound: 100,
                managedAccountsFoundAuthoritative: 80,
                managedAccountsFoundRecord: 15,
                managedAccountsFoundOrphan: 5,
            },
            totalProcessingTime: '2m 10s',
            phaseTiming: [{ phase: 'Fetch', elapsed: '30s' }],
        })

        expect(stats.identitiesFound).toBe(42)
        expect(stats.managedAccountsFound).toBe(100)
        expect(stats.managedAccountsFoundAuthoritative).toBe(80)
        expect(stats.managedAccountsFoundRecord).toBe(15)
        expect(stats.managedAccountsFoundOrphan).toBe(5)
        expect(stats.totalProcessingTime).toBe('2m 10s')
        expect(stats.fusionAccountsFound).toBe(7)
        expect(stats.usedMemory).toMatch(/^\d+ MB$/)
    })

    it('builds dry-run report stats correctly mapping authoritative, record, and orphan decisions', () => {
        const { service } = createService({
            forms: {
                finishedFusionDecisions: [
                    { newIdentity: false, sourceType: SourceType.Authoritative },
                    { newIdentity: true, sourceType: SourceType.Authoritative },
                    { newIdentity: true, sourceType: SourceType.Record },
                    { newIdentity: true, sourceType: SourceType.Orphan },
                ],
                formsCreated: 4,
                formInstancesCreated: 8,
                formsFound: 4,
                formInstancesFound: 8,
                answeredFormInstancesProcessed: 4,
            },
        })

        const aggregationStats: any = {
            managedAccountsFound: 10,
            totalProcessingTime: '5s',
            managedAccountsFoundAuthoritative: 5,
            managedAccountsFoundRecord: 3,
            managedAccountsFoundOrphan: 2,
            warningSamples: [],
            errorSamples: [],
        }

        const stats = service.buildDryRunStats(aggregationStats)

        expect(stats.fusionReviewNewIdentitiesAuthoritative).toBe(1)
        expect(stats.fusionReviewNoMatchesRecord).toBe(1)
        expect(stats.fusionReviewNoMatchesOrphan).toBe(1)
        expect(stats.fusionReviewDecisionsAuthoritative).toBe(2)
        expect(stats.fusionReviewDecisionsRecord).toBe(1)
        expect(stats.fusionReviewDecisionsOrphan).toBe(1)
        expect(stats.managedAccountsFound).toBe(10)
        expect(stats.managedAccountsFoundAuthoritative).toBe(5)
        expect(stats.managedAccountsFoundRecord).toBe(3)
        expect(stats.managedAccountsFoundOrphan).toBe(2)
    })

    it('prefers fusionAccountsReturned over cleared run registry for totalFusionAccounts', () => {
        const { service } = createService({
            run: { totalFusionAccountCount: 0 },
        })

        const stats = service.buildDryRunStats({
            identitiesFound: 0,
            managedAccountsFound: 0,
            totalProcessingTime: '1s',
            fusionAccountsReturned: 18875,
        })

        expect(stats.totalFusionAccounts).toBe(18875)
    })

    it('falls back to run totalFusionAccountCount when fusionAccountsReturned is absent', () => {
        const { service } = createService({
            run: { totalFusionAccountCount: 42 },
        })

        const stats = service.buildDryRunStats({
            identitiesFound: 0,
            managedAccountsFound: 0,
            totalProcessingTime: '1s',
        })

        expect(stats.totalFusionAccounts).toBe(42)
    })

    it('preloads reviewer identities via ensureIdentityById before rendering decisions', async () => {
        const reviewerId = 'rev-preload'
        const ensureIdentityById = vi.fn(async (id: string) => ({ id, name: `Resolved ${id}` }))
        const { service } = createService({
            identities: {
                getIdentityById: vi.fn(() => undefined),
                ensureIdentityById,
            },
            forms: {
                finishedFusionDecisions: [
                    {
                        identityId: 'id-target',
                        submitter: { id: reviewerId, name: '' },
                        account: { id: 'src-a::nat', name: 'A', sourceName: 'S' },
                    },
                ],
            },
        })

        await service.hydrateIdentitiesForReportDecisions()

        expect(ensureIdentityById).toHaveBeenCalledWith(reviewerId)
        expect(ensureIdentityById).toHaveBeenCalledWith('id-target')
    })

    it('preloads reviewer and selected identity objects before rendering decisions', async () => {
        const { service, deps } = createService({
            forms: {
                finishedFusionDecisions: [
                    {
                        id: 'd-preload',
                        identityId: 'id-target',
                        submitter: { id: 'id-reviewer' },
                        account: { id: 'acc-1', sourceName: 'S' },
                    },
                ],
            },
        })

        await service.hydrateIdentitiesForReportDecisions()

        expect(deps.identities.ensureIdentityById).toHaveBeenCalledWith('id-reviewer')
        expect(deps.identities.ensureIdentityById).toHaveBeenCalledWith('id-target')
    })

    it('delegates dry-run report delivery to email service directly', async () => {
        const { service, deps } = createService()

        const report: any = {
            accounts: [],
            matches: 0,
            totalAccounts: 0,
        }

        const finalDryRunStats: any = {
            totalFusionAccounts: 1,
            fusionAccountsFound: 1,
            fusionReviewsCreated: 0,
            fusionReviewAssignments: 0,
            fusionReviewsFound: 0,
            fusionReviewInstancesFound: 0,
            fusionReviewsProcessed: 0,
            fusionReviewNewIdentities: 0,
            fusionReviewNonMatches: 0,
            fusionReviewDecisionsAuthoritative: 0,
            fusionReviewDecisionsRecord: 0,
            fusionReviewDecisionsOrphan: 0,
            fusionReviewNewIdentitiesAuthoritative: 0,
            fusionReviewNoMatchesRecord: 0,
            fusionReviewNoMatchesOrphan: 0,
            aggregationWarnings: 0,
            aggregationErrors: 0,
            warningSamples: [],
            errorSamples: [],
            usedMemory: '10 MB',
            identitiesFound: 1,
            managedAccountsFound: 1,
            totalProcessingTime: '1s',
            phaseTiming: [],
        }

        await service.writeAndSendDryRunReport({
            report,
            finalDryRunStats,
            sendEmail: ['reviewer@example.com'],
        })

        expect(deps.email.sendEmail).toHaveBeenCalledTimes(1)
    })

    it('hydrates global owner identities before resolving report recipient emails', async () => {
        const fetchGlobalOwnerIdentityIds = vi.fn(async () => ['owner-1'])
        const hydrateMissingIdentitiesById = vi.fn(async () => undefined)
        const getRecipientEmails = vi.fn(async () => ['owner@example.com'])
        const sendEmail = vi.fn(async () => undefined)

        const { service } = createService({
            sources: { fetchGlobalOwnerIdentityIds },
            identities: {
                hydrateMissingIdentitiesById,
                getIdentityById: vi.fn(() => undefined),
            },
            email: { getRecipientEmails, sendEmail },
        })

        await service.sendReport({ accounts: [], matches: 0 } as any, 'aggregation')

        expect(fetchGlobalOwnerIdentityIds).toHaveBeenCalledTimes(1)
        expect(hydrateMissingIdentitiesById).toHaveBeenCalledWith(['owner-1'])
        expect(getRecipientEmails).toHaveBeenCalledWith(['owner-1'])
        expect(sendEmail).toHaveBeenCalledTimes(1)
    })

    it('includes tenant host and fusion source in the aggregation report header', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml({ accounts: [], matches: 0 } as any, 'aggregation')
        expect(html).toContain('example.identitynow.com - Fusion-NG')
    })

    it('selects the aggregation title from reportType when override is omitted', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml({ accounts: [], matches: 0 } as any, 'aggregation')
        expect(html).toContain('Identity Fusion Aggregation Report')
        expect(html.includes('Identity Fusion Report')).toBe(false)
    })

    it('selects the Fusion report title from reportType when override is omitted', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml({ accounts: [], matches: 0 } as any, 'fusion')
        expect(html).toContain('Identity Fusion Report')
        expect(html).not.toContain('Identity Fusion Aggregation Report')
    })

    it('renders Identity Fusion Aggregation Report as the aggregation title', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml(
            { accounts: [], matches: 0 } as any,
            'aggregation',
            ReportService.AGGREGATION_REPORT_TITLE
        )
        expect(html).toContain('Identity Fusion Aggregation Report')
        expect(html).not.toContain('Identity Fusion Dry Run Report')
        expect(html.includes('Identity Fusion Report')).toBe(false)
    })

    it('renders Identity Fusion Report as the Fusion report title', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml(
            { accounts: [], matches: 0 } as any,
            'fusion',
            ReportService.FUSION_REPORT_EMAIL_TITLE
        )
        expect(html).toContain('Identity Fusion Report')
        expect(html).not.toContain('Identity Fusion Aggregation Report')
        expect(html).not.toContain('Identity Fusion Dry Run Report')
    })

    it('renders Identity Fusion Dry Run Report as the dry-run title', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml(
            { accounts: [], matches: 0 } as any,
            'aggregation',
            ReportService.DRY_RUN_REPORT_TITLE
        )
        expect(html).toContain('Identity Fusion Dry Run Report')
        expect(html).not.toContain('Identity Fusion Aggregation Report')
    })

    it('emails the aggregation report title to global owners', async () => {
        const sendEmail = vi.fn(async () => undefined)
        const { service } = createService({
            sources: { fetchGlobalOwnerIdentityIds: vi.fn(async () => ['owner-1']) },
            identities: {
                hydrateMissingIdentitiesById: vi.fn(async () => undefined),
                getIdentityById: vi.fn(() => undefined),
            },
            email: {
                sendEmail,
                getRecipientEmails: vi.fn(async () => ['owner@example.com']),
            },
        })

        await service.sendReport({ accounts: [], matches: 0 } as any, 'aggregation')

        expect(sendEmail).toHaveBeenCalledWith(
            ['owner@example.com'],
            expect.stringContaining('Identity Fusion Aggregation Report'),
            expect.any(String),
            expect.anything()
        )
    })

    it('keeps the tracker alive for the emailed report when a recording snapshot is built first', async () => {
        const sendEmail = vi.fn(async () => undefined)
        const tracker = { matchAccounts: [{ accountName: 'patti.jones [MelonHRM]' }] }
        const generateReport = vi.fn((t: any, _includeNonMatches?: boolean, _stats?: any, options?: any) => {
            const matches = t.matchAccounts.length
            if (options?.clearTracker ?? true) t.matchAccounts = []
            return { accounts: t.matchAccounts.slice(), matches }
        })
        const { service } = createService({
            sources: { fetchGlobalOwnerIdentityIds: vi.fn(async () => ['owner-1']) },
            identities: {
                hydrateMissingIdentitiesById: vi.fn(async () => undefined),
                getIdentityById: vi.fn(() => undefined),
            },
            fusion: { generateReport },
            email: {
                sendEmail,
                getRecipientEmails: vi.fn(async () => ['owner@example.com']),
            },
            run: { getTracker: vi.fn(() => tracker) },
        })

        const snapshot = await service.buildAggregationReportSnapshot(true, {} as any)
        await service.generateAndSendFusionReport(false, {} as any, 'aggregation')

        expect(snapshot.matches).toBe(1)
        expect(sendEmail.mock.calls[0][1]).toContain('1 match(es)')
        expect(tracker.matchAccounts).toHaveLength(0)
    })

    it('emails the Fusion report title to global owners', async () => {
        const sendEmail = vi.fn(async () => undefined)
        const { service } = createService({
            sources: { fetchGlobalOwnerIdentityIds: vi.fn(async () => ['owner-1']) },
            identities: {
                hydrateMissingIdentitiesById: vi.fn(async () => undefined),
                getIdentityById: vi.fn(() => undefined),
            },
            email: {
                sendEmail,
                getRecipientEmails: vi.fn(async () => ['owner@example.com']),
            },
        })

        await service.sendReport({ accounts: [], matches: 0 } as any, 'fusion')

        expect(sendEmail).toHaveBeenCalledWith(
            ['owner@example.com'],
            expect.stringContaining('Identity Fusion Report'),
            expect.any(String),
            expect.anything()
        )
        expect(sendEmail.mock.calls[0][1]).not.toContain('Identity Fusion Aggregation Report')
    })

    it('labels Fusion Blends with Identity and links the blended account', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml(
            {
                accounts: [],
                matches: 0,
                fusionBlends: [
                    {
                        accountName: 'john.williams',
                        accountUrl: 'https://example.identitynow.com/ui/a/admin/identities/id-1',
                        blendedAccountName: 'john.williams',
                        blendedAccountUrl: 'https://example.identitynow.com/ui/a/admin/identities/id-1/accounts/acct-1',
                        blendedSource: 'MelonHRM',
                    },
                ],
            } as any,
            'aggregation'
        )

        expect(html).toContain('Identity</td>')
        expect(html).toContain('href="https://example.identitynow.com/ui/a/admin/identities/id-1"')
        expect(html).toContain('Blended Account</td>')
        expect(html).toContain('href="https://example.identitynow.com/ui/a/admin/identities/id-1/accounts/acct-1"')
        expect(html).toContain('john.williams</a> [MelonHRM]')
    })

    it('renders the same potential-match cards for Fusion report and dry-run report from one tracker', () => {
        const { service } = createService()
        const report = {
            accounts: [
                {
                    accountName: 'Pat Candidate',
                    accountSource: 'HR',
                    matches: [{ identityName: 'Pat Identity', scores: [] }],
                },
            ],
            matches: 1,
            nonMatchedAccounts: 4,
        } as any

        const fusionHtml = service.renderFusionReportHtml(report, 'fusion', ReportService.FUSION_REPORT_EMAIL_TITLE)
        const dryRunHtml = service.renderFusionReportHtml(report, 'aggregation', ReportService.DRY_RUN_REPORT_TITLE)

        expect(fusionHtml).toContain('Pat Candidate')
        expect(dryRunHtml).toContain('Pat Candidate')
        expect(fusionHtml).toContain('Pat Identity')
        expect(dryRunHtml).toContain('Pat Identity')
        const stripTitle = (html: string) => html.replace(/Identity Fusion (Dry Run |Aggregation )?Report/g, '')
        expect(stripTitle(fusionHtml)).toBe(stripTitle(dryRunHtml))
    })

    it('renders Spanish report HTML when locale is es', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml(
            {
                accounts: [],
                matches: 0,
                stats: { aggregationWarnings: 0, aggregationErrors: 0 },
            } as any,
            'aggregation',
            undefined,
            'es'
        )
        expect(html).toContain('Estadísticas de procesamiento')
        expect(html).toContain('Reporte de agregación de Identity Fusion')
    })

    it('Aggregation report omits the Fusion Review Deletions section after deletions', () => {
        const { service } = createService()
        const html = service.renderFusionReportHtml(
            {
                accounts: [
                    {
                        accountName: 'Ada Lovelace',
                        accountSource: 'HR',
                        matches: [{ identityName: 'Ada', scores: [] }],
                    },
                ],
                matches: 1,
            } as any,
            'aggregation'
        )
        expect(html).toContain('Ada Lovelace')
        expect(html).not.toContain('Fusion Review Deletions')
    })

    it('Fusion report and dry-run report omit the Fusion Review Deletions section', () => {
        const { service } = createService()
        const report = { accounts: [], matches: 0 } as any
        const fusionHtml = service.renderFusionReportHtml(report, 'fusion', ReportService.FUSION_REPORT_EMAIL_TITLE)
        const dryRunHtml = service.renderFusionReportHtml(report, 'aggregation', ReportService.DRY_RUN_REPORT_TITLE)
        expect(fusionHtml).not.toContain('Fusion Review Deletions')
        expect(dryRunHtml).not.toContain('Fusion Review Deletions')
    })
})

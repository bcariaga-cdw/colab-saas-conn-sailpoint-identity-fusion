import { FusionAccount, IDENTITIES_SOURCE_NAME } from '../fusionAccount'
import { resolveFusionAccountNameOrDisplayName } from '../fusionAccountUtils'
import { FusionConfig, SourceType } from '../config'
import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'
import { FusionDecision } from '../form'
import { FusionAccountKind } from '../fusionAccountTypes'
import { StatusEntitlement } from '../statusEntitlement'
import { FusionRun } from '../fusionRun'
import { getManagedAccountSnapshotKey } from '../../utils/velocityAccountSnapshot'

describe('FusionAccount', () => {
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

    const aliasConfig = {
        ...minimalConfig,
        sources: [
            { name: 'HR', id: 'src-hr', sourceType: SourceType.Authoritative },
            { name: 'CRM', id: 'src-crm', sourceType: SourceType.Record },
        ],
    } as unknown as FusionConfig

    const correlatedHrAccount = (overrides: Record<string, unknown> = {}) =>
        ({
            id: 'isc-acc-vincent',
            sourceId: 'src-hr',
            sourceName: 'HR',
            nativeIdentity: '1018',
            name: 'vincent.mccoy',
            uncorrelated: false,
            identityId: 'identity-vincent',
            identity: { id: 'identity-vincent', name: 'Vincent McCoy' },
            attributes: {},
            ...overrides,
        }) as unknown as Account

    beforeAll(() => {
        FusionAccount.configure(minimalConfig)
    })

    describe('1. Factory Methods', () => {
        it('fromIdentity initializes correctly', () => {
            const identity: IdentityDocument = {
                id: 'id-1',
                name: 'test-identity',
                attributes: { email: 'test@example.com', displayName: 'Test Identity' },
            }
            const acc = FusionAccount.fromIdentity(identity)
            expect(acc.type).toBe(FusionAccountKind.Identity)
            expect(acc.sourceName).toBe(IDENTITIES_SOURCE_NAME)
            expect(acc.statuses).toContain('baseline')
            expect(acc.statuses).toContain('new')
            expect(acc.fromIdentity).toBe(true)
            expect(acc.managedKey).toBe(`${IDENTITIES_SOURCE_NAME}::id-1`)
        })

        it('fromManagedAccount initializes correctly', () => {
            const account: Account = {
                id: 'isc-acc-1',
                sourceId: 'src-a',
                nativeIdentity: 'nat-1',
                sourceName: 'Source A',
                attributes: {},
            } as any
            const acc = FusionAccount.fromManagedAccount(account)
            expect(acc.type).toBe(FusionAccountKind.Managed)
            expect(acc.sourceName).toBe('Source A')
            expect(acc.statuses).toContain('uncorrelated')
            expect(acc.statuses).toContain('new')
            expect(acc.needsReset).toBe(true)
            expect(acc.managedKey).toBe('src-a::nat-1')
        })

        it('fromFusionDecision initializes correctly', () => {
            const decision: FusionDecision = {
                account: {
                    id: 'src-a::native-1',
                    sourceName: 'Source A',
                    sourceId: 'src-a',
                    nativeIdentity: 'native-1',
                },
                identityId: 'id-1',
                identityName: 'Test Identity',
                newIdentity: true,
                submitter: { name: 'admin' },
                sourceType: SourceType.Authoritative,
            } as any
            const acc = FusionAccount.fromFusionDecision(decision)
            expect(acc.type).toBe(FusionAccountKind.Decision)
            expect(acc.managedKey).toBe('src-a::native-1')
            expect(acc.statuses).toContain('uncorrelated')
            expect(acc.statuses).toContain('new')
        })

        it('fromFusionAccount removes persisted new status', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                sourceName: 'Identity Fusion NG',
                attributes: { statuses: ['new', 'uncorrelated'] },
            } as Account)

            expect(acc.statuses).not.toContain('new')
            expect(acc.statuses).toContain('uncorrelated')
        })

        it('fromFusionAccount does not add new when it was not persisted', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-2',
                sourceName: 'Identity Fusion NG',
                attributes: { statuses: ['uncorrelated'] },
            } as Account)

            expect(acc.statuses).not.toContain('new')
        })
    })

    describe('1b. Nullish attribute bag leanness', () => {
        it('Seeded current bag omits nullish keys', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-lean-1',
                sourceName: 'Identity Fusion NG',
                attributes: { department: null, notes: undefined, name: 'Ada Wong' },
            } as Account)

            expect(acc.attributeBag.current).not.toHaveProperty('department')
            expect(acc.attributeBag.current).not.toHaveProperty('notes')
            expect(acc.attributeBag.current.name).toBe('Ada Wong')
        })

        it('Seeded previous bag omits nullish keys', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-lean-1',
                sourceName: 'Identity Fusion NG',
                attributes: { department: null, notes: undefined, name: 'Ada Wong' },
            } as Account)

            expect(acc.attributeBag.previous).not.toHaveProperty('department')
            expect(acc.attributeBag.previous).not.toHaveProperty('notes')
            expect(acc.attributeBag.previous.name).toBe('Ada Wong')
        })

        it('Seeded bag keeps false, zero, blank strings, and empty arrays', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-lean-2',
                sourceName: 'Identity Fusion NG',
                attributes: { active: false, employeeNumber: 0, notes: '', reviews: [] },
            } as Account)

            expect(acc.attributeBag.current.active).toBe(false)
            expect(acc.attributeBag.current.employeeNumber).toBe(0)
            expect(acc.attributeBag.current.notes).toBe('')
            expect(acc.attributeBag.current.reviews).toEqual([])
        })

        it('strips nullish keys from identity and managed account seeds', () => {
            const identity = FusionAccount.fromIdentity({
                id: 'id-lean',
                name: 'Lean Identity',
                attributes: { department: null, email: 'lean@example.com' },
            } as any)
            expect(identity.attributeBag.current).not.toHaveProperty('department')
            expect(identity.attributeBag.current.email).toBe('lean@example.com')

            const managed = FusionAccount.fromManagedAccount({
                id: 'isc-lean',
                sourceId: 'src-a',
                nativeIdentity: 'nat-lean',
                sourceName: 'Source A',
                attributes: { department: null, name: 'Managed Lean' },
            } as any)
            expect(managed.attributeBag.current).not.toHaveProperty('department')
            expect(managed.attributeBag.previous).not.toHaveProperty('department')
            expect(managed.attributeBag.current.name).toBe('Managed Lean')
        })

        it('Replacing the current bag omits nullish keys', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-lean', name: 'Lean Identity' } as any)

            acc.setMappedAttributes({ department: null, notes: undefined, name: 'Ada Wong' })

            expect(acc.attributeBag.current).not.toHaveProperty('department')
            expect(acc.attributeBag.current).not.toHaveProperty('notes')
            expect(acc.attributeBag.current.name).toBe('Ada Wong')
        })

        it('keeps raw null values in the identity bag and source snapshots', () => {
            const identity = { id: 'id-raw', name: 'Raw Identity', attributes: { department: null } }
            const identityAccount = FusionAccount.fromIdentity(identity as any)
            identityAccount.addIdentityLayer(identity as any)
            expect(identityAccount.attributeBag.identity).toHaveProperty('department', null)

            const managedAccount = FusionAccount.fromIdentity({ id: 'id-raw-2', name: 'Raw Identity 2' } as any)
            const run = new FusionRun()
            run.managedAccountsById.set('src-a::nat-raw', {
                id: 'isc-raw',
                sourceId: 'src-a',
                nativeIdentity: 'nat-raw',
                sourceName: 'Source A',
                attributes: { department: null },
            } as any)
            run.managedAccountsByIdentityId.set('id-raw-2', new Set(['src-a::nat-raw']))

            managedAccount.addManagedAccountLayer(run)

            const snapshot = managedAccount.attributeBag.sources.get('Source A')?.[0] as any
            expect(snapshot).toBeDefined()
            expect(snapshot.department).toBeNull()
        })
    })

    describe('2. Attribute bag & layer merging', () => {
        it('addIdentityLayer merges identity layer', () => {
            const identity: IdentityDocument = {
                id: 'id-1',
                name: 'test-identity',
                attributes: { email: 'test@test.com' },
                accounts: [{ source: { name: 'Source A', id: 'src-a' }, nativeIdentity: 'native-1' } as any],
            }
            const acc = FusionAccount.fromIdentity(identity)
            acc.addIdentityLayer(identity)
            expect(acc.email).toBe('test@test.com')
            expect(acc.accountIds).toContain('src-a::native-1')
            expect(acc.missingAccountIds).not.toContain('src-a::native-1')
        })

        it('addManagedAccountLayer merges managed account', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            const run = new FusionRun()
            run.managedAccountsById.set('src-a::native-1', {
                id: 'isc-acc-1',
                sourceId: 'src-a',
                nativeIdentity: 'native-1',
                sourceName: 'Source A',
                attributes: {},
            } as any)
            run.managedAccountsByIdentityId.set('id-1', new Set(['src-a::native-1']))

            acc.addManagedAccountLayer(run)
            expect(acc.accountIds).toContain('src-a::native-1')
            expect(acc.sources).toContain('Source A')
            expect(acc.attributeBag.sources.get('Source A')).toHaveLength(1)
            expect(run.managedAccountsById.size).toBe(0)
        })

        it('addFusionDecisionLayer merges decision layer', () => {
            const decision: FusionDecision = {
                account: { id: 'src-b::nat-2', sourceId: 'src-b', nativeIdentity: 'nat-2', sourceName: 'Source B' },
                newIdentity: true,
                submitter: { name: 'admin' },
                sourceType: SourceType.Authoritative,
            } as any
            const acc = FusionAccount.fromFusionDecision(decision)
            acc.layers.addFusionDecisionLayer(decision)
            expect(acc.statuses).toContain('manual')
        })
    })

    describe('3. Status state machine', () => {
        it('addStatus, removeStatus, hasStatus, statuses', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.statuses.add('testStatus')
            expect(acc.collections.statuses.has('testStatus')).toBe(true)
            expect(acc.statuses).toContain('testStatus')
            acc.collections.statuses.remove('testStatus')
            expect(acc.collections.statuses.has('testStatus')).toBe(false)
        })
    })

    describe('4. Action state machine', () => {
        it('addAction, removeAction, actions, setSourceReviewer, removeSourceReviewer, listReviewerSources', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.actions.add('testAction')
            expect(acc.actions).toContain('testAction')
            acc.collections.actions.remove('testAction')

            acc.collections.actions.setSourceReviewer('src-a')
            expect(acc.actions).toContain('reviewer:src-a')
            expect(acc.collections.statuses.has('reviewer')).toBe(true)
            expect(acc.collections.actions.listReviewerSources()).toEqual(['src-a'])

            acc.collections.actions.removeSourceReviewer('src-a')
            expect(acc.actions).not.toContain('reviewer:src-a')
            expect(acc.collections.statuses.has('reviewer')).toBe(false)
        })
    })

    describe('5. Review tracking', () => {
        it('manages reviews correctly', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.reviews.add('url1')
            expect(acc.reviews).toContain('url1')
            acc.collections.reviews.remove('url1')

            acc.collections.reviews.addFusionReview('url2')
            expect(acc.reviews).toContain('url2')
            expect(acc.collections.statuses.has('activeReviews')).toBe(true)

            acc.collections.reviews.removeFusionReview('url2')
            expect(acc.collections.statuses.has('activeReviews')).toBe(false)

            acc.collections.reviews.addFusionReview('url3')
            acc.collections.reviews.clearFusionReviews()
            expect(acc.reviews.length).toBe(0)

            acc.collections.reviews.addPendingUrl('url4')
            acc.correlation.resolvePendingReviewUrls()
            expect(acc.reviews).toContain('url4')
        })
    })

    describe('6. Account ID management', () => {
        it('adds and removes account ids', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.accounts.add('acc-1')
            expect(acc.accountIds).toContain('acc-1')
            acc.collections.accounts.remove('acc-1')

            acc.collections.accounts.addMissing('missing-1')
            expect(acc.missingAccountIds).toContain('missing-1')
            acc.collections.accounts.removeMissing('missing-1')
        })
    })

    describe('7. Correlation promises', () => {
        it('handles correlation promises', async () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.accounts.addMissing('acc-1')
            acc.correlation.markCorrelated('acc-1', Promise.resolve('ok'))
            expect(acc.accountIds).toContain('acc-1')
            expect(acc.missingAccountIds).not.toContain('acc-1')

            await acc.correlation.resolvePendingOperations()
        })
    })

    describe('8. State flags', () => {
        it('toggles flags', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.disable()
            expect(acc.disabled).toBe(true)
            acc.enable()
            expect(acc.disabled).toBe(false)

            acc.setNeedsRefresh(true)
            expect(acc.needsRefresh).toBe(true)

            acc.setNeedsReset(true)
            expect(acc.needsReset).toBe(true)
        })
    })

    describe('9. Collection sync', () => {
        it('syncs collections to attribute bag', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.statuses.add('status1')
            acc.collections.actions.add('action1')
            acc.syncCollectionAttributesToBag()
            expect(acc.attributes.statuses).toContain('status1')
            expect(acc.attributes.actions).toContain('action1')
        })

        it('syncCollectionAttributesToBag writes only the current attribute bag', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.attributes.statuses = ['stale-on-current']
            acc.attributes.actions = ['stale-action']
            ;(acc as any).attributeBagValue.previous = {
                statuses: ['previous-only-status'],
                actions: ['previous-only-action'],
            }

            acc.collections.statuses.add('live-status')
            acc.collections.actions.add('live-action')
            acc.syncCollectionAttributesToBag()

            expect(acc.attributes.statuses).toContain('live-status')
            expect(acc.attributes.actions).toContain('live-action')
            expect(acc.attributes.statuses).not.toContain('previous-only-status')
            expect((acc as any).attributeBagValue.previous.statuses).toEqual(['previous-only-status'])
            expect((acc as any).attributeBagValue.previous.actions).toEqual(['previous-only-action'])
        })
    })

    describe('collaborator presence', () => {
        it('exposes readonly collections, correlation, and layers on a new FusionAccount', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            expect(acc.collections).toBeDefined()
            expect(acc.correlation).toBeDefined()
            expect(acc.layers).toBeDefined()
            expect(typeof acc.collections.statuses.add).toBe('function')
            expect(typeof acc.correlation.markCorrelated).toBe('function')
            expect(typeof acc.layers.addFusionMatch).toBe('function')
        })
    })

    describe('10. toISCAccount serialization', () => {
        it('round trips toISCAccount and fromFusionAccount', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1', attributes: { email: 'a@b.com' } } as any)
            acc.setKey({ simple: { id: 'id-1' } })
            acc.collections.statuses.add(StatusEntitlement.Baseline)
            acc.syncCollectionAttributesToBag()

            const iscAccount = acc.toISCAccount()
            iscAccount.nativeIdentity = 'id-1'
            iscAccount.id = 'isc-1'

            const restored = FusionAccount.fromFusionAccount(iscAccount)
            expect(restored.statuses).toContain('baseline')
            expect(restored.managedKey).toBe(`id-1`)
        })

        it('round trips the persisted identityId through attributes', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1', attributes: { email: 'a@b.com' } } as any)
            acc.setKey({ simple: { id: 'id-1' } })
            acc.collections.statuses.add(StatusEntitlement.Baseline)
            acc.syncCollectionAttributesToBag()

            const iscAccount = acc.toISCAccount()
            iscAccount.nativeIdentity = 'id-1'
            iscAccount.id = 'isc-1'
            // Simulate ISC echo: only attributes + nativeIdentity + id are persisted, no top-level identityId
            iscAccount.attributes = { ...iscAccount.attributes }

            const restored = FusionAccount.fromFusionAccount(iscAccount)
            expect(restored.identityId).toBe('id-1')
            expect(restored.identityIdAttribute).toBe('id-1')
        })

        it('routes via identityIdAttribute fallback when SDK does not expose identityId', () => {
            const persisted = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-attr-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                attributes: { identityId: 'identity-1' },
            } as any)
            // identityInfoValue is created from the persisted attribute (not from the SDK Account)
            expect(persisted.identityId).toBe('identity-1')
            expect(persisted.identityIdAttribute).toBe('identity-1')
        })

        it('ignores empty or whitespace-only persisted identityId', () => {
            const persisted = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-empty',
                name: 'Empty ID',
                sourceName: 'Identity Fusion NG',
                attributes: { identityId: '   ' },
            } as any)
            // No identity info was reconstructed; hasValue('') is false so routing is uncorrelated
            expect(persisted.identityId).toBeUndefined()
            expect(persisted.identityIdAttribute).toBeUndefined()
        })

        it('setIdentityIdAttribute trims and stores the id on identityInfoValue', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.setIdentityIdAttribute('  identity-42  ')
            expect(acc.identityIdAttribute).toBe('identity-42')
            expect((acc as any).identityInfoValue?.id).toBe('identity-42')
            // Empty values are stored as empty string; hasValue returns false
            acc.setIdentityIdAttribute('')
            expect(acc.identityIdAttribute).toBe('')
            expect((acc as any).identityInfoValue?.id).toBe('')
        })

        it('preserves name/displayName when setIdentityIdAttribute updates an existing identityInfoValue', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1', name: 'Jane Doe' } as any)
            expect((acc as any).identityInfoValue?.name).toBeTruthy()
            acc.setIdentityIdAttribute('identity-99')
            expect(acc.identityId).toBe('identity-99')
            expect((acc as any).identityInfoValue?.name).toBeTruthy()
        })
    })

    describe('11. History', () => {
        it('imports and caps history', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            const hist = Array.from({ length: 60 }, (_, i) => `[Date] message ${i}`)
            acc.collections.historyOps.importFromArray(hist)
            expect(acc.history.length).toBe(minimalConfig.maxHistoryMessages)
            expect(acc.history[49]).toBe('[Date] message 59')
        })
    })

    describe('12. Fusion matches', () => {
        it('buildIdentityInfo from decision', () => {
            const decision = {
                account: { sourceId: 'src1', nativeIdentity: 'nat1' },
                identityId: 'a1',
                identityName: 'S1',
                newIdentity: true,
            } as any
            expect(FusionAccount.buildIdentityInfo(decision)).toEqual({ id: 'a1', name: '', displayName: 'S1' })
        })

        it('takes the alias of a correlated authoritative account from the account name', () => {
            FusionAccount.configure(aliasConfig)
            try {
                const acc = FusionAccount.fromManagedAccount(correlatedHrAccount())
                expect(acc.identityAlias).toBe('vincent.mccoy')
                expect(acc.identityDisplayName).toBe('Vincent McCoy')
            } finally {
                FusionAccount.configure(minimalConfig)
            }
        })

        it('leaves the alias unresolved for correlated record, uncorrelated, and untyped-source accounts', () => {
            FusionAccount.configure(aliasConfig)
            try {
                const record = FusionAccount.fromManagedAccount(
                    correlatedHrAccount({ sourceId: 'src-crm', sourceName: 'CRM' })
                )
                const uncorrelated = FusionAccount.fromManagedAccount(correlatedHrAccount({ uncorrelated: true }))
                const untyped = FusionAccount.fromManagedAccount(correlatedHrAccount({ sourceName: 'Unlisted' }))

                expect(record.identityAlias).toBeUndefined()
                expect(uncorrelated.identityAlias).toBeUndefined()
                expect(untyped.identityAlias).toBeUndefined()
            } finally {
                FusionAccount.configure(minimalConfig)
            }
        })

        it('prefers the IdentityDocument alias once the identity layer is applied', () => {
            FusionAccount.configure(aliasConfig)
            try {
                const acc = FusionAccount.fromManagedAccount(correlatedHrAccount())
                acc.addIdentityLayer({
                    id: 'identity-vincent',
                    name: 'vmccoy',
                    attributes: { displayName: 'Vincent McCoy' },
                } as unknown as IdentityDocument)

                expect(acc.identityAlias).toBe('vmccoy')
            } finally {
                FusionAccount.configure(minimalConfig)
            }
        })

        it('adds fusion match', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.layers.addFusionMatch({ fusionIdentity: {} as any, score: 100 } as any)
            expect(acc.isMatch).toBe(true)
            expect(acc.fusionMatches.length).toBe(1)

            acc.layers.clearFusionIdentityReferences()
            expect((acc.fusionMatches[0] as any).fusionIdentity).toBeUndefined()
        })
    })

    describe('13. buildIdentityInfo', () => {
        it('builds identity info', () => {
            const info = FusionAccount.buildIdentityInfo({
                id: 'id-1',
                name: 'Name',
                displayName: 'Display Name',
            } as any)
            expect(info).toEqual({ id: 'id-1', name: 'Name', displayName: 'Display Name' })
        })
    })

    describe('13b. resolveFusionAccountNameOrDisplayName', () => {
        it('prefers name over displayName', () => {
            expect(resolveFusionAccountNameOrDisplayName({ name: 'Name', displayName: 'Display' }, 'fallback')).toBe(
                'Name'
            )
        })

        it('falls back to displayName then explicit fallback', () => {
            expect(resolveFusionAccountNameOrDisplayName({ displayName: 'Display' }, 'fallback')).toBe('Display')
            expect(resolveFusionAccountNameOrDisplayName({}, 'fallback')).toBe('fallback')
        })
    })

    describe('14. Reverse correlation', () => {
        it('sets reverse correlation attribute', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.setReverseCorrelationAttribute('revAttr', 'value')
            expect(acc.attributes['revAttr']).toBe('value')
            acc.clearReverseCorrelationAttribute('revAttr')
            expect(acc.attributes['revAttr']).toBeUndefined()
        })
    })

    describe('15. Identity-origin baseline re-assertion on fromFusionAccount', () => {
        const buildPersistedAccount = (overrides: Record<string, unknown> = {}): Account =>
            ({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                identityId: 'id-1',
                disabled: false,
                attributes: {
                    originSource: IDENTITIES_SOURCE_NAME,
                    originAccount: 'id-1',
                    accounts: [],
                    statuses: ['baseline'],
                    ...overrides,
                },
            }) as unknown as Account

        it('preserves baseline and Identities for a record that already has baseline', () => {
            const acc = FusionAccount.fromFusionAccount(buildPersistedAccount())
            expect(acc.fromIdentity).toBe(true)
            expect(acc.statuses).toContain('baseline')
            expect(acc.sources).toContain(IDENTITIES_SOURCE_NAME)
        })

        it('re-asserts baseline when the persisted statuses array is empty (identity-origin)', () => {
            const acc = FusionAccount.fromFusionAccount(buildPersistedAccount({ statuses: [] }))
            expect(acc.fromIdentity).toBe(true)
            expect(acc.statuses).toContain('baseline')
            expect(acc.sources).toContain(IDENTITIES_SOURCE_NAME)
        })

        it('re-asserts baseline when the persisted statuses key is missing (identity-origin)', () => {
            const acc = FusionAccount.fromFusionAccount(buildPersistedAccount({ statuses: undefined }))
            expect(acc.fromIdentity).toBe(true)
            expect(acc.statuses).toContain('baseline')
            expect(acc.sources).toContain(IDENTITIES_SOURCE_NAME)
        })

        it('coexists with orphan when persisted statuses only carries orphan (identity-origin)', () => {
            const acc = FusionAccount.fromFusionAccount(buildPersistedAccount({ statuses: ['orphan'] }))
            expect(acc.fromIdentity).toBe(true)
            expect(acc.statuses).toContain('baseline')
            expect(acc.statuses).toContain('orphan')
            expect(acc.sources).toContain(IDENTITIES_SOURCE_NAME)
        })

        it('does not add baseline to a non-identity-origin record', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-2',
                id: 'isc-2',
                name: 'Persisted Managed',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    originSource: 'Source A',
                    originAccount: 'src-a::native-1',
                    accounts: [],
                    statuses: [],
                },
            } as unknown as Account)
            expect(acc.fromIdentity).toBe(false)
            expect(acc.statuses).not.toContain('baseline')
            expect(acc.sources).not.toContain(IDENTITIES_SOURCE_NAME)
            expect(acc.originAccountId).toBe('src-a::native-1')
        })
    })

    describe('16. Missing-accounts restoration from persisted attributes', () => {
        it('restores missing-accounts into the missing reference set', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['src-a::correlated-1'],
                    'missing-accounts': ['src-a::missing-1'],
                },
            } as unknown as Account)
            expect(acc.missingAccountIds).toContain('src-a::missing-1')
            expect(acc.missingAccountIds).not.toContain('src-a::correlated-1')
        })

        it('does not put correlated accounts into the missing reference set', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['src-a::correlated-1'],
                },
            } as unknown as Account)
            expect(acc.missingAccountIds).toEqual([])
        })
    })

    describe('17. Persisted collection and history restoration', () => {
        it('restores previous account IDs from persisted accounts', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['src-a::correlated-1', 'src-b::correlated-2'],
                },
            } as unknown as Account)
            expect(acc.previousAccountIdsSet.has('src-a::correlated-1')).toBe(true)
            expect(acc.previousAccountIdsSet.has('src-b::correlated-2')).toBe(true)
        })

        it('restores history from persisted attributes', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: [],
                    history: ['[2026-01-01] event one', '[2026-01-02] event two'],
                },
            } as unknown as Account)
            expect(acc.history).toContain('[2026-01-01] event one')
            expect(acc.history).toContain('[2026-01-02] event two')
        })
    })

    describe('addManagedAccountLayer identity matching', () => {
        it('claims accounts by identityId index and marks them correlated', () => {
            const identity: IdentityDocument = {
                id: 'id-1',
                name: 'test-identity',
                attributes: {},
            } as any
            const acc = FusionAccount.fromIdentity(identity)

            const account: Account = {
                id: 'isc-acc-1',
                sourceId: 'src-a',
                nativeIdentity: 'native-1',
                sourceName: 'Source A',
                attributes: {},
            } as any
            const run = new FusionRun()
            run.managedAccountsById.set('src-a::native-1', account)
            run.managedAccountsByIdentityId.set('id-1', new Set(['src-a::native-1']))

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain('src-a::native-1')
            expect(acc.missingAccountIds).not.toContain('src-a::native-1')
            expect(acc.sources).toContain('Source A')
            expect(acc.attributeBag.sources.get('Source A')).toHaveLength(1)
            expect(run.managedAccountsById.size).toBe(0)
            expect(run.managedAccountsByIdentityId.has('id-1')).toBe(false)
        })

        it('blends identity.accounts links in work queue when not indexed by identityId', () => {
            const WORKDAY_SOURCE_ID = '355fb49e084e4f35adb755410affe0c8'
            const managedKey = `${WORKDAY_SOURCE_ID}::126791`

            const identity: IdentityDocument = {
                id: 'id-1',
                name: 'test-identity',
                attributes: {},
                accounts: [
                    {
                        source: { name: 'Source A', id: 'src-a' },
                        nativeIdentity: 'native-1',
                    } as any,
                ],
            } as any
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Fusion Account',
                sourceName: 'Identity Fusion NG',
                identityId: 'id-1',
                attributes: { accounts: [managedKey] },
            } as unknown as Account)

            acc.addIdentityLayer(identity)

            const account: Account = {
                id: 'isc-acc-1',
                sourceId: 'src-a',
                nativeIdentity: 'native-1',
                sourceName: 'Source A',
                attributes: { POSITION: 'Engineer' },
            } as any
            const run = new FusionRun()
            run.managedAccountsById.set('src-a::native-1', account)

            acc.addManagedAccountLayer(run)

            const snapshots = acc.attributeBag.sources.get('Source A')
            expect(snapshots).toHaveLength(1)
            expect(snapshots![0].POSITION).toBe('Engineer')
            expect(acc.accountIds).toContain('src-a::native-1')
            expect(acc.missingAccountIds).not.toContain('src-a::native-1')
        })

        it('claims accounts from previous run via previousAccountIds', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['src-a::native-1'],
                },
            } as unknown as Account)

            const account: Account = {
                id: 'isc-acc-1',
                sourceId: 'src-a',
                nativeIdentity: 'native-1',
                sourceName: 'Source A',
                attributes: {},
            } as any
            const run = new FusionRun()
            run.managedAccountsById.set('src-a::native-1', account)

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain('src-a::native-1')
            expect(acc.missingAccountIds).toContain('src-a::native-1')
            expect(run.managedAccountsById.size).toBe(0)
        })

        it('sets orphan status when identity-origin account loses all managed accounts and identity is out of scope', () => {
            const identity: IdentityDocument = { id: 'id-1', name: 'test-identity', attributes: {} } as any
            const acc = FusionAccount.fromIdentity(identity)
            acc.setOriginIdentityInScope(false)

            const run = new FusionRun()
            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.collections.statuses.isOrphan()).toBe(true)
            expect(acc.statuses).toContain('orphan')
        })

        it('does not mark identity-origin account orphan when origin identity is in scope and there are no managed accounts', () => {
            const identity: IdentityDocument = { id: 'id-1', name: 'test-identity', attributes: {} } as any
            const acc = FusionAccount.fromIdentity(identity)
            acc.setOriginIdentityInScope(true)

            const run = new FusionRun()
            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.collections.statuses.isOrphan()).toBe(false)
            expect(acc.statuses).not.toContain('orphan')
        })

        it('does not mark identity-origin account orphan when scope has not been evaluated yet', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                identityId: 'id-1',
                attributes: {
                    originSource: IDENTITIES_SOURCE_NAME,
                    originAccount: 'id-1',
                    accounts: [],
                    statuses: ['baseline'],
                },
            } as unknown as Account)

            const run = new FusionRun()
            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.collections.statuses.isOrphan()).toBe(false)
        })

        it('clears stale orphan status when identity-origin account is in scope with no managed accounts', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                identityId: 'id-1',
                attributes: {
                    originSource: IDENTITIES_SOURCE_NAME,
                    originAccount: 'id-1',
                    accounts: [],
                    statuses: ['baseline', 'orphan'],
                },
            } as unknown as Account)
            acc.setOriginIdentityInScope(true)

            const run = new FusionRun()
            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.collections.statuses.isOrphan()).toBe(false)
            expect(acc.statuses).not.toContain('orphan')
        })

        it('treats baseline-only persisted Fusion accounts as identity-origin for orphan detection', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                identityId: 'id-1',
                attributes: {
                    originAccount: 'id-1',
                    accounts: [],
                    statuses: ['baseline'],
                },
            } as unknown as Account)

            expect(acc.fromIdentity).toBe(true)
            acc.setOriginIdentityInScope(true)

            const run = new FusionRun()
            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.collections.statuses.isOrphan()).toBe(false)
        })

        describe('record-source accounts do not retain', () => {
            const crmAccount = {
                id: 'isc-crm-1',
                sourceId: 'src-crm',
                sourceName: 'CRM',
                nativeIdentity: 'rec-1',
                attributes: {},
            } as unknown as Account
            const hrAccount = {
                id: 'isc-hr-1',
                sourceId: 'src-hr',
                sourceName: 'HR',
                nativeIdentity: 'hr-1',
                attributes: {},
            } as unknown as Account

            const persistedWith = (accounts: string[]) =>
                FusionAccount.fromFusionAccount({
                    nativeIdentity: 'fusion-rec',
                    id: 'isc-rec',
                    name: 'Persisted Account',
                    sourceName: 'Identity Fusion NG',
                    attributes: { accounts },
                } as unknown as Account)

            beforeEach(() => FusionAccount.configure(aliasConfig))
            afterEach(() => FusionAccount.configure(minimalConfig))

            it('marks managed-origin account orphan when only record-source accounts remain', () => {
                const acc = persistedWith(['src-crm::rec-1'])
                const run = new FusionRun()
                run.managedAccountsById.set('src-crm::rec-1', crmAccount)

                acc.addManagedAccountLayer(run)

                expect(acc.accountIds).toContain('src-crm::rec-1')
                expect(acc.collections.statuses.isOrphan()).toBe(true)
            })

            it('does not mark orphan when a non-record source account remains', () => {
                const acc = persistedWith(['src-crm::rec-1', 'src-hr::hr-1'])
                const run = new FusionRun()
                run.managedAccountsById.set('src-crm::rec-1', crmAccount)
                run.managedAccountsById.set('src-hr::hr-1', hrAccount)

                acc.addManagedAccountLayer(run)

                expect(acc.collections.statuses.isOrphan()).toBe(false)
            })
        })
    })

    describe('pruneDeletedManagedAccounts', () => {
        it('removes account references that no longer exist in the inventory', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['src-a::old-1'],
                    'missing-accounts': ['src-a::old-2'],
                },
            } as unknown as Account)

            // Ensure previousAccountIds is hydrated from persisted accounts
            expect(acc.previousAccountIdsSet.has('src-a::old-1')).toBe(true)

            const run = new FusionRun()
            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.accountIds).not.toContain('src-a::old-1')
            expect(acc.missingAccountIds).not.toContain('src-a::old-2')
            expect(acc.history.some((h) => h.includes('Removed managed account missing reference'))).toBe(true)
        })

        it('clears needsRefresh when a managed-origin account becomes orphan after pruning', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-2',
                id: 'isc-2',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['src-a::gone'],
                },
            } as unknown as Account)

            const run = new FusionRun()
            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.collections.statuses.isOrphan()).toBe(true)
            expect(acc.needsRefresh).toBe(false)
        })
    })

    describe('managed-account modified vs fusion modified', () => {
        const fusionModified = '2024-06-01T12:00:00.000Z'

        const persistedFusionWithQueuedManaged = (options: { fusionModified?: string; managedModified: string }) => {
            const fusionAccountPayload: Record<string, unknown> = {
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['src-a::keep-1'],
                },
            }
            if (options.fusionModified !== undefined) {
                fusionAccountPayload.modified = options.fusionModified
            }
            const acc = FusionAccount.fromFusionAccount(fusionAccountPayload as unknown as Account)
            const run = new FusionRun()
            run.managedAccountsById.set('src-a::keep-1', {
                id: 'isc-keep-1',
                sourceId: 'src-a',
                nativeIdentity: 'keep-1',
                sourceName: 'Source A',
                modified: options.managedModified,
                attributes: {},
            } as any)
            acc.addManagedAccountLayer(run)
            return { acc, run }
        }

        it('previously correlated stale managed account does not force refresh', () => {
            const { acc, run } = persistedFusionWithQueuedManaged({
                fusionModified,
                managedModified: '2024-01-01T00:00:00.000Z',
            })

            expect(acc.needsRefresh).toBe(false)
            expect(acc.accountIds).toContain('src-a::keep-1')
            expect(run.managedAccountsById.has('src-a::keep-1')).toBe(false)
        })

        it('managed account newer than fusion modified beyond the threshold forces refresh', () => {
            const { acc } = persistedFusionWithQueuedManaged({
                fusionModified,
                managedModified: '2024-06-01T14:00:00.000Z',
            })

            expect(acc.needsRefresh).toBe(true)
        })

        it('managed account newer than fusion modified within the threshold does not force refresh', () => {
            const { acc } = persistedFusionWithQueuedManaged({
                fusionModified,
                managedModified: '2024-06-01T12:30:00.000Z',
            })

            expect(acc.needsRefresh).toBe(false)
        })

        it('new blend still forces refresh', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            const run = new FusionRun()
            run.managedAccountsById.set('src-a::native-1', {
                id: 'isc-acc-1',
                sourceId: 'src-a',
                nativeIdentity: 'native-1',
                sourceName: 'Source A',
                modified: '2020-01-01T00:00:00.000Z',
                attributes: {},
            } as any)
            run.managedAccountsByIdentityId.set('id-1', new Set(['src-a::native-1']))

            acc.addManagedAccountLayer(run)

            expect(acc.needsRefresh).toBe(true)
            expect(acc.accountIds).toContain('src-a::native-1')
            expect(run.managedAccountsById.size).toBe(0)
        })

        it('missing fusion modified does not use epoch as the refresh reference', () => {
            const { acc, run } = persistedFusionWithQueuedManaged({
                managedModified: '2024-06-01T14:00:00.000Z',
            })

            expect(acc.needsRefresh).toBe(false)
            expect(acc.accountIds).toContain('src-a::keep-1')
            expect(run.managedAccountsById.has('src-a::keep-1')).toBe(false)
        })
    })

    describe('claim-only vs source snapshot materialization', () => {
        const fusionModified = '2024-06-01T12:00:00.000Z'
        const distinctAttributeName = 'employeeNumber'
        const distinctAttributeValue = 'EMP-CLAIM-ONLY-999'

        const queueManaged = (
            sourceId: string,
            nativeIdentity: string,
            extras: Record<string, unknown> = {}
        ): Account =>
            ({
                id: `isc-${sourceId}-${nativeIdentity}`,
                sourceId,
                nativeIdentity,
                sourceName: sourceId === 'src-a' ? 'Source A' : 'Source B',
                attributes: {
                    [distinctAttributeName]: distinctAttributeValue,
                    ...((extras.attributes as object) ?? {}),
                },
                ...Object.fromEntries(Object.entries(extras).filter(([key]) => key !== 'attributes')),
            }) as Account

        const persistedFusion = (accountKeys: string[], extras: Record<string, unknown> = {}) =>
            FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-claim-only',
                id: 'isc-claim-only',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                modified: fusionModified,
                attributes: {
                    accounts: accountKeys,
                    givenName: 'Already',
                    ...((extras.attributes as object) ?? {}),
                },
                ...Object.fromEntries(Object.entries(extras).filter(([key]) => key !== 'attributes')),
            } as unknown as Account)

        const sourceHasDistinctSnapshot = (acc: FusionAccount, sourceName: string): boolean => {
            const snapshots = acc.attributeBag.sources.get(sourceName) ?? []
            return snapshots.some((snapshot) => snapshot[distinctAttributeName] === distinctAttributeValue)
        }

        it('Stale previously correlated accounts are claim-only', () => {
            const acc = persistedFusion(['src-a::keep-1'])
            expect(acc.previousAccountIdsSet.has('src-a::keep-1')).toBe(true)
            expect(acc.attributeBag.current[distinctAttributeName]).toBeUndefined()

            const run = new FusionRun()
            run.setManagedAccount(
                'src-a::keep-1',
                queueManaged('src-a', 'keep-1', { modified: '2024-01-01T00:00:00.000Z' })
            )

            acc.addManagedAccountLayer(run)

            expect(acc.needsRefresh).toBe(false)
            expect(run.managedAccountsById.has('src-a::keep-1')).toBe(false)
            expect(sourceHasDistinctSnapshot(acc, 'Source A')).toBe(false)
            expect(run.getRetainedAccount('src-a::keep-1')?.attributes?.[distinctAttributeName]).toBe(
                distinctAttributeValue
            )
        })

        it('New blend materializes snapshots for the Fusion account', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-new-blend' } as any)
            const run = new FusionRun()
            run.setManagedAccount(
                'src-a::native-1',
                queueManaged('src-a', 'native-1', { modified: '2020-01-01T00:00:00.000Z' })
            )
            run.managedAccountsByIdentityId.set('id-new-blend', new Set(['src-a::native-1']))

            acc.addManagedAccountLayer(run)

            expect(acc.needsRefresh).toBe(true)
            expect(sourceHasDistinctSnapshot(acc, 'Source A')).toBe(true)
            expect(run.managedAccountsById.has('src-a::native-1')).toBe(false)
        })

        it('Over-threshold modified materializes all live linked accounts on the Fusion account', () => {
            const acc = persistedFusion(['src-a::keep-1', 'src-b::keep-2'])
            const run = new FusionRun()
            run.setManagedAccount(
                'src-a::keep-1',
                queueManaged('src-a', 'keep-1', {
                    modified: '2024-06-01T14:00:00.000Z',
                    attributes: { [distinctAttributeName]: distinctAttributeValue, sibling: 'a' },
                })
            )
            run.setManagedAccount(
                'src-b::keep-2',
                queueManaged('src-b', 'keep-2', {
                    modified: '2024-01-01T00:00:00.000Z',
                    attributes: { [distinctAttributeName]: distinctAttributeValue, sibling: 'b' },
                })
            )

            acc.addManagedAccountLayer(run)

            expect(acc.needsRefresh).toBe(true)
            expect(sourceHasDistinctSnapshot(acc, 'Source A')).toBe(true)
            expect(sourceHasDistinctSnapshot(acc, 'Source B')).toBe(true)
        })

        it('Prune-deleted requires materializing remaining live accounts', () => {
            const acc = persistedFusion(['src-a::keep-1'], {
                attributes: {
                    accounts: ['src-a::keep-1'],
                    'missing-accounts': ['src-a::gone-1'],
                    givenName: 'Already',
                },
            })
            const run = new FusionRun()
            run.setManagedAccount(
                'src-a::keep-1',
                queueManaged('src-a', 'keep-1', { modified: '2024-01-01T00:00:00.000Z' })
            )

            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(acc.needsRefresh).toBe(true)
            expect(acc.accountIds).not.toContain('src-a::gone-1')
            expect(sourceHasDistinctSnapshot(acc, 'Source A')).toBe(true)
            expect(run.managedAccountsById.has('src-a::keep-1')).toBe(false)
        })

        it('Force attribute refresh materializes before Map', () => {
            const acc = persistedFusion(['src-a::keep-1'])
            const run = new FusionRun()
            run.setManagedAccount(
                'src-a::keep-1',
                queueManaged('src-a', 'keep-1', { modified: '2024-01-01T00:00:00.000Z' })
            )

            acc.addManagedAccountLayer(run, { forceAttributeRefresh: true })

            expect(sourceHasDistinctSnapshot(acc, 'Source A')).toBe(true)
            expect(run.managedAccountsById.has('src-a::keep-1')).toBe(false)
        })

        it('Eligible Always recalculate materializes when timestamps are stale', () => {
            const acc = persistedFusion(['src-a::keep-1'])
            const run = new FusionRun()
            run.setManagedAccount(
                'src-a::keep-1',
                queueManaged('src-a', 'keep-1', { modified: '2024-01-01T00:00:00.000Z' })
            )

            acc.addManagedAccountLayer(run, { hasEligibleAlwaysRecalculate: true })

            expect(sourceHasDistinctSnapshot(acc, 'Source A')).toBe(true)
            expect(run.managedAccountsById.has('src-a::keep-1')).toBe(false)
        })

        const snapshotForKey = (acc: FusionAccount, key: string) => {
            for (const snapshots of acc.attributeBag.sources.values()) {
                for (const snapshot of snapshots) {
                    if (getManagedAccountSnapshotKey(snapshot) === key) return snapshot
                }
            }
            return undefined
        }

        it('Prior claim-only origin rematerializes when a new blend requires live sources', () => {
            const originKey = 'src-a::keep-1'
            const blendKey = 'src-a::blend-2'
            const acc = persistedFusion([originKey])
            const run = new FusionRun()
            run.setManagedAccount(
                originKey,
                queueManaged('src-a', 'keep-1', {
                    modified: '2024-01-01T00:00:00.000Z',
                    attributes: { [distinctAttributeName]: 'ORIGIN-BODY', givenName: 'Nadya' },
                })
            )
            acc.addManagedAccountLayer(run)
            expect(sourceHasDistinctSnapshot(acc, 'Source A')).toBe(false)
            expect(run.get(originKey)).toBeUndefined()

            acc.collections.accounts.add(blendKey)
            run.setManagedAccount(
                blendKey,
                queueManaged('src-a', 'blend-2', {
                    modified: '2024-06-01T14:00:00.000Z',
                    attributes: { [distinctAttributeName]: 'BLEND-BODY', givenName: 'Nadia' },
                })
            )
            acc.addManagedAccountLayer(run)

            expect(acc.needsRefresh).toBe(true)
            expect(snapshotForKey(acc, originKey)?.[distinctAttributeName]).toBe('ORIGIN-BODY')
            expect(snapshotForKey(acc, blendKey)?.[distinctAttributeName]).toBe('BLEND-BODY')
            expect(run.get(originKey)).toBeUndefined()
            const sourceA = acc.attributeBag.sources.get('Source A') ?? []
            expect(getManagedAccountSnapshotKey(sourceA[0])).toBe(originKey)
        })

        it('Authorized merge onto a claim-only-preprocessed Fusion account rematerializes linked keys', () => {
            const originKey = 'src-a::keep-1'
            const blendKey = 'src-b::blend-2'
            const acc = persistedFusion([originKey])
            const run = new FusionRun()
            run.setManagedAccount(originKey, queueManaged('src-a', 'keep-1', { modified: '2024-01-01T00:00:00.000Z' }))
            acc.addManagedAccountLayer(run)

            acc.collections.accounts.add(blendKey)
            run.setManagedAccount(blendKey, queueManaged('src-b', 'blend-2', { modified: '2024-06-01T14:00:00.000Z' }))
            acc.addManagedAccountLayer(run)

            expect(snapshotForKey(acc, originKey)?.[distinctAttributeName]).toBe(distinctAttributeValue)
            expect(snapshotForKey(acc, blendKey)?.[distinctAttributeName]).toBe(distinctAttributeValue)
        })

        it('Missing retention leaves only queue-backed snapshots', () => {
            const originKey = 'src-a::keep-1'
            const blendKey = 'src-a::blend-2'
            const acc = persistedFusion([originKey])
            acc.collections.accounts.add(blendKey)
            const run = new FusionRun()
            run.setManagedAccount(
                blendKey,
                queueManaged('src-a', 'blend-2', {
                    modified: '2024-06-01T14:00:00.000Z',
                    attributes: { [distinctAttributeName]: 'BLEND-ONLY' },
                })
            )
            acc.addManagedAccountLayer(run)

            expect(snapshotForKey(acc, blendKey)?.[distinctAttributeName]).toBe('BLEND-ONLY')
            expect(snapshotForKey(acc, originKey)).toBeUndefined()
        })

        it('New blend rematerializes a previously claim-only sibling from retention', () => {
            const keyA = 'src-a::keep-1'
            const keyB = 'src-b::blend-2'
            const acc = persistedFusion([keyA])
            const run = new FusionRun()
            run.setManagedAccount(keyA, queueManaged('src-a', 'keep-1', { modified: '2024-01-01T00:00:00.000Z' }))
            acc.addManagedAccountLayer(run)

            acc.collections.accounts.add(keyB)
            run.setManagedAccount(keyB, queueManaged('src-b', 'blend-2', { modified: '2024-06-01T14:00:00.000Z' }))
            acc.addManagedAccountLayer(run)

            expect(acc.needsRefresh).toBe(true)
            expect(snapshotForKey(acc, keyB)?.[distinctAttributeName]).toBe(distinctAttributeValue)
            expect(snapshotForKey(acc, keyA)?.[distinctAttributeName]).toBe(distinctAttributeValue)
        })
    })

    describe('foreign-owned previous/missing keys', () => {
        const managedAccount = (
            nativeIdentity: string,
            identityId?: string,
            attributes: Record<string, unknown> = {}
        ): Account =>
            ({
                id: `isc-${nativeIdentity}`,
                sourceId: 'src-a',
                nativeIdentity,
                sourceName: 'Source A',
                identityId,
                modified: '2024-01-01T00:00:00.000Z',
                attributes,
            }) as Account

        const persistedFusion = (
            accountKeys: string[],
            missingKeys: string[] = [],
            identityId?: string
        ): FusionAccount =>
            FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-target',
                id: 'isc-fusion-target',
                name: 'Target Fusion Account',
                sourceName: 'Identity Fusion NG',
                identityId,
                modified: '2024-06-01T12:00:00.000Z',
                attributes: {
                    accounts: accountKeys,
                    'missing-accounts': missingKeys,
                },
            } as unknown as Account)

        const registerFusionIdentity = (run: FusionRun, identityId: string): void => {
            run.registerFusionAccount(
                FusionAccount.fromIdentity({
                    id: identityId,
                    name: identityId,
                    attributes: {},
                } as IdentityDocument)
            )
        }

        it('drops a queue hit owned by another Fusion identity without claiming it', () => {
            const key = 'src-a::foreign-1'
            const acc = persistedFusion([key, 'src-b::remaining-1'], [key])
            const run = new FusionRun()
            registerFusionIdentity(run, 'owner-id')
            run.setManagedAccount(key, managedAccount('foreign-1', 'owner-id'))
            run.setManagedAccount('src-b::remaining-1', {
                ...managedAccount('remaining-1'),
                sourceId: 'src-b',
                sourceName: 'Source B',
            } as Account)

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).not.toContain(key)
            expect(acc.missingAccountIds).not.toContain(key)
            expect(acc.previousAccountIdsSet.has(key)).toBe(false)
            expect(acc.needsRefresh).toBe(true)
            expect(run.managedAccountsById.has(key)).toBe(true)
        })

        it('drops an already-claimed foreign-owned key despite inventory presence', () => {
            const key = 'src-a::foreign-2'
            const acc = persistedFusion([key], [key])
            const run = new FusionRun()
            registerFusionIdentity(run, 'owner-id')
            run.setManagedAccount(key, managedAccount('foreign-2', 'owner-id'))
            run.claimAccount(key, 'owner-id')

            acc.addManagedAccountLayer(run, { pruneDeleted: true })

            expect(run.managedAccountInventory.has(key)).toBe(true)
            expect(acc.accountIds).not.toContain(key)
            expect(acc.missingAccountIds).not.toContain(key)
            expect(acc.previousAccountIdsSet.has(key)).toBe(false)
            expect(acc.statuses).toContain('orphan')
            expect(acc.needsRefresh).toBe(false)
        })

        it('still absorbs an uncorrelated key listed on another Fusion identity', () => {
            const key = 'src-a::foreign-listed'
            const acc = persistedFusion([key, 'src-b::remaining-listed'])
            const run = new FusionRun()
            run.registerFusionAccount(
                FusionAccount.fromFusionAccount({
                    nativeIdentity: 'fusion-owner',
                    id: 'isc-fusion-owner',
                    name: 'Owner Fusion Identity',
                    sourceName: 'Identity Fusion NG',
                    identityId: 'owner-id',
                    attributes: { accounts: [key] },
                } as unknown as Account)
            )
            run.setManagedAccount(key, managedAccount('foreign-listed'))
            run.setManagedAccount('src-b::remaining-listed', {
                ...managedAccount('remaining-listed'),
                sourceId: 'src-b',
                sourceName: 'Source B',
            } as Account)

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain(key)
            expect(run.managedAccountsById.has(key)).toBe(false)
        })

        it('still absorbs an uncorrelated key with no other Fusion identity', () => {
            const key = 'src-a::unowned-1'
            const acc = persistedFusion([key])
            const run = new FusionRun()
            run.setManagedAccount(key, managedAccount('unowned-1', 'not-loaded'))

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain(key)
            expect(acc.missingAccountIds).toContain(key)
            expect(run.managedAccountsById.has(key)).toBe(false)
        })

        it('does not treat a NonMatched Fusion account as the owner by itself', () => {
            const key = 'src-a::nonmatched-1'
            const account = managedAccount('nonmatched-1')
            const acc = persistedFusion([key])
            const run = new FusionRun()
            run.registerFusionAccount(FusionAccount.fromManagedAccount(account))
            run.setManagedAccount(key, account)

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain(key)
            expect(acc.missingAccountIds).toContain(key)
            expect(run.managedAccountsById.has(key)).toBe(false)
        })

        it('keeps this Fusion identity identity-matched key', () => {
            const key = 'src-a::owned-1'
            const acc = persistedFusion([key], [], 'current-id')
            const run = new FusionRun()
            registerFusionIdentity(run, 'current-id')
            run.setManagedAccount(key, managedAccount('owned-1', 'current-id'))

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain(key)
            expect(acc.missingAccountIds).not.toContain(key)
            expect(run.managedAccountsById.has(key)).toBe(false)
        })

        it('keeps this Fusion identity identity-matched key when another identity still lists it', () => {
            const key = 'src-a::owned-shared'
            const acc = persistedFusion([key], [], 'current-id')
            const run = new FusionRun()
            registerFusionIdentity(run, 'current-id')
            run.registerFusionAccount(
                FusionAccount.fromFusionAccount({
                    nativeIdentity: 'fusion-stale',
                    id: 'isc-fusion-stale',
                    name: 'Stale Fusion Identity',
                    sourceName: 'Identity Fusion NG',
                    identityId: 'stale-id',
                    attributes: {
                        accounts: [key],
                        'missing-accounts': [key],
                    },
                } as unknown as Account)
            )
            run.setManagedAccount(key, managedAccount('owned-shared', 'current-id'))

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain(key)
            expect(acc.missingAccountIds).not.toContain(key)
            expect(run.managedAccountsById.has(key)).toBe(false)
        })

        it('still absorbs when another Fusion identity only lists the key as missing', () => {
            const key = 'src-a::unowned-missing-listed'
            const acc = persistedFusion([key])
            const run = new FusionRun()
            run.registerFusionAccount(
                FusionAccount.fromFusionAccount({
                    nativeIdentity: 'fusion-stale-missing',
                    id: 'isc-fusion-stale-missing',
                    name: 'Stale missing listing',
                    sourceName: 'Identity Fusion NG',
                    identityId: 'stale-id',
                    attributes: { 'missing-accounts': [key] },
                } as unknown as Account)
            )
            run.setManagedAccount(key, managedAccount('unowned-missing-listed'))

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).toContain(key)
            expect(run.managedAccountsById.has(key)).toBe(false)
        })

        it('Foreign-owned drop requires materializing remaining live accounts', () => {
            const foreignKey = 'src-a::foreign-3'
            const siblingKey = 'src-b::sibling-1'
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-target',
                id: 'isc-fusion-target',
                name: 'Target Fusion Account',
                sourceName: 'Identity Fusion NG',
                modified: '2024-06-01T12:00:00.000Z',
                attributes: {
                    accounts: [foreignKey, siblingKey],
                },
            } as unknown as Account)
            const run = new FusionRun()
            registerFusionIdentity(run, 'owner-id')
            run.setManagedAccount(foreignKey, managedAccount('foreign-3', 'owner-id'))
            run.setManagedAccount(siblingKey, {
                ...managedAccount('sibling-1', undefined, { siblingMarker: 'materialized' }),
                sourceId: 'src-b',
                sourceName: 'Source B',
            } as Account)

            acc.addManagedAccountLayer(run)

            expect(acc.accountIds).not.toContain(foreignKey)
            expect(run.managedAccountsById.has(foreignKey)).toBe(true)
            expect(acc.attributeBag.sources.get('Source B')).toEqual([
                expect.objectContaining({ siblingMarker: 'materialized' }),
            ])
            expect(run.managedAccountsById.has(siblingKey)).toBe(false)
        })
    })

    describe('attribute-bag setters', () => {
        it('addAccountId adds to correlated set and sync reflects it', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.accounts.add('src-a::native-1')
            acc.syncCollectionAttributesToBag()
            expect(acc.accountIds).toContain('src-a::native-1')
            expect(acc.attributes.accounts).toContain('src-a::native-1')
        })

        it('addMissingAccountId adds to missing set and sync reflects it', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.accounts.addMissing('src-a::missing-1')
            acc.syncCollectionAttributesToBag()
            expect(acc.missingAccountIds).toContain('src-a::missing-1')
            expect(acc.attributes['missing-accounts']).toContain('src-a::missing-1')
        })

        it('setCorrelatedAccount moves an id from missing to correlated', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)
            acc.collections.accounts.addMissing('src-a::native-1')
            acc.correlation.markCorrelated('src-a::native-1')
            acc.syncCollectionAttributesToBag()
            expect(acc.accountIds).toContain('src-a::native-1')
            expect(acc.missingAccountIds).not.toContain('src-a::native-1')
            expect(acc.attributes.accounts).toContain('src-a::native-1')
        })
    })

    describe('FusionAccount state encapsulation', () => {
        it('collections sub-object reflects account mutations', () => {
            const acc = FusionAccount.fromIdentity({ id: 'id-1' } as any)

            acc.collections.accounts.add('src-a::native-1')
            expect(acc.collections.accountIds.has('src-a::native-1')).toBe(true)
            expect(acc.accountIds).toContain('src-a::native-1')

            acc.collections.statuses.add('test-status')
            expect(acc.collections.statusesSet.has('test-status')).toBe(true)
            expect(acc.statuses).toContain('test-status')

            acc.correlation.markCorrelated('src-a::native-1')
            expect(acc.collections.accountIds.has('src-a::native-1')).toBe(true)
            expect(acc.collections.missingAccountIds.has('src-a::native-1')).toBe(false)
        })
    })

    describe('17. Composite-only account reference loading', () => {
        it('drops non-composite accounts values during fromFusionAccount', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    accounts: ['legacy-uuid-only', 'src-a::user-1'],
                },
            } as unknown as Account)
            expect(acc.previousAccountIdsSet.has('src-a::user-1')).toBe(true)
            expect(acc.previousAccountIdsSet.has('legacy-uuid-only')).toBe(false)
        })

        it('drops non-composite missing-accounts values during fromFusionAccount', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Account',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    'missing-accounts': ['legacy-uuid-only', 'src-a::missing-1'],
                },
            } as unknown as Account)
            expect(acc.missingAccountIds).toContain('src-a::missing-1')
            expect(acc.missingAccountIds).not.toContain('legacy-uuid-only')
        })

        it('retains identity ID originAccount for Identities origin', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    originSource: IDENTITIES_SOURCE_NAME,
                    originAccount: 'identity-uuid-123',
                },
            } as unknown as Account)
            expect(acc.originAccountId).toBe('identity-uuid-123')
        })

        it('retains originAccount from baseline-only persisted Fusion accounts without originSource', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-1',
                id: 'isc-1',
                name: 'Persisted Identity',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    originAccount: 'identity-baseline-only',
                    statuses: ['baseline'],
                },
            } as unknown as Account)
            expect(acc.fromIdentity).toBe(true)
            expect(acc.originAccountId).toBe('identity-baseline-only')
        })

        it('rejects raw originAccount for managed-source origin', () => {
            const acc = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-2',
                id: 'isc-2',
                name: 'Persisted Managed',
                sourceName: 'Identity Fusion NG',
                attributes: {
                    originSource: 'Workday',
                    originAccount: 'legacy-uuid-only',
                },
            } as unknown as Account)
            expect(acc.originAccountId).toBeUndefined()
        })
    })

    describe('identityAlias accessor', () => {
        it('returns identityInfo.name (login) when set', () => {
            const acc = FusionAccount.fromIdentity({
                id: 'id-1',
                name: 'login',
                displayName: 'Display Name',
                attributes: { displayName: 'Attr Display Name' },
            } as any)
            expect(acc.identityAlias).toBe('login')
        })

        it('returns undefined when identityInfo is not set', () => {
            const acc = FusionAccount.fromFusionDecision({
                account: {
                    id: 'src-a::native-1',
                    sourceId: 'src-a',
                    nativeIdentity: 'native-1',
                    sourceName: 'Source A',
                },
                newIdentity: true,
                submitter: { name: 'test' },
            } as any)
            expect(acc.identityAlias).toBeUndefined()
        })
    })

    describe('identityDisplayName accessor', () => {
        it('prefers attributes.displayName over top-level displayName and name', () => {
            const acc = FusionAccount.fromIdentity({
                id: 'id-1',
                name: 'login',
                displayName: 'Top Display Name',
                attributes: { displayName: 'Attr Display Name' },
            } as any)
            expect(acc.identityDisplayName).toBe('Attr Display Name')
        })

        it('falls back to top-level displayName then name', () => {
            const acc = FusionAccount.fromIdentity({
                id: 'id-1',
                name: 'login',
                displayName: 'Top Display Name',
                attributes: {},
            } as any)
            expect(acc.identityDisplayName).toBe('Top Display Name')

            const nameOnly = FusionAccount.fromIdentity({
                id: 'id-2',
                name: 'login-only',
                attributes: {},
            } as any)
            expect(nameOnly.identityDisplayName).toBe('login-only')
        })
    })
})

import { describe, it, expect } from 'vitest'
import { AccountV2025 as Account } from 'sailpoint-api-client'
import { FusionRun, RunStateSnapshot } from '../fusionRun'
import { AggregationTracker } from '../aggregationTracker'
import { ManagedAccountAnalysisRecording } from '../managedAccountAnalysisRecording'
import { SourceInfo } from '../../services/sourceService'
import { SourceType } from '../config'
import { FusionAccount } from '../account'
import { ManagedAccountAnalysisContext } from '../../services/matchingService/types'

describe('FusionRun', () => {
    it('initializes with empty maps and sets', () => {
        const run = new FusionRun()
        expect(run.managedAccountsById).toBeInstanceOf(Map)
        expect(run.managedAccountsById.size).toBe(0)
        expect(run.managedAccountsByIdentityId).toBeInstanceOf(Map)
        expect(run.managedAccountsByIdentityId.size).toBe(0)
        expect(run.fusionAccountMap).toBeInstanceOf(Map)
        expect(run.fusionAccountMap.size).toBe(0)
        expect(run.fusionIdentityMap).toBeInstanceOf(Map)
        expect(run.fusionIdentityMap.size).toBe(0)
        expect(run.identityMap).toBeInstanceOf(Map)
        expect(run.identityMap.size).toBe(0)
        expect(run.identitiesLoadedCount).toBe(0)
        expect(run.sourcesByName).toBeInstanceOf(Map)
        expect(run.sourcesByName.size).toBe(0)
        expect(run.autoMergedIdentityIds).toBeInstanceOf(Set)
        expect(run.autoMergedIdentityIds.size).toBe(0)
        expect(run.fusionIdentityDecisions.length).toBe(0)
        expect(run.fusionBlends).toEqual([])
        expect(run.matchScoringMs).toBe(0)
        expect(run.fullScanFallbackCount).toBe(0)
        expect(run.mandatoryMissingBlockCount).toBe(0)
        expect(run.identityComparisonCount).toBe(0)
        expect(run.identityCandidateSetSizeSum).toBe(0)
        expect(run.pendingDisableOperationsCount).toBe(0)
        expect(run.nameMatcherTokenCache).toBeInstanceOf(Map)
        expect(run.nameMatcherTokenCache.size).toBe(0)
        expect(run.nameMatcherPhoneticCache).toBeInstanceOf(Map)
        expect(run.nameMatcherPhoneticCache.size).toBe(0)
    })

    describe('identitiesLoadedCount', () => {
        it('tracks non-protected identities loaded and survives cache clear', () => {
            const run = new FusionRun()
            run.addIdentity('identity-1', { id: 'identity-1', protected: false } as any)
            run.addIdentity('identity-2', { id: 'identity-2', protected: false } as any)

            expect(run.identityCount).toBe(2)
            expect(run.identitiesLoadedCount).toBe(2)

            run.clearIdentities()

            expect(run.identityCount).toBe(0)
            expect(run.identitiesLoadedCount).toBe(2)
        })

        it('does not count protected identities toward identitiesLoadedCount', () => {
            const run = new FusionRun()
            run.addIdentity('protected-1', { id: 'protected-1', protected: true } as any)
            run.addIdentity('identity-1', { id: 'identity-1', protected: false } as any)

            expect(run.identityCount).toBe(2)
            expect(run.identitiesLoadedCount).toBe(1)
        })
    })

    describe('isRecordMode from config', () => {
        it('reads isRecordMode from config.recording.mode = "record"', () => {
            const run = new FusionRun(undefined, { recording: { mode: 'record' } } as any)
            expect(run.isRecordMode).toBe(true)
        })

        it('is false for config.recording.mode = "off"', () => {
            const run = new FusionRun(undefined, { recording: { mode: 'off' } } as any)
            expect(run.isRecordMode).toBe(false)
        })

        it('is false for config.recording.mode = "replay"', () => {
            const run = new FusionRun(undefined, { recording: { mode: 'replay' } } as any)
            expect(run.isRecordMode).toBe(false)
        })

        it('is false when config has no recording field', () => {
            const run = new FusionRun(undefined, {} as any)
            expect(run.isRecordMode).toBe(false)
        })

        it('is false when recording.mode resolved to off despite RECORD_MODE env var', () => {
            process.env.RECORD_MODE = 'true'
            const run = new FusionRun(undefined, { recording: { mode: 'off' } } as any)
            expect(run.isRecordMode).toBe(false)
            delete process.env.RECORD_MODE
        })
    })

    it('allows reading and writing managed accounts', () => {
        const run = new FusionRun()
        const account = { name: 'test', sourceName: 'SourceA', nativeIdentity: 'ni-1' }
        run.managedAccountsById.set('src-a::ni-1', account as any)
        expect(run.managedAccountsById.get('src-a::ni-1')).toBe(account)
    })

    it('tracks auto-assigned identity IDs', () => {
        const run = new FusionRun()
        run.markAutoMerged('id-1')
        run.markAutoMerged('id-2')
        expect(run.isAutoMerged('id-1')).toBe(true)
        expect(run.isAutoMerged('id-2')).toBe(true)
        expect(run.isAutoMerged('id-3')).toBe(false)
    })

    describe('simulated recording time', () => {
        it('setSimulatedTime, clearSimulatedTime, and currentTimeMs use ISO and epoch inputs', () => {
            const run = new FusionRun()
            const iso = '2026-07-31T08:24:12.899Z'
            const expectedMs = Date.parse(iso)

            run.setSimulatedTime(iso)
            expect(run.currentTimeMs()).toBe(expectedMs)

            run.setSimulatedTime(expectedMs)
            expect(run.currentTimeMs()).toBe(expectedMs)

            run.clearSimulatedTime()
            expect(run.currentTimeMs()).toBeGreaterThanOrEqual(expectedMs)
        })

        it('snapshot and restore round-trip simulatedTimeMs', () => {
            const run = new FusionRun()
            run.setSimulatedTime('2026-07-31T08:24:12.899Z')

            const snap = run.snapshot()
            expect(snap.simulatedTimeMs).toBe(Date.parse('2026-07-31T08:24:12.899Z'))

            run.clearSimulatedTime()
            expect(run.currentTimeMs()).not.toBe(snap.simulatedTimeMs)

            run.restore(snap)
            expect(run.currentTimeMs()).toBe(snap.simulatedTimeMs)
        })
    })

    it('fusionAccountsIterable yields registered accounts without copying the map', () => {
        const run = new FusionRun()
        const fa1 = { name: 'fa1', managedKey: 'k1' } as FusionAccount
        const fa2 = { name: 'fa2', managedKey: 'k2' } as FusionAccount
        run.registerFusionAccount(fa1)
        run.registerFusionAccount(fa2)

        expect([...run.fusionAccountsIterable()]).toEqual([fa1, fa2])

        const copied = run.allFusionAccounts
        copied.pop()
        expect(run.fusionAccountMap.size).toBe(2)
    })

    describe('registerFusionAccount duplicate handling', () => {
        beforeEach(() => {
            FusionAccount.configure({ sources: [] } as any)
        })

        const makeAccount = (nativeIdentity: string, identityId: string, name: string) =>
            FusionAccount.fromFusionAccount({
                nativeIdentity,
                identityId,
                name,
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)

        it('keeps the first account and skips a later duplicate when the Skip setting is enabled', () => {
            const run = new FusionRun(undefined, { skipDuplicateFusionAccounts: true } as any)
            run.setTracker(new AggregationTracker())

            const first = makeAccount('fusion-a', 'identity-dup', 'First')
            const duplicate = makeAccount('fusion-b', 'identity-dup', 'Duplicate')

            run.registerFusionAccount(first)
            run.registerFusionAccount(duplicate)

            expect(run.getFusionIdentity('identity-dup')).toBe(first)
            expect(run.fusionIdentityMap.size).toBe(1)
        })

        it('overwrites the existing account when the Skip setting is disabled', () => {
            const run = new FusionRun(undefined, { skipDuplicateFusionAccounts: false } as any)
            run.setTracker(new AggregationTracker())

            const first = makeAccount('fusion-a', 'identity-dup', 'First')
            const duplicate = makeAccount('fusion-b', 'identity-dup', 'Duplicate')

            run.registerFusionAccount(first)
            run.registerFusionAccount(duplicate)

            expect(run.getFusionIdentity('identity-dup')).toBe(duplicate)
            expect(run.fusionIdentityMap.size).toBe(1)
        })

        it('still updates in place when the same account key is refreshed', () => {
            const run = new FusionRun(undefined, { skipDuplicateFusionAccounts: true } as any)
            run.setTracker(new AggregationTracker())

            const original = makeAccount('fusion-a', 'identity-1', 'Original')
            const refreshed = makeAccount('fusion-a', 'identity-1', 'Refreshed')

            run.registerFusionAccount(original)
            run.registerFusionAccount(refreshed)

            expect(run.getFusionIdentity('identity-1')).toBe(refreshed)
            expect(run.fusionIdentityMap.size).toBe(1)
        })

        it('skips a duplicate even when no tracker or logger is attached', () => {
            const run = new FusionRun(undefined, { skipDuplicateFusionAccounts: true } as any)

            const first = makeAccount('fusion-a', 'identity-dup', 'First')
            const duplicate = makeAccount('fusion-b', 'identity-dup', 'Duplicate')

            run.registerFusionAccount(first)
            run.registerFusionAccount(duplicate)

            expect(run.getFusionIdentity('identity-dup')).toBe(first)
            expect(run.fusionIdentityMap.size).toBe(1)
        })
    })

    describe('disable operations', () => {
        it('queues and awaits pending disable operations', async () => {
            const run = new FusionRun()
            let fired = false
            const account = { name: 'acct', sourceName: 'src' } as Account
            run.setDisableOperationFactory(async () => {
                await new Promise<void>((resolve) => setTimeout(resolve, 10))
                fired = true
            })
            run.queueDisableOperation(account)
            expect(run.pendingDisableOperationsCount).toBe(1)
            await run.awaitPendingDisableOperations()
            expect(fired).toBe(true)
            expect(run.pendingDisableOperationsCount).toBe(0)
        })

        it('removes completed disable operations from the pending set', async () => {
            const run = new FusionRun()
            const account = { name: 'acct', sourceName: 'src' } as Account
            run.setDisableOperationFactory(async () => {})
            run.queueDisableOperation(account)
            await run.awaitPendingDisableOperations()
            expect(run.pendingDisableOperationsCount).toBe(0)
        })

        it('awaitPendingDisableOperations is safe when empty', async () => {
            const run = new FusionRun()
            await expect(run.awaitPendingDisableOperations()).resolves.toBeUndefined()
        })

        it('is a no-op when no factory is registered', () => {
            const run = new FusionRun()
            const account = { name: 'acct', sourceName: 'src' } as Account
            expect(() => run.queueDisableOperation(account)).not.toThrow()
            expect(run.pendingDisableOperationsCount).toBe(0)
        })
    })

    describe('removeMatchAccount', () => {
        it('removes a managed account from the run tracker', () => {
            const run = new FusionRun()
            const tracker = new AggregationTracker()
            const fusionAccount = { managedAccountId: 'managed-1' } as FusionAccount
            tracker.matchAccounts.push(fusionAccount)
            run.setTracker(tracker)

            run.removeMatchAccount('managed-1')
            expect(tracker.matchAccounts).toHaveLength(0)
        })

        it('is a no-op when no recorder is attached', () => {
            const run = new FusionRun()
            expect(() => run.removeMatchAccount('managed-1')).not.toThrow()
        })

        it('is a no-op for undefined ids', () => {
            const run = new FusionRun()
            run.setTracker(new AggregationTracker())
            expect(() => run.removeMatchAccount(undefined)).not.toThrow()
        })

        it('is a no-op when the id is not found', () => {
            const run = new FusionRun()
            const tracker = new AggregationTracker()
            tracker.matchAccounts.push({ managedAccountId: 'managed-1' } as FusionAccount)
            run.setTracker(tracker)

            run.removeMatchAccount('managed-2')
            expect(tracker.matchAccounts).toHaveLength(1)
        })
    })

    describe('trackFailed', () => {
        it('delegates to the analysis recorder', () => {
            const run = new FusionRun()
            const recorder = makeMockRecorder()
            run.analysisRecorder = recorder
            const fusionAccount = { name: 'fa', sourceName: 's' } as FusionAccount

            run.trackFailed(fusionAccount, 'something went wrong')
            expect(recorder.trackFailedCalls).toEqual([[fusionAccount, 'something went wrong']])
        })

        it('is a no-op when no recorder is attached', () => {
            const run = new FusionRun()
            expect(() => run.trackFailed({} as FusionAccount, 'oops')).not.toThrow()
        })
    })

    describe('recordAnalysis', () => {
        it('delegates to the analysis recorder', () => {
            const run = new FusionRun()
            const recorder = makeMockRecorder()
            run.analysisRecorder = recorder
            const analysis = {
                account: { name: 'acct', sourceName: 'Source A' } as Account,
                fusionAccount: { name: 'fa', sourceName: 'Source A' } as FusionAccount,
                sourceType: 'authoritative' as const,
                hasIdentityCandidateMatches: false,
                fusionIdentityComparisons: 0,
            }

            run.recordAnalysis(analysis)
            expect(recorder.recordAnalysisCalls).toEqual([analysis])
        })

        it('is a no-op when no recorder is attached', () => {
            const run = new FusionRun()
            expect(() =>
                run.recordAnalysis({
                    account: {} as Account,
                    fusionAccount: {} as FusionAccount,
                    sourceType: 'authoritative',
                    hasIdentityCandidateMatches: false,
                    fusionIdentityComparisons: 0,
                })
            ).not.toThrow()
        })
    })

    it('Inventory retains keys after work queue claim', () => {
        const run = new FusionRun()
        const account = {
            id: 'isc-1',
            sourceId: 'src-a',
            sourceName: 'Source A',
            nativeIdentity: 'native-1',
            name: 'Test User',
        } as any
        run.setManagedAccount('src-a::native-1', account)
        run.claimAccount('src-a::native-1')

        expect(run.hasManagedAccount('src-a::native-1')).toBe(true)
        expect(run.managedAccountsById.has('src-a::native-1')).toBe(false)
        expect(run.getManagedAccountInfo('src-a::native-1')?.name).toBe('Test User')
    })

    it('Claim moves attribute body into retention', () => {
        const run = new FusionRun()
        const account = {
            id: 'isc-1',
            sourceId: 'src-a',
            sourceName: 'Source A',
            nativeIdentity: 'native-1',
            name: 'Test User',
            attributes: { givenName: 'Nadya' },
        } as Account
        run.setManagedAccount('src-a::native-1', account)
        run.claimAccount('src-a::native-1')

        expect(run.get('src-a::native-1')).toBeUndefined()
        expect(run.getRetainedAccount('src-a::native-1')?.attributes?.givenName).toBe('Nadya')
    })

    it('Retention clears with managed account state', () => {
        const run = new FusionRun()
        const account = {
            id: 'isc-1',
            sourceId: 'src-a',
            sourceName: 'Source A',
            nativeIdentity: 'native-1',
            name: 'Test User',
            attributes: { givenName: 'Nadya' },
        } as Account
        run.setManagedAccount('src-a::native-1', account)
        run.claimAccount('src-a::native-1')
        run.clearManagedAccountState()

        expect(run.getRetainedAccount('src-a::native-1')).toBeUndefined()
        expect(run.get('src-a::native-1')).toBeUndefined()
        expect(run.hasManagedAccount('src-a::native-1')).toBe(false)
        expect(run.managedAccountInventory.size).toBe(0)
    })

    it('Output phase clears managed account state', () => {
        const run = new FusionRun()
        const account = {
            id: 'isc-1',
            sourceId: 'src-a',
            sourceName: 'Source A',
            nativeIdentity: 'native-1',
            name: 'Test User',
            attributes: { givenName: 'Nadya' },
        } as Account
        run.setManagedAccount('src-a::native-1', account)
        run.claimAccount('src-a::native-1')
        run.clearManagedAccountState()

        expect(run.get('src-a::native-1')).toBeUndefined()
        expect(run.hasManagedAccount('src-a::native-1')).toBe(false)
        expect(run.getRetainedAccount('src-a::native-1')).toBeUndefined()
    })

    it('Match does not consume retention as a work queue', () => {
        const run = new FusionRun()
        const account = {
            id: 'isc-1',
            sourceId: 'src-a',
            sourceName: 'Source A',
            nativeIdentity: 'native-1',
            identityId: 'identity-1',
            name: 'Test User',
            attributes: { givenName: 'Nadya' },
        } as Account
        run.setManagedAccount('src-a::native-1', account)
        run.claimAccount('src-a::native-1', 'identity-1')

        expect([...run.entries()].map(([key]) => key)).not.toContain('src-a::native-1')
        expect(run.get('src-a::native-1')).toBeUndefined()
        expect(run.getKeysForIdentity('identity-1')).toBeUndefined()
        expect(run.getRetainedAccount('src-a::native-1')).toBeDefined()
    })

    it('inventory retains identityId after setManagedAccount and claimAccount', () => {
        const run = new FusionRun()
        const account = {
            id: 'isc-1',
            sourceId: 'src-a',
            sourceName: 'Source A',
            nativeIdentity: 'native-1',
            identityId: 'identity-1',
            name: 'Test User',
        } as any
        run.setManagedAccount('src-a::native-1', account)
        run.claimAccount('src-a::native-1', 'identity-1')

        expect(run.getManagedAccountInfo('src-a::native-1')?.identityId).toBe('identity-1')
    })

    it('inventory retains isMachine for a machine account', () => {
        const run = new FusionRun()
        const account = {
            id: 'isc-machine',
            sourceId: 'src-a',
            sourceName: 'Source A',
            nativeIdentity: 'machine-1',
            name: 'Batch Bot',
            isMachine: true,
        } as any
        run.setManagedAccount('src-a::machine-1', account)
        run.claimAccount('src-a::machine-1')

        expect(run.getManagedAccountInfo('src-a::machine-1')?.isMachine).toBe(true)
    })

    it('snapshot includes identity-linked fusion accounts separately from managed-key map', () => {
        const run = new FusionRun()
        ;(run as any).fusionAccountMapValue.set('managed-key', { name: 'managed-fa', managedKey: 'managed-key' } as any)
        ;(run as any).fusionIdentityMapValue.set('identity-1', {
            name: 'identity-fa',
            identityId: 'identity-1',
        } as any)

        const snap = run.snapshot()
        expect(snap.fusionAccounts).toHaveLength(1)
        expect(snap.fusionIdentityAccounts).toHaveLength(1)
        expect(snap.fusionIdentityAccounts[0].identityId).toBe('identity-1')
    })

    it('restore repopulates fusion identity map from snapshot', () => {
        const run = new FusionRun()
        run.restore({
            managedAccounts: [],
            fusionAccounts: [],
            fusionIdentityAccounts: [{ identityId: 'identity-1', name: 'target' } as any],
            identities: [],
            fusionIdentityDecisions: [],
            finishedFusionDecisions: [],
            pendingCandidateIdentityIds: [],
            pendingReviewUrlsByReviewerId: {},
            pendingReviewUrlsByCandidateId: {},
            sourcesByName: {},
            currentRunNonMatchedKeysBySource: {},
            fusionBlends: [],
            autoMergedIds: [],
            matchScoringMs: 0,
            phaseTimings: [],
            managedAccountInventory: {},
            formCounters: {
                formsCreated: 0,
                formInstancesCreated: 0,
                formsFound: 0,
                formInstancesFound: 0,
                answeredFormInstancesProcessed: 0,
            },
            formDeleteQueue: { formsToDelete: [], queuedFormDeleteIds: [] },
            managedAccountProcessing: { state: 'idle', startedAt: 0, batchSize: 0 },
            trigramIndexBuilt: false,
        })

        expect((run as any).fusionIdentityMapValue.get('identity-1')?.name).toBe('target')
    })

    it('snapshot returns serializable state', () => {
        const run = new FusionRun()
        run.managedAccountsById.set('k1', { name: 'a1' } as any)
        ;(run as any).fusionAccountMapValue.set('k2', { name: 'fa1' } as any)
        run.matchScoringMs = 1500

        const snap = run.snapshot()
        expect(snap.managedAccounts).toHaveLength(1)
        expect(snap.fusionAccounts).toHaveLength(1)
        expect(snap.matchScoringMs).toBe(1500)
        expect(snap.autoMergedIds).toEqual([])
        expect(JSON.stringify(snap)).toBeTruthy()
    })

    it('snapshot captures auto-assigned IDs', () => {
        const run = new FusionRun()
        run.markAutoMerged('id-a')
        run.markAutoMerged('id-b')

        const snap = run.snapshot()
        expect(snap.autoMergedIds).toEqual(expect.arrayContaining(['id-a', 'id-b']))
    })

    it('snapshot captures form processing state', () => {
        const run = new FusionRun()
        ;(run as any).fusionIdentityDecisionsValue = [{ account: { id: 'a1', name: 'test', sourceName: 's1' } } as any]
        ;(run as any).pendingCandidateIdentityIdsValue = new Set(['candidate-1'])
        ;(run as any).pendingReviewUrlsByReviewerIdValue = new Map([['r1', ['url1']]])

        const snap = run.snapshot()
        expect(snap.fusionIdentityDecisions.length).toBe(1)
        expect(snap.pendingCandidateIdentityIds).toEqual(['candidate-1'])
        expect(snap.pendingReviewUrlsByReviewerId).toEqual({ r1: ['url1'] })
    })

    it('restore reconstructs state from snapshot', () => {
        const snapshot: RunStateSnapshot = {
            managedAccounts: [{ name: 'a1' }],
            fusionAccounts: [{ name: 'fa1' }],
            identities: [{ id: 'id1', name: 'Identity One' }],
            fusionIdentityDecisions: [],
            pendingCandidateIdentityIds: [],
            pendingReviewUrlsByReviewerId: {},
            pendingReviewUrlsByCandidateId: {},
            sourcesByName: {},
            currentRunNonMatchedKeysBySource: {},
            fusionBlends: [],
            autoMergedIds: ['id-a'],
            matchScoringMs: 2500,
            phaseTimings: [{ phase: 'Setup', elapsed: '1.2s' }],
        }

        const run = new FusionRun()
        run.restore(snapshot)

        expect(run.managedAccountsById.size).toBe(1)
        expect(run.fusionAccountMap.size).toBe(1)
        expect(run.identityMap.size).toBe(1)
        expect(run.matchScoringMs).toBe(2500)
        expect(run.autoMergedIdentityIds.has('id-a')).toBe(true)
        expect(run.phaseTimings).toEqual([{ phase: 'Setup', elapsed: '1.2s' }])
    })

    it('restore populates sourcesByName', () => {
        const sourceInfo: SourceInfo = {
            id: 'src-1',
            name: 'Source A',
            isManaged: true,
            sourceType: SourceType.Authoritative,
        }
        const snapshot: RunStateSnapshot = {
            managedAccounts: [],
            fusionAccounts: [],
            identities: [],
            fusionIdentityDecisions: [],
            pendingCandidateIdentityIds: [],
            pendingReviewUrlsByReviewerId: {},
            pendingReviewUrlsByCandidateId: {},
            sourcesByName: { 'Source A': sourceInfo as any },
            currentRunNonMatchedKeysBySource: {},
            fusionBlends: [],
            autoMergedIds: [],
            matchScoringMs: 0,
            phaseTimings: [],
        }

        const run = new FusionRun()
        run.restore(snapshot)

        expect(run.sourcesByName.get('Source A')).toEqual(sourceInfo)
    })
})

function makeMockRecorder(): ManagedAccountAnalysisRecording & {
    trackFailedCalls: [FusionAccount, string][]
    recordAnalysisCalls: ManagedAccountAnalysisContext[]
} {
    const recorder = {
        trackFailedCalls: [] as [FusionAccount, string][],
        recordAnalysisCalls: [] as ManagedAccountAnalysisContext[],
        recordAnalysis(analysis: ManagedAccountAnalysisContext) {
            recorder.recordAnalysisCalls.push(analysis)
        },
        trackFailed(fusionAccount: FusionAccount, message: string) {
            recorder.trackFailedCalls.push([fusionAccount, message])
        },
    }
    return recorder
}

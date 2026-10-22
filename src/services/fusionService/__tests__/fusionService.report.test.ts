import { createFusionServiceTestContext, type FusionServiceTestContext } from './fusionService.testFixtures'
import { FusionAccount } from '../../../model/account'
import { AggregationTracker } from '../aggregationTracker'
import { FusionConfig, SourceType } from '../../../model/config'
import { FusionRun } from '../../../model/fusionRun'
import { FusionService } from '../fusionService'
import { StandardCommand } from '@sailpoint/connector-sdk'
import { MatchCandidateType } from '../../matchingService/types'

describe('FusionService — report', () => {
    let ctx: FusionServiceTestContext

    beforeEach(() => {
        ctx = createFusionServiceTestContext()
    })

    describe('identity conflict warnings', () => {
        it('logs warning and includes identity conflict details in report', () => {
            const tracker = new AggregationTracker()
            ctx.fusionService.setTracker(tracker)
            const accountA = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-a',
                identityId: 'identity-duplicate',
                name: 'Fusion Account A',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)
            const accountB = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-b',
                identityId: 'identity-duplicate',
                name: 'Fusion Account B',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(accountA)
            ctx.fusionService.setFusionAccount(accountB)

            expect(ctx.mockLog.warn).toHaveBeenCalledWith(
                expect.stringContaining('More than one Fusion account was found for identity identity-duplicate')
            )

            const report = ctx.fusionService.generateReport(tracker)
            const conflictWarnings = report.warnings?.identityConflicts

            expect(conflictWarnings?.affectedIdentities).toBe(1)
            expect(conflictWarnings?.occurrences).toHaveLength(1)
            expect(conflictWarnings?.occurrences[0].identityId).toBe('identity-duplicate')
            expect(conflictWarnings?.occurrences[0].accountCount).toBe(2)
            expect(conflictWarnings?.occurrences[0].managedKeys).toEqual([`fusion-a`, `fusion-b`])
        })

        it('does not warn when the same correlated account key is updated', () => {
            const tracker = new AggregationTracker()
            ctx.fusionService.setTracker(tracker)
            const original = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-a',
                identityId: 'identity-1',
                name: 'Fusion Account A',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)
            const refreshed = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-a',
                identityId: 'identity-1',
                name: 'Fusion Account A Refreshed',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(original)
            ctx.fusionService.setFusionAccount(refreshed)

            expect(ctx.mockLog.warn).not.toHaveBeenCalled()

            const report = ctx.fusionService.generateReport(tracker)
            expect(report.warnings).toBeUndefined()
        })

        it('clears identity conflict warning payload after report generation', () => {
            const tracker = new AggregationTracker()
            ctx.fusionService.setTracker(tracker)
            const accountA = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-a',
                identityId: 'identity-duplicate',
                name: 'Fusion Account A',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)
            const accountB = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-b',
                identityId: 'identity-duplicate',
                name: 'Fusion Account B',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(accountA)
            ctx.fusionService.setFusionAccount(accountB)

            const firstReport = ctx.fusionService.generateReport(tracker)
            expect(firstReport.warnings?.identityConflicts?.affectedIdentities).toBe(1)

            const secondReport = ctx.fusionService.generateReport(tracker)
            expect(secondReport.warnings).toBeUndefined()
        })

        it('retains tracker state when clearTracker is false', () => {
            const tracker = new AggregationTracker()
            ctx.fusionService.setTracker(tracker)
            const accountA = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-a',
                identityId: 'identity-duplicate',
                name: 'Fusion Account A',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)
            const accountB = FusionAccount.fromFusionAccount({
                nativeIdentity: 'fusion-b',
                identityId: 'identity-duplicate',
                name: 'Fusion Account B',
                sourceName: 'Identity Fusion NG',
                uncorrelated: false,
                attributes: {},
            } as unknown as Account)

            ctx.fusionService.setFusionAccount(accountA)
            ctx.fusionService.setFusionAccount(accountB)

            const snapshotReport = ctx.fusionService.generateReport(tracker, true, undefined, { clearTracker: false })
            expect(snapshotReport.warnings?.identityConflicts?.affectedIdentities).toBe(1)

            const emailReport = ctx.fusionService.generateReport(tracker)
            expect(emailReport.warnings?.identityConflicts?.affectedIdentities).toBe(1)
        })
    })

    describe('initializeManagedAccountProcessing scoring prep', () => {
        async function initializeWithReportCaptureFlag(shouldCaptureReportData: boolean): Promise<FusionService> {
            const localRun = new FusionRun()
            localRun.log = ctx.mockLog
            Object.defineProperty(localRun, 'managedAccountsById', {
                get: () => new Map(),
                configurable: true,
            })

            ctx.mockMatchingService.buildTrigramIndex = vi.fn()
            const configureScoring = vi.fn()
            Object.assign(ctx.mockMatchingService, { configureScoring })

            const service = new FusionService({
                config: ctx.mockConfig,
                log: ctx.mockLog,
                identities: ctx.mockIdentities,
                sources: ctx.mockSources,
                forms: ctx.mockForms,
                mappingService: ctx.mockMappingService,
                definitionService: ctx.mockDefinitionService,
                matchingService: ctx.mockMatchingService,
                schemas: ctx.mockSchemas,
                run: localRun,
                commandType: StandardCommand.StdAccountList,
                shouldCaptureReportData,
            })
            service.setTracker(new AggregationTracker())

            await service.initializeManagedAccountProcessing()
            return service
        }

        it('does not call configureScoring when report capture is disabled', async () => {
            await initializeWithReportCaptureFlag(false)
            expect(
                (ctx.mockMatchingService as { configureScoring?: ReturnType<typeof vi.fn> }).configureScoring
            ).not.toHaveBeenCalled()
            expect(ctx.mockMatchingService.buildTrigramIndex).toHaveBeenCalled()
        })

        it('does not call configureScoring when report capture is enabled', async () => {
            await initializeWithReportCaptureFlag(true)
            expect(
                (ctx.mockMatchingService as { configureScoring?: ReturnType<typeof vi.fn> }).configureScoring
            ).not.toHaveBeenCalled()
            expect(ctx.mockMatchingService.buildTrigramIndex).toHaveBeenCalled()
        })

        it('does not call configureScoring when run is in record mode', async () => {
            const recordConfig = {
                recording: { mode: 'record' as const, chainName: 'test-chain', store: 'ndjson' as const },
            } as FusionConfig
            const localRun = new FusionRun(undefined, recordConfig)
            localRun.log = ctx.mockLog
            Object.defineProperty(localRun, 'managedAccountsById', {
                get: () => new Map(),
                configurable: true,
            })

            const configureScoring = vi.fn()
            ctx.mockMatchingService.buildTrigramIndex = vi.fn()
            Object.assign(ctx.mockMatchingService, { configureScoring })

            const service = new FusionService({
                config: ctx.mockConfig,
                log: ctx.mockLog,
                identities: ctx.mockIdentities,
                sources: ctx.mockSources,
                forms: ctx.mockForms,
                mappingService: ctx.mockMappingService,
                definitionService: ctx.mockDefinitionService,
                matchingService: ctx.mockMatchingService,
                schemas: ctx.mockSchemas,
                run: localRun,
                commandType: StandardCommand.StdAccountList,
                shouldCaptureReportData: false,
            })
            service.setTracker(new AggregationTracker())

            await service.initializeManagedAccountProcessing()
            expect(configureScoring).not.toHaveBeenCalled()
            expect(ctx.mockMatchingService.buildTrigramIndex).toHaveBeenCalled()
        })
    })

    describe('record-mode deferred match report capture', () => {
        it('populates deferredMatchReportData with score breakdowns via analysis recorder', () => {
            const recordConfig = {
                recording: { mode: 'record' as const, chainName: 'test-chain', store: 'ndjson' as const },
                fusionFormAttributes: [],
                baseurl: 'https://example.identitynow.com',
            } as FusionConfig
            const localRun = new FusionRun(undefined, recordConfig)
            localRun.log = ctx.mockLog
            localRun.sourcesByName.set('HR', {
                sourceType: SourceType.Authoritative,
                config: { deferredMatching: true },
            } as any)

            const service = new FusionService({
                config: ctx.mockConfig,
                log: ctx.mockLog,
                identities: ctx.mockIdentities,
                sources: ctx.mockSources,
                forms: ctx.mockForms,
                mappingService: ctx.mockMappingService,
                definitionService: ctx.mockDefinitionService,
                matchingService: ctx.mockMatchingService,
                schemas: ctx.mockSchemas,
                run: localRun,
                commandType: StandardCommand.StdAccountList,
                shouldCaptureReportData: false,
            })
            const tracker = new AggregationTracker()
            service.setTracker(tracker)

            const anchor = { managedKey: 'source-a-id::anchor', sourceName: 'HR', name: 'Jane' } as any
            localRun.registerFinalizedDeferredCandidate(anchor)

            const fusionAccount = {
                name: 'acct',
                sourceName: 'HR',
                isMatch: true,
                fusionMatches: [
                    {
                        candidateType: MatchCandidateType.Deferred,
                        identityName: 'Jane',
                        fusionIdentity: anchor,
                        scores: [{ attribute: 'email', score: 88, isMatch: true, algorithm: 'jaro-winkler' }],
                    },
                ],
            } as any

            localRun.recordAnalysis({
                account: { name: 'acct', sourceName: 'HR' } as any,
                fusionAccount,
                sourceInfo: undefined,
                sourceType: SourceType.Authoritative,
                hasIdentityCandidateMatches: false,
                fusionIdentityComparisons: 2,
            })

            expect(tracker.deferredMatchReportData).toHaveLength(1)
            expect(tracker.deferredMatchReportData[0].matches[0].scores?.[0].attribute).toBe('email')
            expect(tracker.deferredMatchReportData[0].matches[0].scores?.[0].score).toBe(88)
        })
    })
})

import { accountList } from '../accountList'
import { aggregationScenarios } from './fixtures/aggregationScenarios'
import { AggregationScenario } from './fixtures/scenarioTypes'
import { createOperationTestRegistry } from './harness/operationTestRegistry'
import type { Mock } from 'vitest'

function createMockRegistry(sourceConfigs: any[]) {
    const registry = createOperationTestRegistry({
        sourceConfigs,
    })
    const sources = registry.sources as any
    const schemas = registry.schemas as any
    const identities = registry.identities as any
    const fusion = registry.fusion as any
    return { registry, schemas, sources, identities, fusion }
}

function createTwoSweepRegistry(scenario: AggregationScenario) {
    const currentSweep = { value: 'sweep1' as 'sweep1' | 'sweep2' }
    const dataBySweep = scenario.sweepData
    const decisionHistory: string[][] = []

    const { registry, sources } = createMockRegistry(scenario.sourceConfigs)
    const forms = registry.forms
    const identities = registry.identities
    const fusion = registry.fusion
    const res = registry.res

    sources.getSourceByName.mockImplementation((sourceName: string) =>
        scenario.sourceConfigs.find((sc) => sc.name === sourceName)
    )

    sources.fetchManagedAccounts.mockImplementation(async () => {
        const sweepData = dataBySweep[currentSweep.value]
        const map = new Map<string, { id: string; sourceName: string }>()
        for (const account of sweepData.managedAccounts) {
            map.set(account.id, account)
        }
        sources.run.managedAccountsById = map
        for (const [key, account] of map.entries()) {
        sources.run.setManagedAccount(key, account)
    }
    })

    sources.fusionAccountCount = 2
    identities.fetchIdentities.mockImplementation(async () => {
        identities.identityCount = dataBySweep[currentSweep.value].identitiesFound
    })

    forms.processFetchedFormData.mockImplementation(async () => {
        decisionHistory.push([...dataBySweep[currentSweep.value].decisions])
    })

    fusion.forEachISCAccount.mockImplementation(async (sendFn: (account: unknown) => void | Promise<void>) => {
        const output = dataBySweep[currentSweep.value].outputAccounts
        for (const account of output) {
            await sendFn(account)
        }
        return { sent: output.length, eligible: output.length }
    })

    fusion.streamAndClearEligibleAccounts.mockImplementation(async () => {
        return { sent: 0, eligible: 0 }
    })

    return {
        registry,
        sources,
        forms,
        identities,
        fusion,
        res,
        decisionHistory,
        setSweep: (sweep: 'sweep1' | 'sweep2') => {
            currentSweep.value = sweep
        },
    }
}

describe('accountList setup phase', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('refreshes schema after reverse-correlation setup so new attributes are retained', async () => {
        const reverseSource = {
            name: 'HR Source',
            correlationMode: 'reverse' as const,
            correlationAttribute: 'hrNativeIdentity',
            correlationDisplayName: 'HR Native Identity',
        }
        const { registry, schemas, sources } = createMockRegistry([reverseSource])
        sources.setupReverseCorrelationSources = vi.fn().mockResolvedValue(1)
        const input = { schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(sources.clearReverseCorrelationReadinessCache).toHaveBeenCalledTimes(1)
        expect(sources.setupReverseCorrelationSources).toHaveBeenCalledTimes(1)
        expect(schemas.setFusionAccountSchema).toHaveBeenNthCalledWith(1, input.schema)
        expect(schemas.setFusionAccountSchema).toHaveBeenNthCalledWith(2, undefined)
    })

    it('does not reload schema when no reverse-correlation source is configured', async () => {
        const correlateSource = {
            name: 'IT Source',
            correlationMode: 'correlate' as const,
        }
        const { registry, schemas, sources } = createMockRegistry([correlateSource])
        const input = { schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(sources.clearReverseCorrelationReadinessCache).toHaveBeenCalledTimes(1)
        expect(sources.setupReverseCorrelationSources).toHaveBeenCalledTimes(1)
        expect(schemas.setFusionAccountSchema).toHaveBeenCalledTimes(1)
        expect(schemas.setFusionAccountSchema).toHaveBeenCalledWith(input.schema)
    })

    it('runs reverse-correlation setup sequentially across multiple sources', async () => {
        const reverseSources = [
            {
                name: 'Source A',
                correlationMode: 'reverse' as const,
                correlationAttribute: 'attrA',
                correlationDisplayName: 'Attr A',
            },
            {
                name: 'Source B',
                correlationMode: 'reverse' as const,
                correlationAttribute: 'attrB',
                correlationDisplayName: 'Attr B',
            },
        ]
        const { registry, sources } = createMockRegistry(reverseSources)
        const input = { schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(sources.setupReverseCorrelationSources).toHaveBeenCalledTimes(1)
    })

    it('passes global owner ids to fetchIdentities when fusionOwnerIsGlobalReviewer', async () => {
        const { registry, sources, identities, fusion } = createMockRegistry([])
        const input = { schema: { attributes: [] } } as any

        ;(fusion as any).fusionOwnerIsGlobalReviewer = true
        const globalOwnerIds = Array.from({ length: 61 }, (_, i) => `identity-${i + 1}`)
        ;(sources as any).fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue(globalOwnerIds)

        await accountList(registry, input)

        expect((sources as any).fetchGlobalOwnerIdentityIds).toHaveBeenCalledTimes(1)
        expect(identities.fetchIdentities).toHaveBeenCalledWith(globalOwnerIds)
    })

    it('passes global owner ids to fetchIdentities during dry-run when fusionOwnerIsGlobalReviewer', async () => {
        const { registry, sources, identities, fusion } = createMockRegistry([])
        const input = { dryRun: { enabled: true }, schema: { attributes: [] } } as any

        ;(fusion as any).fusionOwnerIsGlobalReviewer = true
        const globalOwnerIds = ['global-owner-1']
        ;(sources as any).fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue(globalOwnerIds)

        await accountList(registry, input)

        expect((sources as any).fetchGlobalOwnerIdentityIds).toHaveBeenCalledTimes(1)
        expect(identities.fetchIdentities).toHaveBeenCalledWith(globalOwnerIds)
    })

    it('schedules delayed aggregation via workflow callback path', async () => {
        const delayedSource = {
            name: 'HR Source',
            correlationMode: 'none' as const,
            aggregationMode: 'delayed' as const,
            aggregationDelay: 7,
            optimizedAggregation: false,
        }
        const { registry, sources } = createMockRegistry([delayedSource])
        const workflows = registry.workflows
        const input = { schema: { attributes: [] } } as any

        sources.managedSources = [
            {
                id: 'source-1',
                name: delayedSource.name,
                config: {
                    aggregationMode: delayedSource.aggregationMode,
                    aggregationDelay: delayedSource.aggregationDelay,
                    optimizedAggregation: delayedSource.optimizedAggregation,
                },
            },
        ] as any

        sources.aggregateDelayedSources.mockImplementation(async (schedule: any) => {
            await schedule({
                sourceId: 'source-1',
                delayMinutes: 7,
                disableOptimization: true,
            })
        })

        await accountList(registry, input)

        expect(workflows.fetchDelayedAggregationSender).toHaveBeenCalledTimes(1)
        expect(workflows.scheduleDelayedAggregation).toHaveBeenCalledWith({
            sourceId: 'source-1',
            delayMinutes: 7,
            disableOptimization: true,
        })
    })
})

describe('accountList two-sweep aggregation lifecycle', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it.each(aggregationScenarios)('$name', async (scenario) => {
        const { registry, sources, forms, fusion, res, decisionHistory, setSweep } = createTwoSweepRegistry(scenario)
        const input = { schema: { attributes: [] } } as any

        setSweep('sweep1')
        await accountList(registry, input)

        expect(forms.fetchFormInstances).toHaveBeenCalledTimes(1)
        expect(forms.processFetchedFormData).toHaveBeenCalledTimes(1)
        expect(fusion.processFusionIdentityDecisions).toHaveBeenCalledTimes(1)
        expect(sources.releaseProcessLock).toHaveBeenCalledTimes(1)
        expect(res.send).toHaveBeenCalledTimes(scenario.sweepData.sweep1.outputAccounts.length)
        ;(res.send as Mock).mockClear()
        setSweep('sweep2')
        await accountList(registry, input)

        expect(forms.fetchFormInstances).toHaveBeenCalledTimes(2)
        expect(forms.processFetchedFormData).toHaveBeenCalledTimes(2)
        expect(fusion.processFusionIdentityDecisions).toHaveBeenCalledTimes(2)
        expect(sources.releaseProcessLock).toHaveBeenCalledTimes(2)
        expect(decisionHistory).toEqual([scenario.sweepData.sweep1.decisions, scenario.sweepData.sweep2.decisions])
        expect(res.send).toHaveBeenCalledTimes(scenario.sweepData.sweep2.outputAccounts.length)
    })
})

describe('accountList dry-run mode', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('streams accounts and logs run summary to console when dryRun.enabled is true', async () => {
        const { registry, sources, fusion } = createMockRegistry([])
        const res = registry.res
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        const outputAccounts = [{ identity: 'acct-1' }, { identity: 'acct-2' }]
        fusion.forEachISCAccount.mockImplementation(async (sendFn: (account: unknown) => void | Promise<void>) => {
            for (const account of outputAccounts) {
                await sendFn(account)
            }
            return { sent: outputAccounts.length, eligible: outputAccounts.length }
        })
        const input = { dryRun: { enabled: true }, schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(sources.setProcessLock).not.toHaveBeenCalled()
        expect(sources.releaseProcessLock).not.toHaveBeenCalled()
        expect(fusion.forEachISCAccount).toHaveBeenCalledWith(expect.any(Function), true)
        expect(res.send).toHaveBeenCalledTimes(outputAccounts.length)
        expect(res.send).toHaveBeenCalledWith(outputAccounts[0])
        expect(res.send).toHaveBeenCalledWith(outputAccounts[1])
        expect(consoleSpy).toHaveBeenCalledWith(
            expect.stringContaining('"rowsSent": 2')
        )
        consoleSpy.mockRestore()
    })

    it('rejects dry-run when recording mode is active', async () => {
        const { registry } = createMockRegistry([])
        registry.config.recording = { mode: 'record' } as any
        const input = { dryRun: { enabled: true }, schema: { attributes: [] } } as any

        await expect(accountList(registry, input)).rejects.toThrow(
            'Dry-run mode cannot be combined with recording mode'
        )
    })

    it('rejects dry-run when replay mode is active', async () => {
        const { registry } = createMockRegistry([])
        registry.config.recording = { mode: 'replay' } as any
        const input = { dryRun: { enabled: true }, schema: { attributes: [] } } as any

        await expect(accountList(registry, input)).rejects.toThrow(
            'Dry-run mode cannot be combined with recording mode'
        )
    })

    it('skips summary-only options when dryRun.enabled is absent', async () => {
        const { registry, sources } = createMockRegistry([])
        const input = { dryRun: { saveFile: true }, schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(sources.setProcessLock).toHaveBeenCalledTimes(1)
        expect(sources.releaseProcessLock).toHaveBeenCalledTimes(1)
    })

    it('does not fetch the delayed-aggregation sender workflow in dry-run', async () => {
        const delayedSource = {
            name: 'HR Source',
            correlationMode: 'none' as const,
            aggregationMode: 'delayed' as const,
            aggregationDelay: 7,
            optimizedAggregation: false,
        }
        const { registry, sources } = createMockRegistry([delayedSource])
        const workflows = registry.workflows

        sources.managedSources = [
            {
                id: 'source-1',
                name: delayedSource.name,
                config: {
                    aggregationMode: delayedSource.aggregationMode,
                    aggregationDelay: delayedSource.aggregationDelay,
                    optimizedAggregation: delayedSource.optimizedAggregation,
                },
            },
        ] as any

        sources.aggregateDelayedSources.mockImplementation(async (schedule: any) => {
            await schedule({
                sourceId: 'source-1',
                delayMinutes: 7,
                disableOptimization: true,
            })
        })

        const input = { dryRun: { enabled: true }, schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(workflows.fetchDelayedAggregationSender).not.toHaveBeenCalled()
    })
})

describe('accountList report epilogue', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('emits the aggregation report and rethrows when res.send fails mid-stream', async () => {
        const { registry, sources, fusion } = createMockRegistry([{ name: 'fusion', correlationMode: 'none' }])
        fusion.fusionReportOnAggregation = true
        fusion.forEachISCAccount.mockImplementation(async (sendFn: (a: unknown) => void | Promise<void>) => {
            await sendFn({ id: 'a1' })
            return { sent: 1, eligible: 1 }
        })
        ;(registry.res.send as Mock).mockImplementation(() => {
            throw new Error('write after end')
        })

        await expect(accountList(registry, { schema: { attributes: [] } } as any)).rejects.toThrow(
            'write after end'
        )

        expect(registry.reports.generateAndSendFusionReport).toHaveBeenCalledTimes(1)
        expect(registry.definition.saveState).not.toHaveBeenCalled()
        expect(sources.saveBatchCumulativeCount).not.toHaveBeenCalled()
        expect(sources.releaseProcessLock).toHaveBeenCalledTimes(1)
    })

    it('persists definition state and batch cumulative counts on a successful persistent aggregation', async () => {
        const { registry, sources } = createMockRegistry([{ name: 'fusion', correlationMode: 'none' }])

        await accountList(registry, { schema: { attributes: [] } } as any)

        expect(registry.definition.saveState).toHaveBeenCalledTimes(1)
        expect(sources.saveBatchCumulativeCount).toHaveBeenCalledTimes(1)
    })

    it('writes dry-run report artifacts even when res.send fails mid-stream', async () => {
        const { registry, fusion } = createMockRegistry([{ name: 'fusion', correlationMode: 'none' }])
        const reports = registry.reports as any
        reports.generateDryRunReport = vi.fn().mockResolvedValue({ reportHtmlOutputPath: './reports/dry-run.html' })
        fusion.forEachISCAccount.mockImplementation(async (sendFn: (a: unknown) => void | Promise<void>) => {
            await sendFn({ id: 'a1' })
            return { sent: 1, eligible: 1 }
        })
        ;(registry.res.send as Mock).mockImplementation(() => {
            throw new Error('write after end')
        })
        const input = { dryRun: { enabled: true, saveFile: true }, schema: { attributes: [] } } as any

        await expect(accountList(registry, input)).rejects.toThrow('write after end')

        expect(reports.generateDryRunReport).toHaveBeenCalledTimes(1)
    })

    it('logs run summary to console even when dry-run report artifacts fail', async () => {
        const { registry } = createMockRegistry([{ name: 'fusion', correlationMode: 'none' }])
        const reports = registry.reports as any
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        reports.generateDryRunReport = vi.fn().mockRejectedValue(new Error('email down'))
        const input = { dryRun: { enabled: true, saveFile: true }, schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"rowsSent"'))
        consoleSpy.mockRestore()
    })

    it('logs run summary after report artifacts on a clean dry-run', async () => {
        const { registry } = createMockRegistry([{ name: 'fusion', correlationMode: 'none' }])
        const reports = registry.reports as any
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        reports.generateDryRunReport = vi.fn().mockResolvedValue({ reportHtmlOutputPath: './reports/dry-run.html' })
        const input = { dryRun: { enabled: true, saveFile: true }, schema: { attributes: [] } } as any

        await accountList(registry, input)

        expect(reports.generateDryRunReport.mock.invocationCallOrder[0]).toBeLessThan(consoleSpy.mock.invocationCallOrder[0])
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"reportHtmlOutputPath"'))
        consoleSpy.mockRestore()
    })

    it('delegates sendEmail string input to dry-run report delivery', async () => {
        const { registry } = createMockRegistry([{ name: 'fusion', correlationMode: 'none' }])
        const reports = registry.reports as any
        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
        reports.generateDryRunReport = vi.fn().mockResolvedValue({})
        const input = {
            dryRun: { enabled: true, sendEmail: 'reviewer@example.com' },
            schema: { attributes: [] },
        } as any

        await accountList(registry, input)

        expect(reports.generateDryRunReport).toHaveBeenCalledWith(
            expect.objectContaining({ sendEmail: ['reviewer@example.com'], saveFile: false })
        )
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('"sendEmail": true'))
        consoleSpy.mockRestore()
    })

    it('logs phase START, Epilogue labels, and no legacy heartbeats', async () => {
        const { registry } = createMockRegistry([{ name: 'fusion', correlationMode: 'none' }])
        const logSpy = vi.spyOn(registry.log, 'info')

        await accountList(registry, { schema: { attributes: [] } } as any)

        const messages = logSpy.mock.calls.map((call) => String(call[0]))
        expect(messages.some((msg) => msg.includes('PHASE 1 Setup START'))).toBe(true)
        expect(messages.some((msg) => msg.includes('PHASE 1 Setup END elapsed='))).toBe(true)
        expect(messages.some((msg) => msg.includes('EPILOGUE report START'))).toBe(true)
        expect(messages.some((msg) => msg.includes('EPILOGUE report END elapsed='))).toBe(true)
        expect(messages.some((msg) => msg.includes('Queue Stats:'))).toBe(false)
        expect(messages.some((msg) => msg.includes('Memory usage'))).toBe(false)
        expect(messages.some((msg) => /\bPHASE [1-5]:/.test(msg))).toBe(false)
        expect(messages.some((msg) => msg.startsWith('Epilogue: report generation'))).toBe(false)

        logSpy.mockRestore()
    })
})








import * as fs from 'fs'
import * as path from 'path'
import { SourceType } from '../../model/config'
import { ReportService } from '../reportService'

function loadStep23State() {
    const stepsPath = path.join(
        process.cwd(),
        'recordings/company12926-poc/fernando/steps.ndjson'
    )
    const line = fs
        .readFileSync(stepsPath, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .find((s) => s.stepId === 'step-23')
    if (!line?.stateAfter) throw new Error('step-23 stateAfter not found')
    return line.stateAfter as Record<string, any>
}

const RECORDING_DIR = path.join(process.cwd(), 'recordings/company12926-poc/fernando')

/** The recording fixtures are gitignored; skip the suite when they are absent locally. */
function isRecordingAvailable(): boolean {
    return fs.existsSync(path.join(RECORDING_DIR, 'steps.ndjson'))
}

describe.skipIf(!isRecordingAvailable())('ReportService recording: company12926-poc/fernando', () => {
    const reviewerId = '9d86f225e3a24b1a9e3d10d92ec12005'

    const createServiceFromRecording = (submitterNameOverride?: string) => {
        const state = loadStep23State()
        const identitiesList = (state.identities ?? []) as Array<Record<string, any>>
        const identityById = new Map(identitiesList.map((i) => [i.id, i]))
        const decisions = (state.fusionIdentityDecisions ?? []) as Array<Record<string, any>>
        const finishedFusionDecisions = decisions.map((d) => ({
            ...d,
            submitter: {
                ...d.submitter,
                name: submitterNameOverride ?? d.submitter?.name ?? '',
            },
        }))

        const identities = {
            getIdentityById: vi.fn((id?: string) => (id ? identityById.get(id) : undefined)),
            hydrateMissingIdentitiesById: vi.fn(async () => undefined),
        }

        const managedAccountInventory = new Map<string, any>(
            Object.entries(state.managedAccountInventory ?? {})
        )

        const service = new ReportService(
            'https://company12926-poc.identitynow-demo.com',
            { getAggregationIssueSummary: vi.fn(() => ({ warningCount: 0, errorCount: 0, warningSamples: [], errorSamples: [] })) } as any,
            {
                fusionAccountCount: 0,
                getSourceByNameSafe: vi.fn((name?: string) =>
                    name ? { sourceType: SourceType.Authoritative } : undefined
                ),
                resolveIscAccountIdForManagedKey: vi.fn((managedKey?: string) => {
                    const info = managedKey ? managedAccountInventory.get(managedKey) : undefined
                    const iscId = info?.id
                    if (iscId && iscId !== managedKey) return iscId
                    if (managedKey && !managedKey.includes('::')) return managedKey
                    return undefined
                }),
            } as any,
            identities as any,
            { finishedFusionDecisions } as any,
            { generateReport: vi.fn(), getFusionIdentity: vi.fn(), getFusionAccountByManagedKey: vi.fn() } as any,
            { sendEmail: vi.fn(), getRecipientEmails: vi.fn(), getDefaultEffectiveLocale: vi.fn(() => 'en') } as any,
            {
                getTracker: vi.fn(() => ({})),
                allFusionIdentities: [],
                managedAccountInventory,
                hasManagedAccount: (key: string) => managedAccountInventory.has(key),
                getManagedAccountInfo: (key: string) => managedAccountInventory.get(key),
            } as any
        )

        return { service, finishedFusionDecisions, identityById }
    }

    it('resolves reviewer display name from recording identity cache when submitter name is empty', () => {
        const { service } = createServiceFromRecording('')
        const decisions = service.buildFusionReviewDecisions()
        expect(decisions.length).toBeGreaterThan(0)
        expect(decisions[0].reviewerName).toBe('fernando.delosrios')
        expect(decisions[0].reviewerName).not.toBe(reviewerId)
    })

    it('resolves review decision account URL from recording managed account inventory', () => {
        const { service } = createServiceFromRecording(reviewerId)
        const decisions = service.buildFusionReviewDecisions()
        expect(decisions.length).toBeGreaterThan(0)
        expect(decisions[0].accountUrl).toBe(
            'https://company12926-poc.identitynow-demo.com/ui/a/admin/accounts-management/human-accounts/c80e2bca691944abbe9effbe0eaf086b'
        )
        expect(decisions[0].accountUrl).not.toContain('::')
    })

    it('resolves reviewer display name from recording identity cache when submitter name equals reviewer id', () => {
        const { service } = createServiceFromRecording(reviewerId)
        const decisions = service.buildFusionReviewDecisions()
        expect(decisions.length).toBeGreaterThan(0)
        expect(decisions[0].reviewerName).toBe('fernando.delosrios')
        expect(decisions[0].reviewerName).not.toBe(reviewerId)
    })
})


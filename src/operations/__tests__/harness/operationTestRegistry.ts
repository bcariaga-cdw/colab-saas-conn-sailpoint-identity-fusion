import { ServiceRegistry } from '../../../services/serviceRegistry'
import { createTestRegistry, TestRegistryOptions, SourceConfigLike } from './testRegistry'

export type { SourceConfigLike }

/**
 * Creates a test ServiceRegistry with commonly-mocked service methods for
 * operation-level tests that call the full pipeline (e.g., accountList).
 * All API-calling and stateful methods are stubbed as vi.fn() mocks so
 * assertions can verify they were called with expected arguments.
 */
export function createOperationTestRegistry(options: TestRegistryOptions = {}): ServiceRegistry {
    const registry = createTestRegistry(options)

    const log = registry.log as any
    log.crash = vi.fn()

    const sources = registry.sources as any
    sources.fetchAllSources = vi.fn().mockResolvedValue(undefined)
    sources.fetchFusionAccounts = vi.fn().mockResolvedValue(undefined)
    sources.fetchManagedAccounts = vi.fn().mockResolvedValue(undefined)
    sources.fetchFusionAccount = vi.fn().mockResolvedValue(undefined)
    sources.fetchManagedAccount = vi.fn().mockResolvedValue(undefined)
    sources.fetchGlobalOwnerIdentityIds = vi.fn().mockResolvedValue([])
    sources.aggregateManagedSources = vi.fn().mockResolvedValue(undefined)
    sources.aggregateDelayedSources = vi.fn().mockImplementation(async (callback?: (params: any) => Promise<void>) => {
        const delayedSources = sources.delayedAggregationSources || []
        for (const source of delayedSources) {
            if (typeof callback === 'function') {
                await callback({ sourceId: source.id, delayMinutes: source.delayMinutes || 5, disableOptimization: false })
            }
        }
    })
    sources.validateAccountJmespathFilters = vi.fn()
    sources.isEmailWorkflowConfigured = vi.fn().mockReturnValue(true)
    sources.setProcessLock = vi.fn().mockResolvedValue(undefined)
    sources.releaseProcessLock = vi.fn().mockResolvedValue(undefined)
    sources.removeProcessingAttribute = vi.fn().mockResolvedValue(undefined)
    sources.resetBatchCumulativeCount = vi.fn().mockResolvedValue(undefined)
    sources.saveBatchCumulativeCount = vi.fn().mockResolvedValue(undefined)
    sources.clearManagedAccounts = vi.fn()
    sources.clearFusionAccounts = vi.fn()
    sources.getSourceByName = vi.fn()
    sources.getSourceByNameSafe = vi.fn()
    sources.getSourceById = vi.fn()
    sources.getFusionSource = vi.fn()
    sources.clearReverseCorrelationReadinessCache = vi.fn()
    sources.ensureReverseCorrelationSetup = vi.fn().mockResolvedValue(undefined)
    sources.setupReverseCorrelationSources = vi.fn().mockResolvedValue(0)
    Object.defineProperty(sources, 'hasFusionSource', { value: true, writable: true, configurable: true })
    Object.defineProperty(sources, 'managedSources', { value: [], writable: true, configurable: true })
    Object.defineProperty(sources, 'fusionAccounts', { value: [], writable: true, configurable: true })
    Object.defineProperty(sources, 'fusionAccountCount', { value: 0, writable: true, configurable: true })
    Object.defineProperty(sources, 'fusionSourceOwner', { value: { id: 'fusion-owner' }, writable: true, configurable: true })
    Object.defineProperty(sources, 'managedAccountCount', { value: 0, writable: true, configurable: true })

    const schemas = registry.schemas as any
    schemas.setFusionAccountSchema = vi.fn().mockResolvedValue(undefined)
    schemas.loadFusionAccountSchemaFromSource = vi.fn().mockResolvedValue(undefined)
    schemas.getManagedSourceSchemaAttributeNames = vi.fn().mockResolvedValue(new Set<string>())
    Object.defineProperty(schemas, 'fusionDisplayAttribute', { value: 'name', writable: true, configurable: true })

    const identities = registry.identities as any
    identities.fetchIdentities = vi.fn().mockResolvedValue(undefined)
    identities.fetchIdentityByName = vi.fn().mockResolvedValue({ id: 'id-1', name: 'Test Identity' })
    identities.fetchIdentityById = vi.fn().mockResolvedValue(undefined)
    identities.getIdentityById = vi.fn()
    identities.clear = vi.fn()
    identities.getIdentities = vi.fn(() => [])
    Object.defineProperty(identities, 'identityCount', { value: 0, writable: true, configurable: true })

    const fusion = registry.fusion as any
    fusion.setTracker = vi.fn()
    fusion.getTracker = vi.fn()
    fusion.isResetAccounts = vi.fn().mockReturnValue(false)
    fusion.isResetForms = vi.fn().mockReturnValue(false)
    fusion.disableResetAccounts = vi.fn().mockResolvedValue(undefined)
    fusion.disableResetForms = vi.fn().mockResolvedValue(undefined)
    fusion.disableForceAttributeRefresh = vi.fn().mockResolvedValue(undefined)
    fusion.resetState = vi.fn().mockResolvedValue(undefined)
    fusion.preProcessFusionAccounts = vi.fn().mockResolvedValue([])
    fusion.processFusionAccounts = vi.fn().mockResolvedValue([])
    fusion.processFusionAccount = vi.fn().mockImplementation(async (account) => account)
    fusion.processIdentities = vi.fn().mockResolvedValue([])
    fusion.processIdentity = vi.fn().mockResolvedValue(undefined)
    fusion.processFusionIdentityDecisions = vi.fn().mockResolvedValue([])
    fusion.getFusionIdentity = vi.fn().mockReturnValue({ managedKey: 'fusion-id-1', collections: { statuses: { add: vi.fn() } } })
    fusion.getISCAccount = vi.fn().mockResolvedValue({ id: 'isc-1' })
    fusion.normalizePendingFormStateForOutput = vi.fn().mockResolvedValue(undefined)
    fusion.forEachISCAccount = vi.fn().mockResolvedValue({ sent: 0, eligible: 0 })
    fusion.streamAndClearEligibleAccounts = vi.fn().mockResolvedValue({ sent: 0, eligible: 0 })
    fusion.initializeManagedAccountProcessing = vi.fn().mockImplementation(async () => {
        fusion.run.startManagedAccountProcessing(1)
    })
    fusion.processRecordUniqueRegistration = vi.fn().mockResolvedValue({ registered: 0 })
    fusion.processCorrelatedManagedAccounts = vi.fn().mockResolvedValue(undefined)
    fusion.processUncorrelatedManagedAccounts = vi.fn().mockResolvedValue({ processed: 0, matchScoringMs: 0 })
    fusion.processManagedAccounts = vi.fn().mockResolvedValue(undefined)
    fusion.awaitPendingDisableOperations = vi.fn().mockResolvedValue(undefined)
    fusion.reconcilePendingFormState = vi.fn()
    fusion.correlateMissingAccountsPerSource = vi.fn().mockResolvedValue(undefined)
    fusion.analyzeUncorrelatedAccounts = vi.fn()

    const forms = registry.forms as any
    forms.deleteExistingForms = vi.fn().mockResolvedValue(undefined)
    forms.fetchFormData = vi.fn().mockResolvedValue(undefined)
    forms.fetchFormInstances = vi.fn().mockResolvedValue(undefined)
    forms.processFetchedFormData = vi.fn().mockResolvedValue(undefined)
    forms.cleanUpForms = vi.fn().mockResolvedValue(undefined)
    forms.awaitPendingDeleteOperations = vi.fn().mockResolvedValue(undefined)

    const definition = registry.definition as any
    definition.initializeCounters = vi.fn().mockResolvedValue(undefined)
    definition.registerUniqueValuesFromManagedSourceAccounts = vi.fn()
    definition.refreshUniqueAttributes = vi.fn().mockResolvedValue(undefined)
    definition.saveState = vi.fn().mockResolvedValue(undefined)

    const email = registry.email as any
    if (email) {
        email.sendEmail = vi.fn().mockResolvedValue(undefined)
        email.sendFusionEmail = vi.fn().mockResolvedValue(undefined)
        email.getRecipientEmails = vi.fn().mockResolvedValue([])
    }

    const workflows = registry.workflows as any
    if (workflows) {
        workflows.fetchSender = vi.fn().mockResolvedValue(undefined)
        workflows.fetchDelayedAggregationSender = vi.fn().mockResolvedValue(undefined)
        workflows.scheduleDelayedAggregation = vi.fn().mockResolvedValue(undefined)
        workflows.getWorkflow = vi.fn().mockResolvedValue({ id: 'wf-mock-1', name: 'Mock Workflow' })
        workflows.getDelayedAggregationWorkflow = vi.fn().mockResolvedValue({ id: 'wf-mock-delayed-1', name: 'Mock Delayed Workflow' })
        workflows.resolveAccessToken = vi.fn().mockResolvedValue('mock-token')
    }

    const reports = registry.reports as any
    if (reports) {
        reports.generateAndSendFusionReport = vi.fn().mockResolvedValue(undefined)
        reports.sendReportTo = vi.fn().mockResolvedValue(undefined)
        reports.deliverReportToRecipients = vi.fn().mockResolvedValue(undefined)
    }

    return registry
}





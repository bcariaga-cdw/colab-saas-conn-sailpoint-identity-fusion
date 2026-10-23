import { AsyncLocalStorage } from 'node:async_hooks'
import { Context, ConnectorError, ConnectorErrorType, Response, StandardCommand } from '@sailpoint/connector-sdk'
import { FusionConfig } from '../model/config'
import { LogService } from './logService'
import { HeartbeatSnapshot, countCorrelationQueuePending } from './logService/operationHeartbeat'
import { OperationRunContext } from './logService/operationRunContext'
import { InMemoryLockService } from './lockService'
import { ClientService, SdkApiAdapter, ApiQueue } from './clientService'
import { IscApiAdapter } from './clientService/iscApiAdapter'
import { RecordingApiAdapter, ApiLogEntry } from './clientService/recordingApiAdapter'
import { ReplayApiAdapter } from './clientService/replayApiAdapter'
import { recordingScenarioDirRelative } from '../data/recordingPaths'
import { loadRecordingApiLog } from './recordingService/recordingStore'
import { DryRunApiAdapter } from './clientService/dryRunApiAdapter'
import { SourceService } from './sourceService'
import { FusionService } from './fusionService'
import { IdentityService } from './identityService'
import { SchemaService } from './schemaService'
import { FormService } from './formService'
import { MappingService } from './mappingService'
import { DefinitionService } from './definitionService'
import { MatchingService } from './matchingService'
import { MatchOutcomeDispatcher } from './matchingService/matchOutcomeDispatcher'
import { EntitlementService } from './entitlementService'
import { EmailService } from './emailService'
import { WorkflowService } from './workflowService'
import { ProxyService } from './proxyService'
import { isProxyClientConfig } from '../utils/proxyRole'
import { ReportService } from './reportService'
import { RecordingService } from './recordingService'
import { FusionRun } from '../model/fusionRun'
import { internalConfig } from '../data/config'

/**
 * Central dependency injection container for all connector services.
 *
 * Instantiates and wires together all services in dependency order during construction.
 * Each service can be overridden via the SDK context (useful for testing). The active
 * registry for an in-flight operation is tracked via {@link AsyncLocalStorage} so that
 * deeply-nested code can access services without prop-drilling while still being
 * isolated per concurrent operation.
 */
export class ServiceRegistry {
    private static readonly storage = new AsyncLocalStorage<ServiceRegistry>()
    public log: LogService
    public locks: InMemoryLockService
    public client: ClientService
    public sources: SourceService
    public fusion: FusionService
    public identities: IdentityService
    public schemas: SchemaService
    public forms: FormService
    public entitlements: EntitlementService
    public mapping: MappingService
    public definition: DefinitionService
    public matching: MatchingService
    public email: EmailService
    public workflows: WorkflowService
    public reports: ReportService
    public proxy: ProxyService
    public recording?: RecordingService
    public matchOutcomeDispatcher: MatchOutcomeDispatcher
    public run: FusionRun
    public runContext: OperationRunContext
    private readonly clientUsesInjection: boolean

    /**
     * Creates a new ServiceRegistry, initializing all services in dependency order.
     * Services provided via `context` override the default implementations.
     *
     * @param config - The resolved fusion configuration
     * @param context - SDK context, optionally providing pre-built service overrides
     * @param res - SDK response object for sending results back to the platform
     * @param operationContext - Optional operation name for log attribution (e.g. "accountList")
     */
    constructor(
        public config: FusionConfig,
        context: Context,
        public res: Response<any>,
        operationContext?: string
    ) {
        // Initialize core services first
        const logConfig = operationContext ? { ...config, operationContext } : config
        this.log = context.logService ?? new LogService(logConfig)
        this.runContext = new OperationRunContext()
        if (operationContext === 'accountList') {
            this.runContext.excludeCorrelatedActionInSummaries = true
        }
        this.log.bindRunContext(this.runContext)
        this.run = new FusionRun(this.log, this.config)
        this.locks = context.lockService ?? new InMemoryLockService(this.log)
        this.clientUsesInjection = !!context.connectionService

        if (context.connectionService) {
            this.client = context.connectionService
            this.log.setQueue(this.client.getQueue())
        } else {
            const recMode = this.config.recording?.mode ?? 'off'
            const skipLocalRecording = isProxyClientConfig(this.config)
            let adapter: IscApiAdapter = new SdkApiAdapter(this.config, this.log)

            if (recMode === 'record' && !skipLocalRecording) {
                const recording = (context as any).recordingService ?? new RecordingService(this.log, this.config)
                this.recording = recording
                adapter = new RecordingApiAdapter(
                    adapter,
                    (entry: ApiLogEntry) => {
                        recording.onApiCall(entry)
                    },
                    (message: string) => {
                        this.log.warn(message)
                    }
                )
                const rec = this.config.recording
                this.log.info(
                    `Recording enabled — chain: ${recording.getName()}, dir: ${recording.getRecordingDir()}, store: ${rec?.store ?? 'ndjson'}`
                )
                this.bindRecordingHooks()
            } else if (recMode === 'replay' && !skipLocalRecording) {
                this.log.info('Replay mode active — no live ISC API calls permitted')
                const scenarioName = this.config.recording?.scenarioName ?? this.config.recording?.chainName
                const scenarioDir = scenarioName
                    ? recordingScenarioDirRelative(scenarioName, this.config.baseurl)
                    : undefined
                const entries = scenarioDir ? loadRecordingApiLog(scenarioDir, this.config.baseurl) : []
                adapter = new ReplayApiAdapter(entries, adapter.config)
            }

            const requestsPerSecond = this.config.requestsPerSecond ?? this.config.requestsPerSecondConstant
            const queueConfig = {
                requestsPerSecond,
                maxConcurrentRequests: this.config.maxConcurrentRequests ?? 20,
                maxRetries: this.config.maxRetries ?? this.config.retriesConstant,
                enablePriority: this.config.enablePriority ?? true,
                rateLimitWindowMs: internalConfig.clientService.rateLimitWindowMs,
            }
            const queue = new ApiQueue(queueConfig)
            this.client = new ClientService(adapter, queue, this.config, this.log)
            this.log.setQueue(queue)

            if (recMode === 'replay' && !skipLocalRecording && !(adapter instanceof ReplayApiAdapter)) {
                throw new ConnectorError(
                    'Replay mode requires ReplayApiAdapter — live SdkApiAdapter wiring is not permitted',
                    ConnectorErrorType.Generic
                )
            }
        }

        // Initialize services that don't depend on others
        this.sources = context.sourceService ?? new SourceService(this.config, this.log, this.client, this.run)
        this.entitlements = context.entitlementService ?? new EntitlementService(this.sources)
        this.identities =
            context.identityService ?? new IdentityService(this.config, this.log, this.client, this.sources, this.run)
        this.workflows =
            (context as any).workflowService ?? new WorkflowService(this.config, this.log, this.client, this.sources)
        this.email =
            (context as any).emailService ??
            new EmailService(this.config, this.log, this.client, this.sources, this.identities, this.workflows)
        this.forms =
            context.formService ??
            new FormService(this.config, this.log, this.client, this.sources, this.identities, this.email, this.run)

        // Initialize services that depend on others (in dependency order)
        this.schemas = context.schemaService ?? new SchemaService(this.config, this.log, this.sources, this.identities)
        const commandType = context.commandType as StandardCommand | undefined

        // Initialize new services (Tasks 6-8)
        this.mapping = context.mappingService ?? new MappingService(this.config, this.log)
        this.definition =
            context.definitionService ??
            new DefinitionService(this.config, this.schemas, this.log, this.locks, this.sources)
        this.matching =
            context.matchingService ??
            new MatchingService(this.config, this.log, this.run)

        // Initialize FusionService last (depends on multiple services)
        this.fusion =
            context.fusionService ??
            new FusionService({
                config: this.config,
                log: this.log,
                identities: this.identities,
                sources: this.sources,
                forms: this.forms,
                mappingService: this.mapping,
                definitionService: this.definition,
                matchingService: this.matching,
                schemas: this.schemas,
                run: this.run,
                commandType,
                shouldCaptureReportData: operationContext === 'custom:dryrun',
                isAggregationMode: operationContext === 'accountList',
            })

        // Wire the MatchOutcomeDispatcher through the registry using real collaborators already
        // owned by FusionService. This keeps the dispatcher free of closures over FusionService.
        this.matchOutcomeDispatcher = new MatchOutcomeDispatcher({
            config: this.config,
            log: this.log,
            run: this.run,
            matchingService: this.matching,
            definitionService: this.definition,
            mappingService: this.mapping,
            accountAssembly: this.fusion.accountAssembly,
            forms: this.forms,
            decisionProcessor: this.fusion.decisionProcessor,
            commandType,
        })
        this.fusion.matchOutcomeDispatcher = this.matchOutcomeDispatcher

        this.reports =
            (context as any).reportService ??
            new ReportService(
                this.config.baseurl,
                this.log,
                this.sources,
                this.identities,
                this.forms,
                this.fusion,
                this.email,
                this.run
            )

        this.proxy = context.proxyService ?? new ProxyService(this.config, this.log, this.res, commandType)
    }

    /** Wires LogService phase hooks to the active recording service. */
    private bindRecordingHooks(): void {
        if (!this.recording) return

        this.log.setPhaseRecordingHook((phaseNumber, phase, detail, elapsedMs) => {
            const run = this.run
            this.recording?.recordPhaseEnd({
                phaseNumber,
                phase,
                detail,
                elapsedMs,
                timestamp: new Date().toISOString(),
                managedAccounts: run.managedAccountsById.size,
                fusionAccounts: run.fusionAccountMap.size,
                apiCalls: this.recording?.getStore().getApiLogEntryCount(),
            })
        })
    }

    /**
     * Wraps the live client adapter with {@link DryRunApiAdapter} to inhibit tenant writes.
     * Must be called after parsing dry-run input and before any account-list phase API calls.
     */
    activateDryRunMode(): void {
        this.run.isDryRunMode = true
        if (this.clientUsesInjection) {
            return
        }
        this.client.wrapAdapter((inner) => new DryRunApiAdapter(inner))
        this.log.info('DryRunApiAdapter enabled — ISC write calls inhibited for this run')
    }

    /**
     * Runs a callback with `reg` bound as the active registry for the duration of the
     * async call tree. Nested service accessors (e.g. via {@link getCurrent}) read
     * the registry from the current `AsyncLocalStorage` context, so concurrent
     * operations each see their own registry without cross-contamination.
     *
     * The callback is invoked with no arguments and is expected to perform async
     * work; any value (including `undefined`) it resolves to is returned to the
     * caller.
     *
     * @param reg - The registry instance to make active
     * @param callback - Async work that may read the active registry
     * @returns The result of `callback`
     */
    static run<T>(reg: ServiceRegistry, callback: () => Promise<T>): Promise<T> {
        return this.storage.run(reg, callback)
    }

    /**
     * Retrieves the active registry singleton from the current `AsyncLocalStorage`
     * context. Replaces the previous process-global `static current` to make the
     * registry request-scoped.
     *
     * @returns The current ServiceRegistry instance
     * @throws {ConnectorError} If no registry is bound in the current context
     */
    static getCurrent(): ServiceRegistry {
        const reg = this.storage.getStore()
        if (!reg) {
            throw new ConnectorError('ServiceRegistry not found', ConnectorErrorType.Generic)
        }
        return reg
    }

    /** Snapshot for the operation heartbeat (queue, memory, run context). */
    getHeartbeatSnapshot(): HeartbeatSnapshot {
        const queueItems = this.client.getQueueItems()
        const run = this.run

        return {
            runContext: this.runContext,
            queueStats: this.client.getQueueStats(),
            activeItems: queueItems.active,
            pendingItems: queueItems.pending,
            correlationQueuePending: countCorrelationQueuePending(queueItems.pending),
            fusionPending: {
                fusionReviewsFound: run.formsFound,
                fusionReviewInstancesFound: run.formInstancesFound,
                formsCreated: run.formsCreated,
                formInstancesCreated: run.formInstancesCreated,
            },
            memory: process.memoryUsage(),
            cpu: process.cpuUsage(),
            intervalMs: this.config.statsLoggingIntervalMs,
        }
    }

    /**
     * Flushes pending logs for the active registry, if any. Retained for backward
     * compatibility with callers that previously invoked `clear()` to drop the
     * process-global reference. With `AsyncLocalStorage`, context cleanup is handled
     * by the call tree boundary established via {@link run}.
     */
    static clear() {
        void this.storage.getStore()?.log?.flush()
    }
}




















import { Context, ConnectorError, ConnectorErrorType, Response, StandardCommand } from '@sailpoint/connector-sdk'
import { FusionConfig } from '../model/config'
import { LogService } from './logService'
import { InMemoryLockService, LockService } from './lockService'
import { ClientService } from './clientService'
import { SourceService } from './sourceService'
import { FusionService } from './fusionService'
import { IdentityService } from './identityService'
import { SchemaService } from './schemaService'
import { FormService } from './formService'
import { AttributeService } from './attributeService'
import { EntitlementService } from './entitlementService'
import { ScoringService } from './scoringService'
import { MessagingService } from './messagingService'
import { ProxyService } from './proxyService'
import { ReportService } from './reportService'
import { CustomizerService } from './customizerService'

/**
 * Central dependency injection container for all connector services.
 *
 * Instantiates and wires together all services in dependency order during construction.
 * Each service can be overridden via the SDK context (useful for testing). A static
 * singleton reference tracks the "current" registry for the active operation so that
 * deeply-nested code can access services without prop-drilling.
 */
export class ServiceRegistry {
    private static current?: ServiceRegistry
    public log: LogService
    public locks: LockService
    public client: ClientService
    public sources: SourceService
    public fusion: FusionService
    public identities: IdentityService
    public schemas: SchemaService
    public forms: FormService
    public attributes: AttributeService
    public entitlements: EntitlementService
    public scoring: ScoringService
    public messaging: MessagingService
    public reports: ReportService
    public proxy: ProxyService
    public customizer: CustomizerService

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
        this.locks = context.lockService ?? new InMemoryLockService(this.log)
        // Retains the SDK context: `customizedOperation` is injected onto it by the ISC runtime
        // when a customizer is attached, and is otherwise absent.
        this.customizer = context.customizerService ?? new CustomizerService(context, this.log)
        this.client = context.connectionService ?? new ClientService(this.config, this.log)
        this.log.setQueue(this.client.getQueue())

        // Initialize services that don't depend on others
        this.sources = context.sourceService ?? new SourceService(this.config, this.log, this.client)
        this.entitlements = context.entitlementService ?? new EntitlementService(this.sources)
        this.scoring = context.scoringService ?? new ScoringService(this.config, this.log)
        this.identities =
            context.identityService ?? new IdentityService(this.config, this.log, this.client, this.sources)
        this.messaging =
            context.messagingService ??
            new MessagingService(this.config, this.log, this.client, this.sources, this.identities)
        this.forms =
            context.formService ??
            new FormService(this.config, this.log, this.client, this.sources, this.identities, this.messaging)

        // Initialize services that depend on others (in dependency order)
        this.schemas = context.schemaService ?? new SchemaService(this.config, this.log, this.sources, this.identities)
        const commandType = context.commandType as StandardCommand | undefined
        this.attributes =
            context.attributesService ??
            new AttributeService(
                this.config,
                this.schemas,
                this.sources,
                this.log,
                this.locks,
                commandType,
                this.customizer
            )

        // Initialize FusionService last (depends on multiple services)
        this.fusion =
            context.fusionService ??
            new FusionService(
                this.config,
                this.log,
                this.identities,
                this.sources,
                this.forms,
                this.attributes,
                this.scoring,
                this.schemas,
                commandType,
                operationContext
            )

        this.reports = new ReportService(
            this.config.baseurl,
            this.log,
            this.sources,
            this.identities,
            this.forms,
            this.fusion,
            this.messaging
        )

        this.proxy = context.proxyService ?? new ProxyService(this.config, this.log, this.res, commandType)
    }

    /**
     * Sets the active registry singleton for the current operation.
     * Called at the start of every operation handler.
     *
     * @param reg - The registry instance to make globally accessible
     */
    static setCurrent(reg: ServiceRegistry) {
        this.current = reg
    }

    /**
     * Retrieves the active registry singleton.
     *
     * @returns The current ServiceRegistry instance
     * @throws {ConnectorError} If no registry has been set via {@link setCurrent}
     */
    static getCurrent(): ServiceRegistry {
        if (!this.current) {
            throw new ConnectorError('ServiceRegistry not found', ConnectorErrorType.Generic)
        }
        return this.current!
    }

    /**
     * Flushes pending logs and clears the active registry singleton, releasing all service references.
     */
    static clear() {
        void this.current?.log?.flush()
        this.current = undefined
    }
}

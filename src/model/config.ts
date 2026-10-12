/** Base connector configuration provided by the ISC platform. */
export interface BaseConfig {
    beforeProvisioningRule: string | null
    cloudCacheUpdate: number
    cloudDisplayName: string
    cloudExternalId: string
    commandType: string
    connectionType: string
    connectorName: string
    deleteThresholdPercentage: number
    deleteEmpty: boolean
    formPath: string | null
    healthy: boolean
    idnProxyType: string
    invocationId: string
    since: string
    sourceDescription: string
    spConnectorInstanceId: string
    spConnectorSpecId: string
    spConnectorSupportsCustomSchemas: boolean
    status: string
    templateApplication: string
    version: number
    spConnDebugLoggingEnabled: boolean
}

export enum AttributeMergeMode {
    MainAccount = 'mainAccount',
    OriginAccount = 'originAccount',
    First = 'first',
    List = 'list',
    Concatenate = 'concatenate',
    Source = 'source',
}

export type DefaultAttributeMergeMode =
    | AttributeMergeMode.MainAccount
    | AttributeMergeMode.OriginAccount
    | AttributeMergeMode.First
    | AttributeMergeMode.List
    | AttributeMergeMode.Concatenate

/**
 * Configuration for mapping one or more source attributes into a single fusion attribute.
 * Controls how values are merged when multiple source accounts contribute the same attribute.
 */
export interface AttributeMap {
    /** The target fusion attribute name to create */
    newAttribute: string
    /** Source attribute names to read values from */
    existingAttributes: string[]
    /** Strategy for merging values from an account snapshot, source order, all sources, or a named source */
    attributeMerge?: AttributeMergeMode
    /** Specific source for "source" merge; "$originSource" resolves to the prioritized account's source name */
    source?: string
}

/**
 * Configuration for a normal (non-unique) generated attribute.
 * Value is computed via a Velocity template expression on every aggregation when refresh is enabled.
 */
export interface NormalAttributeDefinition {
    /** The target attribute name */
    name: string
    /** Apache Velocity template expression for value generation */
    expression: string
    /** Case transformation to apply after generation */
    case?: 'same' | 'lower' | 'upper' | 'capitalize'
    /** Maximum character length for generated values */
    maxLength?: number
    /** Whether to normalize (transliterate) the generated value */
    normalize: boolean
    /** Whether to remove spaces from the generated value */
    spaces: boolean
    /** Whether to trim whitespace from the generated value */
    trim: boolean
    /** Whether to regenerate this attribute on every aggregation */
    refresh: boolean
    /** Whether this attribute evaluates only when it has no value */
    static?: boolean
}

/**
 * Configuration for a unique generated attribute.
 * Value must be unique across all accounts. Supports `$UUID` in the expression
 * (auto-generates a v4 UUID injected into the Velocity context) and an optional
 * incremental counter for sequential numbering or collision disambiguation.
 *
 * Unique expressions also receive `$isUnique(value)`, which returns whether `value`
 * (after the same trim/case/spaces/normalize/maxLength rules as the generated value)
 * is not already present in the in-use registry for this attribute. On reset, existing
 * values for the account are unregistered before the template runs, so candidates can
 * be tested without relying on `$counter` disambiguation.
 * When using Velocity directives (`#if`, `#set`, …), put each directive on its own line;
 * velocity.js does not treat single-line `#if…#else…#end` as separate blocks.
 */
export interface UniqueAttributeDefinition {
    /** The target attribute name */
    name: string
    /** Apache Velocity template expression. Use $UUID for auto-generated UUIDs, $counter for counter values, $isUnique(...) to test candidates against registered values. */
    expression: string
    /** Case transformation to apply after generation */
    case?: 'same' | 'lower' | 'upper' | 'capitalize'
    /** Use a persistent incremental counter ($counter) that always increments instead of collision-based disambiguation */
    useIncrementalCounter?: boolean
    /** Starting value for the incremental counter */
    counterStart?: number
    /** Minimum digits for the counter value (zero-padded) */
    digits?: number
    /** Maximum character length for generated values */
    maxLength?: number
    /** Whether to normalize (transliterate) the generated value */
    normalize: boolean
    /** Whether to remove spaces from the generated value */
    spaces: boolean
    /** Whether to trim whitespace from the generated value */
    trim: boolean
}

/**
 * Configuration for a single attribute matching rule used in Match scoring.
 */
export interface MatchingConfig {
    /** The attribute name to compare between accounts */
    attribute: string
    /** The similarity algorithm to use for comparison */
    algorithm?: 'name-matcher' | 'jaro-winkler' | 'lig3' | 'dice' | 'double-metaphone' | 'binary' | 'custom'
    /**
     * When `algorithm` is `custom`, Apache Velocity template evaluated per pair.
     * Context includes `$accountValue`, `$candidateValue`, and `$attribute` (rule attribute name).
     * Rendered output must parse as a number in 0–100 (used as similarity score).
     */
    customVelocityExpression?: string
    /** Minimum similarity score (0-100) required to consider this attribute a match */
    fusionScore?: number
    /** If true, this rule must pass its minimum similarity for the pair to be a potential match */
    mandatory?: boolean
    /** If true (default), skip this rule when either side is missing (null/undefined/empty after trim). */
    skipMatchIfMissing?: boolean
    /**
     * If true, skip this rule (exclude from the weighted combined score) when its
     * computed similarity is strictly below `fusionScore`. Mandatory rules ignore this
     * toggle and are always evaluated against their minimum similarity.
     */
    skipMatchIfThresholdNotMet?: boolean
}

/**
 * Whether a rule should be skipped when either side has a missing match value.
 * Default is to skip when the key is omitted or true; explicit `false` always evaluates.
 * Mandatory rules are always evaluated so missing data can fail the threshold.
 */
export function effectiveSkipMatchIfMissing(
    matching: Pick<MatchingConfig, 'skipMatchIfMissing' | 'mandatory'>
): boolean {
    return !matching.mandatory && matching.skipMatchIfMissing !== false
}

/**
 * Whether a rule should be skipped when its computed similarity is below its
 * configured minimum similarity (`fusionScore`). Mandatory rules are always
 * evaluated so a failed mandatory rule can invalidate the candidate.
 */
export function effectiveSkipMatchIfThresholdNotMet(
    matching: Pick<MatchingConfig, 'skipMatchIfThresholdNotMet' | 'mandatory'>
): boolean {
    return !matching.mandatory && matching.skipMatchIfThresholdNotMet === true
}

// ============================================================================
// Connection Settings Menu
// ============================================================================

/** ISC API connection credentials. */
interface ConnectionSettingsSection {
    baseurl: string
    clientId: string
    clientSecret: string
}

type ConnectionSettingsMenu = ConnectionSettingsSection

// ============================================================================
// Source Settings Menu
// ============================================================================

/** Controls which identities are included in fusion processing. */
export interface ScopeSection {
    includeIdentities?: boolean
    identityScopeQuery?: string
}

export enum SourceType {
    Authoritative = 'authoritative',
    Record = 'record',
    Orphan = 'orphan',
}

/** How an Orphan accounts source processes accounts. Omitted values are Assignment. */
export enum OrphanProcessingMode {
    Assignment = 'assignment',
    Ownership = 'ownership',
}

type CorrelationMode = 'correlate' | 'reverse' | 'none'

/** Configuration for a single managed source that feeds into fusion. */
export interface SourceConfig {
    name: string
    enabled?: boolean
    sourceType?: SourceType
    /**
     * Orphan sources only. Assignment scores uncorrelated non-machine accounts and correlates
     * a selected identity. Ownership scores machine accounts with no established owner identity
     * and writes that identity as `ownerIdentity`. Omitted values, and any value on a
     * non-Orphan source, read as Assignment.
     */
    orphanProcessingMode?: OrphanProcessingMode
    disableNonMatchingAccounts?: boolean
    aggregationMode?: 'none' | 'before' | 'delayed'
    /**
     * Maximum time (minutes) to poll aggregation task status for this source when
     * `aggregationMode` is `before`. Status is checked every 30 seconds until the task
     * completes or this deadline is reached.
     */
    aggregationTimeout?: number
    aggregationDelay?: number
    optimizedAggregation?: boolean
    accountFilter?: string
    accountJmespathFilter?: string
    accountLimit?: number
    correlationMode?: CorrelationMode
    correlationAttribute?: string
    correlationDisplayName?: string
    /**
     * Deferred candidate matching: after identity scoring, also compare to other
     * provisional Fusion accounts from the same source in this run. If the only strong match is
     * a deferred candidate, defer instead of creating another Fusion identity until the next aggregation.
     * When false, skip that check (normal non-matched handling). Default true; disable
     * when one person may appear as multiple accounts in a single aggregation.
     */
    deferredMatching?: boolean
    /**
     * Record sources only: when true (default), record accounts are scored in the Match
     * phase against identities (and deferred candidates when enabled). When false, Match
     * scoring is skipped; the account still maps attributes and contributes to unique
     * attribute registration (for example reserving third-party identifiers).
     */
    includeRecordAccountsForMatching?: boolean
}

/** Configuration for all managed sources and aggregation behavior. */
export interface SourcesSection {
    sources: SourceConfig[]
}

/** Controls various processing behaviors during aggregation. */
export interface ProcessingControlSection {
    deleteEmpty: boolean
    skipAccountsWithMissingId: boolean
    /**
     * While on, `processFusionAccount` sets `mainAccount` to the first live managed account
     * when the origin is not a current contributor, and clears it when the origin is a current
     * contributor again. Off when the key is absent.
     */
    promoteMainAccountWhenOriginMissing: boolean
    maxHistoryMessages: number
    cascadeAggregationEnabled?: boolean
}

/** Combined source settings: scope, sources, and processing controls. */
interface SourceSettingsMenu extends ScopeSection, SourcesSection, ProcessingControlSection {}

// ============================================================================
// Attribute Mapping Settings Menu
// ============================================================================

/** Configuration for attribute mapping definitions and the default merge strategy. */
export interface AttributeMappingDefinitionsSection {
    attributeMerge: DefaultAttributeMergeMode
    attributeMaps?: AttributeMap[]
}

type AttributeMappingSettingsMenu = AttributeMappingDefinitionsSection

// ============================================================================
// Normal Attribute Definition Settings Menu
// ============================================================================

/** Configuration for normal (non-unique) attribute definitions (Velocity templates). */
export interface NormalAttributeDefinitionSettingsSection {
    normalAttributeDefinitions: NormalAttributeDefinition[]
}

type NormalAttributeDefinitionSettingsMenu = NormalAttributeDefinitionSettingsSection

// ============================================================================
// Unique Attribute Definition Settings Menu
// ============================================================================

/** Configuration for unique attribute definitions (unique IDs, UUIDs, counters). */
export interface UniqueAttributeDefinitionSettingsSection {
    uniqueAttributeDefinitions: UniqueAttributeDefinition[]
    /**
     * Maximum number of attempts to generate a unique attribute value before giving up.
     * Prevents infinite loops when generating unique attributes.
     */
    maxAttempts?: number
}

type UniqueAttributeDefinitionSettingsMenu = UniqueAttributeDefinitionSettingsSection

// ============================================================================
// Attribute Matching Settings Menu
// ============================================================================

/** Configuration for Match rules and scoring strategy. */
export interface MatchingSettingsSection {
    matchingConfigs?: MatchingConfig[]
    /** Minimum weighted combined match score (0-100). Required for matching. */
    fusionManualReviewScore?: number
    /** When true, potential matches below the automatic merge threshold may enter manual review when reviewers are configured. */
    fusionEnableManualReview: boolean
    /** When true, exact attribute matches skip manual review (automatic merge to the matched identity). */
    fusionEnableAutoMerge: boolean
    /** Automatic assignment match score threshold. Matches equal to or above this score are automatically assigned. */
    fusionAutoMergeScore?: number
}

/** Configuration for the manual review workflow and fusion reports. */
export interface ReviewSettingsSection {
    fusionFormAttributes?: string[]
    fusionFormExpirationDays: number
    /**
     * Maximum number of potential identity matches included on each fusion review form.
     * When there are more candidates than this cap, the highest-scoring matches are kept (see form builder).
     * Valid range: 1–15. Default for new sources: `sourceConfigInitialValues.fusionMaxCandidatesForForm` in connector-spec.json.
     */
    fusionMaxCandidatesForForm?: number
    fusionOwnerIsGlobalReviewer?: boolean
    fusionReportOnAggregation?: boolean
    enableLocalization?: boolean
    defaultLanguage?: string
    identityLanguageAttribute?: string
}

/** Combined Attribute Matching Settings: matching rules and review workflow. */
interface AttributeMatchingSettingsMenu extends MatchingSettingsSection, ReviewSettingsSection {}

// ============================================================================
// Advanced Settings Menu
// ============================================================================

/** Developer/debug settings including reset flags, attribute refresh behavior, and concurrency check. */
export interface DeveloperSettingsSection {
    resetAccounts: boolean
    resetForms: boolean
    /**
     * Batch size for processing uncorrelated managed accounts during Match.
     * Lower values reduce peak memory usage; higher values may improve throughput.
     * Default: 100.
     */
    managedAccountsBatchSize?: number
    /**
     * Maximum concurrent identity-comparison scoring operations during managed-account analysis.
     * Independent from managedAccountsBatchSize (batch grouping). Default: 12.
     */
    scoringMaxConcurrency?: number
    /**
     * Force recalculation of all computed Normal-type attributes on every aggregation,
     * even when no changes were detected.
     */
    forceAttributeRefresh: boolean
    /**
     * Enable the concurrency check that prevents concurrent account aggregations.
     * When enabled, a processing lock is set on the source at the start of each
     * aggregation. If the lock is already active (from a prior incomplete run or
     * a concurrent aggregation), it is automatically reset and an error is returned
     * asking the user to verify no other aggregation is running before retrying.
     * Enabled by default.
     */
    concurrencyCheckEnabled: boolean
    /**
     * Keep the first Fusion account registered for a Fusion identity and skip later
     * duplicates (accounts that resolve to the same identity with a different account key).
     * Disabled by default; when disabled, a later account overwrites the earlier one.
     */
    skipDuplicateFusionAccounts: boolean
}

/** External infrastructure settings: shared target, proxy mode, recording, and logging. */
export interface ExternalSettingsSection {
    /** Gateway toggle — when off, target fields and sub-options are inactive. */
    externalProcessingEnabled?: boolean
    /** Shared external target URL (proxy endpoint or log HTTP endpoint). */
    externalTargetUrl?: string
    /** Password for proxy authentication; required when proxy sub-option is on. */
    externalTargetPassword?: string
    /** Delegate operation processing to the external target. */
    externalProxyEnabled?: boolean
    /** Enable chain recording on the proxy server (requires proxy sub-option). */
    externalRecordingEnabled?: boolean
    /** Named recording chain when external recording is enabled. */
    recordingName?: string
    /** Stream connector logs to the external target or disk (role-dependent). */
    externalLoggingEnabled?: boolean
    /** Minimum log level for external logging delivery. */
    externalLoggingLevel?: 'error' | 'warn' | 'info' | 'debug'
    /** Timeout in milliseconds for requests sent to the external proxy endpoint. */
    proxyRequestTimeoutMs?: number
}

// Advanced Connection Settings Section
export interface AdvancedConnectionSettingsSection {
    /**
     * Maximum time in seconds to wait for provisioning operations to complete.
     */
    provisioningTimeout?: number

    /**
     * The number of times to retry a failed API request.
     * Configured in Advanced Connection Settings.
     */
    maxRetries?: number

    /**
     * Maximum number of requests to send per second (throttling).
     * Configured in Advanced Connection Settings.
     */
    requestsPerSecond?: number

    /**
     * Maximum number of API requests to run concurrently.
     * Used for queueConfig.maxConcurrentRequests.
     */
    maxConcurrentRequests?: number

    /**
     * Interval (in milliseconds) between keep-alive signals sent to the platform
     * during long-running account list and account update operations. Configured in
     * seconds in the connector UI; converted to milliseconds internally. Default and
     * maximum 180 seconds (platform keep-alive cap). Lower values reduce timeout risk;
     * higher values reduce keep-alive traffic.
     */
    processingWait?: number

    /**
     * Enable priority processing in the queue, allowing more important requests to be handled first.
     */
    enablePriority?: boolean

    /**
     * Maximum in-flight parallel page requests per pagination stream (sliding window).
     * Defaults to 16 when unset. Independent from maxConcurrentRequests — the shared
     * ApiQueue still enforces global HTTP concurrency and rate-window limits.
     */
    parallelBatchSize?: number

    /**
     * Interval (in seconds) between operation heartbeat STATUS and EVENT_SUMMARY lines
     * during long-running operations. Configured in Advanced Connection Settings as
     * `heartbeatInterval`; converted to `statsLoggingIntervalMs` at runtime. Default 10 seconds.
     */
    heartbeatInterval?: number
}

/** Combined advanced settings: developer, connection tuning, and external infrastructure. */
interface AdvancedSettingsMenu
    extends DeveloperSettingsSection, AdvancedConnectionSettingsSection, ExternalSettingsSection {}

// ============================================================================
// Internal/Computed fields
// ============================================================================

/** Internal constants and computed values not exposed through the UI configuration. */
interface InternalConfig {
    readonly fusionScoreMap?: Map<string, number>
    readonly requestsPerSecondConstant: number
    readonly tokenUrlPath: string
    readonly processingWaitConstant: number
    readonly retriesConstant: number
    readonly inFlightGatewayFailureCap: number
    readonly paginationGatewayMaxRetries: number
    readonly workflowName: string
    readonly delayedAggregationWorkflowName: string
    readonly padding: string
    readonly msDay: number
    readonly identityNotFoundWait: number
    readonly identityNotFoundRetries: number
    readonly separator: string
    readonly fusionFormNamePattern: string
    readonly nonAggregableTypes: readonly string[]
    readonly pageSize: number
    readonly fusionAccountRefreshThresholdInSeconds: number
    readonly fusionMaxCandidatesForFormMin: number
    readonly fusionMaxCandidatesForFormMax: number
    readonly maxRetryDelayMs: number
    readonly retryJitterFactor: number
    readonly rateLimitJitterFactor: number
    readonly statsLoggingIntervalMs: number
    readonly maxStatsSamples: number
    readonly queueProcessingIntervalMs: number
    readonly sailPointListMax: number
    readonly concurrency: {
        readonly uncorrelatedAccounts: number
        readonly processAccounts: number
        readonly correlateAccounts: number
    }
    readonly fusionState?: Record<string, any>
    /**
     * Persisted cumulative count of accounts fetched per source in batch mode.
     * Used when a source has an `accountLimit`: the effective limit for each run
     * is `batchCumulativeCount[sourceName] + accountLimit`, ensuring previously
     * fetched accounts are always included. Updated after each successful run
     * and cleared on reset.
     */
    readonly batchCumulativeCount?: Record<string, number>
    readonly isProxy?: boolean
}

// ============================================================================
// Recording Configuration
// ============================================================================

/** Centralized recording flags, replacing scattered env vars (RECORD_MODE, RECORD_SCENARIO_NAME, VERBOSE_RECORDING). */
export interface RecordingConfig {
    mode: 'off' | 'record' | 'replay'
    /** Named recording scenario for record/replay artifact paths. */
    scenarioName?: string
    /**
     * @deprecated Use `scenarioName`. Kept for backward compatibility with legacy configs and env vars.
     */
    chainName?: string
    verbose?: boolean
    /** Persistence backend for record-mode artifacts. Default `'ndjson'`. */
    store?: 'ndjson' | 'sqlite'
    /** Ephemeral per-step timestamp for replay stale-form simulation (orchestrator only). */
    replayStepTimestamp?: string
}

// ============================================================================
// Source Config - Combination of all menus
// ============================================================================

/**
 * Complete fusion connector configuration. Combines all menu sections, the base
 * ISC platform config, and internal computed constants into a single interface.
 */
export interface FusionConfig
    extends
        BaseConfig,
        ConnectionSettingsMenu,
        SourceSettingsMenu,
        AttributeMappingSettingsMenu,
        NormalAttributeDefinitionSettingsMenu,
        UniqueAttributeDefinitionSettingsMenu,
        AttributeMatchingSettingsMenu,
        AdvancedSettingsMenu,
        InternalConfig {
    recording?: RecordingConfig
}

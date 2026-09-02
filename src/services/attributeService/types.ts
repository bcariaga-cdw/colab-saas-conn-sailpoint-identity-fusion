import { AttributeMergeMode, UniqueAttributeDefinition } from '../../model/config'

// ============================================================================
// Type Definitions — Attribute Service
// ============================================================================

/**
 * Resolved configuration for a single attribute mapping, derived from
 * the user-configured {@link AttributeMap} at initialization time.
 */
export type AttributeMappingConfig = {
    /** The target fusion attribute name */
    attributeName: string
    /** Source attribute names to look for in managed accounts */
    sourceAttributes: string[]
    /** Strategy for merging values from multiple sources */
    attributeMerge: AttributeMergeMode
    /** Specific source name (only used with "source" merge strategy) */
    source?: string
}

/**
 * Flags controlling which attribute operations to perform when rebuilding
 * a fusion account (used by single-account operations like read, update, disable).
 */
export type AttributeOperations = {
    /** Whether to re-evaluate attribute mappings from source accounts */
    refreshMapping: boolean
    /** Whether to re-evaluate attribute definitions (Velocity templates) */
    refreshDefinition: boolean
    /** Whether to fully reset generated attributes (re-register unique values) */
    resetDefinition: boolean
}

/** Refresh mappings and definitions without resetting (read, disable). */
export const ATTR_OPS_REFRESH: AttributeOperations = {
    refreshMapping: true,
    refreshDefinition: true,
    resetDefinition: false,
}

/** Full reset: refresh and regenerate unique values (enable). */
export const ATTR_OPS_RESET: AttributeOperations = {
    refreshMapping: true,
    refreshDefinition: true,
    resetDefinition: true,
}

/** No attribute processing (update -- only actions are applied). */
export const ATTR_OPS_NONE: AttributeOperations = {
    refreshMapping: false,
    refreshDefinition: false,
    resetDefinition: false,
}

// ============================================================================
// Customizer Hook Payloads
// ============================================================================

/** Serializable projection of the account a unique value is being generated for. */
export type UniqueGenerationCustomizerAccount = {
    name?: string
    nativeIdentity?: string
    sourceName?: string
    identityId?: string
    originSource?: string
    originAccountId?: string
    isIdentity: boolean
    needsReset: boolean
    /** Current fusion attributes, including any unique values already generated this run. */
    attributes: Record<string, any>
}

/**
 * Input sent to the `IdentityFusion:BeforeUniqueGeneration` and
 * `IdentityFusion:AfterUniqueGeneration` customized operations.
 *
 * A handler overrides the value by returning either a plain string or this payload with a
 * `value` property set. Returning it unchanged leaves connector behavior untouched.
 */
export type UniqueGenerationCustomizerPayload = {
    /** Which unique attribute is being generated — switch on this in the handler. */
    attributeName: string
    /** The configured definition driving generation. */
    definition: UniqueAttributeDefinition
    account: UniqueGenerationCustomizerAccount
    /** Velocity variables available to the expression, with function values removed. */
    renderContext: Record<string, any>
    /** How many values are already taken for this attribute. The full set is not sent. */
    registeredValueCount: number
    /** `AfterUniqueGeneration` only: the value the connector generated. */
    generatedValue?: string
    /** Set by the handler to override the value. */
    value?: string
}

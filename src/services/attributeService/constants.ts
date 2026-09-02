// ============================================================================
// Constants
// ============================================================================

export const COMPOUND_KEY_UNIQUE_ID_ATTRIBUTE = 'CompoundKey.uniqueId'
export const FUSION_STATE_CONFIG_PATH = '/connectorAttributes/fusionState'

/**
 * Customized operation identifiers for the unique-attribute (Define) generation hooks.
 *
 * Both are stable across configurations — the attribute being generated travels in the payload
 * as `attributeName`, so a single handler serves every configured unique attribute.
 */
export const CUSTOMIZER_OP_BEFORE_UNIQUE_GENERATION = 'IdentityFusion:BeforeUniqueGeneration'
export const CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION = 'IdentityFusion:AfterUniqueGeneration'

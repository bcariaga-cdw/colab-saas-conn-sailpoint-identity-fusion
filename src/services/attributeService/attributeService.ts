import {
    FusionConfig,
    AttributeMap,
    DefaultAttributeMergeMode,
    NormalAttributeDefinition,
    UniqueAttributeDefinition,
    SourceConfig,
} from '../../model/config'
import { LogService } from '../logService'
import { FusionAccount } from '../../model/account'
import { SchemaService } from '../schemaService'
import { Account } from 'sailpoint-api-client'
import { CompoundKey, CompoundKeyType, SimpleKey, SimpleKeyType, StandardCommand } from '@sailpoint/connector-sdk'
import {
    evaluateVelocityTemplate,
    normalize,
    padNumber,
    removeSpaces,
    switchCase,
    truncateResultToMaxLength,
} from './formatting'
import { LockService } from '../lockService'
export type RenderContext = Record<string, any>
import { v4 as uuidv4 } from 'uuid'
import { assert } from '../../utils/assert'
import { SourceService } from '../sourceService'
import {
    COMPOUND_KEY_UNIQUE_ID_ATTRIBUTE,
    CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION,
    CUSTOMIZER_OP_BEFORE_UNIQUE_GENERATION,
    FUSION_STATE_CONFIG_PATH,
} from './constants'
import { AttributeMappingConfig, UniqueGenerationCustomizerPayload } from './types'
import { CustomizerService, NoopCustomizerService } from '../customizerService'
import { processAttributeMapping, buildAttributeMappingConfig } from './helpers'
import { isValidAttributeValue } from '../../utils/attributes'
import { StateWrapper } from './stateWrapper'
import { buildManagedAccountKey } from '../../model/managedAccountKey'
import { velocitySnapshotSchemaId, velocitySnapshotSourceId } from '../../utils/velocityAccountSnapshot'
import { hasValue, missing, readString, trimStr } from '../../utils/safeRead'
import { defaults } from '../../data/config'

type AnyDefinition = NormalAttributeDefinition | UniqueAttributeDefinition
const MAIN_ACCOUNT_ATTRIBUTE = 'mainAccount'

// Module-level regex constants — compiled once (hot attribute-evaluation path)
const COUNTER_SUFFIX_RE = /\$counter$|\$\{counter\}$/
const VELOCITY_VAR_RE = /(^|[^\\])\$(\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)/
/** System-managed provenance id; not mapped or defined via Velocity. */
const ORIGIN_ACCOUNT_ATTRIBUTE = 'originAccount'
/** System-managed provenance source; not mapped or defined via Velocity. */
const ORIGIN_SOURCE_ATTRIBUTE = 'originSource'

/**
 * Managed account key for matching `mainAccount` / `$originAccount` — composite `sourceId::nativeIdentity`
 * from snapshot fields only. Use top-level `$originAccount` in Velocity when you need the origin key.
 */
function getManagedAccountSnapshotKey(account: Record<string, any> | undefined): string {
    if (!account) return ''
    const key = buildManagedAccountKey({
        sourceId: velocitySnapshotSourceId(account),
        nativeIdentity: velocitySnapshotSchemaId(account),
    })
    return trimStr(key ?? '') ?? ''
}

// ============================================================================
// AttributeService Class
// ============================================================================

/**
 * Service for attribute mapping, attribute definition, and UUID management.
 * Combines functionality for mapping attributes from source accounts and generating unique IDs.
 */
export class AttributeService {
    private _attributeMappingConfig?: Map<string, AttributeMappingConfig>
    private normalDefinitions: NormalAttributeDefinition[] = []
    private uniqueDefinitions: UniqueAttributeDefinition[] = []
    private uniqueAttributeNames: Set<string> = new Set()
    private uniqueValuesByAttribute: Map<string, Set<string>> = new Map()
    private uniqueDefinitionByName: Map<string, UniqueAttributeDefinition> = new Map()
    private stateWrapper?: StateWrapper
    private readonly skipAccountsWithMissingId: boolean
    private readonly attributeMaps?: AttributeMap[]
    private readonly attributeMerge: DefaultAttributeMergeMode
    private readonly sourceConfigs: SourceConfig[]
    private readonly maxAttempts?: number
    private readonly forceAttributeRefresh: boolean
    private readonly reverseSources: SourceConfig[]

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    /**
     * @param config - Fusion configuration containing attribute maps, definitions, and merge strategy
     * @param schemas - Schema service for resolving attribute names and types
     * @param sourceService - Source service for persisting state to the fusion source config
     * @param log - Logger instance
     * @param locks - Lock service for thread-safe unique Define generation
     * @param commandType - The current SDK command type (affects key generation behavior)
     * @param customizer - Customized-operation dispatcher for the unique-generation hooks;
     *                     defaults to a no-op so callers without an SDK context behave as before
     */
    constructor(
        config: FusionConfig,
        private schemas: SchemaService,
        private sourceService: SourceService,
        private log: LogService,
        private locks: LockService,
        _commandType?: StandardCommand,
        private customizer: CustomizerService = new NoopCustomizerService()
    ) {
        this.attributeMaps = config.attributeMaps
        this.attributeMerge = config.attributeMerge
        this.sourceConfigs = config.sources
        this.maxAttempts = config.maxAttempts
        this.skipAccountsWithMissingId = config.skipAccountsWithMissingId
        this.forceAttributeRefresh = config.forceAttributeRefresh

        this.normalDefinitions = config.normalAttributeDefinitions ? [...config.normalAttributeDefinitions] : []
        this.uniqueDefinitions = config.uniqueAttributeDefinitions ? [...config.uniqueAttributeDefinitions] : []

        this.uniqueDefinitionByName = new Map(this.uniqueDefinitions.map((d) => [d.name, d]))
        this.uniqueAttributeNames = new Set(this.uniqueDefinitions.map((d) => d.name))

        this.setStateWrapper(config.fusionState)
        this.reverseSources = this.sourceConfigs.filter(
            (sc) => sc.correlationMode === 'reverse' && sc.correlationAttribute
        )
    }

    // ------------------------------------------------------------------------
    // Public State Management Methods
    // ------------------------------------------------------------------------

    /**
     * Save the current state to the source configuration
     */
    public async saveState(): Promise<void> {
        const { fusionSourceId } = this.sourceService
        const stateObject = await this.getStateObject()

        this.log.info(`Saving state object: ${JSON.stringify(stateObject)}`)
        await this.sourceService.patchSourceConfig(
            fusionSourceId,
            FUSION_STATE_CONFIG_PATH,
            stateObject,
            'AttributeService>saveState'
        )
    }

    /**
     * Get the current state object
     */
    public async getStateObject(): Promise<{ [key: string]: number }> {
        if (this.locks && typeof this.locks.waitForAllPendingOperations === 'function') {
            await this.locks.waitForAllPendingOperations()
        }
        const stateWrapper = this.getStateWrapper()
        this.log.debug(`Reading state - StateWrapper has ${stateWrapper.state.size} entries`)

        const state = stateWrapper.getState()
        this.log.debug(`getState() returned: ${JSON.stringify(state)}`)

        return state
    }

    /**
     * Set state wrapper for counter-based attributes.
     * Injects lock service for thread-safe counter operations in parallel processing.
     *
     * @param state - Persisted counter state (attribute name -> numeric value); typically from config.fusionState
     */
    public setStateWrapper(state: Record<string, unknown> | undefined): void {
        this.stateWrapper = new StateWrapper(state, this.locks)
    }

    /**
     * Initialize incremental counters from unique attribute definitions.
     * Should be called once after setStateWrapper to ensure all counters are initialized.
     */
    public async initializeCounters(): Promise<void> {
        const stateWrapper = this.getStateWrapper()
        const counterDefinitions = this.uniqueDefinitions.filter((def) => def.useIncrementalCounter)
        if (counterDefinitions.length === 0) return

        this.log.debug(`Initializing ${counterDefinitions.length} incremental counter attributes`)
        const existingCounters = Object.fromEntries(
            Array.from(stateWrapper.state.entries()).filter(([key]) =>
                counterDefinitions.some((def) => def.name === key)
            )
        )
        if (Object.keys(existingCounters).length > 0) {
            this.log.debug(`Preserving existing counter values: ${JSON.stringify(existingCounters)}`)
        }

        await Promise.all(
            counterDefinitions.map((def) => {
                const start = def.counterStart ?? 1
                return stateWrapper.initCounter(def.name, start)
            })
        )

        const finalCounters: { [key: string]: number } = {}
        for (const def of counterDefinitions) {
            const value = stateWrapper.state.get(def.name)
            if (value !== undefined) {
                finalCounters[def.name] = value
            }
        }
        this.log.debug(`All incremental counters initialized. Current values: ${JSON.stringify(finalCounters)}`)
    }

    // ------------------------------------------------------------------------
    // Public Attribute Mapping Methods
    // ------------------------------------------------------------------------

    /**
     * Maps attributes from source accounts to the fusion account.
     * Processes source attributes in the established source order if refresh is needed,
     * using the current attribute bag as a default. For identity-type accounts, returns
     * immediately without mapping. Ensures fusion account history is preserved and never
     * overwritten by empty arrays from source mapping.
     *
     * @param fusionAccount - The fusion account to map attributes for
     */
    public mapAttributes(fusionAccount: FusionAccount): void {
        if (fusionAccount.type === 'identity') return

        const { attributeBag, needsRefresh } = fusionAccount
        const { fusionIdentityAttribute, fusionDisplayAttribute } = this.schemas
        const attributes = { ...attributeBag.current }

        // Ensure all fusionAccount sources have an entry (default to [] if missing).
        const sourceAttributeMap = attributeBag.sources
        for (const source of fusionAccount.sources) {
            if (!sourceAttributeMap.has(source)) {
                sourceAttributeMap.set(source, [])
            }
        }

        if (needsRefresh && sourceAttributeMap.size > 0) {
            const hasManagedAccountContext = Array.from(sourceAttributeMap.values()).some(
                (accounts) => accounts.length > 0
            )
            const shouldPreserveCurrentWithoutContext = !hasManagedAccountContext && !fusionAccount.isIdentity
            const sourceOrder = this.sourceConfigs.map((sc) => sc.name)
            if (fusionAccount.originSource === 'Identities') {
                sourceOrder.push('Identities')
                sourceAttributeMap.set('Identities', [attributeBag.identity])
            }
            let prioritizedAccount = this.getMainAccountContextAccount(fusionAccount, sourceAttributeMap)
            const mappingTargets = this.getAttributeMappingTargetNames()
            for (const attribute of mappingTargets) {
                if (
                    this.shouldSkipMappedAttribute(
                        attribute,
                        fusionAccount,
                        fusionIdentityAttribute,
                        fusionDisplayAttribute
                    )
                ) {
                    continue
                }

                const processingConfig = this.attributeMappingConfig.get(attribute)!
                const processedValue = processAttributeMapping(
                    processingConfig,
                    sourceAttributeMap,
                    sourceOrder,
                    prioritizedAccount
                )
                if (processedValue === undefined) {
                    if (!shouldPreserveCurrentWithoutContext) {
                        delete attributes[attribute]
                    }
                    // mainAccount is used as an override context selector; when no supporting
                    // source value exists anymore, clear stale values so account mapping can update.
                    if (attribute === MAIN_ACCOUNT_ATTRIBUTE) {
                        delete attributes[attribute]
                        prioritizedAccount = undefined
                    }
                    continue
                }

                attributes[attribute] = processedValue
                if (attribute === MAIN_ACCOUNT_ATTRIBUTE) {
                    const mainAccountId = trimStr(processedValue)
                    prioritizedAccount = mainAccountId
                        ? this.findAccountByIdInSourceMap(sourceAttributeMap, mainAccountId)
                        : undefined
                }
                if (attribute === 'history') {
                    this.applyHistoryMapping(processedValue, fusionAccount)
                }
            }
        }

        // Ensure fusion account history is never lost: for accounts that have their own audit log
        // (e.g. type 'managed' with setNonMatched), keep it in the bag so output is correct.
        if (fusionAccount.history.length > 0) {
            attributes['history'] = [...fusionAccount.history]
        }

        attributeBag.current = attributes
    }

    /**
     * Skip attribute mapping when identity/display must stay immutable or unique values are already set.
     */
    private shouldSkipMappedAttribute(
        attribute: string,
        fusionAccount: FusionAccount,
        fusionIdentityAttribute: string,
        fusionDisplayAttribute: string
    ): boolean {
        if (attribute === ORIGIN_ACCOUNT_ATTRIBUTE || attribute === ORIGIN_SOURCE_ATTRIBUTE) return true
        const { current } = fusionAccount.attributeBag
        const hasExistingValue = isValidAttributeValue(current[attribute])
        const canResetDisplay = fusionAccount.needsReset && attribute === fusionDisplayAttribute
        const shouldKeepIdentityImmutable = this.isExistingFusionAccount(fusionAccount) && fusionAccount.isIdentity
        const isImmutableIdentityAttribute =
            attribute === fusionIdentityAttribute && hasExistingValue && shouldKeepIdentityImmutable
        const isImmutableDisplayAttribute = attribute === fusionDisplayAttribute && hasExistingValue && !canResetDisplay

        if (isImmutableIdentityAttribute || isImmutableDisplayAttribute) return true
        if (this.uniqueAttributeNames.has(attribute) && current[attribute] !== undefined) return true
        return false
    }

    private applyHistoryMapping(processedValue: unknown, fusionAccount: FusionAccount): void {
        if (!Array.isArray(processedValue) || processedValue.length === 0) return

        const history = processedValue
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)

        if (history.length === 0) return
        fusionAccount.importHistory(history)
    }

    // ------------------------------------------------------------------------
    // Public Attribute Refresh Methods
    // ------------------------------------------------------------------------

    /**
     * Refreshes all attribute definitions for a fusion account (normal + unique).
     *
     * @param fusionAccount - The fusion account to refresh attributes for
     */
    public async refreshAllAttributes(fusionAccount: FusionAccount): Promise<void> {
        const context = this.buildVelocityContext(fusionAccount)

        for (const definition of this.normalDefinitions) {
            try {
                await this.processNormalDefinition(definition, fusionAccount, context)
            } catch (error) {
                this.log.error(
                    `Error generating normal attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
            }
        }

        for (const definition of this.uniqueDefinitions) {
            try {
                await this.processUniqueDefinition(definition, fusionAccount, context)
            } catch (error) {
                this.log.error(
                    `Error generating unique attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
                throw error
            }
        }
    }

    /**
     * Refreshes only normal attribute definitions.
     * Skips processing if the account doesn't need a refresh.
     *
     * @param fusionAccount - The fusion account to refresh normal attributes for
     */
    public async refreshNormalAttributes(fusionAccount: FusionAccount): Promise<void> {
        if (this.normalDefinitions.length === 0) return

        const forceRefresh =
            this.forceAttributeRefresh || fusionAccount.needsReset || this.normalDefinitions.some((def) => def.refresh)
        const shouldRefresh = fusionAccount.needsRefresh || forceRefresh
        if (!shouldRefresh) return

        this.log.debug(`Refreshing normal attributes for account: ${fusionAccount.name} [${fusionAccount.sourceName}]`)
        const context = this.buildVelocityContext(fusionAccount)

        for (const definition of this.normalDefinitions) {
            try {
                await this.processNormalDefinition(definition, fusionAccount, context)
            } catch (error) {
                this.log.error(
                    `Error generating normal attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
            }
        }
    }

    /**
     * Refreshes reverse correlation attributes for all sources configured with
     * correlationMode 'reverse'. Sets the attribute to the first missing account's
     * schema.id for sources with missing accounts, and clears it for sources without.
     *
     * This is called alongside refreshNormalAttributes to ensure reverse correlation
     * attributes stay in sync with the current state of missing accounts.
     *
     * @param fusionAccount - The fusion account to refresh reverse correlation attributes for
     */
    public refreshReverseCorrelationAttributes(fusionAccount: FusionAccount): void {
        if (fusionAccount.missingAccountIds.length === 0) return
        for (const sc of this.reverseSources) {
            const missingForSource = fusionAccount.getMissingAccountIdsForSource(sc.name)
            if (missingForSource.length > 0) {
                const firstAccountId = missingForSource[0]
                const info = fusionAccount.getManagedAccountInfo(firstAccountId)
                if (info) {
                    fusionAccount.setReverseCorrelationAttribute(sc.correlationAttribute!, info.schema.id)
                    this.log.debug(
                        `Set reverse correlation attribute "${sc.correlationAttribute}" = "${info.schema.id}" ` +
                            `for fusion account ${fusionAccount.name} (source: ${sc.name})`
                    )
                }
            } else {
                fusionAccount.clearReverseCorrelationAttribute(sc.correlationAttribute!)
            }
        }
    }

    /**
     * Refreshes only unique attribute definitions.
     * Unique attributes are only generated for new accounts; existing values are preserved
     * unless needsReset is set (e.g. when re-enabling a previously disabled account).
     *
     * Disabling and then re-enabling a Fusion account triggers a full unique attribute
     * reset: the enable operation sets `needsReset = true`, which causes this method to
     * unregister existing values and regenerate them via {@link applyUniqueDefinitions}.
     * This ensures the re-enabled account receives fresh, collision-free unique values
     * (such as usernames) that may have been reassigned while it was disabled.
     *
     * Additionally, if any unique attribute is currently empty or missing (e.g. because a
     * prior generation failed when `$account` resolved to an identity-backed object lacking
     * managed-account attributes), this method will attempt to regenerate those values
     * regardless of the needsRefresh flag, preventing a permanent empty-attribute state.
     *
     * @param fusionAccount - The fusion account to refresh unique attributes for
     */
    public async refreshUniqueAttributes(fusionAccount: FusionAccount): Promise<void> {
        if (this.uniqueDefinitions.length === 0) return

        // Also refresh when any unique attribute value is missing or empty, to recover from
        // failed generation on a prior run (e.g. $account resolved to an identity object
        // that lacked the managed-account attributes referenced by the expression).
        const hasMissingUniqueAttribute = this.uniqueDefinitions.some(
            (def) => !isValidAttributeValue(fusionAccount.attributes[def.name])
        )

        const shouldRefresh = fusionAccount.needsRefresh || fusionAccount.needsReset || hasMissingUniqueAttribute
        if (!shouldRefresh) return

        this.log.debug(`Refreshing unique attributes for account: ${fusionAccount.name} [${fusionAccount.sourceName}]`)

        if (fusionAccount.needsReset) {
            await this.unregisterUniqueAttributes(fusionAccount)
        }

        const context = this.buildVelocityContext(fusionAccount)

        for (const definition of this.uniqueDefinitions) {
            try {
                await this.processUniqueDefinition(definition, fusionAccount, context)
            } catch (error) {
                this.log.error(
                    `Error generating unique attribute ${definition.name} for account: ${fusionAccount.name} (${fusionAccount.sourceName})`,
                    error instanceof Error ? error.message : readString(error, 'message', String(error))
                )
                throw error
            }
        }
    }

    /**
     * Registers all unique attribute values for a fusion account, preventing them
     * from being assigned to other accounts.
     *
     * @param fusionAccount - The fusion account whose unique values to register
     */
    public async registerUniqueAttributes(fusionAccount: FusionAccount): Promise<void> {
        this.log.debug(`Registering unique attributes for account: ${fusionAccount.nativeIdentity}`)

        for (const definition of this.uniqueDefinitions) {
            const value = fusionAccount.attributes[definition.name]
            if (missing(value)) continue

            const valueStr = String(value)
            const lockKey = `unique:${definition.name}`
            await this.locks.withLock(lockKey, async () => {
                assert(
                    this.uniqueDefinitionByName.has(definition.name),
                    `Attribute ${definition.name} not found in unique attribute definition config`
                )
                this.getUniqueValues(definition.name).add(valueStr)
            })
        }
    }

    /**
     * Unregisters all unique attribute values for a fusion account, releasing them
     * for reassignment. Used when an account is being removed or re-enabled.
     *
     * @param fusionAccount - The fusion account whose unique values to release
     */
    public async unregisterUniqueAttributes(fusionAccount: FusionAccount): Promise<void> {
        const { fusionIdentityAttribute } = this.schemas
        this.log.debug(`Unregistering unique attributes for account: ${fusionAccount.nativeIdentity}`)

        for (const definition of this.uniqueDefinitions) {
            if (definition.name === fusionIdentityAttribute) continue

            const value = fusionAccount.attributes[definition.name]
            if (missing(value)) continue

            const valueStr = String(value)
            const lockKey = `unique:${definition.name}`
            await this.locks.withLock(lockKey, async () => {
                if (!this.getUniqueValues(definition.name).delete(valueStr)) return
                this.log.debug(`Unregistered unique value '${valueStr}' for attribute ${definition.name}`)
            })
        }
    }

    // ------------------------------------------------------------------------
    // Public Key Generation Methods
    // ------------------------------------------------------------------------

    /**
     * Generate a simple key for a fusion account.
     *
     * The key is derived from the fusion identity attribute value (typically a unique
     * attribute such as a UUID or generated username). If the attribute is empty and
     * `skipAccountsWithMissingId` is enabled, the method returns `undefined`, which
     * causes {@link FusionService.getISCAccount} to omit the account from the output.
     *
     * This enables a deliberate pattern: generate an intentionally empty identity
     * attribute (via attribute definitions that resolve to an empty string) combined
     * with the "Skip accounts with a missing identifier" processing option to prevent
     * specific managed accounts or identities from producing Fusion accounts.
     *
     * @returns SimpleKeyType if successful, undefined if skipAccountsWithMissingId is enabled and the ID is missing
     */
    public getSimpleKey(fusionAccount: FusionAccount): SimpleKeyType | undefined {
        const { fusionIdentityAttribute } = this.schemas

        const uniqueId = fusionAccount.attributes[fusionIdentityAttribute] as string | undefined

        if (this.skipAccountsWithMissingId && !uniqueId) {
            this.log.warn(
                `Skipping account ${fusionAccount.name} [${fusionAccount.sourceName}]: ` +
                    `Missing value for fusion identity attribute '${fusionIdentityAttribute}'`
            )
            return undefined
        }

        const finalId = uniqueId ?? fusionAccount.nativeIdentity
        assert(finalId, `Unique ID is required for simple key`)

        return SimpleKey(finalId)
    }

    /**
     * Generate a compound key for a fusion account
     */
    public getCompoundKey(fusionAccount: FusionAccount): CompoundKeyType {
        const { fusionDisplayAttribute } = this.schemas

        const uniqueId = fusionAccount.attributes[COMPOUND_KEY_UNIQUE_ID_ATTRIBUTE] as string
        assert(uniqueId, `Unique ID is required for compound key`)
        const lookupId = (fusionAccount.attributes[fusionDisplayAttribute] as string) ?? uniqueId

        return CompoundKey(lookupId, uniqueId)
    }

    // ------------------------------------------------------------------------
    // Private Configuration Helper Methods
    // ------------------------------------------------------------------------

    /**
     * Resolve all mapping targets that should be available in attribute-definition context.
     * Includes schema attributes plus explicit attribute-map targets.
     */
    private getAttributeMappingTargetNames(): string[] {
        const schemaAttributes = this.schemas.listSchemaAttributeNames()
        const mappedAttributes = (this.attributeMaps ?? [])
            .map((am) => am.newAttribute)
            .filter((name): name is string => Boolean(name))

        return Array.from(new Set([...schemaAttributes, ...mappedAttributes]))
    }

    private get attributeMappingConfig(): Map<string, AttributeMappingConfig> {
        if (!this._attributeMappingConfig) {
            this._attributeMappingConfig = new Map()
            const mappingTargets = this.getAttributeMappingTargetNames()
            for (const attrName of mappingTargets) {
                this._attributeMappingConfig.set(
                    attrName,
                    buildAttributeMappingConfig(attrName, this.attributeMaps, this.attributeMerge)
                )
            }
        }
        return this._attributeMappingConfig
    }

    /**
     * Check whether an attribute name belongs to a unique definition.
     */
    public isUniqueAttribute(name: string): boolean {
        return this.uniqueAttributeNames.has(name)
    }

    /**
     * Get or create the Set of registered unique values for an attribute.
     * The Set is stored in uniqueValuesByAttribute and shared across attribute definitions.
     */
    private getUniqueValues(attributeName: string): Set<string> {
        let set = this.uniqueValuesByAttribute.get(attributeName)
        if (!set) {
            set = new Set<string>()
            this.uniqueValuesByAttribute.set(attributeName, set)
        }
        return set
    }

    /**
     * Register an array of existing values for a unique attribute.
     * Use when loading existing accounts or bulk-initializing to prevent duplicate value generation.
     *
     * @param attributeName - The attribute name (must match a unique attribute definition)
     * @param values - Array of values to register as already in use
     */
    public registerExistingValues(attributeName: string, values: string[]): void {
        if (values.length === 0) return
        const set = this.getUniqueValues(attributeName)
        for (const v of values) {
            if (hasValue(v)) {
                set.add(String(v))
            }
        }
        this.log.debug(`Registered ${values.length} existing value(s) for attribute '${attributeName}'`)
    }

    /**
     * Lightweight bulk registration of unique attribute values from raw Account objects.
     * Reads unique attribute values directly from account.attributes without creating
     * FusionAccount instances, avoiding the overhead of full object hydration.
     *
     * Use this instead of preProcessFusionAccounts + registerUniqueAttributes
     * for single-account operations (create, enable) where only uniqueness
     * enforcement is needed.
     *
     * @param accounts - Raw Account objects from the platform
     */
    public registerUniqueValuesFromRawAccounts(accounts: Account[]): void {
        if (this.uniqueDefinitions.length === 0) return

        for (const def of this.uniqueDefinitions) {
            const values: string[] = []
            for (const account of accounts) {
                const value = account.attributes?.[def.name]
                if (hasValue(value)) {
                    values.push(String(value))
                }
            }
            this.registerExistingValues(def.name, values)
        }

        this.log.debug(
            `Registered unique values from ${accounts.length} raw account(s) ` +
                `for ${this.uniqueDefinitions.length} unique attribute definition(s)`
        )
    }

    private getStateWrapper(): StateWrapper {
        assert(this.stateWrapper, 'State wrapper is not set')
        return this.stateWrapper!
    }

    // ------------------------------------------------------------------------
    // Private Context Builder Methods
    // ------------------------------------------------------------------------

    /**
     * Build Velocity context from FusionAccount's attributeBag
     * The context includes current attributes plus referenceable objects from attributeBag
     */
    private buildVelocityContext(fusionAccount: FusionAccount): Record<string, any> {
        const context: Record<string, any> = { ...fusionAccount.attributeBag.current }
        const orderedAccounts = this.getOrderedAccountsForContext(fusionAccount)

        context.identity = { ...fusionAccount.attributeBag.identity }
        if (fusionAccount.fromIdentity) {
            const identityName = trimStr(fusionAccount.name)
            if (identityName) {
                context.identity.name = identityName
                if (!trimStr(context.name)) {
                    context.name = identityName
                }
            }
        }
        context.accounts = orderedAccounts
        context.previous = fusionAccount.attributeBag.previous
        context.sources = fusionAccount.attributeBag.sources
        context.account = this.resolveOriginAccountObjectForVelocity(fusionAccount, orderedAccounts)

        if (fusionAccount.originSource) {
            context.originSource = fusionAccount.originSource
        }
        if (fusionAccount.originAccountId) {
            context.originAccount = fusionAccount.originAccountId
        }

        return context
    }

    /**
     * Velocity `$account`: origin snapshot (managed account shape or identity-backed).
     * `$originAccount` remains the origin key string (set on context above).
     */
    private resolveOriginAccountObjectForVelocity(
        fusionAccount: FusionAccount,
        orderedAccounts: Record<string, any>[]
    ): Record<string, any> | undefined {
        const originIdRaw = fusionAccount.originAccountId ?? fusionAccount.attributes[ORIGIN_ACCOUNT_ATTRIBUTE]
        const originId = trimStr(originIdRaw)
        if (!originId) return undefined

        const { originSource } = fusionAccount
        const identityBag = (fusionAccount.attributeBag.identity ?? {}) as Record<string, unknown>
        const identityHasData = Object.keys(identityBag).length > 0
        const { fusionDisplayAttribute, fusionIdentityAttribute } = this.schemas

        const configuredSchemaName = this.readAccountAttributeString(fusionAccount, fusionDisplayAttribute)
        const configuredSchemaId = this.readAccountAttributeString(fusionAccount, fusionIdentityAttribute)
        const identityName = this.hostingIdentityName(fusionAccount)
        const identityId = this.hostingIdentityId(fusionAccount, identityBag)

        const schemaName = configuredSchemaName ?? identityName ?? originId
        const schemaId = configuredSchemaId ?? identityId ?? originId

        const identityIdTrimmed = trimStr(identityId)
        const identityMatchesOrigin = identityIdTrimmed !== undefined && identityIdTrimmed === originId
        if (originSource === 'Identities' && identityHasData && identityMatchesOrigin) {
            return {
                ...identityBag,
                name: schemaName,
                source: { name: 'Identities' },
                schema: {
                    name: schemaName,
                    id: schemaId,
                },
                IIQDisabled: Boolean(fusionAccount.disabled),
            }
        }

        const managed = orderedAccounts.find((account) => getManagedAccountSnapshotKey(account) === originId)
        if (managed) return managed

        return undefined
    }

    private readAccountAttributeString(fusionAccount: FusionAccount, attributeName: string): string | undefined {
        return trimStr(fusionAccount.attributes[attributeName])
    }

    private hostingIdentityName(fusionAccount: FusionAccount): string | undefined {
        return trimStr(fusionAccount.name)
    }

    private hostingIdentityId(fusionAccount: FusionAccount, identity: Record<string, unknown>): string | undefined {
        return trimStr(fusionAccount.identityId) ?? trimStr(identity.id)
    }

    /**
     * Build a deterministic accounts array for attribute-definition context.
     *
     * Ordering rules:
     * 1) Sources are ordered by config.sources.
     * 2) Accounts within a source keep insertion order.
     * 3) Any non-configured sources are appended in map insertion order.
     */
    private getOrderedAccountsForContext(fusionAccount: FusionAccount): Record<string, any>[] {
        const { sources } = fusionAccount.attributeBag
        if (sources.size === 0) return fusionAccount.attributeBag.accounts

        const ordered: Record<string, any>[] = []
        const seenSources = new Set<string>()

        for (const sc of this.sourceConfigs) {
            const sourceAccounts = sources.get(sc.name)
            if (!sourceAccounts || sourceAccounts.length === 0) continue
            ordered.push(...sourceAccounts)
            seenSources.add(sc.name)
        }

        for (const [sourceName, sourceAccounts] of sources.entries()) {
            if (seenSources.has(sourceName) || sourceAccounts.length === 0) continue
            ordered.push(...sourceAccounts)
        }

        const mainAccountId = this.getMainAccountOverrideId(fusionAccount)
        if (!mainAccountId) return ordered

        const prioritizedIndex = ordered.findIndex((account) => getManagedAccountSnapshotKey(account) === mainAccountId)
        if (prioritizedIndex <= 0) return ordered

        const prioritizedAccount = ordered[prioritizedIndex]
        return [prioritizedAccount, ...ordered.slice(0, prioritizedIndex), ...ordered.slice(prioritizedIndex + 1)]
    }

    private getMainAccountOverrideId(fusionAccount: FusionAccount): string | undefined {
        return trimStr(fusionAccount.attributeBag.current[MAIN_ACCOUNT_ATTRIBUTE])
    }

    private getMainAccountContextAccount(
        fusionAccount: FusionAccount,
        sourceAttributeMap: Map<string, Record<string, any>[]>
    ): Record<string, any> | undefined {
        const mainAccountId = this.getMainAccountOverrideId(fusionAccount)
        if (!mainAccountId) return undefined

        return this.findAccountByIdInSourceMap(sourceAttributeMap, mainAccountId)
    }

    private findAccountByIdInSourceMap(
        sourceAttributeMap: Map<string, Record<string, any>[]>,
        accountId: string
    ): Record<string, any> | undefined {
        for (const accounts of sourceAttributeMap.values()) {
            const match = accounts.find((account) => getManagedAccountSnapshotKey(account) === accountId)
            if (match) return match
        }

        return undefined
    }

    // ------------------------------------------------------------------------
    // Private Map & Define Methods
    // ------------------------------------------------------------------------

    /**
     * Evaluate template expression and apply transformations
     */
    private evaluateTemplate(
        definition: AnyDefinition,
        context: RenderContext,
        accountName?: string,
        expressionOverride?: string
    ): string | undefined {
        const expression = expressionOverride ?? definition.expression
        if (!expression) {
            this.log.error(`Expression is required for attribute ${definition.name}`)
            return undefined
        }

        let value = evaluateVelocityTemplate(expression, context)
        if (!value) return undefined

        if (definition.trim) value = value.trim()
        if (definition.case) value = switchCase(value, definition.case)
        if (definition.spaces) value = removeSpaces(value)
        if (definition.normalize) value = normalize(value)
        if (definition.maxLength && value.length > definition.maxLength) {
            value = truncateResultToMaxLength(value, expression, context, definition.maxLength)
        }

        this.log.debug(`[${accountName}] ${definition.name} = ${value}`)

        return value
    }

    /**
     * Detect whether an expression references at least one Velocity variable token.
     * Examples: $name, ${name}. Excludes escaped tokens like \$name.
     */
    private hasVelocityVariableReference(expression: string): boolean {
        return VELOCITY_VAR_RE.test(expression)
    }

    /**
     * Generate a unique attribute value with uniqueness enforcement.
     *
     * Handles three modes via the same definition type:
     * - `$UUID` in expression: a v4 UUID is generated and injected into the Velocity context
     * - `useIncrementalCounter`: a persistent counter ($counter) increments on every use
     * - Default: collision-based disambiguation appends a non-persistent $counter on collision
     */
    private async generateUniqueAttributeValue(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>
    ): Promise<string | undefined> {
        const lockKey = `unique:${definition.name}`

        return await this.locks.withLock(lockKey, async () => {
            const registeredValues = this.getUniqueValues(definition.name)
            const maxAttempts = this.maxAttempts ?? defaults.maxAttempts

            const override = await this.requestCustomizerValue(
                CUSTOMIZER_OP_BEFORE_UNIQUE_GENERATION,
                definition,
                fusionAccount,
                context,
                registeredValues
            )
            if (override !== undefined) {
                registeredValues.add(override)
                return override
            }

            const generated = definition.useIncrementalCounter
                ? await this.generateWithIncrementalCounter(
                      definition,
                      fusionAccount,
                      context,
                      registeredValues,
                      maxAttempts
                  )
                : await this.generateWithCollisionDisambiguation(
                      definition,
                      fusionAccount,
                      context,
                      registeredValues,
                      maxAttempts
                  )

            if (generated === undefined) return undefined

            const replacement = await this.requestCustomizerValue(
                CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION,
                definition,
                fusionAccount,
                context,
                registeredValues,
                generated
            )
            if (replacement === undefined || replacement === generated) return generated

            // The generators already reserved `generated`; move the reservation to the override.
            registeredValues.delete(generated)
            registeredValues.add(replacement)
            return replacement
        })
    }

    /**
     * Offer a unique-attribute generation decision to an attached customizer.
     *
     * Returns an override value, or undefined to continue with normal generation — which covers
     * every failure mode: no customizer attached, no handler registered, the handler threw, or
     * it returned an empty/non-string value. A customizer must never be able to abort an
     * aggregation.
     *
     * Once a handler answers it is the authoritative source for the value, so the response is
     * deliberately NOT second-guessed:
     * - Collision detection does not apply. Reusing a registered value is a legitimate outcome
     *   (it is logged), because overriding what the connector would have produced is the whole
     *   point of the hook.
     * - {@link applyUniqueValueOutputTransforms} is not applied — silently case-folding the
     *   value or truncating it to `maxLength` would rewrite the handler's decision.
     *
     * @param generatedValue - For the After hook, the connector's own value; used only to
     *                         recognize an unchanged response
     */
    private async requestCustomizerValue(
        operationId: string,
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: RenderContext,
        registeredValues: Set<string>,
        generatedValue?: string
    ): Promise<string | undefined> {
        // Cheap exit before building a payload — the common case is no customizer at all.
        if (!this.customizer.isAvailable) return undefined

        const payload: UniqueGenerationCustomizerPayload = {
            attributeName: definition.name,
            definition,
            account: {
                name: fusionAccount.name,
                nativeIdentity: fusionAccount.nativeIdentityOrUndefined,
                sourceName: fusionAccount.sourceName,
                identityId: fusionAccount.identityId,
                originSource: fusionAccount.originSource,
                originAccountId: fusionAccount.originAccountId,
                isIdentity: fusionAccount.isIdentity,
                needsReset: fusionAccount.needsReset,
                attributes: { ...fusionAccount.attributes },
            },
            renderContext: this.toSerializableRenderContext(context),
            registeredValueCount: registeredValues.size,
            ...(generatedValue !== undefined ? { generatedValue } : {}),
        }

        const response = await this.customizer.invoke<unknown>(operationId, payload)
        const candidate = this.readCustomizerValue(response)
        if (candidate === undefined) return undefined

        if (!isValidAttributeValue(candidate)) {
            this.log.warn(
                `${operationId} returned an empty value for attribute ${definition.name}, using generated value`
            )
            return undefined
        }

        // A customizer is the authoritative source once it answers, so a value that is already
        // registered is still honoured — reuse can be exactly what the handler intends. Surface
        // it at info level so the deliberate duplicate is visible in the logs.
        if (candidate !== generatedValue && registeredValues.has(candidate)) {
            this.log.info(
                `${operationId} reused already-registered value "${candidate}" for attribute ${definition.name}`
            )
        }

        return candidate
    }

    /**
     * Read the override out of a customizer response. Handlers conventionally return the mutated
     * input, so `{ value }` is the natural shape; a bare string is accepted for convenience.
     */
    private readCustomizerValue(response: unknown): string | undefined {
        if (typeof response === 'string') return response
        if (response && typeof response === 'object') {
            const value = (response as { value?: unknown }).value
            if (typeof value === 'string') return value
        }
        return undefined
    }

    /**
     * Shallow copy of the Velocity context with function values removed, so it can cross the
     * customizer boundary. Drops `$isUnique` (installed per definition in
     * {@link processUniqueDefinition}); the remaining members are already plain snapshots, so
     * no deep clone is taken — `accounts` and `sources` can be large.
     */
    private toSerializableRenderContext(context: RenderContext): Record<string, any> {
        const serializable: Record<string, any> = {}
        for (const [key, value] of Object.entries(context)) {
            if (typeof value === 'function') continue
            serializable[key] = value
        }
        return serializable
    }

    /**
     * Incremental counter mode: a persistent counter always increments (like old 'counter' type).
     */
    private async generateWithIncrementalCounter(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>,
        registeredValues: Set<string>,
        maxAttempts: number
    ): Promise<string | undefined> {
        const stateWrapper = this.getStateWrapper()
        const counterFn = stateWrapper.getCounter(definition.name)
        const digits = definition.digits ?? 1

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const counterValue = await counterFn()
            context.counter = padNumber(counterValue, digits)

            this.injectUUIDIfNeeded(definition, context)

            const value = this.evaluateTemplate(definition, context, fusionAccount.name)
            if (!value) return undefined

            if (!registeredValues.has(value)) {
                registeredValues.add(value)
                this.log.debug(`Generated unique value (incremental) for attribute ${definition.name}: ${value}`)
                return value
            }

            this.log.debug(`Collision on incremental counter for ${definition.name}, retrying (attempt ${attempt + 1})`)
        }

        this.log.error(`Failed to generate unique value for attribute ${definition.name} after ${maxAttempts} attempts`)
        return undefined
    }

    /**
     * Collision disambiguation mode: first attempt has empty $counter; on collision a
     * non-persistent counter increments (like old 'unique' type).
     */
    private async generateWithCollisionDisambiguation(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>,
        registeredValues: Set<string>,
        maxAttempts: number
    ): Promise<string | undefined> {
        const counter = StateWrapper.getCounter()
        const digits = definition.digits ?? 1

        // Ensure expression has $counter for disambiguation fallback (local only; do not mutate config).
        // Skip auto-append for UUID-based expressions because UUID already
        // provides uniqueness and appending counter can mutate intent.
        // Skip when the template uses Velocity directives (#if, #set, …): appending `$counter`
        // after `#end` breaks parsing and would defeat $isUnique-based expressions.
        let effectiveExpression = definition.expression ?? ''
        if (
            effectiveExpression &&
            !effectiveExpression.includes('$counter') &&
            !effectiveExpression.includes('${counter}') &&
            !effectiveExpression.includes('$UUID') &&
            !effectiveExpression.includes('${UUID}')
        ) {
            effectiveExpression = `${effectiveExpression}$counter`
        }
        context.counter = ''

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            this.injectUUIDIfNeeded(definition, context)

            const value = this.evaluateTemplate(definition, context, fusionAccount.name, effectiveExpression)
            if (!value) return undefined

            if (!registeredValues.has(value)) {
                registeredValues.add(value)
                this.log.debug(`Generated unique value for attribute ${definition.name}: ${value}`)
                return value
            }

            this.log.debug(`Value ${value} already exists for unique attribute: ${definition.name}`)
            context.counter = padNumber(counter(), digits)
            this.log.debug(`Regenerating unique attribute: ${definition.name} (attempt ${attempt + 1})`)
        }

        this.log.error(`Failed to generate unique value for attribute ${definition.name} after ${maxAttempts} attempts`)
        return undefined
    }

    /**
     * If the expression references $UUID or ${UUID}, generate a fresh v4 UUID
     * and inject it into the Velocity context.
     */
    private injectUUIDIfNeeded(definition: UniqueAttributeDefinition, context: Record<string, any>): void {
        if (
            definition.expression &&
            (definition.expression.includes('$UUID') || definition.expression.includes('${UUID}'))
        ) {
            context.UUID = uuidv4()
        }
    }

    /**
     * Existing Fusion accounts reconstructed from the Fusion source keep previous
     * attributes populated. New in-run accounts leave this bag empty.
     */
    private isExistingFusionAccount(fusionAccount: FusionAccount): boolean {
        return Object.keys(fusionAccount.previousAttributes ?? {}).length > 0
    }

    /**
     * When a fusion identity/display definition evaluates to no value, use stable
     * schema-driven defaults so the account is not left with a cleared id/name.
     */
    private fusionAttributeSafeDefault(
        attributeName: string,
        fusionAccount: FusionAccount,
        fusionIdentityAttribute: string,
        fusionDisplayAttribute: string
    ): string | undefined {
        if (attributeName === fusionIdentityAttribute) {
            const fromTop = trimStr(fusionAccount.originAccountId)
            if (fromTop !== undefined) return fromTop
            const fromOrigin = trimStr(fusionAccount.attributes[ORIGIN_ACCOUNT_ATTRIBUTE])
            if (fromOrigin !== undefined) return fromOrigin
            return uuidv4()
        }
        if (attributeName === fusionDisplayAttribute) {
            return trimStr(fusionAccount.name)
        }
        return undefined
    }

    // ------------------------------------------------------------------------
    // Private Attribute Processing Flow
    // ------------------------------------------------------------------------

    /**
     * Process a single normal attribute definition for an account.
     *
     * Immutability guards for identity-linked accounts:
     * - **id** (fusionIdentityAttribute): skipped entirely to prevent
     *   disconnection between the existing Fusion account and subsequent updates.
     * - **name** (fusionDisplayAttribute): locked to the hosting identity's name to
     *   prevent destruction of the identity linkage.
     *
     * Generated values are written to both the account's attribute bag and the shared
     * Velocity context, making them available to subsequent definitions in the same run.
     */
    private async processNormalDefinition(
        definition: NormalAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>
    ): Promise<void> {
        const { name, refresh } = definition
        if (name === ORIGIN_ACCOUNT_ATTRIBUTE || name === ORIGIN_SOURCE_ATTRIBUTE) return
        const { fusionIdentityAttribute, fusionDisplayAttribute } = this.schemas
        const needsRefresh = fusionAccount.needsRefresh || fusionAccount.needsReset || refresh
        const hasValue = isValidAttributeValue(fusionAccount.attributes[name])
        const canResetDisplay = fusionAccount.needsReset && name === fusionDisplayAttribute
        const shouldKeepIdentityImmutable = this.isExistingFusionAccount(fusionAccount) && fusionAccount.isIdentity

        if (hasValue && !needsRefresh) return

        if (hasValue && name === fusionIdentityAttribute && shouldKeepIdentityImmutable) {
            return
        }

        if (hasValue && name === fusionDisplayAttribute && !canResetDisplay) {
            return
        }

        if (shouldKeepIdentityImmutable && name === fusionIdentityAttribute) {
            this.log.warn(`Skipping change of nativeIdentity for account: ${fusionAccount.name}`)
            return
        }

        if (fusionAccount.isIdentity && name === fusionDisplayAttribute) {
            const label = this.hostingIdentityName(fusionAccount)
            if (label) {
                this.log.info(`Setting identity name for attribute: ${name} for account: ${fusionAccount.name}`)
                fusionAccount.attributes[name] = label
            }
            return
        }

        const value = this.evaluateTemplate(definition, context, fusionAccount.name)
        if (value === undefined) {
            const fallback = this.fusionAttributeSafeDefault(
                name,
                fusionAccount,
                fusionIdentityAttribute,
                fusionDisplayAttribute
            )
            if (fallback !== undefined) {
                fusionAccount.attributes[name] = fallback
                context[name] = fallback
                return
            }
            // Clear attribute when expression fails (e.g. unresolved variables), so we do not
            // retain a literal template string that may have come from attribute mapping.
            delete fusionAccount.attributes[name]
            delete context[name]
            return
        }
        fusionAccount.attributes[name] = value
        context[name] = value
    }

    /**
     * Process a single unique attribute definition for an account.
     *
     * Existing unique values are preserved unless `needsReset` is set (triggered by
     * re-enabling a disabled account). This prevents accidental regeneration of stable
     * identifiers. Use regular unique attribute schemas to define changeable attributes
     * (e.g. usernames) that should be regenerated on enable/disable cycles.
     *
     * Immutability guards for identity-linked accounts:
     * - **nativeIdentity** (fusionIdentityAttribute): skipped entirely to prevent
     *   disconnection between the existing Fusion account and subsequent updates.
     * - **name** (fusionDisplayAttribute): locked to the hosting identity's name to
     *   prevent destruction of the identity linkage.
     *
     * Generated values are written to both the account's attribute bag and the shared
     * Velocity context, making them available to subsequent unique definitions.
     */
    private async processUniqueDefinition(
        definition: UniqueAttributeDefinition,
        fusionAccount: FusionAccount,
        context: Record<string, any>
    ): Promise<void> {
        const { name } = definition
        if (name === ORIGIN_ACCOUNT_ATTRIBUTE || name === ORIGIN_SOURCE_ATTRIBUTE) return

        const { fusionIdentityAttribute, fusionDisplayAttribute } = this.schemas
        const existingValue = fusionAccount.attributes[name]
        const hasValue = isValidAttributeValue(existingValue)
        const isFusionIdentityAttribute = name === fusionIdentityAttribute
        const isFusionDisplayAttribute = name === fusionDisplayAttribute
        const isExistingIdentity = fusionAccount.isIdentity

        const prevIsUnique = context.isUnique
        context.isUnique = (value: unknown) => this.isUniqueTemplateValue(definition, value, context)
        try {
            // Don't regenerate unique values if the account is not being reset
            if (hasValue && !fusionAccount.needsReset) {
                const valueStr = String(existingValue)
                this.getUniqueValues(name).add(valueStr)
                if (definition.useIncrementalCounter) {
                    await this.seedIncrementalCounterFromExistingValue(definition, valueStr)
                }
                return
            }

            // Don't regenerate Fusion identity attribute if the account is an existing identity
            if (hasValue && isFusionIdentityAttribute && isExistingIdentity) {
                this.getUniqueValues(name).add(String(fusionAccount.attributes[name]))
                return
            }

            // Set identity name for display attribute if the account is an identity
            if (fusionAccount.isIdentity && isFusionDisplayAttribute) {
                const label = this.hostingIdentityName(fusionAccount)
                if (label) {
                    this.log.info(`Setting identity name for attribute: ${name} for account: ${fusionAccount.name}`)
                    fusionAccount.attributes[name] = label
                }
                return
            }

            if (hasValue) {
                this.getUniqueValues(name).delete(String(existingValue))
            }

            const value = await this.generateUniqueAttributeValue(definition, fusionAccount, context)
            if (value === undefined) {
                const fallback = this.fusionAttributeSafeDefault(
                    name,
                    fusionAccount,
                    fusionIdentityAttribute,
                    fusionDisplayAttribute
                )
                if (fallback !== undefined) {
                    this.getUniqueValues(name).add(fallback)
                    fusionAccount.attributes[name] = fallback
                    context[name] = fallback
                    return
                }
                // Clear attribute when expression fails (e.g. unresolved variables)
                delete fusionAccount.attributes[name]
                delete context[name]
                return
            }
            fusionAccount.attributes[name] = value
            context[name] = value
        } finally {
            if (prevIsUnique !== undefined) {
                context.isUnique = prevIsUnique
            } else {
                delete context.isUnique
            }
        }
    }

    /**
     * Velocity helper for unique attribute templates: true if the transformed candidate
     * is not in the registered-in-use set for this attribute.
     *
     * Unique values are only (re)generated when missing or on reset; on reset,
     * {@link unregisterUniqueAttributes} removes this account's prior value from the set
     * before evaluation, so the registry reflects other accounts only during generation.
     */
    private isUniqueTemplateValue(
        definition: UniqueAttributeDefinition,
        value: unknown,
        context: RenderContext
    ): boolean {
        if (missing(value)) return false
        const raw = String(value)

        const transformed = this.applyUniqueValueOutputTransforms(definition, raw, definition.expression, context)
        if (transformed === '') return false

        return !this.getUniqueValues(definition.name).has(transformed)
    }

    /** Match {@link evaluateTemplate} post-velocity transforms for a unique definition (including maxLength). */
    private applyUniqueValueOutputTransforms(
        definition: UniqueAttributeDefinition,
        raw: string,
        expression: string | undefined,
        context: RenderContext
    ): string {
        let s = raw
        if (definition.trim) s = s.trim()
        if (definition.case) s = switchCase(s, definition.case)
        if (definition.spaces) s = removeSpaces(s)
        if (definition.normalize) s = normalize(s)
        if (definition.maxLength && s.length > definition.maxLength) {
            s = expression
                ? truncateResultToMaxLength(s, expression, context, definition.maxLength)
                : s.substring(0, definition.maxLength)
        }
        return s
    }

    private async seedIncrementalCounterFromExistingValue(
        definition: UniqueAttributeDefinition,
        value: string
    ): Promise<void> {
        const match = value.match(/(\d+)\s*$/)
        if (!match) return
        const parsed = Number.parseInt(match[1], 10)
        if (!Number.isFinite(parsed) || parsed <= 0) return

        const stateWrapper = this.getStateWrapper()
        const key = definition.name
        const lockKey = `counter:${key}`
        await this.locks.withLock(lockKey, async () => {
            const current = stateWrapper.state.get(key)
            if (current === undefined) {
                const start = definition.counterStart ?? 1
                await stateWrapper.initCounter(key, start)
            }
            const nextCurrent = stateWrapper.state.get(key) ?? 0
            if (parsed > nextCurrent) {
                stateWrapper.state.set(key, parsed)
            }
        })
    }
}

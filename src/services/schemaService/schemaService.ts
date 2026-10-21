import { AccountSchema, Attributes, SchemaAttribute } from '@sailpoint/connector-sdk'
import {
    AttributeMap,
    AttributeMergeMode,
    DefaultAttributeMergeMode,
    FusionConfig,
    NormalAttributeDefinition,
    SourceConfig,
    UniqueAttributeDefinition,
} from '../../model/config'
import { FusionAttribute } from '../../data/schema'
import { LogService } from '../logService'
import { SourceService } from '../sourceService'
import { IdentityService } from '../identityService'
import { assert } from '../../utils/assert'
import { compact } from '../../utils/safeRead'
import { fusionAccountSchemaAttributes } from '../../data/schema'
import { dedupeSchemaAttributesByName, isAccountSchema, apiSchemaToAccountSchema } from './helpers'
import { promiseAllBatched } from '../fusionService/collections'

/**
 * Service for managing account schema, dynamic schema building.
 */
export class SchemaService {
    private fusionAccountSchemaValue?: AccountSchema
    private attributeMap: Map<string, AttributeMap> = new Map()
    private fusionSchemaAttributeNames: string[] = []
    private fusionSchemaAttributeMap: Map<string, SchemaAttribute> = new Map()
    private accountSchemasCache = new Map<string, Promise<AccountSchema>>()
    private readonly attributeMerge: DefaultAttributeMergeMode
    private readonly normalAttributeDefinitions: NormalAttributeDefinition[]
    private readonly uniqueAttributeDefinitions: UniqueAttributeDefinition[]
    private readonly sourceConfigs: SourceConfig[]

    /**
     * @param config - Fusion configuration containing attribute merge strategy and definitions
     * @param log - Logger instance
     * @param sources - Source service for fetching source schemas
     * @param identities - Identity service for identity-related API calls and attribute retrieval
     */
    constructor(
        private config: FusionConfig,
        private log: LogService,
        private sources: SourceService,
        private identities: IdentityService
    ) {
        this.attributeMerge = config.attributeMerge
        this.normalAttributeDefinitions = config.normalAttributeDefinitions ?? []
        this.uniqueAttributeDefinitions = config.uniqueAttributeDefinitions ?? []
        this.sourceConfigs = config.sources ?? []
        this.attributeMap = new Map(config.attributeMaps?.map((x) => [x.newAttribute, x]) ?? [])
    }

    /**
     * Filters an attribute bag down to only the attributes defined in the fusion account schema,
     * casting each value to match its schema-defined type and cardinality.
     *
     * Attributes absent from the bag (`undefined`) are omitted so the subset never invents keys
     * for the rest of the schema. A present `null` is cast per the schema definition and emitted
     * as `null`; nullish-key omission is enforced on the Fusion account attribute bags at build
     * time (see `FusionAccount.applyFactorySeed` / `setMappedAttributes`), not here.
     * After cast, blank strings and empty arrays are omitted.
     * Blank string elements are removed from a multi-valued value first; the attribute is omitted when
     * none remain. `id` and `name` are still included when the emitted value is a blank string.
     * The input attribute bag is never mutated.
     *
     * @param attributes - The full attribute bag to filter, or null
     * @returns A new object containing the schema attributes sent to ISC
     */
    public getFusionAttributeSubset(attributes: Attributes | null): Attributes {
        if (!attributes) return {}

        const fusionAttributes: Attributes = {}
        for (const attribute of this.fusionSchemaAttributeNames) {
            const value = attributes?.[attribute]
            if (value === undefined) continue
            const schemaDef = this.fusionSchemaAttributeMap.get(attribute)
            const casted = schemaDef ? this.castAttributeValue(value, schemaDef) : value
            const emitted = this.emittedPlatformValue(attribute, casted)
            if (emitted === undefined) continue
            fusionAttributes[attribute] = emitted
        }
        return fusionAttributes
    }

    /**
     * Returns the value to assign on the platform bag, or `undefined` when the attribute should be omitted.
     * Blank strings and arrays that are empty after blank string elements are removed are omitted.
     * `id` and `name` are still returned when the emitted value is a blank string.
     * Filtered arrays are copies; `casted` is not mutated.
     */
    private emittedPlatformValue(attribute: string, casted: any): any {
        if (Array.isArray(casted)) {
            const filtered = casted.filter((element) => !this.isBlankString(element))
            return filtered.length === 0 ? undefined : filtered
        }
        if (this.isBlankString(casted) && attribute !== 'id' && attribute !== 'name') return undefined
        return casted
    }

    /** A string with no characters, or only whitespace. */
    private isBlankString(value: unknown): boolean {
        return typeof value === 'string' && value.trim() === ''
    }

    /**
     * Cast an attribute value to match its schema-defined type and cardinality.
     * - For single-valued attributes (`multi` is false/undefined): arrays are joined with ", ".
     * - For multi-valued attributes (`multi` is true): scalar values are wrapped in an array.
     * - Values are cast to the target type (`string`, `boolean`, `int`/`long`).
     */
    private castAttributeValue(
        value: any,
        schemaDef: SchemaAttribute
    ): any {
        if (value === null || value === undefined) return null

        const isMulti = schemaDef.multi === true
        const type = (schemaDef.type ?? 'string').toLowerCase()

        if (isMulti) {
            // Multi-valued: ensure the value is an array, filter null/undefined, then cast each element
            const arr = Array.isArray(value) ? value : [value]
            return compact(arr).map((v) => {
                if (type === 'string' && typeof v === 'object' && v !== null) {
                    return JSON.stringify(v)
                }
                return this.castScalar(v as boolean | string | number, type)
            })
        } else {
            if (type === 'string') {
                if (typeof value === 'object' && value !== null) {
                    if (Array.isArray(value)) {
                        const isObjectArray = value.some(v => typeof v === 'object' && v !== null)
                        if (isObjectArray) {
                            return JSON.stringify(value)
                        } else {
                            return value.join(',')
                        }
                    } else {
                        return JSON.stringify(value)
                    }
                } else {
                    return String(value)
                }
            } else {
                const scalar = Array.isArray(value) ? value.join(',') : value
                return this.castScalar(scalar as boolean | string | number, type)
            }
        }
    }

    /**
     * Cast a single scalar value to the target schema type.
     */
    private castScalar(value: boolean | string | number, type: string): boolean | string | number {
        switch (type) {
            case 'boolean':
                if (typeof value === 'boolean') return value
                if (typeof value === 'string') return value.toLowerCase() === 'true'
                return value !== 0
            case 'int':
            case 'long': {
                if (typeof value === 'number') return value
                if (typeof value === 'boolean') return value ? 1 : 0
                const num = Number(value)
                return isNaN(num) ? 0 : num
            }
            case 'string':
            default:
                return String(value)
        }
    }

    /** Fetches the fusion account schema from the fusion source via the API. */
    private async fetchFusionAccountSchema(): Promise<void> {
        this.fusionAccountSchemaValue = await this.fetchAccountSchema(this.sources.fusionSourceId!)
    }

    /** The identity attribute name from the fusion account schema (e.g. "id"). */
    public get fusionIdentityAttribute(): string {
        return this.fusionAccountSchema.identityAttribute
    }

    /** The display attribute name from the fusion account schema (e.g. "name"). */
    public get fusionDisplayAttribute(): string {
        return this.fusionAccountSchema.displayAttribute
    }

    /** Base fusion attribute names that must always be included in the subset (e.g. reviews for reviewers). */
    private static readonly BASE_FUSION_ATTRIBUTE_NAMES = fusionAccountSchemaAttributes
        .map((a) => a.name!)
        .filter(Boolean)

    /**
     * Sets the fusion account schema, either from a provided schema object or by
     * fetching it from the fusion source. Also builds internal lookup maps for
     * attribute names and schema definitions.
     *
     * @param accountSchema - The schema to use, or undefined to fetch from the fusion source
     */
    public async setFusionAccountSchema(accountSchema: AccountSchema | undefined): Promise<void> {
        if (accountSchema) {
            this.fusionAccountSchemaValue = accountSchema
        } else {
            await this.fetchFusionAccountSchema()
        }
        this.fusionAccountSchemaValue = {
            ...this.fusionAccountSchema,
            attributes: dedupeSchemaAttributesByName(this.fusionAccountSchema.attributes, this.log),
        }
        const fromSchema = this.fusionAccountSchema.attributes.map((x) => x.name!).filter(Boolean)
        this.fusionSchemaAttributeNames = [
            ...new Set([...fromSchema, ...SchemaService.BASE_FUSION_ATTRIBUTE_NAMES]),
        ].sort()

        // Build a lookup map from attribute name to its SchemaAttribute definition
        this.fusionSchemaAttributeMap = new Map()
        for (const attr of this.fusionAccountSchema.attributes) {
            if (attr.name) {
                this.fusionSchemaAttributeMap.set(attr.name, attr)
            }
        }
        // Also include base fusion attributes
        for (const attr of fusionAccountSchemaAttributes) {
            if (attr.name && !this.fusionSchemaAttributeMap.has(attr.name)) {
                this.fusionSchemaAttributeMap.set(attr.name, attr)
            }
        }
    }

    /** Fetches the fusion account schema from the fusion source and sets internal lookup maps. */
    public async loadFusionAccountSchemaFromSource(): Promise<void> {
        await this.setFusionAccountSchema(undefined)
    }

    /**
     * Get schema - build dynamically if not loaded
     */
    private get fusionAccountSchema(): AccountSchema {
        assert(this.fusionAccountSchemaValue, 'Fusion account schema must be set first')

        return this.fusionAccountSchemaValue
    }

    /**
     * Fetches and converts the account schema for a given source.
     *
     * @param id - The source ID to fetch the schema for
     * @returns The converted AccountSchema
     */
    private async fetchAccountSchema(id: string): Promise<AccountSchema> {
        let promise = this.accountSchemasCache.get(id)
        if (!promise) {
            promise = (async () => {
                const sourceSchemas = await this.sources.listSourceSchemas(id)
                const apiAccountSchema = sourceSchemas.find(isAccountSchema)
                assert(apiAccountSchema, `Account schema not found for source ${id}`)
                const accountSchema = apiSchemaToAccountSchema(apiAccountSchema)
                return accountSchema
            })()
            this.accountSchemasCache.set(id, promise)
        }
        return promise
    }

    /**
     * Extracts schema attributes from a source's account schema, applying the configured
     * attribute merge strategy (first/list/concatenate) to set multi-value cardinality.
     *
     * @param schema - The source account schema
     * @param sourceName - The source name (used for default descriptions)
     * @returns Array of schema attributes with merge-aware cardinality
     */
    private getAccountSchemaAttributes(schema: AccountSchema, sourceName: string): SchemaAttribute[] {
        const attributes: SchemaAttribute[] = []
        for (const attribute of schema.attributes) {
            const attributeMap = this.attributeMap.get(attribute.name!)
            if (attributeMap) {
                if (attributeMap.attributeMerge === AttributeMergeMode.List) {
                    attribute.multi = true
                } else {
                    attribute.multi = false
                }
            } else {
                if (this.attributeMerge === AttributeMergeMode.List) {
                    attribute.multi = true
                } else {
                    attribute.multi = false
                }
            }
            attribute.description = attribute.description || `${attribute.name} from ${sourceName}`
            attributes.push(attribute)
        }

        return attributes
    }

    /** Builds schema attributes for configured attribute mappings. */
    private getAttributeMappingAttributes(): SchemaAttribute[] {
        const attributes: SchemaAttribute[] = []
        for (const attributeMap of this.attributeMap.values()) {
            if (attributeMap.attributeMerge === AttributeMergeMode.List) {
                attributes.push({
                    name: attributeMap.newAttribute,
                    description: `Created from ${attributeMap.existingAttributes.join(', ')}`,
                    type: 'string',
                    multi: true,
                    entitlement: false,
                })
            } else {
                attributes.push({
                    name: attributeMap.newAttribute,
                    description: `Created from ${attributeMap.existingAttributes.join(', ')}`,
                    type: 'string',
                    multi: false,
                    entitlement: false,
                })
            }
        }

        return attributes
    }

    /** Builds schema attributes for configured attribute definitions (normal + unique). */
    private getAttributeDefinitionAttributes(): SchemaAttribute[] {
        const allDefinitions = [...this.normalAttributeDefinitions, ...this.uniqueAttributeDefinitions]

        return allDefinitions
            .filter((x) => x.name)
            .map((x) => ({
                name: x.name,
                description: x.expression ? `Created from expression: ${x.expression}` : '',
                type: 'string',
                multi: false,
                entitlement: false,
            }))
    }

    /** Returns the static base fusion schema attributes (status, actions, reviews, etc.). */
    private listFusionAttributes(): SchemaAttribute[] {
        return fusionAccountSchemaAttributes
    }

    /**
     * Lists all attribute names defined in the current fusion account schema.
     *
     * @returns Array of attribute name strings
     */
    public listSchemaAttributeNames(): string[] {
        return this.fusionAccountSchema.attributes.map((x) => x.name!)
    }

    /**
     * Returns all schema attributes from the fusion account schema (identity, display,
     * and attribute definitions).
     *
     * @returns Array of SchemaAttribute objects
     */
    public getSchemaAttributes(): SchemaAttribute[] {
        return this.fusionAccountSchema.attributes
    }

    /**
     * Collects all attribute names from managed source account schemas.
     * Used for reverse correlation overlap validation.
     */
    public async getManagedSourceSchemaAttributeNames(): Promise<Set<string>> {
        const names = new Set<string>()
        const { managedSources } = this.sources

        // Fetch schemas from managed sources concurrently to resolve sequential N+1 bottleneck
        const schemas = await promiseAllBatched(
            managedSources,
            async (source) => {
                try {
                    return await this.fetchAccountSchema(source.id)
                } catch {
                    return undefined
                }
            },
            50
        )

        for (const schema of schemas) {
            if (schema) {
                for (const attr of schema.attributes) {
                    if (attr.name) names.add(attr.name.toLowerCase())
                }
            }
        }
        return names
    }

    /**
     * Fetches and converts identity attributes into SchemaAttributes.
     */
    private async fetchIdentitySchemaAttributes(): Promise<SchemaAttribute[]> {
        return this.identities.fetchIdentitySchemaAttributes()
    }

    /**
     * Builds the fusion account schema from attribute definitions, attribute mappings,
     * managed account source schemas, and identity schema attributes (when identity scope
     * is enabled). Used for schema discovery.
     *
     * Attribute sources are merged in that order, so case-insensitive name collisions
     * resolve in favor of the earliest source: definitions outrank mappings, both outrank
     * managed account source schemas, and identity schema attributes are considered last.
     * Fusion base structural attributes precede all of these; reverse-correlation
     * attributes follow them.
     *
     * @returns The dynamically built AccountSchema
     */
    public async buildDynamicSchema(): Promise<AccountSchema> {
        this.log.debug('Building dynamic schema.')
        const mergedAttributes: SchemaAttribute[] = []
        const pushAttribute = (attribute: SchemaAttribute) => {
            if (attribute.name && attribute.name.trim() !== '') {
                mergedAttributes.push(attribute)
            }
        }

        // Define static attributes
        const fusionAttributes = this.listFusionAttributes()

        // Define attribute map attributes
        const attributeMappingAttributes = this.getAttributeMappingAttributes()

        // Define attribute definition attributes
        const attributeDefinitionAttributes = this.getAttributeDefinitionAttributes()

        // Define account schema attributes
        const { managedSources } = this.sources

        const accountSchemaAttributes: SchemaAttribute[] = []
        // Fetch schemas from all managed sources sequentially to avoid concurrent API throttling
        const schemaResults: SchemaAttribute[][] = []
        for (const source of managedSources.reverse()) {
            const accountSchema = await this.fetchAccountSchema(source.id)
            schemaResults.push(this.getAccountSchemaAttributes(accountSchema, source.name))
        }
        for (const attributes of schemaResults) {
            accountSchemaAttributes.push(...attributes)
        }

        // Define identity schema attributes when identities are in scope
        const identitySchemaAttributes: SchemaAttribute[] = []
        if (this.config.includeIdentities !== false) {
            try {
                const attrs = await this.fetchIdentitySchemaAttributes()
                identitySchemaAttributes.push(...attrs)
            } catch (err) {
                this.log.error(
                    `Failed to fetch identity attributes: ${err instanceof Error ? err.message : String(err)}`
                )
            }
        }

        // Attribute-source order defines case-insensitive collision precedence: dedupe keeps the
        // first variant, so user-configured definitions outrank mappings, both outrank managed
        // account source schemas, and identity schema attributes are considered last.
        fusionAttributes.forEach(pushAttribute)
        attributeDefinitionAttributes.forEach(pushAttribute)
        attributeMappingAttributes.forEach(pushAttribute)
        accountSchemaAttributes.forEach(pushAttribute)
        identitySchemaAttributes.forEach(pushAttribute)

        // Add reverse correlation attributes from sources configured with correlationMode 'reverse'
        for (const sc of this.sourceConfigs) {
            if (sc.correlationMode === 'reverse' && sc.correlationAttribute) {
                pushAttribute({
                    name: sc.correlationAttribute,
                    description: sc.correlationDisplayName ?? sc.correlationAttribute,
                    type: 'string',
                    multi: false,
                })
            }
        }

        return {
            displayAttribute: 'name',
            identityAttribute: 'id',
            groupAttribute: FusionAttribute.Actions,
            attributes: dedupeSchemaAttributesByName(mergedAttributes, this.log),
        }
    }
}

import { FusionAccount } from '../../model/account'
import { FusionConfig, SourceConfig, AttributeMap, DefaultAttributeMergeMode } from '../../model/config'
import { LogService } from '../logService'
import { FusionAttribute } from '../../data/schema'
import { FusionRun } from '../../model/fusionRun'
import { Attributes } from '@sailpoint/connector-sdk'
import { AttributeMappingConfig } from './types'
import { processAttributeMapping, buildAttributeMappingConfig, DESIGNATED_SNAPSHOT_UNAVAILABLE } from './helpers'
import { hasValue, isNullish, trimStr } from '../../utils/safeRead'
import { getManagedAccountSnapshotKey } from '../../utils/velocityAccountSnapshot'
import { IDENTITIES_SOURCE_NAME } from '../../model/fusionAccount'

export interface MapAttributesOptions {
    onlyTargets?: ReadonlySet<string>
}

const IMPLICIT_KEY_DENYLIST = new Set<string>([
    ...Object.values(FusionAttribute),
    'id',
    'name',
    'source',
    'schema',
    'IIQDisabled',
])

function buildSnapshotIndex(sourceAttributeMap: Map<string, Attributes[]>): Map<string, Attributes> {
    const index = new Map<string, Attributes>()
    for (const accounts of sourceAttributeMap.values()) {
        for (const account of accounts) {
            const key = getManagedAccountSnapshotKey(account)
            const id = trimStr(account?._id)
            if (key && !index.has(key)) index.set(key, account)
            if (id && !index.has(id)) index.set(id, account)
        }
    }
    return index
}

function collectDefinitionNames(
    ...definitionLists: (readonly ({ name?: string } | undefined)[] | undefined)[]
): ReadonlySet<string> {
    const names = new Set<string>()
    for (const definitions of definitionLists) {
        for (const def of definitions ?? []) {
            const name = trimStr(def?.name)
            if (name) names.add(name)
        }
    }
    return names
}

function isImplicitCandidateKey(
    key: string,
    explicitTargets: ReadonlySet<string>,
    uniqueDefinitionNames: ReadonlySet<string>
): boolean {
    return !IMPLICIT_KEY_DENYLIST.has(key) && !explicitTargets.has(key) && !uniqueDefinitionNames.has(key)
}

/**
 * Implicit Map candidates: live-snapshot keys union `attributeBag.current` keys,
 * minus explicit mapping targets, Unique definition names, and the control denylist.
 * Only Unique definition names are excluded here, so they are neither merged nor cleared;
 * Normal definition names stay candidates so a same-named snapshot key still merges.
 * An empty merge never deletes a definition-owned name — that suppression lives in
 * `applyMappedValue`, not in this filter.
 */
function collectImplicitCandidateKeys(
    sourceAttributeMap: Map<string, Attributes[]>,
    currentBag: Attributes,
    explicitTargets: ReadonlySet<string>,
    uniqueDefinitionNames: ReadonlySet<string>
): string[] {
    const names = new Set<string>()
    for (const accounts of sourceAttributeMap.values()) {
        for (const account of accounts) {
            if (!account || typeof account !== 'object') continue
            for (const key of Object.keys(account)) {
                if (isImplicitCandidateKey(key, explicitTargets, uniqueDefinitionNames)) {
                    names.add(key)
                }
            }
        }
    }
    for (const key of Object.keys(currentBag ?? {})) {
        if (isImplicitCandidateKey(key, explicitTargets, uniqueDefinitionNames)) {
            names.add(key)
        }
    }
    return [...names]
}

export class MappingService {
    private cachedAttributeMappingConfig?: Map<string, AttributeMappingConfig>
    private readonly attributeMaps?: AttributeMap[]
    private readonly attributeMerge: DefaultAttributeMergeMode
    private readonly sourceConfigs: SourceConfig[]
    private readonly sourceOrder: string[]
    private readonly mappingTargetNames: string[]
    private readonly includeIdentities: boolean
    private readonly uniqueDefinitionNames: ReadonlySet<string>
    private readonly definitionOwnedNames: ReadonlySet<string>

    constructor(config: FusionConfig, _log: LogService) {
        this.attributeMaps = config.attributeMaps
        this.attributeMerge = config.attributeMerge
        this.sourceConfigs = config.sources
        this.sourceOrder = this.sourceConfigs.map((sc) => sc.name)
        this.mappingTargetNames = this.getAttributeMappingTargetNames()
        this.includeIdentities = config.includeIdentities !== false
        this.uniqueDefinitionNames = collectDefinitionNames(config.uniqueAttributeDefinitions)
        this.definitionOwnedNames = collectDefinitionNames(
            config.normalAttributeDefinitions,
            config.uniqueAttributeDefinitions
        )
    }

    /**
     * Maps explicit `attributeMaps` targets onto `attributeBag.current` in configured order.
     * A value an earlier explicit map produces in this invocation is a prior mapped value
     * for later explicit maps, addressed by that map's new attribute name. An empty result
     * and designated snapshot unavailable are not prior mapped values. Implicit candidates
     * do not read them.
     * On a full invocation (`onlyTargets` omitted), also evaluates implicit candidates:
     * live-snapshot keys union bag keys, minus the control denylist and Unique definition names.
     * A vanished snapshot key resolves empty and is deleted, subject to identity-bag fallback
     * and no-managed-context preservation. A definition-owned name (Normal or Unique) is never
     * deleted on an empty result, so Define outputs and generated unique values survive; a
     * definition-owned name still takes a value whenever the merge yields one.
     */
    mapAttributes(fusionAccount: FusionAccount, _run: FusionRun, options?: MapAttributesOptions): void {
        const { attributeBag, needsRefresh } = fusionAccount
        const sourceAttributeMap = attributeBag.sources
        for (const source of fusionAccount.sources) {
            if (!sourceAttributeMap.has(source)) {
                sourceAttributeMap.set(source, [])
            }
        }

        const mappingRuns = needsRefresh && sourceAttributeMap.size > 0
        const hasHistory = fusionAccount.history.length > 0

        if (!mappingRuns) {
            if (hasHistory) {
                attributeBag.current[FusionAttribute.History] = [...fusionAccount.history]
            }
            return
        }

        const attributes = { ...attributeBag.current }
        let sourceOrder = this.sourceOrder
        const identityBag = attributeBag.identity
        const identityInputsEnabled = this.includeIdentities || fusionAccount.fromIdentity
        const identityPresent = identityInputsEnabled && Object.keys(identityBag).length > 0
        if (identityPresent) {
            sourceAttributeMap.set(IDENTITIES_SOURCE_NAME, [identityBag])
            if (!sourceOrder.includes(IDENTITIES_SOURCE_NAME)) {
                sourceOrder = [...sourceOrder, IDENTITIES_SOURCE_NAME]
            }
        } else if (!identityInputsEnabled) {
            sourceAttributeMap.delete(IDENTITIES_SOURCE_NAME)
        }

        const hasManagedAccountContext = Array.from(sourceAttributeMap.values()).some((accounts) => accounts.length > 0)
        const shouldPreserveCurrentWithoutContext = !hasManagedAccountContext && !fusionAccount.isIdentity
        const snapshotIndex = buildSnapshotIndex(sourceAttributeMap)
        if (identityPresent) {
            const identityId = trimStr(fusionAccount.identityId) ?? trimStr(identityBag.id)
            if (identityId) {
                snapshotIndex.set(identityId, identityBag)
            }
        }
        const originSnapshot = this.getOriginAccountContextAccount(fusionAccount, snapshotIndex)
        let prioritizedAccount = this.getMainAccountContextAccount(fusionAccount, snapshotIndex)
        const mappingTargets = this.mappingTargetNames
        const explicitTargetSet = new Set(mappingTargets)
        const priorMappedValues = new Map<string, unknown>()

        const applyMappedValue = (
            attribute: string,
            processedValue: Attributes[string] | typeof DESIGNATED_SNAPSHOT_UNAVAILABLE | undefined
        ): void => {
            if (processedValue === DESIGNATED_SNAPSHOT_UNAVAILABLE) {
                return
            }
            if (processedValue === undefined) {
                const identityValue = fusionAccount.attributeBag.identity[attribute]
                if (fusionAccount.isIdentity && !isNullish(identityValue)) {
                    attributes[attribute] = identityValue
                } else if (!shouldPreserveCurrentWithoutContext && !this.definitionOwnedNames.has(attribute)) {
                    delete attributes[attribute]
                }
                if (attribute === FusionAttribute.MainAccount) {
                    delete attributes[attribute]
                    prioritizedAccount = undefined
                }
                return
            }

            attributes[attribute] = processedValue
            if (attribute === FusionAttribute.MainAccount) {
                const mainAccountId = trimStr(processedValue)
                prioritizedAccount = mainAccountId ? snapshotIndex.get(mainAccountId) : undefined
            }
            if (attribute === FusionAttribute.History) {
                this.applyHistoryMapping(processedValue, fusionAccount)
            }
        }

        for (const attribute of mappingTargets) {
            if (options?.onlyTargets && !options.onlyTargets.has(attribute)) {
                continue
            }

            if (this.isSystemProvenanceAttribute(attribute)) {
                continue
            }

            const processingConfig = this.attributeMappingConfig.get(attribute)!
            const processedValue = processAttributeMapping(
                processingConfig,
                sourceAttributeMap,
                sourceOrder,
                prioritizedAccount,
                originSnapshot,
                priorMappedValues
            )
            applyMappedValue(attribute, processedValue)
            if (processedValue !== DESIGNATED_SNAPSHOT_UNAVAILABLE && hasValue(processedValue)) {
                priorMappedValues.set(attribute, processedValue)
            }
        }

        if (!options?.onlyTargets) {
            for (const attribute of collectImplicitCandidateKeys(
                sourceAttributeMap,
                attributeBag.current,
                explicitTargetSet,
                this.uniqueDefinitionNames
            )) {
                const processingConfig = buildAttributeMappingConfig(attribute, this.attributeMaps, this.attributeMerge)
                applyMappedValue(
                    attribute,
                    processAttributeMapping(
                        processingConfig,
                        sourceAttributeMap,
                        sourceOrder,
                        prioritizedAccount,
                        originSnapshot
                    )
                )
            }
        }

        if (hasHistory) {
            attributes[FusionAttribute.History] = [...fusionAccount.history]
        }

        fusionAccount.setMappedAttributes(attributes)
    }

    private isSystemProvenanceAttribute(name: string): boolean {
        return name === FusionAttribute.OriginAccount || name === FusionAttribute.OriginSource
    }

    private getAttributeMappingTargetNames(): string[] {
        const mappedAttributes = (this.attributeMaps ?? [])
            .map((attributeMap) => attributeMap.newAttribute)
            .filter((name): name is string => Boolean(name))

        return Array.from(new Set([...mappedAttributes]))
    }

    private get attributeMappingConfig(): Map<string, AttributeMappingConfig> {
        if (!this.cachedAttributeMappingConfig) {
            this.cachedAttributeMappingConfig = new Map()
            for (const attrName of this.mappingTargetNames) {
                this.cachedAttributeMappingConfig.set(
                    attrName,
                    buildAttributeMappingConfig(attrName, this.attributeMaps, this.attributeMerge)
                )
            }
        }
        return this.cachedAttributeMappingConfig
    }

    private getMainAccountContextAccount(
        fusionAccount: FusionAccount,
        snapshotIndex: Map<string, Attributes>
    ): Attributes | undefined {
        const mainAccountId = trimStr(fusionAccount.attributeBag.current[FusionAttribute.MainAccount])
        if (!mainAccountId) return undefined

        return snapshotIndex.get(mainAccountId)
    }

    private getOriginAccountContextAccount(
        fusionAccount: FusionAccount,
        snapshotIndex: Map<string, Attributes>
    ): Attributes | undefined {
        const originAccountId = trimStr(fusionAccount.originAccountId)
        if (!originAccountId) return undefined

        return snapshotIndex.get(originAccountId)
    }

    private applyHistoryMapping(processedValue: unknown, fusionAccount: FusionAccount): void {
        if (!Array.isArray(processedValue) || processedValue.length === 0) return

        const history = processedValue
            .filter((entry): entry is string => typeof entry === 'string')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)

        if (history.length === 0) return
        fusionAccount.collections.historyOps.importFromArray(history)
    }
}

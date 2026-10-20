import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'
import { trimStr } from '../utils/safeRead'
import { Attributes, ConnectorError, ConnectorErrorType, SimpleKeyType } from '@sailpoint/connector-sdk'
import { FusionDecision } from './form'
import { FusionConfig, SourceType } from './config'
import { FusionMatch } from '../services/matchingService'
import { FusionAccountKind } from './fusionAccountTypes'
import { StatusEntitlement } from './statusEntitlement'
import type { FusionAttributeBag, IdentityInfo } from './fusionAccountTypes'
import { buildIdentityInfo, isIdentityOriginFusionAccount, omitNullishAttributeKeys } from './fusionAccountUtils'
import type { FusionRun } from './fusionRun'
import { FusionCollections } from './fusionCollections'
import { FusionCorrelation } from './fusionCorrelation'
import { FusionLayers, type AddManagedAccountOptions } from './fusionLayers'
import type { FusionAccountFactorySeed } from './fusionAccountFactorySeed'
import {
    buildFromFusionAccount,
    buildFromFusionDecision,
    buildFromIdentity,
    buildFromManagedAccount,
} from './fusionAccountFactories'

export const IDENTITIES_SOURCE_NAME = 'Identities'

/**
 * Consolidated Fusion account: owns identity fields and the attribute bag.
 * Mutable slices live on readonly collaborators — `collections`, `correlation`, and `layers`.
 * Prefer those collaborators over flat pass-through mutators for statuses, layers, and promises.
 */
export class FusionAccount {
    private static config?: FusionConfig

    private keyValue?: SimpleKeyType
    private managedKeyValue?: string
    private iscAccountIdValue?: string
    private emailValue?: string
    private nameValue?: string
    private sourceNameValue = ''
    /** Machine account flag from the originating managed account. Public so run snapshots keep it. */
    isMachine?: boolean
    private typeValue: FusionAccountKind = FusionAccountKind.Fusion
    private modifiedValue?: string
    private identityInfoValue?: IdentityInfo
    private attributeBagValue: FusionAttributeBag = {
        previous: {},
        current: {},
        identity: {},
        sourceAccountContexts: [],
        sources: new Map(),
    }
    private sourceAttributeMapCache?: Map<string, Attributes[]>

    readonly collections: FusionCollections
    readonly correlation: FusionCorrelation
    readonly layers: FusionLayers

    private constructor(config?: FusionConfig) {
        const resolvedConfig = config ?? FusionAccount.ensureConfig()
        this.collections = new FusionCollections(resolvedConfig.maxHistoryMessages)
        this.correlation = new FusionCorrelation(this.collections)
        this.layers = new FusionLayers(
            this.collections,
            new Set(resolvedConfig.sources.map((sc) => sc.name)),
            resolvedConfig.fusionAccountRefreshThresholdInSeconds
        )
    }

    // ============================================================================
    // Static
    // ============================================================================

    static configure(config: FusionConfig): void {
        FusionAccount.config = config
    }

    static buildIdentityInfo(source: Parameters<typeof buildIdentityInfo>[0]): ReturnType<typeof buildIdentityInfo> {
        return buildIdentityInfo(source)
    }

    /** Configured type of a managed source; `undefined` when the source is unknown or untyped. */
    static configuredSourceType(sourceName: string | undefined): SourceType | undefined {
        if (!sourceName) return undefined
        const { sources } = FusionAccount.ensureConfig()
        return sources.find((source) => source.name === sourceName)?.sourceType
    }

    private static ensureConfig(): FusionConfig {
        const config = FusionAccount.config
        if (!config) {
            throw new ConnectorError(
                'FusionAccount is not configured. Call FusionAccount.configure(config) before creating accounts.',
                ConnectorErrorType.Generic
            )
        }
        return config
    }

    /** Used by fusionAccountFactories during construction. */
    static createForFactory(): FusionAccount {
        return new FusionAccount(FusionAccount.ensureConfig())
    }

    /** Seeds identity fields during factory construction. */
    applyFactorySeed(seed: FusionAccountFactorySeed): void {
        if (seed.type !== undefined) this.typeValue = seed.type
        if (seed.managedKey !== undefined) this.managedKeyValue = seed.managedKey
        if (seed.iscAccountId !== undefined) this.iscAccountIdValue = seed.iscAccountId
        if (seed.modified !== undefined) this.modifiedValue = seed.modified
        if (seed.identityInfo !== undefined) this.identityInfoValue = seed.identityInfo
        if (seed.name) this.nameValue = seed.name
        if (seed.sourceName) this.sourceNameValue = seed.sourceName
        if (seed.isMachine === true) this.isMachine = true
        if (seed.attributeBagCurrent !== undefined) {
            this.attributeBagValue.current = omitNullishAttributeKeys(seed.attributeBagCurrent)
        }
        if (seed.attributeBagPrevious !== undefined) {
            this.attributeBagValue.previous = omitNullishAttributeKeys(seed.attributeBagPrevious)
        }
    }

    // ============================================================================
    // Factory methods
    // ============================================================================

    static fromFusionAccount(account: Account): FusionAccount {
        return buildFromFusionAccount(account)
    }

    static fromIdentity(identity: IdentityDocument): FusionAccount {
        return buildFromIdentity(identity)
    }

    static fromManagedAccount(account: Account): FusionAccount {
        return buildFromManagedAccount(account)
    }

    static fromFusionDecision(decision: FusionDecision): FusionAccount {
        return buildFromFusionDecision(decision)
    }

    // ============================================================================
    // Identity info
    // ============================================================================

    setIdentityIdAttribute(value: string | undefined): void {
        const trimmed = trimStr(value) ?? ''
        if (!this.identityInfoValue) {
            this.identityInfoValue = { id: trimmed, name: '', displayName: '' }
            return
        }
        this.identityInfoValue.id = trimmed
    }

    // ============================================================================
    // Basic accessors
    // ============================================================================

    get type(): FusionAccountKind {
        return this.typeValue
    }

    get managedKey(): string | undefined {
        return this.managedKeyValue
    }

    get managedKeyOrUndefined(): string | undefined {
        return this.managedKeyValue
    }

    get managedAccountId(): string | undefined {
        return this.managedKeyValue
    }

    get iscAccountId(): string | undefined {
        return this.iscAccountIdValue
    }

    get key(): SimpleKeyType | undefined {
        return this.keyValue
    }

    setKey(key: SimpleKeyType): void {
        this.keyValue = key
    }

    get email(): string | undefined {
        return this.emailValue
    }

    setEmail(email: string | undefined): void {
        this.emailValue = email
    }

    get name(): string | undefined {
        return this.nameValue
    }

    setName(name: string | undefined): void {
        this.nameValue = name
    }

    get displayName(): string | undefined {
        return this.nameValue
    }

    setDisplayName(displayName: string | undefined): void {
        this.nameValue = displayName
    }

    get sourceName(): string {
        return this.sourceNameValue
    }

    setSourceName(sourceName: string): void {
        this.sourceNameValue = sourceName
    }

    get identityId(): string | undefined {
        return this.identityInfoValue?.id
    }

    get identityIdAttribute(): string | undefined {
        return this.identityInfoValue?.id
    }

    get identityInfo(): IdentityInfo | undefined {
        return this.identityInfoValue
    }

    /** Identity alias (`IdentityDocument.name`) — authoritative login used for display-attribute override. */
    get identityAlias(): string | undefined {
        return trimStr(this.identityInfoValue?.name)
    }

    /** Identity display name chain — friendly label for reports, forms, and emails. */
    get identityDisplayName(): string | undefined {
        return trimStr(this.identityInfoValue?.displayName)
    }

    /**
     * @deprecated Use {@link identityDisplayName} for friendly labels or {@link identityAlias} for login/override.
     */
    get identityName(): string | undefined {
        return this.identityDisplayName
    }

    get disabled(): boolean {
        return this.layers.disabled
    }

    enable(): void {
        this.layers.disabled = false
    }

    disable(): void {
        this.layers.disabled = true
    }

    get needsRefresh(): boolean {
        return this.layers.needsRefresh
    }

    get needsReset(): boolean {
        return this.layers.needsReset
    }

    setNeedsRefresh(refresh: boolean): void {
        this.layers.needsRefresh = refresh
    }

    setNeedsReset(reset: boolean): void {
        this.layers.needsReset = reset
    }

    get uncorrelated(): boolean {
        return this.layers.uncorrelated
    }

    get isManaged(): boolean {
        return this.typeValue === FusionAccountKind.Managed
    }

    get isIdentity(): boolean {
        return this.layers.isIdentity
    }

    get fromIdentity(): boolean {
        return isIdentityOriginFusionAccount(
            this.layers.originSource,
            this.attributeBagValue.current,
            this.collections.statusesSet.has(StatusEntitlement.Baseline)
        )
    }

    get isMatch(): boolean {
        return this.layers.isMatch
    }

    get originSource(): string | undefined {
        return this.layers.originSource
    }

    get originAccountId(): string | undefined {
        return this.layers.originAccount
    }

    get originIdentityInScope(): boolean | undefined {
        return this.layers.originIdentityInScope
    }

    setOriginIdentityInScope(inScope: boolean): void {
        this.layers.originIdentityInScope = inScope
    }

    get modified(): string | undefined {
        return this.modifiedValue
    }

    // ============================================================================
    // Attribute accessors
    // ============================================================================

    get attributes(): Attributes {
        return this.attributeBagValue.current
    }

    get currentAttributes(): Attributes {
        return this.attributeBagValue.current
    }

    get previousAttributes(): Attributes {
        return this.attributeBagValue.previous
    }

    get attributeBag(): FusionAttributeBag {
        return this.attributeBagValue
    }

    get sourceAttributeMap(): Map<string, Attributes[]> | undefined {
        return this.sourceAttributeMapCache
    }

    getAttribute(name: string): Attributes[string] | undefined {
        return this.attributeBagValue.current[name]
    }

    getStringAttribute(name: string): string | undefined {
        const value = this.getAttribute(name)
        return typeof value === 'string' ? value : undefined
    }

    hasAttribute(name: string): boolean {
        return name in this.attributeBagValue.current
    }

    setMappedAttributes(attributes: Attributes): void {
        this.attributeBagValue.current = omitNullishAttributeKeys(attributes)
    }

    // ============================================================================
    // Layer method pass-throughs
    // ============================================================================

    addIdentityLayer(identity: IdentityDocument): void {
        this.layers.addIdentityLayer(
            identity,
            this.attributeBagValue,
            this.identityInfoValue,
            this.modifiedValue,
            (email: string) => {
                this.emailValue = email
            },
            (info: IdentityInfo) => {
                this.identityInfoValue = info
            }
        )
    }

    addManagedAccountLayer(workQueue: FusionRun, options: AddManagedAccountOptions = {}): void {
        this.layers.addManagedAccountLayer(
            workQueue,
            this.attributeBagValue,
            this.identityInfoValue,
            this.modifiedValue,
            this.iscAccountIdValue,
            (id: string) => {
                this.iscAccountIdValue = id
            },
            (name: string) => {
                this.sourceNameValue = name
            },
            () => {
                this.sourceAttributeMapCache = undefined
            },
            options
        )
    }

    // ============================================================================
    // Read-only collection convenience getters
    // ============================================================================

    get accountIds(): string[] {
        return Array.from(this.collections.accountIds)
    }

    get missingAccountIds(): string[] {
        return Array.from(this.collections.missingAccountIds)
    }

    get accountIdsSet(): ReadonlySet<string> {
        return this.collections.accountIds
    }

    get missingAccountIdsSet(): ReadonlySet<string> {
        return this.collections.missingAccountIds
    }

    /** Persisted managed-account keys from the last aggregation (`accounts` attribute). */
    get previousAccountIdsSet(): ReadonlySet<string> {
        return this.collections.previousAccountIds
    }

    get statuses(): string[] {
        return Array.from(this.collections.statusesSet)
    }

    get actions(): string[] {
        return Array.from(this.collections.actionsSet)
    }

    get reviews(): string[] {
        return Array.from(this.collections.reviewsSet)
    }

    get sources(): string[] {
        return Array.from(this.collections.sourcesSet)
    }

    get fusionMatches(): FusionMatch[] {
        return [...this.collections.fusionMatches]
    }

    get fusionMatchesRaw(): readonly FusionMatch[] {
        return this.collections.fusionMatches
    }

    get history(): string[] {
        return [...this.collections.history]
    }

    get statusesSet(): ReadonlySet<string> {
        return this.collections.statusesSet
    }

    setReverseCorrelationAttribute(attributeName: string, value: string): void {
        this.attributeBagValue.current[attributeName] = value
    }

    clearReverseCorrelationAttribute(attributeName: string): void {
        delete this.attributeBagValue.current[attributeName]
    }

    /**
     * Remove a source-account reference, binding origin metadata that collections alone do not own.
     */
    removeSourceAccount(id: string): void {
        this.collections.accounts.removeSourceAccount(id, this.fromIdentity, this.layers.originIdentityInScope)
    }

    updateCorrelationStatus(onCorrelatedActionGranted?: () => void): void {
        this.correlation.updateStatus((v: boolean) => {
            this.layers.uncorrelated = v
        }, onCorrelatedActionGranted)
    }

    get correlationPromises(): Array<Promise<unknown>> {
        return [...this.correlation.promises]
    }

    get pendingReviewUrls(): string[] {
        return Array.from(this.collections.pendingReviewUrls)
    }

    // ============================================================================
    // Output
    // ============================================================================

    syncCollectionAttributesToBag(): void {
        this.collections.syncToBag(
            this.attributeBagValue.current,
            this.layers.originSource,
            this.layers.originAccount,
            this.identityInfoValue?.id
        )
    }

    toISCAccount(): any {
        return {
            attributes: this.attributeBagValue.current,
            disabled: this.layers.disabled,
            key: this.keyValue,
        }
    }
}

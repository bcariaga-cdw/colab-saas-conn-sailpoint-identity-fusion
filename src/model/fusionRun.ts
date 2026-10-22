import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'
import { FusionAccount, FusionAccountKind } from './account'
import { SourceInfo } from '../services/sourceService'
import { FusionDecision } from './form'
import { AggregationTracker } from './aggregationTracker'
import { ManagedAccountAnalysisRecording } from './managedAccountAnalysisRecording'
import { FusionReportBlend } from './fusionReportBlend'
import { LogService } from '../services/logService'
import { FusionConfig } from './config'
import { hasValue, readString, trimStr } from '../utils/safeRead'
import { assert } from '../utils/assert'
import { buildManagedAccountKey } from './managedAccountKey'
import { CandidateRegistry } from '../services/matchingService/candidateRegistry'
import { ManagedAccountAnalysisContext } from '../services/matchingService/types'
import { resolveFusionAccountNameOrDisplayName } from './fusionAccountUtils'

export type ManagedAccountInfo = {
    id: string
    name: string
    sourceName: string
    sourceId?: string
    nativeIdentity?: string
    identityId?: string
    /** Set when the managed account is a machine account (`Account.isMachine`). */
    isMachine?: boolean
}

export function toManagedAccountInfo(account: Account): ManagedAccountInfo {
    return {
        id: account.id ?? '',
        name: account.name ?? '',
        sourceName: account.sourceName ?? '',
        sourceId: account.sourceId,
        nativeIdentity: account.nativeIdentity,
        identityId: account.identityId,
        ...(account.isMachine === true ? { isMachine: true } : {}),
    }
}

export interface RunStateSnapshot {
    managedAccounts: Record<string, any>[]
    fusionAccounts: Record<string, any>[]
    fusionIdentityAccounts: Record<string, any>[]
    identities: Record<string, any>[]
    fusionIdentityDecisions: Record<string, any>[]
    finishedFusionDecisions: Record<string, any>[]
    pendingCandidateIdentityIds: string[]
    pendingReviewUrlsByReviewerId: Record<string, string[]>
    pendingReviewUrlsByCandidateId: Record<string, string[]>
    sourcesByName: Record<string, any>
    currentRunNonMatchedKeysBySource: Record<string, string[]>
    fusionBlends: Record<string, any>[]
    autoMergedIds: string[]
    matchScoringMs: number
    phaseTimings: { phase: string; elapsed: string }[]
    managedAccountInventory: Record<string, ManagedAccountInfo>
    formCounters: {
        formsCreated: number
        formInstancesCreated: number
        formsFound: number
        formInstancesFound: number
        answeredFormInstancesProcessed: number
    }
    formDeleteQueue: {
        formsToDelete: string[]
        queuedFormDeleteIds: string[]
    }
    managedAccountProcessing: {
        state: 'idle' | 'initialized'
        startedAt: number
        batchSize: number
    }
    trigramIndexBuilt: boolean
    /** Optional replay-only simulated wall clock (epoch ms). Undefined in live aggregation. */
    simulatedTimeMs?: number
}

/**
 * Run-scoped managed account state:
 * - `managedAccountsById`: mutable Match work queue; entries removed via `claimAccount()`
 * - `managedAccountInventory`: lightweight metadata for every loaded key until output phase
 * - claimed account retention: post-claim attribute bodies for FusionLayers rematerialization
 *   (not a second Match work queue; not inventory)
 */
export class FusionRun {
    public readonly isRecordMode: boolean
    /** Keep the first Fusion account for an identity and skip later duplicate accounts. */
    public readonly skipDuplicateFusionAccounts: boolean
    /** Set when account-list dry-run mode activates write inhibition. */
    public isDryRunMode = false
    readonly managedAccountsById = new Map<string, Account>()
    readonly managedAccountInventory = new Map<string, ManagedAccountInfo>()
    readonly managedAccountsByIdentityId = new Map<string, Set<string>>()
    /** Post-claim Account bodies keyed by managed account key. Not Match work. */
    private readonly claimedAccountRetention = new Map<string, Account>()
    private readonly fusionAccountMapValue = new Map<string, FusionAccount>()
    private readonly fusionIdentityMapValue = new Map<string, FusionAccount>()
    private readonly fusionIdentityOwnerIdByManagedKey = new Map<string, string>()
    private readonly identityMapValue = new Map<string, IdentityDocument>()
    /** Non-protected identity IDs loaded from ISC during this run (survives cache clears). */
    private readonly identitiesLoadedIds = new Set<string>()
    readonly sourcesByName = new Map<string, SourceInfo>()
    private readonly autoMergedIdentityIdsValue = new Set<string>()
    private readonly currentRunNonMatchedKeysBySource = new Map<string, Set<string>>()
    readonly reviewersBySourceId = new Map<string, Set<FusionAccount>>()
    readonly sourcesWithoutReviewers = new Set<string>()
    private linkedAccountKeyIndexValue: Set<string> | undefined
    private fusionIdentityDecisionsValue: FusionDecision[] = []
    private finishedFusionDecisionsValue: FusionDecision[] = []
    private pendingCandidateIdentityIdsValue: Set<string> = new Set()
    private pendingReviewUrlsByReviewerIdValue: Map<string, string[]> = new Map()
    private pendingReviewUrlsByCandidateIdValue: Map<string, string[]> = new Map()
    fusionBlends: FusionReportBlend[] = []
    matchScoringMs = 0
    fullScanFallbackCount = 0
    mandatoryMissingBlockCount = 0
    identityComparisonCount = 0
    identityCandidateSetSizeSum = 0
    analysisRecorder?: ManagedAccountAnalysisRecording
    phaseTimings: { phase: string; elapsed: string }[] = []
    private pendingDisableOperations = new Set<Promise<void>>()
    private disableOperationFactory?: (account: Account) => Promise<void>
    private readonly candidateRegistry: CandidateRegistry
    private tracker?: AggregationTracker
    private managedAccountProcessingStateValue: 'idle' | 'initialized' = 'idle'
    private managedAccountProcessingStartedAt: number = 0
    private managedAccountProcessingBatchSizeValue: number = 0
    trigramIndexByAttribute: Map<string, Map<string, Set<FusionAccount>>> = new Map()
    /** Compact-id roster for Binary/LIG3 blocking indexes (index = compact identity id). */
    blockingIdentityRoster: FusionAccount[] = []
    binaryIndexByAttribute: Map<string, Map<string, number[]>> = new Map()
    lig3LengthIndexByAttribute: Map<string, Map<number, number[]>> = new Map()
    normalizedCache: WeakMap<FusionAccount, Map<string, string>> = new WeakMap()
    nameNormalizedCache: WeakMap<FusionAccount, Map<string, string>> = new WeakMap()
    /** Run-scoped name-matcher token arrays keyed by already-normalized name string. */
    nameMatcherTokenCache: Map<string, string[]> = new Map()
    /** Run-scoped Double Metaphone codes keyed by name-matcher token. */
    nameMatcherPhoneticCache: Map<string, [string, string]> = new Map()
    indexedMandatoryAttributes: string[] = []
    trigramIndexBuilt: boolean = false
    formsCreated: number = 0
    formInstancesCreated: number = 0
    formsFound: number = 0
    formInstancesFound: number = 0
    answeredFormInstancesProcessed: number = 0
    formsToDelete: Set<string> = new Set()
    formDeleteQueue: string[] = []
    queuedFormDeleteIds: Set<string> = new Set()
    activeFormDeleteWorkers: number = 0
    pendingFormDeleteTasks: Set<Promise<void>> = new Set()
    private simulatedTimeMsValue?: number

    get autoMergedCount(): number {
        return this.autoMergedIdentityIdsValue.size
    }

    get pendingDisableOperationsCount(): number {
        return this.pendingDisableOperations.size
    }

    get deferredCandidateCount(): number {
        return this.candidateRegistry.count()
    }

    get autoMergedIdentityIds(): ReadonlySet<string> {
        return this.autoMergedIdentityIdsValue
    }

    get identityCount(): number {
        return this.identityMapValue.size
    }

    /** Total non-protected identities loaded from ISC during this run. */
    get identitiesLoadedCount(): number {
        return this.identitiesLoadedIds.size
    }

    get allIdentities(): IdentityDocument[] {
        return Array.from(this.identityMapValue.values())
    }

    identityValues(): IterableIterator<IdentityDocument> {
        return this.identityMapValue.values()
    }

    get fusionAccountMap(): ReadonlyMap<string, FusionAccount> {
        return this.fusionAccountMapValue
    }

    get linkedAccountKeyIndex(): ReadonlySet<string> | undefined {
        return this.linkedAccountKeyIndexValue
    }

    addToLinkedAccountIndex(key: string): void {
        this.linkedAccountKeyIndexValue?.add(key)
    }

    get fusionIdentityDecisions(): readonly FusionDecision[] {
        return this.fusionIdentityDecisionsValue
    }

    get finishedFusionDecisions(): readonly FusionDecision[] {
        return this.finishedFusionDecisionsValue
    }

    get pendingCandidateIdentityIds(): ReadonlySet<string> {
        return this.pendingCandidateIdentityIdsValue
    }

    get pendingReviewerUrlKeys(): IterableIterator<string> {
        return this.pendingReviewUrlsByReviewerIdValue.keys()
    }

    get pendingCandidateUrlKeys(): IterableIterator<string> {
        return this.pendingReviewUrlsByCandidateIdValue.keys()
    }

    clearReviewUrls(): void {
        this.pendingReviewUrlsByReviewerIdValue = new Map()
        this.pendingReviewUrlsByCandidateIdValue = new Map()
        this.pendingCandidateIdentityIdsValue = new Set()
    }

    get pendingReviewUrlsByReviewerId(): ReadonlyMap<string, string[]> {
        return this.pendingReviewUrlsByReviewerIdValue
    }

    get pendingReviewUrlsByCandidateId(): ReadonlyMap<string, string[]> {
        return this.pendingReviewUrlsByCandidateIdValue
    }

    get fusionIdentityMap(): ReadonlyMap<string, FusionAccount> {
        return this.fusionIdentityMapValue
    }

    get identityMap(): ReadonlyMap<string, IdentityDocument> {
        return this.identityMapValue
    }

    constructor(
        public log?: LogService,
        config?: FusionConfig
    ) {
        this.isRecordMode = config?.recording?.mode === 'record'
        this.skipDuplicateFusionAccounts = config?.skipDuplicateFusionAccounts ?? false
        this.candidateRegistry = new CandidateRegistry({
            getFusionAccount: (key: string) => this.getFusionAccountByManagedKey(key),
            sourcesByName: this.sourcesByName,
            log: this.log,
        })
    }

    private retainClaimedAccount(accountKey: string): void {
        const account = this.managedAccountsById.get(accountKey)
        if (account) {
            this.claimedAccountRetention.set(accountKey, account)
        }
    }

    setManagedAccount(accountKey: string, account: Account): void {
        this.managedAccountsById.set(accountKey, account)
        this.managedAccountInventory.set(accountKey, toManagedAccountInfo(account))
        if (account.identityId) {
            let idSet = this.managedAccountsByIdentityId.get(account.identityId)
            if (!idSet) {
                idSet = new Set()
                this.managedAccountsByIdentityId.set(account.identityId, idSet)
            }
            idSet.add(accountKey)
        }
    }

    claimAccount(accountKey: string, identityId?: string): boolean {
        this.retainClaimedAccount(accountKey)
        const deleted = this.managedAccountsById.delete(accountKey)
        if (identityId) {
            const idSet = this.managedAccountsByIdentityId.get(identityId)
            if (idSet) {
                idSet.delete(accountKey)
                if (idSet.size === 0) {
                    this.managedAccountsByIdentityId.delete(identityId)
                }
            }
        }
        return deleted
    }

    claimAccountsForIdentity(identityId: string): number {
        const idSet = this.managedAccountsByIdentityId.get(identityId)
        if (!idSet) return 0
        let deleted = 0
        for (const key of idSet) {
            this.retainClaimedAccount(key)
            if (this.managedAccountsById.delete(key)) {
                deleted++
            }
        }
        this.managedAccountsByIdentityId.delete(identityId)
        return deleted
    }

    get(key: string): Account | undefined {
        return this.managedAccountsById.get(key)
    }

    /**
     * Returns a claimed managed account’s attribute body for FusionLayers rematerialization.
     * Match and uncorrelated sweeps must keep using {@link get} / {@link entries} only.
     */
    getRetainedAccount(accountKey: string): Account | undefined {
        return this.claimedAccountRetention.get(accountKey)
    }

    getKeysForIdentity(identityId: string): ReadonlySet<string> | undefined {
        return this.managedAccountsByIdentityId.get(identityId)
    }

    entries(): IterableIterator<[string, Account]> {
        return this.managedAccountsById.entries()
    }

    hasManagedAccount(accountKey: string): boolean {
        return this.managedAccountInventory.has(accountKey)
    }

    getManagedAccountInfo(accountKey: string): ManagedAccountInfo | undefined {
        return this.managedAccountInventory.get(accountKey)
    }

    clearWorkQueue(): void {
        this.managedAccountsById.clear()
        this.managedAccountsByIdentityId.clear()
        this.claimedAccountRetention.clear()
    }

    clearManagedAccountState(): void {
        this.clearWorkQueue()
        this.managedAccountInventory.clear()
    }

    /**
     * Register the factory used to fire a disable operation for a managed account.
     * When no factory is registered, {@link queueDisableOperation} is a no-op.
     */
    setDisableOperationFactory(factory: (account: Account) => Promise<void>): void {
        this.disableOperationFactory = factory
    }

    /**
     * Queue a pending asynchronous disable operation for a managed account.
     * The operation is tracked run-locally so it can be awaited before the run completes.
     */
    queueDisableOperation(account: Account): void {
        if (!this.disableOperationFactory) {
            return
        }
        const op = this.disableOperationFactory(account).finally(() => {
            this.pendingDisableOperations.delete(op)
        })
        this.pendingDisableOperations.add(op)
    }

    /**
     * Wait for all pending asynchronous disable operations to complete.
     * Safe to call multiple times; it drains the current pending set.
     */
    async awaitPendingDisableOperations(): Promise<void> {
        if (this.pendingDisableOperations.size === 0) {
            return
        }

        while (this.pendingDisableOperations.size > 0) {
            const pending = Array.from(this.pendingDisableOperations)
            await Promise.allSettled(pending)
        }
    }

    /**
     * Remove a managed account from the match-reporting work queue.
     * No-op when the id is undefined or not present.
     */
    removeMatchAccount(managedAccountId: string | undefined): void {
        if (!managedAccountId) return
        const tracker = this.getTracker()
        if (!tracker) return
        const idx = tracker.matchAccounts.findIndex((x) => x.managedAccountId === managedAccountId)
        if (idx !== -1) {
            tracker.matchAccounts.splice(idx, 1)
        }
    }

    /**
     * Record a failed match/form outcome through the run's analysis recorder.
     * No-op when no recorder is attached.
     */
    trackFailed(fusionAccount: FusionAccount, message: string): void {
        this.analysisRecorder?.trackFailed(fusionAccount, message)
    }

    /**
     * Record managed-account analysis through the run's analysis recorder.
     * No-op when no recorder is attached.
     */
    recordAnalysis(analysis: ManagedAccountAnalysisContext): void {
        this.analysisRecorder?.recordAnalysis(analysis)
    }

    registerFusionAccount(fusionAccount: FusionAccount): void {
        const tracker = this.getTracker()
        const identityId = fusionAccount.identityId
        if (hasValue(identityId) && fusionAccount.type !== FusionAccountKind.Managed) {
            const existingFusionAccount = this.fusionIdentityMapValue.get(identityId!)
            if (existingFusionAccount) {
                // A duplicate account resolves to an identity that already has one. When the
                // Skip setting is enabled, keep the first account and skip the duplicate so it
                // is never returned; otherwise fall through and let the incoming account win.
                const isDuplicate = this.trackConflictingFusionIdentity(
                    identityId!,
                    existingFusionAccount,
                    fusionAccount,
                    tracker
                )
                if (isDuplicate && this.skipDuplicateFusionAccounts) {
                    return
                }
                this.removeFusionIdentityOwnership(identityId!)
            }
            this.fusionIdentityMapValue.set(identityId!, fusionAccount)
            this.addFusionIdentityOwnership(identityId!, fusionAccount)
        } else {
            assert(fusionAccount.managedKey, 'Fusion account must have a managedKey to be added to fusion account map')
            this.fusionAccountMapValue.set(fusionAccount.managedKey, fusionAccount)
        }
    }

    removeFusionAccount(fa: FusionAccount): boolean {
        const managedKey = fa.managedKey
        if (managedKey && this.fusionAccountMapValue.get(managedKey) === fa) {
            return this.fusionAccountMapValue.delete(managedKey)
        }
        for (const [id, account] of this.fusionIdentityMapValue.entries()) {
            if (account === fa) {
                this.removeFusionIdentityOwnership(id)
                return this.fusionIdentityMapValue.delete(id)
            }
        }
        return false
    }

    private addFusionIdentityOwnership(identityId: string, fusionAccount: FusionAccount): void {
        for (const key of fusionAccount.accountIdsSet) {
            this.fusionIdentityOwnerIdByManagedKey.set(key, identityId)
        }
    }

    private removeFusionIdentityOwnership(identityId: string): void {
        for (const [key, ownerIdentityId] of this.fusionIdentityOwnerIdByManagedKey) {
            if (ownerIdentityId === identityId) {
                this.fusionIdentityOwnerIdByManagedKey.delete(key)
            }
        }
    }

    getFusionIdentity(identityId: string): FusionAccount | undefined {
        return this.fusionIdentityMapValue.get(identityId)
    }

    getFusionAccountByManagedKey(managedKey: string): FusionAccount | undefined {
        return this.fusionAccountMapValue.get(managedKey)
    }

    /**
     * Register a provisional Fusion account as a deferred-match candidate for its source.
     * State is kept run-local so the Match module remains stateless.
     */
    registerDeferredCandidate(fusionAccount: FusionAccount): void {
        this.candidateRegistry.registerPending(fusionAccount)
    }

    registerPersistedDeferredCandidate(fusionAccount: FusionAccount): void {
        this.candidateRegistry.registerPersisted(fusionAccount)
    }

    registerFinalizedDeferredCandidate(fusionAccount: FusionAccount): void {
        this.candidateRegistry.registerFinalized(fusionAccount)
    }

    /** Alias for {@link registerFinalizedDeferredCandidate} — anchor terminology from ubiquitous language. */
    registerAnchorDeferredCandidate(fusionAccount: FusionAccount): void {
        this.registerFinalizedDeferredCandidate(fusionAccount)
    }

    unregisterDeferredCandidate(fusionAccount: FusionAccount): void {
        this.candidateRegistry.unregister(fusionAccount)
    }

    hasPersistedDeferredCandidates(): boolean {
        return this.candidateRegistry.hasPersistedCandidates()
    }

    getDeferredCandidateTier(
        fusionAccount: FusionAccount
    ): import('../services/matchingService/candidateRegistry').DeferredCandidateTier | undefined {
        return this.candidateRegistry.getCandidateTier(fusionAccount)
    }

    /**
     * Clear all run-local deferred-match candidates. Called at the start of each managed-account sweep.
     */
    clearDeferredCandidates(): void {
        this.candidateRegistry.clear()
    }

    /**
     * Iterate over the current-run deferred-match candidates for a source.
     */
    currentRunDeferredCandidatesForSource(sourceName: string | null | undefined): Iterable<FusionAccount> {
        return this.candidateRegistry.queryForSource(sourceName)
    }

    hasFusionIdentity(identityId: string): boolean {
        return this.fusionIdentityMapValue.has(identityId)
    }

    /**
     * True when a managed source account currently belongs to a loaded Fusion identity
     * other than the Fusion account under Refresh. Current ISC `identityId` is
     * authoritative. A missing or previous listing does not establish ownership.
     * NonMatched Fusion accounts and prune-deleted inventory absence do not either.
     */
    isManagedAccountForeignOwned(accountKey: string, currentIdentityId?: string): boolean {
        const inventoryIdentityId = this.managedAccountInventory.get(accountKey)?.identityId
        if (hasValue(inventoryIdentityId) && inventoryIdentityId === currentIdentityId) {
            return false
        }
        if (
            hasValue(inventoryIdentityId) &&
            inventoryIdentityId !== currentIdentityId &&
            this.fusionIdentityMapValue.has(inventoryIdentityId!)
        ) {
            return true
        }

        const ownerIdentityId = this.fusionIdentityOwnerIdByManagedKey.get(accountKey)
        return ownerIdentityId !== undefined && ownerIdentityId !== currentIdentityId
    }

    get totalFusionAccountCount(): number {
        return this.fusionIdentityMapValue.size + this.fusionAccountMapValue.size
    }

    get allFusionAccounts(): FusionAccount[] {
        return Array.from(this.fusionAccountMapValue.values())
    }

    /**
     * Iterate fusion accounts without copying the map values into a new array.
     * Use {@link allFusionAccounts} when a mutable array or spread composition is required.
     */
    *fusionAccountsIterable(): Iterable<FusionAccount> {
        yield* this.fusionAccountMapValue.values()
    }

    get allFusionIdentities(): Iterable<FusionAccount> {
        return this.fusionIdentityMapValue.values()
    }

    *fusionIdentitiesExcluding(excludeIds: ReadonlySet<string>): Iterable<FusionAccount> {
        for (const identity of this.fusionIdentityMapValue.values()) {
            if (!identity.identityId || !excludeIds.has(identity.identityId)) {
                yield identity
            }
        }
    }

    findFusionAccountForIdentity(identity: IdentityDocument, sourceNames: Set<string>): FusionAccount | undefined {
        const identityAccountIds = new Set<string>(
            (identity.accounts ?? [])
                .filter((a) => sourceNames.has(a.source?.name ?? ''))
                .map((a) =>
                    buildManagedAccountKey({
                        sourceId: a.source?.id,
                        nativeIdentity: readString(a, 'nativeIdentity'),
                    })
                )
                .filter((value): value is string => Boolean(value))
        )
        if (identityAccountIds.size === 0) return undefined

        for (const account of this.fusionAccountMapValue.values()) {
            if (this.hasIntersectingManagedAccounts(account, identityAccountIds)) {
                return account
            }
        }

        for (const [existingIdentityId, account] of this.fusionIdentityMapValue.entries()) {
            if (existingIdentityId === identity.id) continue
            if (this.hasIntersectingManagedAccounts(account, identityAccountIds)) {
                return account
            }
        }

        return undefined
    }

    addIdentity(id: string, doc: IdentityDocument): void {
        this.identityMapValue.set(id, doc)
        if (id && !doc.protected) {
            this.identitiesLoadedIds.add(id)
        }
    }

    removeIdentity(id: string): void {
        this.identityMapValue.delete(id)
    }

    clearIdentities(): void {
        this.identityMapValue.clear()
    }

    getIdentity(id: string): IdentityDocument | undefined {
        return this.identityMapValue.get(id)
    }

    hasIdentity(id: string): boolean {
        return this.identityMapValue.has(id)
    }

    markAutoMerged(identityId: string): void {
        this.autoMergedIdentityIdsValue.add(identityId)
    }

    isAutoMerged(identityId: string): boolean {
        return this.autoMergedIdentityIdsValue.has(identityId)
    }

    resetScoringState(): void {
        this.autoMergedIdentityIdsValue.clear()
        this.matchScoringMs = 0
    }

    initLinkedAccountIndex(): void {
        this.linkedAccountKeyIndexValue = new Set<string>()
    }

    clearLinkedAccountIndex(): void {
        this.linkedAccountKeyIndexValue = undefined
    }

    addDecision(decision: FusionDecision): void {
        this.fusionIdentityDecisionsValue.push(decision)
    }

    addFinishedFusionDecision(decision: FusionDecision): void {
        this.finishedFusionDecisionsValue.push(decision)
    }

    clearDecisions(): void {
        this.fusionIdentityDecisionsValue = []
    }

    clearFinishedFusionDecisions(): void {
        this.finishedFusionDecisionsValue = []
    }

    addReviewUrlForReviewer(reviewerId: string, url: string): void {
        const list = this.pendingReviewUrlsByReviewerIdValue.get(reviewerId) ?? []
        list.push(url)
        this.pendingReviewUrlsByReviewerIdValue.set(reviewerId, list)
    }

    addReviewUrlForCandidate(candidateId: string, url: string): void {
        const list = this.pendingReviewUrlsByCandidateIdValue.get(candidateId) ?? []
        list.push(url)
        this.pendingReviewUrlsByCandidateIdValue.set(candidateId, list)
    }

    addPendingCandidateId(candidateId: string): void {
        this.pendingCandidateIdentityIdsValue.add(candidateId)
    }

    recordFusionBlend(blend: FusionReportBlend): void {
        const tracker = this.getTracker()
        if (!tracker) return
        tracker.fusionBlends.push(blend)
    }

    getReviewerUrls(reviewerId: string): string[] | undefined {
        return this.pendingReviewUrlsByReviewerIdValue.get(reviewerId)
    }

    getCandidateUrls(candidateId: string): string[] | undefined {
        return this.pendingReviewUrlsByCandidateIdValue.get(candidateId)
    }

    clearNonMatchedKeys(): void {
        this.currentRunNonMatchedKeysBySource.clear()
    }

    private hasIntersectingManagedAccounts(account: FusionAccount, identityAccountIds: Set<string>): boolean {
        for (const id of account.accountIdsSet) {
            if (identityAccountIds.has(id)) return true
        }
        for (const id of account.missingAccountIdsSet) {
            if (identityAccountIds.has(id)) return true
        }
        return false
    }

    private trackConflictingFusionIdentity(
        identityId: string,
        existingAccount: FusionAccount,
        newAccount: FusionAccount,
        tracker?: AggregationTracker
    ): boolean {
        const existingKey = this.conflictTrackingKey(existingAccount)
        const incomingKey = this.conflictTrackingKey(newAccount)
        // Same key means the existing account is being refreshed/updated, not duplicated.
        if (existingKey === incomingKey) return false

        if (tracker && this.log) {
            let accounts = tracker.conflictingFusionIdentityAccounts.get(identityId)
            if (!accounts) {
                accounts = new Map()
                tracker.conflictingFusionIdentityAccounts.set(identityId, accounts)
            }

            accounts.set(existingKey, resolveFusionAccountNameOrDisplayName(existingAccount, existingKey))
            accounts.set(incomingKey, resolveFusionAccountNameOrDisplayName(newAccount, incomingKey))

            const accountLabels = Array.from(accounts.entries()).map(([managedKey, name]) => `${name} (${managedKey})`)
            this.log.warn(
                `More than one Fusion account was found for identity ${identityId} (${accounts.size} account(s)): ${accountLabels.join(', ')}. ` +
                    'This is generally caused by non-unique account names. Please review the configuration and consider using a unique attribute for the account name.'
            )
        }

        return true
    }

    private conflictTrackingKey(fa: FusionAccount): string {
        const managedKey = fa.managedKeyOrUndefined
        const trimmedManagedKey = trimStr(managedKey)
        if (trimmedManagedKey) {
            return trimmedManagedKey
        }
        const name = resolveFusionAccountNameOrDisplayName(fa, 'unknown')
        return `name:${name}`
    }

    setTracker(tracker: AggregationTracker): void {
        this.tracker = tracker
    }

    getTracker(): AggregationTracker | undefined {
        return this.tracker
    }

    get managedAccountProcessingState(): 'idle' | 'initialized' {
        return this.managedAccountProcessingStateValue
    }

    get managedAccountProcessingBatchSize(): number {
        return this.managedAccountProcessingBatchSizeValue
    }

    startManagedAccountProcessing(batchSize: number): void {
        this.managedAccountProcessingBatchSizeValue = batchSize
        this.managedAccountProcessingStartedAt = Date.now()
        this.managedAccountProcessingStateValue = 'initialized'
    }

    resetManagedAccountProcessing(): void {
        this.managedAccountProcessingStateValue = 'idle'
        this.managedAccountProcessingStartedAt = 0
        this.managedAccountProcessingBatchSizeValue = 0
    }

    incrementFormsCreated(): void {
        this.formsCreated++
    }

    incrementFormInstancesCreated(): void {
        this.formInstancesCreated++
    }

    incrementFormsFound(): void {
        this.formsFound++
    }

    incrementFormInstancesFound(): void {
        this.formInstancesFound++
    }

    incrementAnsweredFormInstancesProcessed(): void {
        this.answeredFormInstancesProcessed++
    }

    resetFormCounters(): void {
        this.formsCreated = 0
        this.formInstancesCreated = 0
        this.formsFound = 0
        this.formInstancesFound = 0
        this.answeredFormInstancesProcessed = 0
    }

    queueFormForDeletion(formDefId: string): void {
        if (this.queuedFormDeleteIds.has(formDefId)) return
        this.queuedFormDeleteIds.add(formDefId)
        this.formsToDelete.add(formDefId)
        this.formDeleteQueue.push(formDefId)
    }

    isFormQueuedForDeletion(formDefId: string): boolean {
        return this.queuedFormDeleteIds.has(formDefId)
    }

    getNextFormToDelete(): string | undefined {
        return this.formDeleteQueue.shift()
    }

    markFormDeletionComplete(formDefId: string): void {
        this.formsToDelete.delete(formDefId)
        this.queuedFormDeleteIds.delete(formDefId)
        this.activeFormDeleteWorkers--
    }

    async awaitPendingFormDeleteTasks(): Promise<void> {
        await Promise.all(this.pendingFormDeleteTasks)
    }

    resetFormDeletionQueue(): void {
        this.formsToDelete.clear()
        this.formDeleteQueue = []
        this.pendingFormDeleteTasks.clear()
        this.queuedFormDeleteIds.clear()
        this.activeFormDeleteWorkers = 0
    }

    resetFormState(): void {
        this.resetFormCounters()
        this.resetFormDeletionQueue()
    }

    /**
     * Sets replay-only simulated wall clock from an ISO-8601 string or epoch milliseconds.
     * Live aggregation leaves simulated time unset; `currentTimeMs()` then uses wall clock.
     */
    setSimulatedTime(isoOrMs: string | number): void {
        if (typeof isoOrMs === 'number') {
            this.simulatedTimeMsValue = isoOrMs
            return
        }
        const parsed = Date.parse(isoOrMs)
        if (Number.isNaN(parsed)) {
            throw new Error(`Invalid simulated time: ${isoOrMs}`)
        }
        this.simulatedTimeMsValue = parsed
    }

    clearSimulatedTime(): void {
        this.simulatedTimeMsValue = undefined
    }

    /** Current time for run-scoped age checks; uses simulated time during replay when set. */
    currentTimeMs(): number {
        return this.simulatedTimeMsValue ?? Date.now()
    }

    snapshot(): RunStateSnapshot {
        return {
            managedAccounts: Array.from(this.managedAccountsById.values()),
            fusionAccounts: Array.from(this.fusionAccountMapValue.values()),
            fusionIdentityAccounts: Array.from(this.fusionIdentityMapValue.values()),
            identities: Array.from(this.identityMapValue.values()),
            fusionIdentityDecisions: this.fusionIdentityDecisionsValue.map((d) => ({ ...d })),
            finishedFusionDecisions: this.finishedFusionDecisionsValue.map((d) => ({ ...d })),
            pendingCandidateIdentityIds: Array.from(this.pendingCandidateIdentityIdsValue),
            pendingReviewUrlsByReviewerId: Object.fromEntries(this.pendingReviewUrlsByReviewerIdValue),
            pendingReviewUrlsByCandidateId: Object.fromEntries(this.pendingReviewUrlsByCandidateIdValue),
            sourcesByName: Object.fromEntries(this.sourcesByName),
            currentRunNonMatchedKeysBySource: Object.fromEntries(
                Array.from(this.currentRunNonMatchedKeysBySource).map(([k, v]) => [k, Array.from(v)])
            ),
            fusionBlends: this.fusionBlends,
            autoMergedIds: Array.from(this.autoMergedIdentityIdsValue),
            matchScoringMs: this.matchScoringMs,
            phaseTimings: this.phaseTimings,
            managedAccountInventory: Object.fromEntries(this.managedAccountInventory),
            formCounters: {
                formsCreated: this.formsCreated,
                formInstancesCreated: this.formInstancesCreated,
                formsFound: this.formsFound,
                formInstancesFound: this.formInstancesFound,
                answeredFormInstancesProcessed: this.answeredFormInstancesProcessed,
            },
            formDeleteQueue: {
                formsToDelete: Array.from(this.formsToDelete),
                queuedFormDeleteIds: Array.from(this.queuedFormDeleteIds),
            },
            managedAccountProcessing: {
                state: this.managedAccountProcessingStateValue,
                startedAt: this.managedAccountProcessingStartedAt,
                batchSize: this.managedAccountProcessingBatchSizeValue,
            },
            trigramIndexBuilt: this.trigramIndexBuilt,
            simulatedTimeMs: this.simulatedTimeMsValue,
        }
    }

    restore(snapshot: RunStateSnapshot): void {
        this.managedAccountsById.clear()
        for (const account of snapshot.managedAccounts) {
            this.managedAccountsById.set((account as any).id ?? (account as any).name, account as Account)
        }
        this.fusionAccountMapValue.clear()
        for (const account of snapshot.fusionAccounts) {
            this.fusionAccountMapValue.set(
                (account as any).managedKey ?? (account as any).name,
                account as FusionAccount
            )
        }
        this.fusionIdentityMapValue.clear()
        for (const account of snapshot.fusionIdentityAccounts ?? []) {
            const identityId = (account as FusionAccount).identityId
            if (identityId) {
                this.fusionIdentityMapValue.set(identityId, account as FusionAccount)
            }
        }
        this.identityMapValue.clear()
        for (const identity of snapshot.identities) {
            this.identityMapValue.set((identity as any).id, identity as IdentityDocument)
        }
        this.fusionIdentityDecisionsValue = snapshot.fusionIdentityDecisions as FusionDecision[]
        this.finishedFusionDecisionsValue = (snapshot.finishedFusionDecisions ?? []) as FusionDecision[]
        this.pendingCandidateIdentityIdsValue = new Set(snapshot.pendingCandidateIdentityIds)
        this.pendingReviewUrlsByReviewerIdValue = new Map(Object.entries(snapshot.pendingReviewUrlsByReviewerId))
        this.pendingReviewUrlsByCandidateIdValue = new Map(Object.entries(snapshot.pendingReviewUrlsByCandidateId))
        this.sourcesByName.clear()
        for (const [k, v] of Object.entries(snapshot.sourcesByName)) {
            this.sourcesByName.set(k, v as SourceInfo)
        }
        this.currentRunNonMatchedKeysBySource.clear()
        for (const [k, v] of Object.entries(snapshot.currentRunNonMatchedKeysBySource)) {
            this.currentRunNonMatchedKeysBySource.set(k, new Set(v))
        }
        this.fusionBlends = snapshot.fusionBlends as FusionReportBlend[]
        this.autoMergedIdentityIdsValue.clear()
        for (const id of snapshot.autoMergedIds) {
            this.autoMergedIdentityIdsValue.add(id)
        }
        this.matchScoringMs = snapshot.matchScoringMs
        this.phaseTimings = snapshot.phaseTimings
        this.managedAccountInventory.clear()
        const inventoryRecord =
            snapshot.managedAccountInventory ??
            Object.fromEntries(
                Object.entries(
                    (snapshot as { managedAccountsAllById?: Record<string, Account> }).managedAccountsAllById ?? {}
                ).map(([key, account]) => [key, toManagedAccountInfo(account as Account)])
            )
        for (const [key, info] of Object.entries(inventoryRecord)) {
            this.managedAccountInventory.set(key, info as ManagedAccountInfo)
        }
        this.formsCreated = snapshot.formCounters?.formsCreated ?? 0
        this.formInstancesCreated = snapshot.formCounters?.formInstancesCreated ?? 0
        this.formsFound = snapshot.formCounters?.formsFound ?? 0
        this.formInstancesFound = snapshot.formCounters?.formInstancesFound ?? 0
        this.answeredFormInstancesProcessed = snapshot.formCounters?.answeredFormInstancesProcessed ?? 0
        this.formsToDelete = new Set(snapshot.formDeleteQueue?.formsToDelete ?? [])
        this.queuedFormDeleteIds = new Set(snapshot.formDeleteQueue?.queuedFormDeleteIds ?? [])
        this.formDeleteQueue = snapshot.formDeleteQueue?.formsToDelete ?? []
        this.pendingFormDeleteTasks.clear()
        this.activeFormDeleteWorkers = 0
        this.managedAccountProcessingStateValue = snapshot.managedAccountProcessing?.state ?? 'idle'
        this.managedAccountProcessingStartedAt = snapshot.managedAccountProcessing?.startedAt ?? 0
        this.managedAccountProcessingBatchSizeValue = snapshot.managedAccountProcessing?.batchSize ?? 0
        this.trigramIndexBuilt = snapshot.trigramIndexBuilt ?? false
        this.simulatedTimeMsValue = snapshot.simulatedTimeMs
    }
}

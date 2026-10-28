import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'
import { Attributes, ConnectorError, ConnectorErrorType } from '@sailpoint/connector-sdk'
import { FusionDecision } from './form'
import { SourceType } from './config'
import { isNewerThan } from '../utils/date'
import { readString, trimStr } from '../utils/safeRead'
import { StatusEntitlement } from './statusEntitlement'
import { buildIdentityInfo, isIdentityOriginFusionAccount } from './fusionAccountUtils'
import {
    buildManagedAccountKey,
    getManagedAccountKeyFromAccount,
    isCompositeManagedAccountKey,
    normalizeCompositeManagedAccountKey,
    parseManagedAccountKey,
} from './managedAccountKey'
import { FusionAccount, IDENTITIES_SOURCE_NAME } from './fusionAccount'
import { FusionMatch } from '../services/matchingService'
import { getManagedAccountSnapshotKey } from '../utils/velocityAccountSnapshot'
import type { FusionCollections } from './fusionCollections'
import type { FusionRun, ManagedAccountInfo } from './fusionRun'
import type { IdentityInfo } from './fusionAccountTypes'

/**
 * Options for {@link FusionLayers.addManagedAccountLayer}.
 *
 * **Source snapshot materialization** copies managed account attributes onto
 * `attributeBag.sources` so Map and Velocity `$accounts` / `$sources` can read this run.
 * **Claim-only absorb** still claims the work-queue key and updates bookkeeping
 * (`managedAccountInfo`, uncorrelated/status, source names) without that copy.
 * Claim still fills **claimed account retention** on FusionRun. When live sources become
 * required later in the same run, missing linked keys rematerialize from retention
 * without returning those keys to the Match work queue.
 * Prelude flags below are ORed with Fusion-account-local new-blend, over-threshold `modified`,
 * and prune-deleted before any `claimAccount`.
 */
export interface AddManagedAccountOptions {
    pruneDeleted?: boolean
    addBlendHistory?: boolean
    skipBlendHistoryForManagedKeys?: ReadonlySet<string>
    onBlend?: (account: Account) => void
    onQueueScan?: (entriesExamined: number) => void
    /** Prelude: force attribute refresh so Map/Define will read this run's live sources. */
    forceAttributeRefresh?: boolean
    /** Prelude: rebuild asked for mapping refresh. */
    refreshMapping?: boolean
    /** Prelude: rebuild asked for definition refresh. */
    refreshDefinition?: boolean
    /** Prelude: rebuild asked to reset definitions. */
    resetDefinition?: boolean
    /**
     * Prelude: at least one Normal definition has Always recalculate and is eligible
     * on this Fusion account (`definition.refresh` and not skipped static).
     */
    hasEligibleAlwaysRecalculate?: boolean
    /** Caller-computed prelude bit: live source snapshots are required before this layer runs. */
    requireLiveSourceSnapshots?: boolean
}

/**
 * Fusion account collaborator for identity / managed-account / fusion-decision enrichment
 * and layer flags (needsRefresh, disabled, origin metadata, and related).
 */
export class FusionLayers {
    private needsRefreshValue = false
    private needsResetValue = false
    private isIdentityValue = false
    private isMatchValue = false
    private disabledValue = false
    private uncorrelatedValue = false
    private originSourceValue?: string
    private originAccountValue?: string
    private originIdentityInScopeValue?: boolean

    constructor(
        private readonly collections: FusionCollections,
        private readonly sourceConfigNamesSet: ReadonlySet<string>,
        private readonly fusionAccountRefreshThresholdInSeconds: number
    ) {}

    get needsRefresh(): boolean {
        return this.needsRefreshValue
    }
    set needsRefresh(v: boolean) {
        this.needsRefreshValue = v
    }

    get needsReset(): boolean {
        return this.needsResetValue
    }
    set needsReset(v: boolean) {
        this.needsResetValue = v
    }

    get isIdentity(): boolean {
        return this.isIdentityValue
    }
    set isIdentity(v: boolean) {
        this.isIdentityValue = v
    }

    get isMatch(): boolean {
        return this.isMatchValue
    }

    get disabled(): boolean {
        return this.disabledValue
    }
    set disabled(v: boolean) {
        this.disabledValue = v
    }

    get uncorrelated(): boolean {
        return this.uncorrelatedValue
    }
    set uncorrelated(v: boolean) {
        this.uncorrelatedValue = v
    }

    get originSource(): string | undefined {
        return this.originSourceValue
    }
    set originSource(v: string | undefined) {
        this.originSourceValue = v
    }

    get originAccount(): string | undefined {
        return this.originAccountValue
    }
    set originAccount(v: string | undefined) {
        this.originAccountValue = v
    }

    get originIdentityInScope(): boolean | undefined {
        return this.originIdentityInScopeValue
    }
    set originIdentityInScope(v: boolean | undefined) {
        this.originIdentityInScopeValue = v
    }

    // ============================================================================
    // addIdentityLayer
    // ============================================================================

    addIdentityLayer(
        identity: IdentityDocument,
        attributeBag: { identity: Attributes },
        identityInfo: IdentityInfo | undefined,
        modified?: string,
        setEmail?: (email: string) => void,
        setIdentityInfo?: (info: IdentityInfo) => void
    ): void {
        if (setEmail) setEmail(identity.attributes?.email as string)
        const builtInfo = buildIdentityInfo(identity)
        if (setIdentityInfo && builtInfo) {
            setIdentityInfo(builtInfo)
        }
        attributeBag.identity = identity.attributes ?? {}
        attributeBag.identity.name = identity.name
        // Identity layer enriches Velocity blending only. isIdentity (managed-source
        // correlation) is set by factory methods from source account.uncorrelated.

        if (!this.needsRefreshValue && isNewerThan(identity.modified, modified)) {
            this.needsRefreshValue = true
        }

        for (const account of identity.accounts ?? []) {
            if (!this.sourceConfigNamesSet.has(account.source?.name ?? '')) continue
            const managedAccountKey = buildManagedAccountKey({
                sourceId: account.source?.id,
                nativeIdentity: readString(account, 'nativeIdentity'),
            })
            if (managedAccountKey) {
                this.collections.accounts.add(managedAccountKey)
                this.collections.accounts.removeMissing(managedAccountKey)
            }
        }
    }

    // ============================================================================
    // addManagedAccountLayer
    // ============================================================================

    addManagedAccountLayer(
        workQueue: FusionRun,
        attributeBag: { current: Attributes; sources: Map<string, Attributes[]>; sourceAccountContexts: Attributes[] },
        identityInfo: IdentityInfo | undefined,
        modified?: string,
        iscAccountId?: string,
        setIscAccountId?: (id: string) => void,
        setSourceName?: (name: string) => void,
        invalidateSourceCache?: () => void,
        options: AddManagedAccountOptions = {}
    ): void {
        const {
            pruneDeleted = false,
            addBlendHistory = true,
            skipBlendHistoryForManagedKeys,
            onBlend,
            onQueueScan,
        } = options
        const normalizeManagedAccountKeySet = (input: Set<string>): Set<string> => {
            const result = new Set<string>()
            for (const key of input) {
                const normalized = normalizeCompositeManagedAccountKey(key)
                if (normalized !== undefined) {
                    result.add(normalized)
                }
            }
            return result
        }

        this.collections.setPreviousAccountIds(
            normalizeManagedAccountKeySet(new Set(this.collections.previousAccountIds))
        )
        this.collections.replaceMissingAccountIds(
            normalizeManagedAccountKeySet(new Set(this.collections.missingAccountIds))
        )
        this.collections.replaceAccountIds(normalizeManagedAccountKeySet(new Set(this.collections.accountIds)))

        const materializeSourceSnapshots = this.computeRequireLiveSourceSnapshots(
            workQueue,
            options,
            identityInfo?.id,
            modified
        )

        this.processIdentityMatchedAccounts(
            workQueue,
            attributeBag,
            addBlendHistory,
            skipBlendHistoryForManagedKeys,
            onBlend,
            identityInfo?.id,
            modified,
            materializeSourceSnapshots
        )
        this.dropForeignOwnedManagedAccounts(workQueue, identityInfo?.id)
        this.processDeclaredAccountIds(
            workQueue,
            attributeBag,
            addBlendHistory,
            skipBlendHistoryForManagedKeys,
            onBlend,
            modified,
            materializeSourceSnapshots
        )
        this.processPreviousRunMatchedAccounts(
            workQueue,
            attributeBag,
            addBlendHistory,
            skipBlendHistoryForManagedKeys,
            onBlend,
            onQueueScan,
            modified,
            materializeSourceSnapshots
        )

        if (materializeSourceSnapshots) {
            this.rematerializeMissingLinkedSnapshots(
                workQueue,
                attributeBag,
                addBlendHistory,
                skipBlendHistoryForManagedKeys,
                onBlend,
                modified
            )
        }

        if (pruneDeleted) {
            this.pruneDeletedManagedAccounts(workQueue.managedAccountInventory)
        }

        this.preserveMissingAccountContext(workQueue.managedAccountInventory)

        // Record-source accounts never retain a Fusion account.
        const hasRetainingAccount = [...this.collections.accountIds].some(
            (id) => !this.isRecordSourceAccount(id, workQueue.managedAccountInventory)
        )
        if (!hasRetainingAccount) {
            const fromIdentity = isIdentityOriginFusionAccount(
                this.originSourceValue,
                attributeBag.current,
                this.collections.statusesSet.has(StatusEntitlement.Baseline)
            )

            if (fromIdentity) {
                if (this.originIdentityInScopeValue === false) {
                    this.collections.statuses.add(StatusEntitlement.Orphan)
                    this.needsRefreshValue = false
                } else if (this.originIdentityInScopeValue === true) {
                    this.collections.statuses.remove(StatusEntitlement.Orphan)
                }
            } else {
                this.collections.statuses.add(StatusEntitlement.Orphan)
                this.needsRefreshValue = false
            }
        } else {
            this.collections.statuses.remove(StatusEntitlement.Orphan)
        }
    }

    // ============================================================================
    // addFusionDecisionLayer
    // ============================================================================

    addFusionDecisionLayer(decision: FusionDecision): void {
        const managedKey = trimStr(decision.account.id) ?? ''
        if (!isCompositeManagedAccountKey(managedKey)) {
            throw new ConnectorError(
                `Fusion decision account id must be a managed account key (sourceId::nativeIdentity), received: "${managedKey || 'empty'}".`,
                ConnectorErrorType.Generic
            )
        }
        this.collections.statuses.setUncorrelatedAccount(managedKey)
        this.uncorrelatedValue = true
        this.collections.statuses.add(StatusEntitlement.Uncorrelated)
        this.collections.removeActionSilent('correlated')

        const sourceType = decision.sourceType ?? SourceType.Authoritative

        if (decision.newIdentity) {
            if (sourceType === SourceType.Authoritative) {
                this.collections.statuses.setManual(decision)
            }
        } else {
            this.collections.statuses.setAuthorized(decision)
        }
    }

    // ============================================================================
    // Match management
    // ============================================================================

    addFusionMatch(fusionMatch: FusionMatch): void {
        this.collections.matches.add(fusionMatch)
        this.isMatchValue = true
    }

    clearFusionIdentityReferences(): void {
        this.collections.matches.clearRefs()
    }

    removeDeferredFusionMatches(): void {
        this.collections.matches.removeDeferred()
    }

    /** Replace stored matches after identity top-K retention. */
    replaceFusionMatches(fusionMatches: FusionMatch[]): void {
        this.collections.matches.replaceAll(fusionMatches)
        if (fusionMatches.length > 0) {
            this.isMatchValue = true
        }
    }

    // ============================================================================
    // Private: setManagedAccount
    // ============================================================================

    /**
     * Absorbs a work-queue managed account: bookkeeping always, and **source snapshot
     * materialization** when `materializeSourceSnapshots` is true. Claim-only absorb
     * updates keys / uncorrelated / `managedAccountInfo` / source names without copying
     * `account.attributes` onto `attributeBag.sources`. Attribute bodies still move into
     * FusionRun claimed account retention on `claimAccount` for possible later rematerialization.
     */
    setManagedAccount(
        account: Account,
        addBlendHistory: boolean = true,
        skipBlendHistoryForManagedKeys?: ReadonlySet<string>,
        attributeBag?: { sources: Map<string, Attributes[]> },
        fusionModified?: string,
        materializeSourceSnapshots: boolean = true
    ) {
        const accountId = getManagedAccountKeyFromAccount(account)
        if (!accountId) {
            throw new ConnectorError(
                'Cannot absorb managed account without sourceId and nativeIdentity (composite key).',
                ConnectorErrorType.Generic
            )
        }
        const normalizedKey = accountId
        const skipBlendReplay =
            Boolean(skipBlendHistoryForManagedKeys?.has(normalizedKey)) ||
            Boolean(skipBlendHistoryForManagedKeys?.has(accountId))
        const recordBlendHistory = addBlendHistory && !skipBlendReplay
        const isNewAccount = !this.collections.previousAccountIds.has(accountId)

        if (isNewAccount) {
            this.needsRefreshValue = true
            if (recordBlendHistory) {
                const accountLabel = trimStr(account.name ?? account.nativeIdentity ?? accountId) || accountId
                const sourceLabel = account.sourceName ?? ''
                this.collections.addHistoryMessage(
                    `Blended managed account ${accountLabel} [${sourceLabel || 'Unknown source'}]`
                )
            }
        }
        if (!this.needsRefreshValue) {
            const thresholdMs = this.fusionAccountRefreshThresholdInSeconds * 1000
            if (fusionModified && isNewerThan(account.modified, fusionModified, thresholdMs)) {
                this.needsRefreshValue = true
            }
        }

        if (account.sourceName && attributeBag) {
            const parsedKey = parseManagedAccountKey(accountId)
            const schemaNative = trimStr(account.nativeIdentity ?? parsedKey?.nativeIdentity) || accountId
            this.collections.setManagedAccountInfo(accountId, {
                source: { name: account.sourceName },
                schema: { id: schemaNative },
            })
            this.collections.sources.remove(IDENTITIES_SOURCE_NAME)
            this.collections.sources.add(account.sourceName)

            if (materializeSourceSnapshots) {
                this.copyManagedAccountSnapshot(account, accountId, attributeBag, false)
            }
        }
        return recordBlendHistory && isNewAccount
    }

    /**
     * Copies a managed account onto `attributeBag.sources`. Retention-backed copies
     * prepend so previously claimed origin/sibling snapshots stay ahead of new blends
     * for Velocity `$sources.get($originSource)[0]`.
     */
    private copyManagedAccountSnapshot(
        account: Account,
        accountId: string,
        attributeBag: { sources: Map<string, Attributes[]> },
        prepend: boolean
    ): void {
        if (!account.sourceName) return
        const parsedKey = parseManagedAccountKey(accountId)
        const schemaNative = trimStr(account.nativeIdentity ?? parsedKey?.nativeIdentity) || accountId
        const contextAttributes = {
            ...(account.attributes ?? {}),
            name: trimStr(account.name ?? account.nativeIdentity) || accountId,
            source: {
                id: trimStr(readString(account, 'sourceId', '')) ?? '',
                name: account.sourceName ?? '',
            },
            schema: {
                name: trimStr(account.name ?? account.nativeIdentity) || accountId,
                id: schemaNative,
            },
            IIQDisabled: Boolean(account.disabled),
        } as unknown as Attributes

        const existingSourceAccounts = attributeBag.sources.get(account.sourceName) || []
        if (prepend) {
            existingSourceAccounts.unshift(contextAttributes)
        } else {
            existingSourceAccounts.push(contextAttributes)
        }
        attributeBag.sources.set(account.sourceName, existingSourceAccounts)
    }

    /**
     * When live sources are required, fill snapshots for live linked keys that were
     * claimed earlier in this run. Does not put those keys back on the Match work queue.
     */
    private rematerializeMissingLinkedSnapshots(
        queue: FusionRun,
        attributeBag: { sources: Map<string, Attributes[]> },
        addBlendHistory: boolean,
        skipBlendHistoryForManagedKeys?: ReadonlySet<string>,
        onBlend?: (account: Account) => void,
        fusionModified?: string
    ): void {
        const previousLinked: string[] = []
        const remainingLinked: string[] = []
        for (const accountId of this.collections.accountIds) {
            if (this.collections.previousAccountIds.has(accountId)) {
                previousLinked.push(accountId)
            } else {
                remainingLinked.push(accountId)
            }
        }

        for (const accountId of [...previousLinked, ...remainingLinked]) {
            if (this.hasSourceSnapshot(accountId, attributeBag.sources)) continue
            const onQueue = queue.get(accountId)
            const retained = queue.getRetainedAccount(accountId)
            const account = onQueue ?? retained
            if (!account) continue

            const blended = this.setManagedAccount(
                account,
                addBlendHistory,
                skipBlendHistoryForManagedKeys,
                attributeBag,
                fusionModified,
                false
            )
            this.copyManagedAccountSnapshot(account, accountId, attributeBag, retained !== undefined && !onQueue)
            if (blended && onBlend) onBlend(account)
            if (onQueue) {
                queue.claimAccount(accountId, account.identityId)
            }
        }
    }

    // ============================================================================
    // Private: Matcher functions (inlined from fusionAccountMatcher.ts)
    // ============================================================================

    private processIdentityMatchedAccounts(
        queue: FusionRun,
        attributeBag: { sources: Map<string, Attributes[]> },
        addBlendHistory: boolean,
        skipBlendHistoryForManagedKeys?: ReadonlySet<string>,
        onBlend?: (account: Account) => void,
        identityId?: string,
        fusionModified?: string,
        materializeSourceSnapshots: boolean = true
    ): void {
        if (identityId === undefined) return

        const matchedIds = queue.getKeysForIdentity(identityId)
        if (!matchedIds || matchedIds.size === 0) return

        for (const id of matchedIds) {
            const account = queue.get(id)
            if (account) {
                this.collections.accounts.add(id)
                this.collections.accounts.removeMissing(id)
                const blended = this.setManagedAccount(
                    account,
                    addBlendHistory,
                    skipBlendHistoryForManagedKeys,
                    attributeBag,
                    fusionModified,
                    materializeSourceSnapshots
                )
                if (blended && onBlend) onBlend(account)
                queue.claimAccount(id, account.identityId)
            }
        }
        queue.claimAccountsForIdentity(identityId)
    }

    /**
     * Blends managed accounts already listed on the Fusion account (e.g. from
     * {@link addIdentityLayer} identity.accounts links) when they exist in the
     * work queue but were not reached by the identity-id index or previous-run paths.
     */
    private processDeclaredAccountIds(
        queue: FusionRun,
        attributeBag: { sources: Map<string, Attributes[]> },
        addBlendHistory: boolean,
        skipBlendHistoryForManagedKeys?: ReadonlySet<string>,
        onBlend?: (account: Account) => void,
        fusionModified?: string,
        materializeSourceSnapshots: boolean = true
    ): void {
        if (this.collections.accountIds.size === 0) return

        for (const accountId of this.collections.accountIds) {
            if (this.hasSourceSnapshot(accountId, attributeBag.sources)) continue

            const account = queue.get(accountId)
            if (!account) continue

            // A declared key may still be explicitly missing after an authorized blend.
            // Only verified identity matching or a correlation PATCH may clear that state.
            this.collections.accounts.add(accountId)
            const blended = this.setManagedAccount(
                account,
                addBlendHistory,
                skipBlendHistoryForManagedKeys,
                attributeBag,
                fusionModified,
                materializeSourceSnapshots
            )
            if (blended && onBlend) onBlend(account)
            queue.claimAccount(accountId, account.identityId)
        }
    }

    private hasSourceSnapshot(accountId: string, sources: Map<string, Attributes[]>): boolean {
        for (const snapshots of sources.values()) {
            for (const snapshot of snapshots) {
                if (getManagedAccountSnapshotKey(snapshot) === accountId) {
                    return true
                }
            }
        }
        return false
    }

    private processPreviousRunMatchedAccounts(
        queue: FusionRun,
        attributeBag: { sources: Map<string, Attributes[]> },
        addBlendHistory: boolean,
        skipBlendHistoryForManagedKeys?: ReadonlySet<string>,
        onBlend?: (account: Account) => void,
        onQueueScan?: (entriesExamined: number) => void,
        fusionModified?: string,
        materializeSourceSnapshots: boolean = true
    ): void {
        if (this.collections.previousAccountIds.size === 0 && this.collections.missingAccountIds.size === 0) return

        const candidateIds = new Set([...this.collections.previousAccountIds, ...this.collections.missingAccountIds])
        onQueueScan?.(candidateIds.size)

        for (const id of candidateIds) {
            const account = queue.get(id)
            if (!account) continue

            this.collections.statuses.setUncorrelatedAccount(id)
            this.uncorrelatedValue = true
            this.collections.statuses.add(StatusEntitlement.Uncorrelated)
            this.collections.removeActionSilent('correlated')
            const blended = this.setManagedAccount(
                account,
                addBlendHistory,
                skipBlendHistoryForManagedKeys,
                attributeBag,
                fusionModified,
                materializeSourceSnapshots
            )
            if (blended && onBlend) onBlend(account)
            queue.claimAccount(id, account.identityId)
        }
    }

    /**
     * Whole-account decide-before-claim: live sources are required when any prelude flag
     * is set, `needsRefresh` is already true, any linked queue key is a new blend or
     * over-threshold newer, or prune-deleted would drop a tracked key.
     * Already-claimed keys are recovered from claimed account retention later in this
     * invocation; they are not expected to still sit on the Match work queue.
     */
    private computeRequireLiveSourceSnapshots(
        queue: FusionRun,
        options: AddManagedAccountOptions,
        identityId?: string,
        fusionModified?: string
    ): boolean {
        if (this.needsRefreshValue) return true
        if (options.requireLiveSourceSnapshots) return true
        if (options.forceAttributeRefresh) return true
        if (options.refreshMapping || options.refreshDefinition || options.resetDefinition) return true
        if (options.hasEligibleAlwaysRecalculate) return true

        const previousOrMissingKeys = new Set([
            ...this.collections.previousAccountIds,
            ...this.collections.missingAccountIds,
        ])
        for (const key of previousOrMissingKeys) {
            if (queue.isManagedAccountForeignOwned(key, identityId)) return true
        }

        const linkedKeys = new Set<string>()
        if (identityId !== undefined) {
            for (const key of queue.getKeysForIdentity(identityId) ?? []) {
                linkedKeys.add(key)
            }
        }
        for (const key of this.collections.accountIds) linkedKeys.add(key)
        for (const key of this.collections.previousAccountIds) linkedKeys.add(key)
        for (const key of this.collections.missingAccountIds) linkedKeys.add(key)

        const thresholdMs = this.fusionAccountRefreshThresholdInSeconds * 1000
        for (const key of linkedKeys) {
            const account = queue.get(key)
            if (!account) continue
            if (!this.collections.previousAccountIds.has(key)) return true
            if (fusionModified && isNewerThan(account.modified, fusionModified, thresholdMs)) {
                return true
            }
        }

        if (options.pruneDeleted) {
            const inventoryKeys = queue.managedAccountInventory
            const trackedIds = new Set<string>([
                ...this.collections.accountIds,
                ...this.collections.missingAccountIds,
                ...this.collections.previousAccountIds,
            ])
            for (const accountId of trackedIds) {
                if (!inventoryKeys.has(accountId)) return true
            }
        }

        return false
    }

    private dropForeignOwnedManagedAccounts(queue: FusionRun, identityId?: string): void {
        const candidateIds = new Set([...this.collections.previousAccountIds, ...this.collections.missingAccountIds])
        for (const accountId of candidateIds) {
            if (!queue.isManagedAccountForeignOwned(accountId, identityId)) continue
            this.removeManagedAccountReference(accountId)
        }
    }

    private preserveMissingAccountContext(inventory: ReadonlyMap<string, ManagedAccountInfo>): void {
        for (const accountId of this.collections.missingAccountIds) {
            if (this.collections.managedAccountInfo.has(accountId)) continue
            const info = inventory.get(accountId)
            if (!info?.sourceName) continue
            const parsed = parseManagedAccountKey(accountId)
            const nativeId = trimStr(info.nativeIdentity ?? parsed?.nativeIdentity) || accountId
            this.collections.setManagedAccountInfo(accountId, {
                source: { name: info.sourceName },
                schema: { id: nativeId },
            })
        }
    }

    /** Unknown or untyped sources count as retaining, so missing info never orphans an account. */
    private isRecordSourceAccount(accountId: string, inventory: ReadonlyMap<string, ManagedAccountInfo>): boolean {
        const sourceName =
            this.collections.managedAccountInfo.get(accountId)?.source.name ?? inventory.get(accountId)?.sourceName
        return FusionAccount.configuredSourceType(sourceName) === SourceType.Record
    }

    private pruneDeletedManagedAccounts(inventory: ReadonlyMap<string, ManagedAccountInfo>): void {
        const trackedIds = new Set<string>([
            ...this.collections.accountIds,
            ...this.collections.missingAccountIds,
            ...this.collections.previousAccountIds,
        ])
        let removedAnyReference = false

        for (const accountId of trackedIds) {
            if (inventory.has(accountId)) continue
            removedAnyReference = this.removeManagedAccountReference(accountId) || removedAnyReference
        }
        if (removedAnyReference) {
            this.needsRefreshValue = true
        }
    }

    private removeManagedAccountReference(accountId: string): boolean {
        const removedFromAccounts = this.collections.accounts.remove(accountId)
        const removedFromMissing = this.collections.accounts.removeMissing(accountId)
        const previousAccountIds = new Set(this.collections.previousAccountIds)
        const removedFromPrevious = previousAccountIds.delete(accountId)
        this.collections.setPreviousAccountIds(previousAccountIds)
        this.collections.deleteManagedAccountInfo(accountId)

        const removed = removedFromAccounts || removedFromMissing || removedFromPrevious
        if (removed) {
            this.needsRefreshValue = true
            this.collections.addHistoryMessage(`Removed managed account missing reference: ${accountId}`)
        }
        return removed
    }
}

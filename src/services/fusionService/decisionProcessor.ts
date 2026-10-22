import { IdentityDocument } from 'sailpoint-api-client'
import { FusionAccount } from '../../model/account'
import { FusionDecision } from '../../model/form'
import { FusionConfig, SourceType } from '../../model/config'
import { LogService } from '../logService'
import { normalizeCompositeManagedAccountKey } from '../../model/managedAccountKey'
import { StatusEntitlement } from '../../model/statusEntitlement'
import { trimStr } from '../../utils/safeRead'
import { compact, batchProcess } from './collections'
import { skipBlendHistoryKeysForDecisionAccountId } from './helpers'
import { FusionRun } from '../../model/fusionRun'
import type { FormService } from '../formService'
import type { IdentityService } from '../identityService'
import type { CorrelationManager } from '../correlationManager'
import type { DefinitionService } from '../definitionService'
import type { MappingService } from '../mappingService'
import { applyNonAuthoritativeNoMatch } from '../matchingService/matchOutcomeDispatcher'
import { isOwnershipModeSource } from '../sourceService/managedAccountFetcher'
import type { SourceService } from '../sourceService'
import { AccountAssembly } from '../accountAssembly'
import {
    formatDecisionCountsSegment,
    logFusionDecisionApplied,
    summarizeDecisionCounts,
} from './decisionLogging'

export interface DecisionProcessorDeps {
    forms: FormService
    identities: IdentityService
    correlationManager: CorrelationManager
    definitionService: DefinitionService
    mappingService: MappingService
    accountAssembly: AccountAssembly
    sources: SourceService
}

export class DecisionProcessor {
    constructor(
        private config: FusionConfig,
        private log: LogService,
        private run: FusionRun,
        private deps: DecisionProcessorDeps,
    ) {}

    /**
     * Reconcile transient entitlements derived from pending form instances.
     *
     * This is intended for StdAccountList runs:
     * - Clears any persisted/stale 'candidate' and reviewer 'reviews'
     * - Re-applies them only from currently-known pending (unanswered) form instances
     *
     * This is necessary because not all identities may originate from existing fusion accounts
     * (some can be created from Identity documents), and those would otherwise retain stale values.
     */
    public reconcilePendingFormState(): void {
        const pendingCandidateIds = this.run.pendingCandidateIdentityIds
        const pendingReviewUrlsByReviewerId = this.run.pendingReviewUrlsByReviewerId
        const pendingReviewUrlsByCandidateId = this.run.pendingReviewUrlsByCandidateId
        const candidateIdsNeedingStatus = new Set<string>(pendingCandidateIds)
        for (const id of pendingReviewUrlsByCandidateId.keys()) {
            candidateIdsNeedingStatus.add(id)
        }

        // Clear stale transient state, re-apply candidate statuses, and sync attributes.
        for (const account of this.run.fusionAccountsIterable()) {
            this.reconcileCandidateStatus(account, candidateIdsNeedingStatus)
            account.syncCollectionAttributesToBag()
        }

        for (const identity of this.run.allFusionIdentities) {
            this.reconcileCandidateStatus(identity, candidateIdsNeedingStatus)
            const identityId = identity.identityId
            if (identityId) {
                const urls = pendingReviewUrlsByReviewerId.get(identityId)
                if (urls?.length) {
                    for (const url of urls) {
                        identity.collections.reviews.addFusionReview(url)
                    }
                }
            }
            identity.syncCollectionAttributesToBag()
        }
    }

    private reconcileCandidateStatus(account: FusionAccount, candidateIdsNeedingStatus: Set<string>): void {
        account.collections.statuses.remove(StatusEntitlement.Candidate)
        account.collections.reviews.clearFusionReviews()

        const identityId = account.identityId
        if (identityId && candidateIdsNeedingStatus.has(identityId)) {
            account.collections.statuses.add(StatusEntitlement.Candidate)
        }
    }

    /**
     * Refresh pending form data and reconcile transient candidate/reviewer output state
     * for the single account being processed.
     *
     * Single-account operations (create/read/enable/disable) handle one identity at a time,
     * but the shared form/decision state can carry transient 'candidate' and reviewer
     * 'reviews' entries from other accounts processed in the same lifecycle. Before
     * serializing the ISC account output, this method:
     * 1. Re-fetches the latest pending form instances via {@link FusionForms.fetchFormData}
     *    so the current account's pending decisions are reflected.
     * 2. Calls {@link reconcilePendingFormState} to drop stale 'candidate' / 'reviews'
     *    entries (which may reference accounts not present in this run) and
     *    rebuild them from the currently-known pending (unanswered) form instances,
     *    so the serialized output only references the account being returned.
     */
    public async normalizePendingFormStateForOutput(): Promise<void> {
        this.log.detail({ action: 'normalizing pending form state for output' })
        await this.deps.forms.fetchFormData()
        this.reconcilePendingFormState()
    }

    /**
     * Process queued fusion identity decisions, plus authorized merges that
     * never reached a persisted Fusion account (still in the managed-account queue).
     *
     * @returns The fusion accounts produced by those decisions
     */
    public async processFusionIdentityDecisions(): Promise<FusionAccount[]> {
        this.enqueueUnappliedAuthorizedMerges()
        const fusionIdentityDecisions = [...this.run.fusionIdentityDecisions]
        this.log.detail({
            action: 'processing fusion identity decisions',
            count: fusionIdentityDecisions.length,
        })

        const results = await batchProcess(fusionIdentityDecisions, 'Fusion identity decisions', (x) =>
            this.processFusionIdentityDecision(x), this.config, this.log
        )
        const applied = compact(results)
        const discoveredCounts = summarizeDecisionCounts(fusionIdentityDecisions)
        this.log.detail({
            action: 'fusion identity decisions phase finished',
            count: fusionIdentityDecisions.length,
            applied: applied.length,
            skipped: fusionIdentityDecisions.length - applied.length,
            decisions: formatDecisionCountsSegment(
                {
                    newIdentity: discoveredCounts.newIdentity,
                    merge: discoveredCounts.merge,
                    noMatch: discoveredCounts.noMatch,
                    autoMerge: discoveredCounts.autoMerge,
                },
                true
            ),
        })
        return applied
    }

    /**
     * Authorized merges are only queued at fetch when they create a new identity.
     * A completed merge whose managed account is still in the work queue was not
     * applied during refresh — typically because no persisted Fusion account exists
     * (reviewer-gated unique id). Enqueue it so correlation runs before rematch.
     */
    private enqueueUnappliedAuthorizedMerges(): void {
        const queuedKeys = new Set<string>()
        for (const queued of this.run.fusionIdentityDecisions) {
            const key = normalizeCompositeManagedAccountKey(trimStr(queued.account?.id) ?? '')
            if (key) queuedKeys.add(key)
        }

        for (const decision of this.run.finishedFusionDecisions) {
            if (decision.newIdentity) continue
            if (!trimStr(decision.identityId)) continue
            const key = normalizeCompositeManagedAccountKey(trimStr(decision.account?.id) ?? '')
            if (!key || queuedKeys.has(key)) continue
            if (!this.run.managedAccountsById.has(key)) continue
            this.run.addDecision(decision)
            queuedKeys.add(key)
        }
    }

    /**
     * Processes a single fusion identity decision (reviewer form response).
     * Creates a new fusion identity for "new identity" decisions, or merges
     * into an existing one for "authorized" decisions.
     *
     * @param fusionDecision - The reviewer's decision from the review form
     * @returns The fusion account produced or updated, or undefined if the decision was skipped
     */
    public async processFusionIdentityDecision(fusionDecision: FusionDecision): Promise<FusionAccount | undefined> {
        const sourceType = fusionDecision.sourceType ?? SourceType.Authoritative
        const sourceInfo = this.run.sourcesByName.get(fusionDecision.account.sourceName)
        const isAuthorizedDecision = !fusionDecision.newIdentity

        const selectedIdentityId = trimStr(fusionDecision.identityId)
        if (isAuthorizedDecision && isOwnershipModeSource(sourceInfo) && selectedIdentityId) {
            await this.deps.sources.setMachineAccountOwnerIdentity(fusionDecision.account, selectedIdentityId)
            this.claimDecidedOwnershipAccount(fusionDecision)
            return undefined
        }

        // Enrich submitter and selected identity display names for user-facing output.
        await this.enrichDecisionSubmitter(fusionDecision)
        let selectedIdentity = await this.enrichDecisionIdentityName(fusionDecision)

        const existingIdentityAccount =
            isAuthorizedDecision && fusionDecision.identityId
                ? this.resolveAuthorizedMergeTarget(fusionDecision.identityId)
                : undefined
        const fusionAccount = existingIdentityAccount ?? FusionAccount.fromFusionDecision(fusionDecision)

        if (isAuthorizedDecision && fusionDecision.identityId) {
            if (!selectedIdentity) {
                selectedIdentity = await this.resolveIdentityBestEffort(fusionDecision.identityId)
            }
            if (selectedIdentity) {
                fusionAccount.addIdentityLayer(selectedIdentity)
            }
        }

        fusionAccount.setNeedsReset(Boolean(fusionDecision.newIdentity))
        fusionAccount.layers.addFusionDecisionLayer(fusionDecision)

        const normalizedDecisionKey = normalizeCompositeManagedAccountKey(trimStr(fusionDecision.account.id) ?? '')
        const skipBlendHistoryForManagedKeys = skipBlendHistoryKeysForDecisionAccountId(fusionDecision.account.id)
        const managedAccountForNoMatch = normalizedDecisionKey
            ? this.run.managedAccountsById.get(normalizedDecisionKey)
            : undefined

        await this.deps.accountAssembly.assembleAccount(fusionAccount, { skipBlendHistoryForManagedKeys })

        if (isAuthorizedDecision) {
            await this.deps.correlationManager.applyPerSourceCorrelationIfNeeded(
                fusionAccount,
                fusionDecision,
                'merge'
            )
            fusionAccount.updateCorrelationStatus(
                this.deps.accountAssembly.isAggregationAccountListMode()
                    ? undefined
                    : () => this.log.recordCorrelatedActionGranted()
            )
            this.deps.accountAssembly.registerFusionAccount(fusionAccount)
            logFusionDecisionApplied(
                this.log,
                fusionDecision,
                existingIdentityAccount ? 'reused-target' : 'merged'
            )
        }

        if (fusionDecision.newIdentity) {
            if (await applyNonAuthoritativeNoMatch(fusionAccount, sourceType, sourceInfo, managedAccountForNoMatch, {
                definitionService: this.deps.definitionService,
                mappingService: this.deps.mappingService,
                run: this.run,
            })) {
                logFusionDecisionApplied(
                    this.log,
                    fusionDecision,
                    sourceType === SourceType.Record ? 'dropped-record' : 'dropped-orphan'
                )
                return undefined
            }
            this.deps.accountAssembly.registerFusionAccount(fusionAccount)
            logFusionDecisionApplied(this.log, fusionDecision, 'registered')
        }
        return fusionAccount
    }

    /**
     * Ownership decisions persist `ownerIdentity` but deliberately do not correlate the
     * account or attach it to a Fusion account, so they skip {@link AccountAssembly}
     * (which normally claims the managed account off the Match work queue).
     *
     * Claim the account here once the owner is written. Otherwise the same run's
     * uncorrelated sweep re-scores the stale (owner-less) snapshot and opens a duplicate
     * review form, and the account reappears in the report's Fusion Reviews section even
     * though its review was already decided.
     */
    private claimDecidedOwnershipAccount(decision: FusionDecision): void {
        const key = normalizeCompositeManagedAccountKey(trimStr(decision.account?.id) ?? '')
        if (!key) return
        const queued = this.run.get(key)
        this.run.claimAccount(key, queued?.identityId)
    }

    /**
     * Best-effort: enrich the submitter's display name from the identity cache (or live API in aggregation mode).
     * Mutates `decision.submitter.name` in-place when a label is found.
     */
    private async enrichDecisionSubmitter(decision: FusionDecision): Promise<void> {
        const submitterId = trimStr(decision.submitter?.id)
        if (!submitterId) return

        const currentName = trimStr(decision.submitter?.name)
        const currentEmail = trimStr(decision.submitter?.email)
        if (currentName && currentName !== submitterId) return
        if (!currentName && currentEmail) return

        try {
            const identity = await this.resolveIdentityBestEffort(submitterId)
            const label =
                identity?.displayName || (identity as any)?.attributes?.displayName || identity?.name
            if (label && label !== submitterId) {
                decision.submitter.name = label
            }
        } catch {
            // Best-effort: history falls back to Unknown reviewer when unresolved
        }
    }

    /**
     * Best-effort: enrich the decision's `identityName` from the identity cache.
     * Returns the resolved identity document (if any) so the caller can reuse it
     * for the identity layer without a second lookup.
     */
    private async enrichDecisionIdentityName(decision: FusionDecision): Promise<IdentityDocument | undefined> {
        const identityId = trimStr(decision.identityId)
        if (!identityId) return undefined

        const currentName = trimStr(decision.identityName)
        if (currentName && currentName !== identityId) return undefined

        try {
            const identity = await this.resolveIdentityBestEffort(identityId)
            const label =
                identity?.displayName || (identity as any)?.attributes?.displayName || identity?.name
            if (label && label !== identityId) {
                decision.identityName = label
            }
            return identity
        } catch {
            return undefined
        }
    }

    /**
     * Resolve the Fusion account that receives an authorized/automatic merge decision.
     * Supports ISC identity ids and persisted Fusion anchor managed keys from prior runs.
     */
    private resolveAuthorizedMergeTarget(targetId: string): FusionAccount | undefined {
        const trimmed = trimStr(targetId)
        if (!trimmed) return undefined

        const fromIdentityMap = this.run.getFusionIdentity(trimmed)
        if (fromIdentityMap) return fromIdentityMap

        const fromManagedKey = this.run.getFusionAccountByManagedKey(trimmed)
        if (fromManagedKey) return fromManagedKey

        const normalized = normalizeCompositeManagedAccountKey(trimmed)
        if (normalized) {
            return this.run.getFusionAccountByManagedKey(normalized)
        }

        return undefined
    }

    /**
     * Resolve an identity by ID: returns the cached document if available, otherwise
     * makes a live API call only during aggregation (non-aggregation modes are read-only).
     */
    private async resolveIdentityBestEffort(identityId: string): Promise<IdentityDocument | undefined> {
        try {
            const cached = this.deps.identities.getIdentityById(identityId)
            if (cached) return cached
            return this.deps.accountAssembly.isAggregationAccountListMode() ? this.deps.identities.fetchIdentityById(identityId) : undefined
        } catch {
            return undefined
        }
    }
}


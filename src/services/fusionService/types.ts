import { SourceType } from '../../model/config'
import type { FusionReportBlend } from '../../model/fusionReportBlend'
import type { DeletedFusionReviewForm } from '../../model/fusionRun'

// ============================================================================
// Type Definitions — Fusion Report
// ============================================================================

/** Individual attribute score within a fusion report match comparison. */
export type FusionReportScore = {
    /** The attribute name that was compared */
    attribute: string
    /** The algorithm used for comparison (e.g. "jaro-winkler", "name-matcher") */
    algorithm?: string
    /** Raw algorithm similarity (0–100) */
    score: number
    /** Weighted partial toward combined score: (weight/Σw)×raw */
    weightedScore?: number
    /** The configured per-attribute minimum similarity threshold (also used as blend weight). Emitted as `threshold` in custom:dryrun output. */
    fusionScore?: number
    /** Whether the score met or exceeded the threshold */
    isMatch: boolean
    /** When true, rule was not evaluated for the blend (e.g. missing values) */
    skipped?: boolean
    /** Human-readable explanation of the score result */
    comment?: string
}

/** A single identity match candidate within a fusion report account. */
export type FusionReportMatch = {
    /** Display name of the matched identity */
    identityName: string
    /** ISC identity ID */
    identityId?: string
    /** Fusion listing / native key for the candidate identity account (dry-run wire: alongside identity fields). */
    accountId?: string
    /** Display label for the candidate fusion account */
    accountName?: string
    /** Direct URL to the identity in the ISC UI */
    identityUrl?: string
    /** Whether this candidate is considered a match overall */
    isMatch: boolean
    /** Candidate source used for downstream diagnostics/reporting. */
    candidateType?: 'identity' | 'deferred'
    /** 
     * True when every configured rule scored 100 with none skipped (exact attribute match).
     * @deprecated Use auto or manual instead.
     */
    exact?: boolean
    /** True when the candidate meets the automatic merge score threshold. */
    auto?: boolean
    /** True when the candidate only meets the manual-review score threshold. */
    manual?: boolean
    /** Per-attribute score breakdown */
    scores?: FusionReportScore[]
}

/** A single account entry in the fusion report, with its match candidates. */
export type FusionReportAccount = {
    /** Display name of the source account */
    accountName: string
    /** Direct URL to the human account in ISC UI */
    accountUrl?: string
    /** Name of the source the account belongs to */
    accountSource: string
    /** Source processing type (authoritative, record, or orphan) */
    sourceType?: SourceType
    /** ISC account ID */
    accountId?: string
    /** Email address from the account attributes */
    accountEmail?: string
    /** Subset of account attributes included in the report */
    accountAttributes?: Record<string, any>
    /** List of identity match candidates with their scores */
    matches: FusionReportMatch[]
    /** How many fusion identity accounts were compared against this managed account in this run (per scoring sweeps). */
    fusionIdentityComparisons?: number
    /** Error message when form creation failed (excessive candidates or runtime error) */
    error?: string
    /** True when the account matched only deferred candidates and was deferred. */
    deferred?: boolean
}

/** A processed reviewer decision entry included in the fusion report. */
export type FusionReportDecision = {
    /** Reviewer (submitter) identity ID */
    reviewerId: string
    /** Reviewer display name */
    reviewerName: string
    /** Direct URL to reviewer identity in ISC UI */
    reviewerUrl?: string
    /** Reviewer email (if available) */
    reviewerEmail?: string
    /** Composite managed account key (sourceId::nativeIdentity) for the reviewed account. */
    managedAccountKey: string
    /** Source account display label */
    accountName: string
    /** Direct URL to human account in ISC UI */
    accountUrl?: string
    /** Managed source name */
    accountSource: string
    /** Source processing type (authoritative, record, or orphan) */
    sourceType?: SourceType
    /** Canonical decision identifier used by templates */
    decision: 'merge-existing-identity' | 'create-new-identity' | 'confirm-no-match'
    /** Human-friendly decision text */
    decisionLabel: string
    /** Selected identity ID for merge decisions */
    selectedIdentityId?: string
    /** Selected identity display name for merge decisions */
    selectedIdentityName?: string
    /** Direct URL to the selected identity in the ISC UI */
    selectedIdentityUrl?: string
    /** Optional reviewer comments */
    comments?: string
    /** Standalone form URL for traceability */
    formUrl?: string
    /** True when the connector merged without a review form (exact match) */
    automaticMerge?: boolean
}

/** Processing statistics included in the fusion report. */
/**
 * Snapshot values only available from the aggregation orchestrator.
 * Passed to generateReport so it can build the full FusionReportStats.
 */
/** Per-phase elapsed durations from pipeline orchestration (optional for backward compatibility). */
type PhaseTimingBreakdownEntry = {
    phase: string
    elapsed: string
}

export type AggregationStats = {
    identitiesFound: number
    managedAccountsFound: number
    managedAccountsFoundAuthoritative?: number
    managedAccountsFoundRecord?: number
    managedAccountsFoundOrphan?: number
    /** Accounts streamed to the platform during output; set when the run registry is cleared after send */
    fusionAccountsReturned?: number
    totalProcessingTime: string
    phaseTiming?: PhaseTimingBreakdownEntry[]
}

export type FusionReportStats = {
    /** Fusion accounts returned to the platform; falls back to in-memory count when output did not run */
    totalFusionAccounts?: number
    /** Number of fusion accounts fetched from the Fusion source */
    fusionAccountsFound?: number
    /** Number of fusion review forms created */
    fusionReviewsCreated?: number
    /** Number of fusion review assignments (form instances, one per reviewer) */
    fusionReviewAssignments?: number
    /** Number of fusion review form definitions found during fetch */
    fusionReviewsFound?: number
    /** Number of fusion review form instances found during fetch */
    fusionReviewInstancesFound?: number
    /** Number of answered fusion review instances processed */
    fusionReviewsProcessed?: number
    /** Number of "new identity" decisions from reviews */
    fusionReviewNewIdentities?: number
    /** Number of non-match decisions from reviews */
    fusionReviewNonMatches?: number
    /** Number of ISC identities loaded */
    identitiesFound?: number
    /** Number of identities processed by processIdentities() */
    identitiesProcessed?: number
    /** Number of managed source accounts loaded */
    managedAccountsFound?: number
    /** Number of managed source accounts loaded from authoritative sources */
    managedAccountsFoundAuthoritative?: number
    /** Number of managed source accounts loaded from record sources */
    managedAccountsFoundRecord?: number
    /** Number of managed source accounts loaded from orphan sources */
    managedAccountsFoundOrphan?: number
    /** Number of managed source accounts processed */
    managedAccountsProcessed?: number
    /** Number of managed source accounts processed from authoritative sources */
    managedAccountsProcessedAuthoritative?: number
    /** Number of managed source accounts processed from record sources */
    managedAccountsProcessedRecord?: number
    /** Number of managed source accounts processed from orphan sources */
    managedAccountsProcessedOrphan?: number
    /** Number of fusion review decisions by source type */
    fusionReviewDecisionsAuthoritative?: number
    fusionReviewDecisionsRecord?: number
    fusionReviewDecisionsOrphan?: number
    /** Source-type-specific decision outcomes */
    fusionReviewNewIdentitiesAuthoritative?: number
    fusionReviewNoMatchesRecord?: number
    fusionReviewNoMatchesOrphan?: number
    /** Formatted total processing time */
    totalProcessingTime?: string
    /** Ordered pipeline phase durations (Setup → … → Report) when provided by the orchestrator */
    phaseTiming?: PhaseTimingBreakdownEntry[]
    /** Formatted memory usage at report generation time */
    usedMemory?: string
    /** Total warnings logged during aggregation */
    aggregationWarnings?: number
    /** Total errors logged during aggregation */
    aggregationErrors?: number
    /** Concise warning samples logged during aggregation */
    warningSamples?: string[]
    /** Concise error samples logged during aggregation */
    errorSamples?: string[]
}

/** Conflicting Fusion-account mapping details for a single ISC identity. */
export type FusionReportIdentityConflictOccurrence = {
    /** ISC identity ID associated to multiple Fusion accounts */
    identityId: string
    /** Number of Fusion accounts seen for this identity */
    accountCount: number
    /** Unique account names involved in the conflicting mapping */
    accountNames: string[]
    /** Unique managed keys involved in the conflicting mapping */
    managedKeys: string[]
}

/** Report warnings section payload. */
export type FusionReportWarnings = {
    /** Guidance + conflicting identity occurrences detected in this run */
    identityConflicts?: {
        message: string
        affectedIdentities: number
        occurrences: FusionReportIdentityConflictOccurrence[]
    }
}

/**
 * Complete fusion report generated during aggregation or on-demand.
 * Contains all analyzed accounts and their matching results.
 */
export type FusionReport = {
    /** Array of accounts analyzed in this report */
    accounts: FusionReportAccount[]
    /** Total number of accounts analyzed */
    totalAccounts?: number
    /** Number of accounts with matches (for review or correlation) */
    matches?: number
    /** Timestamp when the report was generated */
    reportDate?: Date | string
    /** Processing statistics */
    stats?: FusionReportStats
    /** Finished reviewer decisions processed from fusion reviews */
    fusionReviewDecisions?: FusionReportDecision[]
    /** Blending events executed during this run */
    fusionBlends?: FusionReportBlend[]
    /** Fusion review form definitions deleted successfully during this run. */
    fusionReviewDeletions?: DeletedFusionReviewForm[]
    /** Global warnings surfaced during report generation */
    warnings?: FusionReportWarnings
}



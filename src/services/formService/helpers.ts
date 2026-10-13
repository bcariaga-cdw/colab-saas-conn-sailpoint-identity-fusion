import { FusionAccount } from '../../model/account'
import { FusionDecision } from '../../model/form'
import { AccountV2025 as Account, IdentityDocument, OwnerDto } from 'sailpoint-api-client'
import { logger } from '@sailpoint/connector-sdk'
import { SourceService } from '../sourceService'
import { assert } from '../../utils/assert'
import { getManagedAccountKeyFromAccount } from '../../model/managedAccountKey'
import { isReportableIscAccountId } from '../fusionService/reportAccountResolver'
import { getFusionReportAccountLabel } from '../fusionService/helpers'
import { compareMatchesForForm } from '../matchingService/matchingHelpers'
import { Candidate } from './types'
import { internalConfig } from '../../data/config'
import { SourceType } from '../../model/config'
import { readString, trimStr } from '../../utils/safeRead'

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Builds a synthetic fusion decision when all attribute scores are 100 (exact match),
 * skipping manual review (automatic merge into the selected identity).
 *
 * @param fusionAccount - The fusion account being merged
 * @param account - The managed account
 * @param identityId - The target identity ID
 * @param sourceType - Managed source type (drives report stats and decision processing)
 * @returns Synthetic FusionDecision for automatic merge
 */
export function createAutomaticMergeDecision(
    fusionAccount: FusionAccount,
    account: Account,
    identityId: string,
    sourceType: SourceType
): FusionDecision {
    const accountKey = getManagedAccountKeyFromAccount(account)
    assert(accountKey, 'Managed account missing composite key for automatic merge decision')
    const iscAccountId = [trimStr(fusionAccount.iscAccountId), trimStr(account.id)].find(isReportableIscAccountId)
    return {
        submitter: { id: 'system', email: '', name: 'System (automatic merge)' },
        account: {
            id: accountKey,
            ...(iscAccountId ? { iscAccountId } : {}),
            name: fusionAccount.name ?? account.name ?? '',
            ...(account.isMachine === true || fusionAccount.isMachine === true ? { isMachine: true } : {}),
            sourceName: fusionAccount.sourceName,
            sourceId: readString(account, 'sourceId'),
            nativeIdentity: account.nativeIdentity ?? undefined,
        },
        newIdentity: false,
        identityId,
        comments: 'Automatically merged: combined score met or exceeded threshold',
        finished: true,
        automaticMerge: true,
        sourceType,
    }
}

/**
 * Primary line of the identities SEARCH_V2 SELECT (`label: 'attributes.displayName'` in formBuilder).
 * Form conditions must compare against this exact string so ISC show/hide rules match the dropdown.
 */
export const resolveIdentitiesSelectLabel = (
    fusionAttributes: Record<string, any>,
    identityId: string,
    identityDocument?: IdentityDocument
): string => {
    const fromIndex = identityDocument?.attributes
        ? (trimStr((identityDocument.attributes as Record<string, unknown>).displayName) ?? '')
        : ''
    if (fromIndex) return fromIndex

    const fromFusion = trimStr(fusionAttributes?.displayName) ?? ''
    if (fromFusion) return fromFusion

    const fromIdentityName = trimStr(identityDocument?.name) ?? ''
    if (fromIdentityName) return fromIdentityName

    // During initial candidate build we may not have hydrated identity documents yet.
    // Only emit this warning once we've actually attempted identity lookup.
    if (identityDocument) {
        logger.error(
            `[formBuilder] Candidate identity ${identityId} has no attributes.displayName for identities SELECT; ` +
                `form conditions may not match the dropdown. Using identity.name (or identityId) as fallback label.`
        )
    }
    return identityId
}

/**
 * Candidate label for review forms and emails: prefer attributes/search displayName, then
 * {@link FusionMatch.identityName} from scoring (same chain as dry-run reports).
 */
export const resolveCandidateDisplayName = (
    match: { identityName?: string; fusionIdentity?: FusionAccount },
    fusionAttributes: Record<string, any>,
    identityId: string
): string => {
    const fi = match.fusionIdentity
    if (fi) {
        const fromFusionAccount = trimStr(getFusionReportAccountLabel(fi))
        if (fromFusionAccount && fromFusionAccount !== identityId) return fromFusionAccount
    }

    const fromAttrs = resolveIdentitiesSelectLabel(fusionAttributes, identityId)
    if (fromAttrs !== identityId) return fromAttrs

    const fromMatch = trimStr(match.identityName)
    if (fromMatch && fromMatch !== identityId) return fromMatch

    return fromAttrs
}

/**
 * Build the ordered candidate list for a fusion review form (highest combined score first),
 * capped at `maxCandidates` (configured via `fusionMaxCandidatesForForm`).
 */
export const buildCandidateList = (fusionAccount: FusionAccount, maxCandidates: number): Candidate[] => {
    assert(fusionAccount, 'Fusion account is required')
    assert(fusionAccount.fusionMatches, 'Fusion matches are required')
    assert(
        maxCandidates >= 1 && maxCandidates <= internalConfig.formService.fusionMaxCandidatesForFormMax,
        `maxCandidates must be between 1 and ${internalConfig.formService.fusionMaxCandidatesForFormMax}`
    )

    const ordered = [...fusionAccount.fusionMatches].sort(compareMatchesForForm).slice(0, maxCandidates)

    return ordered.map((match) => {
        assert(match.fusionIdentity, 'Fusion identity is required in match')
        assert(match.fusionIdentity.identityId, 'Fusion identity ID is required')
        const attrs: Record<string, any> = match.fusionIdentity.attributes || {}
        const id = match.fusionIdentity.identityId
        return {
            id,
            name: resolveCandidateDisplayName(match, attrs, id),
            attributes: attrs,
            scores: match.scores || [],
        }
    })
}

export type BuildFormNameOptions = {
    enableLocalization?: boolean
    locale?: string
}

/**
 * Build form name from fusion account with a stable account identifier suffix
 * to avoid collisions when multiple accounts share the same display name/source.
 * When localization is enabled, appends `[locale]` so each language gets its own
 * form definition built with literal translated labels (never reuses an English definition).
 */
export const buildFormName = (
    fusionAccount: FusionAccount,
    fusionFormNamePattern: string,
    options?: BuildFormNameOptions
): string => {
    const accountName = fusionAccount.name || fusionAccount.displayName || 'Unknown'
    const source = `[${fusionAccount.sourceName}]`
    const accountIdentifier = trimStr(fusionAccount.managedKey) || trimStr(fusionAccount.managedAccountId) || 'unknown'
    const base = `${fusionFormNamePattern} - ${accountName} ${source} (${accountIdentifier})`
    if (options?.enableLocalization && options.locale) {
        return `${base} [${options.locale}]`
    }
    return base
}

/**
 * Calculate form expiration date
 */
export const calculateExpirationDate = (fusionFormExpirationDays: number): string => {
    const expirationDate = new Date()
    expirationDate.setDate(expirationDate.getDate() + fusionFormExpirationDays)
    return expirationDate.toISOString()
}

/**
 * Get form owner from fusion source
 */
export const getFormOwner = (sources: SourceService): OwnerDto => {
    const owner = sources.fusionSourceOwner
    assert(owner, 'Fusion source owner not found')
    return owner
}

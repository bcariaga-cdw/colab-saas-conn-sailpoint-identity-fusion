import { AccountV2025 as Account, IdentityDocument } from 'sailpoint-api-client'
import type { Attributes } from '@sailpoint/connector-sdk'
import { FusionDecision } from './form'
import type { IdentityInfo } from './fusionAccountTypes'
import { isNullish, trimStr } from '../utils/safeRead'

const IDENTITIES_SOURCE_NAME = 'Identities'

/**
 * Remove attribute keys whose value is `null` or `undefined` in place.
 *
 * Every other value is kept, including `false`, `0`, blank strings, empty arrays,
 * and arrays that contain null elements. Nullish-key omission for the Fusion account
 * attribute bags is enforced where the bags are installed, not when they are read.
 *
 * @param attributes - The attribute bag to lean out
 * @returns The same bag instance, for call-site convenience
 */
export function omitNullishAttributeKeys(attributes: Attributes): Attributes {
    for (const key of Object.keys(attributes)) {
        if (isNullish(attributes[key])) delete attributes[key]
    }
    return attributes
}

/** Whether a Fusion account was seeded from an ISC identity rather than a managed source account. */
export function isIdentityOriginFusionAccount(
    originSource: string | undefined,
    attributes: { originSource?: string; sourceOrigin?: string } | undefined,
    hasBaselineStatus: boolean
): boolean {
    const originFromAttributes = attributes?.originSource
    const legacyOriginFromAttributes = attributes?.sourceOrigin
    return (
        originSource === IDENTITIES_SOURCE_NAME ||
        originFromAttributes === IDENTITIES_SOURCE_NAME ||
        legacyOriginFromAttributes === IDENTITIES_SOURCE_NAME ||
        hasBaselineStatus
    )
}

/** Primary display label from fusion account name fields, with fallback. */
export function resolveFusionAccountNameOrDisplayName(
    account: { name?: string; displayName?: string },
    fallback: string
): string {
    return account.name || account.displayName || fallback
}

/** Identity display name: attributes.displayName || displayName || name. */
export function resolveIdentityDocumentDisplayName(identity?: IdentityDocument | null): string | undefined {
    if (!identity) return undefined
    return (
        trimStr((identity.attributes as Record<string, unknown> | undefined)?.displayName) ??
        trimStr(identity.displayName) ??
        trimStr(identity.name) ??
        undefined
    )
}

/** @deprecated internal alias */
function identityDisplayNameFromIdentity(identity: IdentityDocument): string | undefined {
    return resolveIdentityDocumentDisplayName(identity)
}

/** Account-side display label: account.identity?.name || account.name. */
function identityDisplayNameFromAccount(account: Account): string | undefined {
    const identityRefName = (account as { identity?: { name?: string } }).identity?.name
    return trimStr(identityRefName) ?? trimStr(account.name) ?? undefined
}

/**
 * Builds a unified IdentityInfo runtime object from an IdentityDocument or standard parameter bag.
 *
 * Rules:
 * - `id` is mandatory and non-empty. Without it, no IdentityInfo is returned.
 * - `name` is the identity alias and comes only from `IdentityDocument.name`. Account references
 *   (`account.identity.name`) and `FusionDecision.identityName` carry the identity display name,
 *   not the alias, so they never populate it. Correlated authoritative managed accounts recover the
 *   alias from their own account name in `buildFromManagedAccount`.
 * - `displayName` is the identity display name chain:
 *   identity.attributes.displayName || identity.displayName || identity.name || account.identity?.name || account.name.
 */
export function buildIdentityInfo(
    source: IdentityDocument | Account | FusionDecision | { id?: string | null; name?: string | null; displayName?: string | null }
): IdentityInfo | undefined {
    let id: string | undefined
    let name: string | undefined
    let displayName: string | undefined

    // FusionDecision
    if ('account' in source && ('identityName' in source || 'identityId' in source)) {
        const decision = source as FusionDecision
        id = trimStr(decision.identityId)
        displayName =
            trimStr(decision.identityName) ?? trimStr(decision.account.name) ?? trimStr(decision.account.id)
    }
    // Account
    else if ('sourceId' in source || 'nativeIdentity' in source || 'accountId' in source || 'identityId' in source || 'identity' in source) {
        const account = source as Account
        id = trimStr(account.identityId)
        displayName = identityDisplayNameFromAccount(account)
    }
    // IdentityDocument
    else if ('attributes' in source && source.attributes) {
        const identity = source as IdentityDocument
        id = trimStr(identity.id)
        name = trimStr(identity.name)
        displayName = identityDisplayNameFromIdentity(identity)
    }
    // Fallback standard bag
    else {
        id = trimStr((source as any).id)
        name = trimStr((source as any).name)
        displayName = trimStr((source as any).displayName) ?? name
    }

    // id is mandatory for an identity linkage
    if (!id) {
        return undefined
    }

    return {
        id,
        name: name ?? '',
        displayName: displayName ?? name ?? '',
    }
}




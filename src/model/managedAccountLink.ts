import { AccountV2025 as Account } from 'sailpoint-api-client'
import { FusionAccount } from './account'
import { FusionRun } from './fusionRun'
import { getManagedAccountKeyFromAccount } from './managedAccountKey'
import { hasValue } from '../utils/safeRead'

/** True when a loaded Fusion account already references this managed-account key. */
function fusionAccountLinksManagedKey(fa: FusionAccount, key: string): boolean {
    return (
        fa.accountIdsSet.has(key) ||
        fa.missingAccountIdsSet.has(key) ||
        fa.previousAccountIdsSet.has(key)
    )
}

/** Register every managed-account key referenced on a Fusion account into the linked-key index. */
export function addFusionAccountLinkedKeysToIndex(fa: FusionAccount, run: FusionRun): void {
    for (const key of fa.accountIdsSet) run.addToLinkedAccountIndex(key)
    for (const key of fa.missingAccountIdsSet) run.addToLinkedAccountIndex(key)
    for (const key of fa.previousAccountIdsSet) run.addToLinkedAccountIndex(key)
}

/**
 * True when a managed account is already represented on a loaded Fusion account
 * (live blend, missing reference, or persisted accounts from the prior run),
 * or when its identityId matches a loaded identity-origin Fusion account.
 */
export function isManagedAccountLinkedInFusion(account: Account, run: FusionRun): boolean {
    const key = getManagedAccountKeyFromAccount(account)
    if (key) {
        const index = run.linkedAccountKeyIndex
        if (index) {
            if (index.has(key)) return true
        } else {
            for (const fa of run.fusionAccountsIterable()) {
                if (fusionAccountLinksManagedKey(fa, key)) return true
            }
            for (const fa of run.allFusionIdentities) {
                if (fusionAccountLinksManagedKey(fa, key)) return true
            }
        }
    }
    const identityId = account.identityId
    if (hasValue(identityId) && run.hasFusionIdentity(identityId)) {
        return true
    }
    return false
}

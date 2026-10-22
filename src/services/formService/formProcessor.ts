import { FormInstanceResponseV2025 } from 'sailpoint-api-client'
import { logger } from '@sailpoint/connector-sdk'
import { SourceType } from '../../model/config'
import { FusionDecision } from '../../model/form'
import { isCompositeManagedAccountKey } from '../../model/managedAccountKey'
import { resolveIdentityDocumentDisplayName } from '../../model/fusionAccountUtils'
import { IdentityService } from '../identityService'
import { assert } from '../../utils/assert'
import { readString, trimStr } from '../../utils/safeRead'
import { FusionAttribute } from '../../data/schema'

// ============================================================================
// Internal Helpers
// ============================================================================

/** Dictionary-shaped form instance input (arbitrary keys; fields located by `id`). */
type FormInputDictionary = Record<string, { id?: string; value?: string; description?: string }>

type FormInputEntry = FormInputDictionary[string]

function findFormInputById(
    formInputs: FormInputDictionary | undefined,
    id: string,
    requireValue = false
): FormInputEntry | undefined {
    if (!formInputs) return undefined

    const direct = formInputs[id]
    if (direct && direct.id === id && (!requireValue || (direct.value?.length ?? 0) > 0)) {
        return direct
    }

    for (const key in formInputs) {
        const entry = formInputs[key]
        if (entry && entry.id === id && (!requireValue || (entry.value?.length ?? 0) > 0)) {
            return entry
        }
    }

    return undefined
}

/**
 * Coerces any scalar or object value to a plain string, extracting a `.value`
 * or display field from objects so templates never render "[object Object]".
 */
function normalizeScalar(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
    if (typeof value === 'object') {
        const v = value as Record<string, unknown>
        if (typeof v.value === 'string') return v.value
        const display = v.displayName ?? v.name ?? v.id
        if (typeof display === 'string') return display
    }
    return String(value)
}

/**
 * Reads the correlated identity ID from either a flat or dictionary form input structure.
 */
function readCorrelatedIdentityId(formInput: any): string | undefined {
    // Try flat structure first (as sent in createFormInstance)
    const flat = readString(formInput, FusionAttribute.IdentityId)
    if (flat) return flat

    // Fall back to dictionary structure (direct key lookup, then id-aligned scan)
    try {
        const dict = formInput as Record<string, any>
        if (!dict) return undefined

        const direct = dict[FusionAttribute.IdentityId]
        if (direct && (direct.value || direct.description)) {
            const val = direct.value || direct.description
            if (typeof val === 'string' && val.length > 0) return val
        }

        for (const key in dict) {
            const item = dict[key]
            if (item?.id === FusionAttribute.IdentityId && (item.value || item.description)) {
                const val = item.value || item.description
                if (typeof val === 'string' && val.length > 0) return val
            }
        }
        return undefined
    } catch {
        return undefined
    }
}

// ============================================================================
// Form Processing Functions
// ============================================================================

/**
 * Get reviewer information from identity ID
 */
export const getReviewerInfo = (
    identityId: string,
    identities?: IdentityService
): { id: string; email: string; name: string } | undefined => {
    if (!identities) {
        return {
            id: identityId,
            email: '',
            name: '',
        }
    }

    const identity = identities.getIdentityById(identityId)
    if (!identity) {
        return {
            id: identityId,
            email: '',
            name: '',
        }
    }

    return {
        id: identityId,
        email: identity.attributes?.email || '',
        name: resolveIdentityDocumentDisplayName(identity) || '',
    }
}

/**
 * Extract account information from form input.
 * Handles both flat structure { account: "...", name: "...", source: "..." }
 * and dictionary structure where formInput is an object with input objects keyed by id.
 */
export const extractAccountInfoFromFormInput = (
    formInput: any
): { id: string; name: string; sourceName: string } | null => {
    let accountId: string | undefined
    let accountName: string | undefined
    let accountSource: string | undefined

    // Try flat structure first (as sent in createFormInstance)
    if (typeof formInput.account === 'string') {
        accountId = formInput.account
        accountName = formInput.name
        accountSource = formInput.source
    } else if (formInput.account && typeof formInput.account === 'object' && formInput.account.value) {
        // Account is an object with value property
        accountId = formInput.account.value
        const nameField = formInput.name
        accountName =
            formInput.account.displayName ||
            (typeof nameField === 'string' ? nameField : nameField?.value || nameField?.description)
        const sourceField = formInput.source
        accountSource =
            formInput.account.sourceName ||
            (typeof sourceField === 'string' ? sourceField : sourceField?.value || sourceField?.description)
    } else {
        const formInputs = formInput as FormInputDictionary | undefined
        const accountInput = findFormInputById(formInputs, 'account', true)
        if (accountInput?.value) {
            accountId = accountInput.value
            const nameInput = findFormInputById(formInputs, 'name')
            accountName = nameInput?.value || nameInput?.description
            const sourceInput = findFormInputById(formInputs, 'source')
            accountSource = sourceInput?.value || sourceInput?.description
        }
    }

    if (!accountId) {
        return null
    }

    return {
        id: accountId,
        name: trimStr(accountName) || '',
        sourceName: accountSource || '',
    }
}

/**
 * Extract candidate identity IDs from form input.
 * Supports both flat and dictionary input structures.
 */
export const extractCandidateIdsFromFormInput = (formInput: any): string[] => {
    if (!formInput || typeof formInput !== 'object') return []

    let candidatesStr: string | undefined
    if (typeof formInput.candidates === 'string') {
        candidatesStr = formInput.candidates
    } else {
        const formInputs = formInput as Record<string, any>
        let candidatesInput = formInputs.candidates
        if (!(candidatesInput?.id === 'candidates' && (candidatesInput.value || candidatesInput.description))) {
            candidatesInput = undefined
            for (const key in formInputs) {
                const x = formInputs[key]
                if (x?.id === 'candidates' && (x.value || x.description)) {
                    candidatesInput = x
                    break
                }
            }
        }
        candidatesStr = candidatesInput?.value || candidatesInput?.description
    }

    if (typeof candidatesStr !== 'string' || candidatesStr.length === 0) {
        return []
    }

    return candidatesStr
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
}

/**
 * Create fusion decision from completed form instance
 * accountInfoOverride allows overriding account info from managedAccountsById before it's deleted
 * Returns null if decision cannot be created
 */
export const createFusionDecision = async (
    formInstance: FormInstanceResponseV2025,
    identities?: IdentityService,
    accountInfoOverride?: {
        id: string
        iscAccountId?: string
        isMachine?: boolean
        name: string
        sourceName: string
        sourceId?: string
        nativeIdentity?: string
    }
): Promise<FusionDecision | null> => {
    assert(formInstance, 'Form instance is required')
    assert(formInstance.id, 'Form instance ID is required')

    const finished =
        formInstance.state === 'COMPLETED' || formInstance.state === 'IN_PROGRESS' || formInstance.state === 'SUBMITTED'

    const { formData, formInput, recipients } = formInstance

    if (!formInput || !recipients || recipients.length === 0) {
        return null
    }

    // Use accountInfoOverride if provided (from managedAccountsById), otherwise extract from formInput
    let accountInfo = accountInfoOverride || extractAccountInfoFromFormInput(formInput)
    if (!accountInfo) {
        return null
    }

    const sourceType = extractSourceType(formInput)

    const isNewIdentity = formData?.newIdentity ?? true
    // SELECT elements with dataSource return arrays, extract the first element
    const identitiesValue = formData?.identities
    const existingIdentity = isNewIdentity
        ? undefined
        : Array.isArray(identitiesValue)
          ? identitiesValue[0]
          : identitiesValue

    if (!isNewIdentity && !existingIdentity) {
        logger.error(
            `[formProcessor] Form ${formInstance.id}: toggle is false but no identity selected ` +
                `for account ${accountInfo.name} [${accountInfo.sourceName}]. Skipping decision.`
        )
        return null
    }

    const reviewerIdentityId = recipients[0].id
    if (!reviewerIdentityId) {
        return null
    }

    const reviewer = getReviewerInfo(reviewerIdentityId, identities)
    if (!reviewer) {
        return null
    }

    // Best-effort: hydrate reviewer displayName/email for history + reporting.
    // getReviewerInfo is sync and only consults the local cache; for out-of-scope identities
    // we try to fetch on-demand here (createFusionDecision is async).
    if (identities && (!reviewer.name || reviewer.name === reviewerIdentityId || !reviewer.email)) {
        try {
            const fetched =
                typeof identities.ensureIdentityById === 'function'
                    ? await identities.ensureIdentityById(reviewerIdentityId)
                    : await identities.fetchIdentityById(reviewerIdentityId)
            const displayName = resolveIdentityDocumentDisplayName(fetched) || reviewer.name
            const email = (fetched as any)?.attributes?.email || reviewer.email
            if (displayName) reviewer.name = displayName
            if (email) reviewer.email = email
        } catch {
            // ignore: keep existing reviewer info
        }
    }

    // Persist correlated identity reference (if the form stored it) for downstream reporting/history.
    // Supports both flat and dictionary formInput structures.
    const correlatedIdentityId = readCorrelatedIdentityId(formInput)

    // Prefer correlated identity display name for downstream reporting/history.
    // This is especially important for "new identity" decisions where there's no selected match,
    // but the fusion account may already be attached to an identity.
    if (correlatedIdentityId && identities) {
        let correlated = identities.getIdentityById(correlatedIdentityId)
        if (!correlated) {
            try {
                correlated = await identities.fetchIdentityById(correlatedIdentityId)
            } catch {
                correlated = undefined
            }
        }
        const correlatedName = correlated?.displayName || correlated?.attributes?.displayName || correlated?.name
        if (correlatedName) {
            accountInfo = { ...accountInfo, name: correlatedName }
        }
    }

    let selectedIdentity = existingIdentity ? identities?.getIdentityById(existingIdentity) : undefined
    if (existingIdentity && identities && !selectedIdentity) {
        try {
            selectedIdentity = await identities.fetchIdentityById(existingIdentity)
        } catch {
            selectedIdentity = undefined
        }
    }
    const selectedIdentityName = existingIdentity
        ? selectedIdentity?.displayName ||
          (selectedIdentity as any)?.attributes?.displayName ||
          selectedIdentity?.name ||
          undefined
        : undefined

    // Defensive: ensure decision.account fields are strings so templates never render "[object Object]".
    const sourceIdNorm = normalizeScalar((accountInfo as any)?.sourceId)
    const nativeIdNorm = normalizeScalar((accountInfo as any)?.nativeIdentity)
    accountInfo = {
        id: normalizeScalar((accountInfo as any)?.id),
        name: normalizeScalar((accountInfo as any)?.name) || normalizeScalar((accountInfo as any)?.id),
        sourceName: normalizeScalar((accountInfo as any)?.sourceName),
        ...(sourceIdNorm ? { sourceId: sourceIdNorm } : {}),
        ...(nativeIdNorm ? { nativeIdentity: nativeIdNorm } : {}),
        ...(trimStr((accountInfo as any)?.iscAccountId)
            ? { iscAccountId: trimStr((accountInfo as any)?.iscAccountId) }
            : {}),
        ...((accountInfo as any)?.isMachine === true ? { isMachine: true } : {}),
    }
    if (!isCompositeManagedAccountKey(accountInfo.id)) {
        logger.error(
            `[formProcessor] Form ${formInstance.id}: account id "${accountInfo.id}" is not a managed account key (sourceId::nativeIdentity). Skipping decision.`
        )
        return null
    }

    return {
        submitter: reviewer,
        account: accountInfo,
        newIdentity: isNewIdentity,
        correlatedIdentityId,
        identityId: existingIdentity,
        identityName: selectedIdentityName,
        comments: formData?.comments || '',
        finished,
        formUrl: formInstance.standAloneFormUrl ?? undefined,
        sourceType,
    }
}

/**
 * Reads the managed source type captured in the form input.
 *
 * Returns `undefined` when the form input does not carry a valid `sourceType` —
 * notably older form definitions created before that input key existed. Callers
 * resolve the type from the managed source in that case so the decision is
 * classified correctly instead of defaulting to authoritative.
 */
const extractSourceType = (formInput: any): SourceType | undefined => {
    if (typeof formInput?.sourceType === 'string') {
        const value = formInput.sourceType as string
        if (value === SourceType.Authoritative || value === SourceType.Record || value === SourceType.Orphan) {
            return value as SourceType
        }
    }
    return undefined
}

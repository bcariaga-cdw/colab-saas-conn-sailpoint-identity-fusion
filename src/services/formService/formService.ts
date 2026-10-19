import { promiseAllBatched } from '../fusionService/collections'
import {
    FormDefinitionResponseV2025,
    FormInstanceResponseV2025,
    FormInstanceResponseV2025StateV2025,
    CustomFormsV2025ApiCreateFormDefinitionRequest,
} from 'sailpoint-api-client'
import { FusionConfig, SourceType } from '../../model/config'
import { ClientService } from '../clientService'
import { LogService } from '../logService'
import { IdentityService } from '../identityService'
import { EmailService } from '../emailService'
import {
    buildFormDefinitionDescription,
    isLocalizationEnabled,
    readNewIdentityToggleLabel,
    resolveEffectiveLocale,
    shouldRefreshLocalizedFormDefinition,
} from '../emailService/localization'
import { SourceService } from '../sourceService'
import { FusionRun } from '../../model/fusionRun'
import { assert, softAssert } from '../../utils/assert'
import { readString, readUnknown, trimStr } from '../../utils/safeRead'
import { FusionDecision } from '../../model/form'
import { FusionAccount } from '../../model/account'
import { AccountV2025 as Account } from 'sailpoint-api-client'
import {
    Candidate,
    CreateFusionFormOutcome,
    PendingReviewFormContext,
    PendingReviewReviewerContext,
    PendingReviewAccountContext,
} from './types'
import { resolveFusionMaxCandidatesForForm } from '../../data/config'
import {
    buildCandidateList,
    buildFormName,
    calculateExpirationDate,
    createAutomaticMergeDecision,
    resolveIdentitiesSelectLabel,
} from './helpers'
import { buildFormInput, buildFormFields, buildFormConditions, buildFormInputs } from './formBuilder'
import {
    createFusionDecision,
    extractAccountInfoFromFormInput,
    extractCandidateIdsFromFormInput,
    getReviewerInfo,
} from './formProcessor'
import { createUrlContext, UrlContext } from '../../utils/url'
import { normalizeCompositeManagedAccountKey } from '../../model/managedAccountKey'
import { resolveIdentityDocumentDisplayName } from '../../model/fusionAccountUtils'
import { isReportableIscAccountId, resolveManagedAccountIscIdForReport } from '../fusionService/reportAccountResolver'
import { FormLifecycle } from './formLifecycle'
import { analyzeFormInstances, isPendingFormInstance } from './formInstanceAnalyzer'
import {
    formatDecisionCountsSegment,
    logFusionDecisionDiscovered,
    summarizeDecisionCounts,
} from '../fusionService/decisionLogging'

export type { PendingReviewFormContext, PendingReviewAccountContext } from './types'

// ============================================================================
// FormService Class
// ============================================================================

export interface FormFetchOptions {
    /** When true, stale form definitions are queued for deletion and skipped during instance fetch. */
    staleFormCleanup?: boolean
}

/**
 * Service for form definition and instance management.
 * Handles creation, processing, and cleanup of fusion forms for Match review.
 */
export class FormService {
    private readonly formDeleteQueueConcurrency = 1
    private fusionMergeDecisionMap: Map<string, FusionDecision> = new Map()
    /** Pending (unanswered) form instance URLs by recipient identityId, populated during fetchFormData. */
    private pendingReviewContextByAccountIdValue: Map<
        string,
        { forms: Map<string, PendingReviewFormContext>; reviewerIds: Set<string>; candidateIds: Set<string> }
    > = new Map()
    /** Finished decisions processed from answered form instances (assignment + newIdentity/no-match). */
    private finishedFusionDecisionsValue: FusionDecision[] = []
    private fetchedFormInstances: FormInstanceResponseV2025[][] = []
    private readonly fusionFormNamePattern: string
    private readonly fusionFormExpirationDays: number
    private readonly fusionFormAttributes?: string[]
    private readonly fusionMaxCandidatesForForm: number
    private readonly urlContext: UrlContext
    private readonly lifecycle: FormLifecycle

    // ------------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------------

    constructor(
        private readonly config: FusionConfig,
        private log: LogService,
        private client: ClientService,
        private sources: SourceService,
        private identities?: IdentityService,
        private email?: EmailService,
        private run: FusionRun = new FusionRun()
    ) {
        this.fusionFormNamePattern = config.fusionFormNamePattern
        this.fusionFormExpirationDays = config.fusionFormExpirationDays
        this.fusionFormAttributes = config.fusionFormAttributes
        this.fusionMaxCandidatesForForm = resolveFusionMaxCandidatesForForm(config.fusionMaxCandidatesForForm)
        this.urlContext = createUrlContext(config.baseurl)
        if (this.localizationEnabled) {
            this.log.info(
                `Form localization enabled: defaultLanguage=${config.defaultLanguage ?? '(unset)'}; review forms use reviewer locale`
            )
        } else {
            this.log.debug('Form localization disabled; review forms use English labels')
        }
        this.lifecycle = new FormLifecycle({
            client: this.client,
            log: this.log,
            run: this.run,
            fusionFormExpirationDays: this.fusionFormExpirationDays,
            formDeleteQueueConcurrency: this.formDeleteQueueConcurrency,
        })
    }

    private get localizationEnabled(): boolean {
        return isLocalizationEnabled(this.config)
    }

    /**
     * Reviewer locale for one reviewer identity: `EmailService.getRecipientLocale` when
     * available, otherwise `resolveEffectiveLocale` from config (no identity attributes).
     */
    private async resolveReviewerLocale(reviewer: FusionAccount): Promise<string> {
        if (this.email?.getRecipientLocale) {
            return this.email.getRecipientLocale(reviewer.identityId)
        }
        return resolveEffectiveLocale(this.config)
    }

    /**
     * Groups an account's reviewers by reviewer locale. One locale group maps to one
     * Fusion review form definition. Groups are processed in insertion order (sequential).
     */
    private async groupReviewersByLocale(reviewers: Set<FusionAccount>): Promise<Map<string, Set<FusionAccount>>> {
        const groups = new Map<string, Set<FusionAccount>>()
        for (const reviewer of reviewers) {
            const locale = await this.resolveReviewerLocale(reviewer)
            let group = groups.get(locale)
            if (!group) {
                group = new Set<FusionAccount>()
                groups.set(locale, group)
            }
            group.add(reviewer)
        }
        return groups
    }

    private isFormDefinitionForManagedAccount(formName: string | undefined, accountFormPrefix: string): boolean {
        if (!formName) {
            return false
        }
        return formName === accountFormPrefix || formName.startsWith(`${accountFormPrefix} [`)
    }

    /**
     * Unions recipients of **pending** instances on every locale-variant definition for this
     * managed account, so duplicate-review detection stays per reviewer across locale groups.
     *
     * Answered and cancelled instances are ignored on purpose: a reviewer whose previous review
     * was submitted or cancelled must get a fresh review, otherwise the account leaves the match
     * queue with no review and is promoted to a Fusion account unreviewed.
     */
    private async collectPendingRecipientIdsForAccount(fusionAccount: FusionAccount): Promise<Set<string>> {
        const accountFormPrefix = buildFormName(fusionAccount, this.fusionFormNamePattern)
        const forms = await this.findFormDefinitionsByName(this.fusionFormNamePattern)
        const recipientIds = new Set<string>()
        for (const form of forms) {
            if (!form.id || !this.isFormDefinitionForManagedAccount(form.name, accountFormPrefix)) {
                continue
            }
            const instances = await this.fetchFormInstancesByDefinitionId(form.id)
            for (const id of this.extractExistingRecipientIds(instances.filter(isPendingFormInstance))) {
                recipientIds.add(id)
            }
        }
        return recipientIds
    }

    /**
     * True when this run already decided to delete the definition (stale, answered, or all
     * instances cancelled). Such a definition must not be reused: form deletion runs in the
     * output phase, after match review creation, so a new instance on it would be deleted too.
     */
    private isFormDefinitionMarkedForDeletion(formDefinitionId: string): boolean {
        return this.run.formsToDelete.has(formDefinitionId) || this.run.isFormQueuedForDeletion(formDefinitionId)
    }

    /** Deletes a definition we are about to recreate, and drops its pending deletion mark. */
    private async deleteReplacedFormDefinition(formDefinitionId: string, formName?: string): Promise<void> {
        try {
            if (formName) this.run.rememberFusionReviewFormName(formDefinitionId, formName)
            await this.deleteFormDefinition(formDefinitionId, formName)
            this.run.formsToDelete.delete(formDefinitionId)
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            this.log.warn(
                `Could not delete form definition ${formDefinitionId} before recreate; will attempt create anyway: ${detail}`
            )
        }
    }

    // ------------------------------------------------------------------------
    // Public Methods
    // ------------------------------------------------------------------------

    /**
     * Fetch and process form data from completed form instances
     */
    public async fetchFormData(): Promise<void> {
        await this.fetchFormInstances()
        await this.processFetchedFormData()
    }

    private partitionStaleForms(forms: FormDefinitionResponseV2025[]): {
        activeForms: FormDefinitionResponseV2025[]
        staleForms: FormDefinitionResponseV2025[]
    } {
        const staleForms: FormDefinitionResponseV2025[] = []
        const activeForms: FormDefinitionResponseV2025[] = []
        for (const form of forms) {
            if (this.isFormDefinitionStale(form)) {
                staleForms.push(form)
            } else {
                activeForms.push(form)
            }
        }
        return { activeForms, staleForms }
    }

    private queueStaleFormDeletions(staleForms: FormDefinitionResponseV2025[]): void {
        for (const staleForm of staleForms) {
            const staleFormId = staleForm.id
            if (!staleFormId) continue
            this.log.info(
                `Form definition ${staleFormId} is older than ${this.fusionFormExpirationDays} day(s), queuing deletion`
            )
            this.addFormToDelete(staleFormId, staleForm.name)
        }
    }

    /**
     * Fetch form definitions and their instances, deferring decision processing.
     */
    public async fetchFormInstances(options?: FormFetchOptions): Promise<void> {
        this.log.debug('Fetching form data')
        assert(this.fusionFormNamePattern, 'Fusion form name pattern is required')
        this.resetFormDataState()

        const forms = await this.findFormDefinitionsByName(this.fusionFormNamePattern)
        for (const form of forms) {
            if (form.id && form.name) this.run.rememberFusionReviewFormName(form.id, form.name)
        }
        let activeForms = forms
        if (options?.staleFormCleanup) {
            const partitioned = this.partitionStaleForms(forms)
            activeForms = partitioned.activeForms
            this.log.debug(
                `Fetched ${forms.length} form definition(s) for pattern: ${this.fusionFormNamePattern} ` +
                    `(active=${partitioned.activeForms.length}, stale=${partitioned.staleForms.length})`
            )
            this.queueStaleFormDeletions(partitioned.staleForms)
        } else {
            this.log.debug(
                `Fetched ${forms.length} form definition(s) for pattern: ${this.fusionFormNamePattern} ` +
                    '(stale cleanup disabled for this run)'
            )
        }
        this.run.formsFound = activeForms.length

        // ⚡ Bolt: Replace unbounded Promise.all mapping with bounded promiseAllBatched
        // to prevent API rate limiting issues when iterating over a large number of forms
        if (activeForms.length === 0) {
            this.fetchedFormInstances = []
            this.log.debug('Fetched 0 instance(s) from 0 form definition(s)')
            return
        }

        const fetchInstancesOp = this.log.track('FormService.fetchFormInstances')
        let formsProcessed = 0
        let instanceCount = 0

        this.fetchedFormInstances = await promiseAllBatched(activeForms, async (form) => {
            const instances = await this.fetchFormInstancesByDefinitionId(form.id)
            formsProcessed++
            instanceCount += instances.length
            this.log.setProgress(formsProcessed, activeForms.length, 'forms')
            return instances
        })

        this.log.debug(`Fetched ${instanceCount} instance(s) from ${activeForms.length} form definition(s)`)
        fetchInstancesOp.done({ definitions: activeForms.length, instances: instanceCount })
    }

    /**
     * Process form instances that were fetched by fetchFormInstances.
     */
    public async processFetchedFormData(): Promise<void> {
        const formInstancesResults = this.fetchedFormInstances

        // Process all instances (single pass) to:
        // - extract assignment/new-identity decisions
        // - collect pending review URLs + pending candidate IDs
        // - queue resolved/orphaned forms for deletion
        // (fetching was done in parallel above, processing is fast so sequential is fine)
        for (const instances of formInstancesResults) {
            this.run.formInstancesFound += instances.length
            if (instances.length > 0) {
                await this.processFusionFormInstances(instances)
            }
        }
        this.fetchedFormInstances = []

        const fusionDecisionsCount = this.run.fusionIdentityDecisions.length
        this.log.debug(`Form data fetch completed - ${fusionDecisionsCount} fusion decision(s)`)
    }

    private resetFormDataState(): void {
        this.run.clearDecisions()
        this.run.clearFinishedFusionDecisions()
        this.fusionMergeDecisionMap = new Map()
        this.run.clearReviewUrls()
        this.pendingReviewContextByAccountIdValue = new Map()
        this.finishedFusionDecisionsValue = []
        this.run.formsFound = 0
        this.run.formInstancesFound = 0
        this.run.answeredFormInstancesProcessed = 0
        this.fetchedFormInstances = []
    }

    /**
     * Deletes Fusion review form definitions matching the name pattern and closes leftover
     * in-flight instances so Reset forms leaves no open Fusion reviews.
     */
    public async deleteExistingForms(): Promise<void> {
        const forms = await this.findFormDefinitionsByName(this.fusionFormNamePattern)
        await promiseAllBatched(forms, async (form) => {
            const formId = form.id
            if (!formId) {
                return
            }
            const instances = await this.fetchFormInstancesByDefinitionId(formId)
            await this.deleteFormDefinition(formId, form.name)
            await this.closeLeftoverFormInstances(instances)
        })
    }

    private async closeLeftoverFormInstances(instances: FormInstanceResponseV2025[]): Promise<void> {
        const alreadyClosed = new Set(['COMPLETED', 'SUBMITTED', 'CANCELLED'])
        for (const instance of instances) {
            if (!instance.id) {
                continue
            }
            const state = String(instance.state ?? '').toUpperCase()
            if (alreadyClosed.has(state)) {
                continue
            }
            try {
                await this.setFormInstanceState(instance.id, 'CANCELLED' as FormInstanceResponseV2025StateV2025)
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error)
                this.log.warn(`Could not cancel leftover form instance ${instance.id} after Reset forms: ${detail}`)
            }
        }
    }

    /**
     * Clean up completed and cancelled forms
     */
    public async cleanUpForms(): Promise<void> {
        if (this.run.formsToDelete.size === 0) {
            this.log.debug('No forms to clean up')
            return
        }

        // Snapshot and clear the transient list up front so producers can keep enqueueing
        // while this cleanup pass deduplicates and schedules the current batch.
        const formIdsToQueue = Array.from(this.run.formsToDelete)
        this.run.formsToDelete = new Set()

        let queuedCount = 0
        for (const formId of formIdsToQueue) {
            if (this.run.queuedFormDeleteIds.has(formId)) {
                continue
            }
            this.run.queuedFormDeleteIds.add(formId)
            this.run.formDeleteQueue.push(formId)
            queuedCount++
        }

        if (queuedCount === 0) {
            this.log.debug('No new forms were queued for cleanup')
            return
        }

        this.log.info(`Queued ${queuedCount} form(s) for low-priority cleanup`)
        this.kickoffFormDeleteWorkers()
    }

    /**
     * Wait for all queued form-deletion work to complete.
     * Called at the end of the pipeline so process flow remains non-blocking mid-run.
     */
    public async awaitPendingDeleteOperations(): Promise<void> {
        if (this.run.pendingFormDeleteTasks.size === 0 && this.run.formDeleteQueue.length === 0) {
            this.log.debug('No pending form deletions to await')
            return
        }

        this.log.info('Waiting for queued form deletions to complete')
        while (this.run.pendingFormDeleteTasks.size > 0 || this.run.formDeleteQueue.length > 0) {
            this.kickoffFormDeleteWorkers()
            if (this.run.pendingFormDeleteTasks.size > 0) {
                await Promise.all(Array.from(this.run.pendingFormDeleteTasks))
            }
        }
        this.log.debug('All queued form deletions completed')
    }

    /**
     * Create a fusion form for Match review.
     */
    public async createFusionForm(
        fusionAccount: FusionAccount,
        reviewers: Set<FusionAccount> | undefined
    ): Promise<CreateFusionFormOutcome> {
        assert(fusionAccount, 'Fusion account is required')

        if (!this.hasValidReviewers(reviewers, fusionAccount.name || 'Unknown')) {
            return { formDefinitionReady: false, newReviewInstancesQueued: 0 }
        }

        const localeGroups = await this.groupReviewersByLocale(reviewers!)
        const pendingRecipientIds = await this.collectPendingRecipientIdsForAccount(fusionAccount)

        let formDefinitionReady = false
        let newReviewInstancesQueued = 0
        let candidates: Candidate[] | undefined

        for (const [formLocale, groupReviewers] of localeGroups) {
            const prepared = await this.prepareFormCreationData(fusionAccount, groupReviewers, formLocale)
            candidates = prepared.candidates
            if (!prepared.formDefinition) {
                continue
            }
            formDefinitionReady = true
            const existingInstances = await this.fetchFormInstancesByDefinitionId(prepared.formDefinition.id)
            this.associateExistingInstancesWithReviewers(existingInstances, groupReviewers)
            newReviewInstancesQueued += await this.createFormInstancesForReviewers(
                groupReviewers,
                prepared.formDefinition,
                prepared.formInput,
                prepared.fusionSourceId,
                prepared.expire,
                fusionAccount,
                prepared.candidates,
                pendingRecipientIds
            )
            for (const reviewer of groupReviewers) {
                if (reviewer.identityId) {
                    pendingRecipientIds.add(reviewer.identityId)
                }
            }
        }

        if (candidates) {
            for (const candidate of candidates) {
                if (candidate.id) {
                    this.run.addPendingCandidateId(candidate.id)
                }
            }
        }
        return { formDefinitionReady, newReviewInstancesQueued }
    }

    /**
     * Validate that reviewers exist and are not empty
     */
    private hasValidReviewers(reviewers: Set<FusionAccount> | undefined, accountName: string): boolean {
        if (!reviewers || reviewers.size === 0) {
            this.log.warn(`No reviewers found for account ${accountName}, skipping form creation`)
            return false
        }
        return true
    }

    /**
     * Prepare all data needed for form creation
     */
    private async prepareFormCreationData(
        fusionAccount: FusionAccount,
        reviewers: Set<FusionAccount>,
        formLocale: string
    ): Promise<{
        candidates: Candidate[]
        formName: string
        formDefinition: FormDefinitionResponseV2025 | undefined
        formInput: { [key: string]: any }
        expire: string
        fusionSourceId: string
    }> {
        this.log.debug(
            `Building fusion form for account ${fusionAccount.name} with ${reviewers.size} reviewer(s) in locale ${formLocale}`
        )

        const candidates = buildCandidateList(fusionAccount, this.fusionMaxCandidatesForForm)
        assert(candidates, 'Failed to build candidate list')

        await this.enrichCandidateIdentities(candidates)

        const sourceType =
            this.sources.getSourceByNameSafe(fusionAccount.sourceName)?.sourceType ?? SourceType.Authoritative

        if (this.localizationEnabled) {
            this.log.debug(`Building localized form definition for reviewer locale ${formLocale}`)
        }
        const formName = buildFormName(fusionAccount, this.fusionFormNamePattern, {
            enableLocalization: this.localizationEnabled,
            locale: formLocale,
        })
        assert(formName, 'Form name is required')

        const formDefinition = await this.getOrCreateFormDefinition(formName, fusionAccount, candidates, formLocale)
        const formInput = buildFormInput(
            fusionAccount,
            candidates,
            this.fusionFormAttributes,
            sourceType,
            formLocale,
            this.urlContext
        )
        assert(formInput, 'Form input is required')

        const expire = calculateExpirationDate(this.fusionFormExpirationDays)
        assert(expire, 'Form expiration date is required')

        const { fusionSourceId } = this.sources
        assert(fusionSourceId, 'Fusion source ID is required')

        return { candidates, formName, formDefinition, formInput, expire, fusionSourceId }
    }

    /**
     * Enrich all candidates in a single pass:
     * - Aligns `candidate.name` with the identities SELECT primary label.
     * - Ensures `attributes.email` is populated for the identities SELECT sublabel.
     *
     * Fetches uncached identities in parallel (Promise.all) instead of sequentially,
     * and fetches each identity only once regardless of which fields are needed.
     */
    private async enrichCandidateIdentities(candidates: Candidate[]): Promise<void> {
        if (!this.identities) return

        const normalizeEmail = (value: unknown): string | undefined => {
            if (value === null || value === undefined) return undefined
            if (Array.isArray(value)) {
                for (const v of value) {
                    const normalized = normalizeEmail(v)
                    if (normalized) return normalized
                }
                return undefined
            }
            return trimStr(value)
        }

        // Collect IDs that are not already in cache so we can fetch them in parallel.
        const uncachedIds = candidates.filter((c) => !this.identities!.getIdentityById(c.id)).map((c) => c.id)

        if (uncachedIds.length > 0) {
            await promiseAllBatched(
                uncachedIds,
                (id) =>
                    this.identities!.fetchIdentityById(id).catch((error) => {
                        const detail = error instanceof Error ? error.message : String(error)
                        this.log.debug(`Could not load identity ${id} for candidate enrichment: ${detail}`)
                    }),
                50
            )
        }

        // Single pass: apply both name and email enrichment using the now-cached docs.
        for (const c of candidates) {
            const doc = this.identities.getIdentityById(c.id)
            const previousName = c.name
            const resolved = resolveIdentitiesSelectLabel(c.attributes, c.id, doc)
            c.name = resolved !== c.id ? resolved : previousName && previousName !== c.id ? previousName : resolved

            const existing = normalizeEmail(readUnknown(c.attributes, 'email'))
            if (existing) {
                ;(c.attributes as Record<string, unknown>).email = existing
                continue
            }

            if (doc) {
                const attrs = readUnknown(doc, 'attributes')
                const hydrated = normalizeEmail(
                    readUnknown(attrs, 'email') ?? readUnknown(attrs, 'mail') ?? readUnknown(attrs, 'emailAddress')
                )
                if (hydrated) {
                    ;(c.attributes as Record<string, unknown>).email = hydrated
                }
            }
        }
    }

    /**
     * Get existing form definition or create a new one
     */
    private async getOrCreateFormDefinition(
        formName: string,
        fusionAccount: FusionAccount,
        candidates: Candidate[],
        formLocale: string
    ): Promise<FormDefinitionResponseV2025 | undefined> {
        if (this.localizationEnabled) {
            const existing = await this.getFormDefinitionByName(formName)
            if (existing?.id) {
                const fullDefinition = existing.formElements
                    ? existing
                    : await this.getFormDefinitionByKeySafe(existing.id)
                const markedForDeletion = this.isFormDefinitionMarkedForDeletion(existing.id)
                if (!fullDefinition) {
                    // Definition search is eventually consistent, so a review deleted moments ago
                    // can still be returned. Fall through and create a replacement.
                    this.log.info(
                        `Form definition ${existing.id} for "${formName}" no longer exists; creating a replacement`
                    )
                    this.run.formsToDelete.delete(existing.id)
                } else if (
                    !markedForDeletion &&
                    !shouldRefreshLocalizedFormDefinition(
                        fullDefinition.description,
                        formLocale,
                        true,
                        fullDefinition.formElements
                    )
                ) {
                    this.log.debug(
                        `Using existing localized form definition: ${fullDefinition.id} (locale ${formLocale})`
                    )
                    return fullDefinition
                } else {
                    this.log.info(
                        markedForDeletion
                            ? `Replacing form definition ${existing.id} already marked for deletion this run for "${formName}" (locale ${formLocale})`
                            : `Replacing existing form definition ${existing.id} for localized form "${formName}" (locale ${formLocale})`
                    )
                    await this.deleteReplacedFormDefinition(existing.id, formName)
                }
            }

            try {
                const created = await this.buildFusionFormDefinition(formName, fusionAccount, candidates, formLocale)
                softAssert(created, 'Failed to create localized form definition')
                softAssert(created?.id, 'Localized form definition ID is required')
                return created!
            } catch (error) {
                if (this.isDuplicateFormDefinitionNameConflict(error)) {
                    this.log.warn(
                        `Form definition create conflict for name ${formName}; retrying lookup and patch for locale ${formLocale}`
                    )
                    const retried = await this.getFormDefinitionByName(formName)
                    if (retried?.id) {
                        return this.refreshFusionFormDefinition(retried.id, fusionAccount, candidates, formLocale)
                    }
                }
                throw error
            }
        }

        let formDefinition = await this.getFormDefinitionByName(formName)
        if (formDefinition?.id && this.isFormDefinitionMarkedForDeletion(formDefinition.id)) {
            this.log.info(
                `Replacing form definition ${formDefinition.id} already marked for deletion this run for "${formName}"`
            )
            await this.deleteReplacedFormDefinition(formDefinition.id, formDefinition.name ?? formName)
            formDefinition = undefined
        }
        if (!formDefinition) {
            this.log.debug(`Form definition not found, creating new one: ${formName}`)
            try {
                formDefinition = await this.buildFusionFormDefinition(formName, fusionAccount, candidates, formLocale)
            } catch (error) {
                if (this.isDuplicateFormDefinitionNameConflict(error)) {
                    this.log.warn(`Form definition create conflict for name ${formName}; retrying lookup by exact name`)
                    formDefinition = await this.getFormDefinitionByName(formName)
                }
                if (!formDefinition) {
                    throw error
                }
            }
            softAssert(formDefinition, 'Failed to create form definition')
            softAssert(formDefinition?.id, 'Form definition ID is required')
        } else {
            this.log.debug(`Using existing form definition: ${formDefinition.id}`)
        }

        assert(formDefinition, 'Form definition is required')
        assert(formDefinition.id, 'Form definition ID is required')
        return formDefinition
    }

    private isDuplicateFormDefinitionNameConflict(error: unknown): boolean {
        if (!error || typeof error !== 'object') {
            return false
        }
        const err = error as {
            message?: string
            status?: number
            response?: { status?: number; data?: { detailCode?: string; errorCode?: string; message?: string } }
        }
        const status = err.response?.status ?? err.status
        if (status === 409) {
            return true
        }
        const detailCode = err.response?.data?.detailCode ?? err.response?.data?.errorCode
        if (detailCode === '400.1.409') {
            return true
        }
        const message = String(err.message ?? err.response?.data?.message ?? '')
        return /another form definition with the same name already exists/i.test(message)
    }

    /**
     * Extract recipient IDs from existing form instances
     */
    private extractExistingRecipientIds(instances: FormInstanceResponseV2025[]): Set<string> {
        const recipientIds: string[] = []
        for (const instance of instances) {
            if (instance.recipients) {
                for (const recipient of instance.recipients) {
                    if (recipient.id) {
                        recipientIds.push(recipient.id)
                    }
                }
            }
        }
        return new Set(recipientIds)
    }

    /**
     * Associate existing form instances with their reviewers
     */
    private associateExistingInstancesWithReviewers(
        existingInstances: FormInstanceResponseV2025[],
        reviewers: Set<FusionAccount>
    ): void {
        const reviewerByIdentityId = new Map<string, FusionAccount>()
        for (const r of reviewers) {
            if (r.identityId) reviewerByIdentityId.set(r.identityId, r)
        }

        for (const instance of existingInstances) {
            if (!instance.recipients || !instance.standAloneFormUrl) continue
            // Only pending instances should show up as active reviews on reviewer accounts.
            if (!isPendingFormInstance(instance)) continue

            for (const recipient of instance.recipients) {
                if (!recipient.id) {
                    continue
                }

                const reviewer = reviewerByIdentityId.get(recipient.id)
                if (reviewer) {
                    reviewer.collections.reviews.addFusionReview(instance.standAloneFormUrl)
                    this.log.debug(`Added existing form instance ${instance.id} to reviewer ${recipient.id} reviews`)
                }
            }
        }
    }

    /**
     * Create form instances for each reviewer
     */
    private async createFormInstancesForReviewers(
        reviewers: Set<FusionAccount>,
        formDefinition: FormDefinitionResponseV2025,
        formInput: { [key: string]: any },
        fusionSourceId: string,
        expire: string,
        fusionAccount: FusionAccount,
        candidates: Candidate[],
        pendingRecipientIds: Set<string>
    ): Promise<number> {
        let newReviewInstancesQueued = 0
        const reviewPromises: Promise<string | undefined>[] = []
        for (const reviewer of reviewers) {
            const reviewerId = reviewer.identityId
            if (!reviewerId) {
                this.log.warn(`Reviewer ${reviewer.name} has no identity ID, skipping`)
                continue
            }

            if (pendingRecipientIds.has(reviewerId)) {
                this.log.debug(`Reviewer ${reviewerId} already has a pending Fusion review for this account`)
                continue
            }
            newReviewInstancesQueued++

            const reviewPromise = this.createReviewPromise(
                formDefinition.id!,
                formInput,
                reviewerId,
                fusionSourceId,
                expire,
                fusionAccount,
                candidates
            )

            reviewer.collections.reviews.addPromise(reviewPromise)
            reviewPromises.push(reviewPromise)
        }
        if (reviewPromises.length > 0) {
            await Promise.allSettled(reviewPromises)
        }
        return newReviewInstancesQueued
    }

    /**
     * Create a promise that handles form instance creation and email notification
     */
    private createReviewPromise(
        formDefinitionId: string,
        formInput: { [key: string]: any },
        reviewerId: string,
        fusionSourceId: string,
        expire: string,
        fusionAccount: FusionAccount,
        candidates: Candidate[]
    ): Promise<string | undefined> {
        return (async (): Promise<string | undefined> => {
            const formInstance = await this.createFormInstance(
                formDefinitionId,
                formInput,
                [reviewerId],
                fusionSourceId,
                expire
            )
            assert(formInstance, 'Failed to create form instance')

            if (!formInstance.id) {
                return undefined
            }

            this.log.debug(`Created form instance ${formInstance.id} for reviewer ${reviewerId}`)

            await this.sendFormInstanceNotificationIfEnabled(formInstance, fusionAccount)

            const url = formInstance.standAloneFormUrl ?? undefined
            if (url) {
                for (const c of candidates) {
                    if (!c.id) continue
                    this.run.addReviewUrlForCandidate(c.id, url)
                }
            }

            return url
        })()
    }

    /**
     * Send email notification for form instance if messaging is enabled
     */
    private async sendFormInstanceNotificationIfEnabled(
        formInstance: FormInstanceResponseV2025,
        fusionAccount: FusionAccount
    ): Promise<void> {
        if (!this.email) {
            return
        }

        if (this.run.isDryRunMode) {
            this.log.debug(`Skipping review email for form ${formInstance.id} — dry-run mode`)
            return
        }

        try {
            const reportAccountId = fusionAccount.iscAccountId
            await this.email.sendFusionEmail(formInstance, {
                accountName: fusionAccount.name || fusionAccount.displayName || 'Unknown',
                accountSource: fusionAccount.sourceName,
                sourceType: this.sources.getSourceByNameSafe(fusionAccount.sourceName)?.sourceType,
                accountId: reportAccountId,
                isMachine: fusionAccount.isMachine === true,
                accountEmail: fusionAccount.email,
                accountAttributes: fusionAccount.attributes as any,
                fusionMatches: fusionAccount.fusionMatches,
                maxCandidates: this.fusionMaxCandidatesForForm,
            })
            this.log.debug(`Email notification sent for form ${formInstance.id}`)
        } catch (error) {
            this.log.warn(`Failed to send email notification for form ${formInstance.id}: ${error}`)
        }
    }

    /** Number of form definitions created during this run */
    public get formsCreated(): number {
        return this.run.formsCreated
    }

    /** Number of form definitions found during fetchFormData for this run */
    public get formsFound(): number {
        return this.run.formsFound
    }

    /** Number of form instances (review assignments) created during this run */
    public get formInstancesCreated(): number {
        return this.run.formInstancesCreated
    }

    /** Number of form instances found during fetchFormData for this run */
    public get formInstancesFound(): number {
        return this.run.formInstancesFound
    }

    /** Number of answered form instances processed in this run */
    public get answeredFormInstancesProcessed(): number {
        return this.run.answeredFormInstancesProcessed
    }

    /** All finished decisions processed from answered form instances in this run */
    public get finishedFusionDecisions(): FusionDecision[] {
        return this.finishedFusionDecisionsValue
    }

    /**
     * Registers a completed decision for reporting/metrics.
     * Optionally include it in the processing queue when it should be handled by
     * processFusionIdentityDecisions (new-identity/no-match decisions from forms).
     */
    public registerFinishedDecision(decision: FusionDecision, includeInProcessingQueue: boolean = false): void {
        const enrichedDecision = this.enrichDecisionForReport(decision)
        this.finishedFusionDecisionsValue.push(enrichedDecision)
        this.run.addFinishedFusionDecision(enrichedDecision)
        if (!includeInProcessingQueue) return
        assert(this.run.fusionIdentityDecisions, 'Fusion identity decisions not fetched')
        this.run.addDecision(enrichedDecision)
    }

    /**
     * Capture the ISC account id on the decision while managed-account caches are still warm.
     * Report rendering runs after cache clear and must not fall back to composite keys.
     */
    private decisionAccountIsMachine(account: FusionDecision['account']): boolean {
        if (account.isMachine === true) return true
        const managedKey = account.id
        if (!managedKey) return false
        if (this.run.getManagedAccountInfo?.(managedKey)?.isMachine === true) return true
        return this.run.getFusionAccountByManagedKey?.(managedKey)?.isMachine === true
    }

    private enrichDecisionAccountIscId(decision: FusionDecision): FusionDecision {
        const account = decision.account
        const isMachine = this.decisionAccountIsMachine(account)
        const accountWithMachine = isMachine ? { ...account, isMachine: true as const } : account
        const existingId = trimStr(accountWithMachine.iscAccountId)
        if (isReportableIscAccountId(existingId)) {
            if (accountWithMachine === account) return decision
            return { ...decision, account: accountWithMachine }
        }

        const resolvedId = resolveManagedAccountIscIdForReport(account.id, this.sources, this.run, {
            identityId: decision.identityId,
        })
        if (!isReportableIscAccountId(resolvedId)) {
            if (accountWithMachine === account) return decision
            return { ...decision, account: accountWithMachine }
        }

        return {
            ...decision,
            account: {
                ...accountWithMachine,
                iscAccountId: resolvedId,
            },
        }
    }

    private enrichDecisionSubmitterName(decision: FusionDecision): FusionDecision {
        const submitterId = trimStr(decision.submitter?.id)
        if (!submitterId || submitterId === 'system') return decision

        const currentName = trimStr(decision.submitter?.name)
        if (currentName && currentName !== submitterId) return decision

        const label = resolveIdentityDocumentDisplayName(this.identities?.getIdentityById?.(submitterId))
        if (!label || label === submitterId) return decision

        return {
            ...decision,
            submitter: {
                ...decision.submitter,
                name: label,
            },
        }
    }

    private enrichDecisionForReport(decision: FusionDecision): FusionDecision {
        return this.enrichDecisionSubmitterName(this.enrichDecisionAccountIscId(decision))
    }

    /**
     * Builds a synthetic fusion decision for automatic merge (exact match).
     * This is the FormService-owned entry point so callers depend on the service,
     * not on the helper function directly.
     */
    public createAutomaticMergeDecision(
        fusionAccount: FusionAccount,
        account: Account,
        identityId: string
    ): FusionDecision {
        const sourceType =
            this.sources.getSourceByNameSafe(fusionAccount.sourceName)?.sourceType ?? SourceType.Authoritative
        return createAutomaticMergeDecision(fusionAccount, account, identityId, sourceType)
    }

    /**
     * Get all fusion identity decisions
     */
    public getFusionIdentityDecision(identityUid: string): FusionDecision | undefined {
        const decisions = this.run.fusionIdentityDecisions
        if (decisions.length === 0) {
            return undefined
        }
        return decisions.find((decision) => decision.account.id === identityUid)
    }

    /**
     * Get merge fusion decision for an identity ID
     */
    /** Restores merge decisions from a recorded run snapshot for replay. */
    public seedFinishedFusionDecisions(decisions: FusionDecision[]): void {
        for (const decision of decisions) {
            if (!decision.finished) continue
            this.finishedFusionDecisionsValue.push(decision)
            this.run.addFinishedFusionDecision(decision)
            if (!decision.newIdentity && decision.identityId) {
                this.fusionMergeDecisionMap.set(decision.identityId, decision)
            }
            if (decision.newIdentity) {
                this.run.addDecision(decision)
            }
        }
    }

    public getFusionMergeDecision(identityId: string): FusionDecision | undefined {
        return this.fusionMergeDecisionMap.get(identityId)
    }

    /**
     * Fetch form instances by definition ID
     */
    public async fetchFormInstancesByDefinitionId(
        formDefinitionId?: string,
        onInstancesLoaded?: (delta: number) => void
    ): Promise<FormInstanceResponseV2025[]> {
        return this.lifecycle.fetchFormInstancesByDefinitionId(formDefinitionId, onInstancesLoaded)
    }

    /**
     * Set form instance state
     */
    public async setFormInstanceState(
        formInstanceID: string,
        state: FormInstanceResponseV2025StateV2025
    ): Promise<FormInstanceResponseV2025 | undefined> {
        return this.lifecycle.setFormInstanceState(formInstanceID, state)
    }

    public get pendingReviewContextByAccountId(): Map<string, PendingReviewAccountContext> {
        const output = new Map<string, PendingReviewAccountContext>()

        for (const [accountId, context] of this.pendingReviewContextByAccountIdValue.entries()) {
            const reviewers = Array.from(context.reviewerIds)
                .map((reviewerId) => getReviewerInfo(reviewerId, this.identities))
                .filter(Boolean) as PendingReviewReviewerContext[]

            output.set(accountId, {
                forms: Array.from(context.forms.values()),
                reviewers,
                candidateIds: Array.from(context.candidateIds),
            })
        }

        return output
    }

    // ------------------------------------------------------------------------
    // Private Helper Methods
    // ------------------------------------------------------------------------

    /**
     * Collect pending (unanswered) form instance URLs by recipient identityId,
     * and candidate identity IDs from pending form instances.
     * Pending = state is not COMPLETED, IN_PROGRESS, SUBMITTED, or CANCELLED.
     * Kept so we can assign current review URLs to each reviewer when we process them,
     * and so we can apply the 'candidate' status to identities in pending reviews.
     */
    private collectPendingReviewUrlsByReviewer(formInstances: FormInstanceResponseV2025[]): void {
        for (const instance of formInstances) {
            if (!isPendingFormInstance(instance)) continue
            if (!instance.recipients?.length) continue

            const accountInfo = extractAccountInfoFromFormInput(instance.formInput)
            const candidateIds = extractCandidateIdsFromFormInput(instance.formInput)
            const accountContext = accountInfo?.id
                ? this.getOrCreatePendingReviewAccountContext(accountInfo.id)
                : undefined

            for (const recipient of instance.recipients) {
                if (!recipient.id) continue
                if (instance.standAloneFormUrl) {
                    this.run.addReviewUrlForReviewer(recipient.id, instance.standAloneFormUrl)
                }
                accountContext?.reviewerIds.add(recipient.id)
            }

            // Extract candidate identity IDs from pending form instances.
            // The 'candidates' field is a comma-separated list of identity IDs
            // stored during form creation (see buildFormInput in formBuilder.ts).
            for (const candidateId of candidateIds) {
                this.run.addPendingCandidateId(candidateId)
                accountContext?.candidateIds.add(candidateId)
                if (instance.standAloneFormUrl) {
                    this.run.addReviewUrlForCandidate(candidateId, instance.standAloneFormUrl)
                }
            }

            if (accountContext && instance.id) {
                accountContext.forms.set(instance.id, {
                    formInstanceId: instance.id,
                    url: instance.standAloneFormUrl ?? undefined,
                })
            }
        }
    }

    private getOrCreatePendingReviewAccountContext(accountId: string): {
        forms: Map<string, PendingReviewFormContext>
        reviewerIds: Set<string>
        candidateIds: Set<string>
    } {
        let context = this.pendingReviewContextByAccountIdValue.get(accountId)
        if (!context) {
            context = {
                forms: new Map<string, PendingReviewFormContext>(),
                reviewerIds: new Set<string>(),
                candidateIds: new Set<string>(),
            }
            this.pendingReviewContextByAccountIdValue.set(accountId, context)
        }
        return context
    }

    /**
     * Process fusion form instances and extract decisions
     */
    private async processFusionFormInstances(formInstances: FormInstanceResponseV2025[]): Promise<void> {
        assert(Array.isArray(this.run.fusionIdentityDecisions), 'Fusion identity decisions array is not initialized')
        assert(this.fusionMergeDecisionMap, 'Fusion merge decision map is not initialized')
        assert(formInstances, 'Form instances array is required')

        const processingResult = analyzeFormInstances(formInstances, {
            log: this.log,
            hasManagedAccount: (accountId) => this.run.hasManagedAccount(accountId),
        })
        const accountInfoOverride = this.extractAccountInfoOverride(
            processingResult.accountId,
            processingResult.shouldRemoveAccountFromMap
        )

        const decisionsAdded = await this.createDecisionsFromInstances(
            processingResult.instancesToProcess,
            accountInfoOverride
        )
        this.run.answeredFormInstancesProcessed += processingResult.instancesToProcess.length

        // Only active (non-deleted) forms should contribute pending review URLs and candidate IDs.
        // A resolved/orphaned form may still have "pending" instances for other reviewers, but those
        // should not be treated as active reviews/candidates once the form is no longer actionable.
        if (!processingResult.shouldDeleteForm) {
            this.collectPendingReviewUrlsByReviewer(formInstances)
        } else if (processingResult.formDefinitionId) {
            this.addFormToDelete(processingResult.formDefinitionId)
        }

        if (decisionsAdded > 0) {
            const discovered = this.finishedFusionDecisionsValue.slice(-decisionsAdded)
            const counts = summarizeDecisionCounts(discovered)
            this.log.detail({
                action: 'fusion decisions discovered from forms',
                count: decisionsAdded,
                decisions: formatDecisionCountsSegment(counts, true),
            })
        }
    }

    /**
     * Extract account info override from managed accounts and optionally
     * remove the account from the managed accounts map.
     *
     * The removal behaviour is controlled by shouldRemoveAccountFromMap,
     * which is derived from the instance analysis rules:
     * - No response and pending/open instances -> remove account from map
     * - All instances cancelled    -> keep account
     * - Response instance present  -> keep account
     */
    private extractAccountInfoOverride(
        accountId: string | undefined,
        shouldRemoveAccountFromMap: boolean
    ):
        | {
              id: string
              iscAccountId?: string
              isMachine?: boolean
              name: string
              sourceName: string
              sourceId?: string
              nativeIdentity?: string
          }
        | undefined {
        if (!accountId) {
            return undefined
        }

        const normalizedAccountId = normalizeCompositeManagedAccountKey(accountId)
        if (!normalizedAccountId) {
            return undefined
        }
        const workQueue = this.run.managedAccountsById
        assert(workQueue, 'Managed accounts have not been loaded')

        const queueAccount = workQueue.get(normalizedAccountId)
        const info = queueAccount ? undefined : this.run.getManagedAccountInfo(normalizedAccountId)
        if (!queueAccount && !info && !this.run.hasManagedAccount(normalizedAccountId)) {
            return undefined
        }

        if (shouldRemoveAccountFromMap && this.run.hasManagedAccount(normalizedAccountId) && queueAccount) {
            const inventoryInfo = this.run.getManagedAccountInfo(normalizedAccountId)
            const claimIdentityId = queueAccount.identityId ?? inventoryInfo?.identityId
            this.sources.run.claimAccount(normalizedAccountId, claimIdentityId)
        }

        if (queueAccount) {
            return {
                id: normalizedAccountId,
                iscAccountId: trimStr(queueAccount.id),
                ...(queueAccount.isMachine === true ? { isMachine: true } : {}),
                name: trimStr(queueAccount.name) || '',
                sourceName: queueAccount.sourceName || '',
                sourceId: readString(queueAccount, 'sourceId'),
                nativeIdentity: queueAccount.nativeIdentity ?? undefined,
            }
        }

        if (info) {
            return {
                id: normalizedAccountId,
                iscAccountId: trimStr(info.id),
                ...(info.isMachine === true ? { isMachine: true } : {}),
                name: info.name,
                sourceName: info.sourceName,
                sourceId: info.sourceId,
                nativeIdentity: info.nativeIdentity,
            }
        }

        return {
            id: normalizedAccountId,
            name: '',
            sourceName: '',
        }
    }

    /**
     * Create fusion decisions from processed instances
     * @returns The number of decisions successfully created
     */
    private async createDecisionsFromInstances(
        instancesToProcess: FormInstanceResponseV2025[],
        accountInfoOverride:
            | {
                  id: string
                  iscAccountId?: string
                  isMachine?: boolean
                  name: string
                  sourceName: string
                  sourceId?: string
                  nativeIdentity?: string
              }
            | undefined
    ): Promise<number> {
        let decisionsAdded = 0

        for (const instance of instancesToProcess) {
            const decision = await createFusionDecision(instance, this.identities, accountInfoOverride)
            if (!decision) {
                this.log.warn(`Failed to create fusion decision for form instance: ${instance.id}`)
                continue
            }

            if (decision.finished) {
                this.registerFinishedDecision(decision, decision.newIdentity)
                if (!decision.newIdentity) {
                    this.fusionMergeDecisionMap!.set(decision.identityId!, decision)
                }

                decisionsAdded++
                logFusionDecisionDiscovered(this.log, decision)
            }
        }

        return decisionsAdded
    }

    /**
     * Create a fusion form definition with appropriate fields
     */
    private async buildFusionFormDefinition(
        formName: string,
        fusionAccount: FusionAccount,
        candidates: Candidate[],
        formLocale: string
    ): Promise<FormDefinitionResponseV2025 | undefined> {
        const body = this.composeFusionFormDefinitionBody(fusionAccount, candidates, formLocale)
        if (!body) {
            return
        }

        const owner = this.sources.fusionSourceOwner
        assert(owner, 'Form owner is required')
        assert(owner.id, 'Form owner ID is required')
        assert(owner.type, 'Form owner type is required')

        const formDefinition: CustomFormsV2025ApiCreateFormDefinitionRequest = {
            body: {
                name: formName,
                description: body.description,
                owner,
                formElements: body.formFields,
                formInput: body.formInputs,
                formConditions: body.formConditions as any,
            },
        }

        if (this.localizationEnabled) {
            this.log.info(
                `Creating fusion form definition "${formName}" with locale ${body.formLocale}; ` +
                    `toggle label="${body.sampleToggleLabel ?? 'n/a'}"`
            )
        }

        return await this.createFormDefinition(formDefinition)
    }

    private async refreshFusionFormDefinition(
        formDefinitionId: string,
        fusionAccount: FusionAccount,
        candidates: Candidate[],
        formLocale: string
    ): Promise<FormDefinitionResponseV2025> {
        const body = this.composeFusionFormDefinitionBody(fusionAccount, candidates, formLocale)
        assert(body, 'Form definition body is required to refresh localization')

        return this.lifecycle.patchFormDefinition(formDefinitionId, [
            { op: 'replace', path: '/description', value: body.description },
            { op: 'replace', path: '/formElements', value: body.formFields },
            { op: 'replace', path: '/formInput', value: body.formInputs },
            { op: 'replace', path: '/formConditions', value: body.formConditions },
        ])
    }

    private composeFusionFormDefinitionBody(
        fusionAccount: FusionAccount,
        candidates: Candidate[],
        formLocale: string
    ):
        | {
              description: string
              formFields: ReturnType<typeof buildFormFields>
              formInputs: ReturnType<typeof buildFormInputs>
              formConditions: ReturnType<typeof buildFormConditions>
              formLocale: string
              sampleToggleLabel?: string
          }
        | undefined {
        if (candidates.length > this.fusionMaxCandidatesForForm) {
            this.log.error(
                `Candidates must be less than or equal to ${this.fusionMaxCandidatesForForm} (fusionMaxCandidatesForForm)`
            )
            return
        }
        const source = this.sources.getSourceByNameSafe(fusionAccount.sourceName)
        const sourceType = source?.sourceType ?? SourceType.Authoritative
        const orphanProcessingMode = source?.config?.orphanProcessingMode
        const formFields = buildFormFields(
            fusionAccount,
            candidates,
            this.fusionFormAttributes,
            sourceType,
            formLocale,
            orphanProcessingMode
        )
        const formInputs = buildFormInputs(
            fusionAccount,
            candidates,
            this.fusionFormAttributes,
            formLocale,
            this.urlContext,
            sourceType,
            orphanProcessingMode
        )
        const formConditions = buildFormConditions(candidates, this.fusionFormAttributes)

        this.log.debug(
            `Form definition validation: fields=${formFields.length}, inputs=${formInputs.length}, conditions=${formConditions.length}`
        )

        assert(formFields && formFields.length > 0, 'Form fields must not be empty')
        assert(formInputs && formInputs.length > 0, 'Form inputs must not be empty')

        if (formConditions.length > 500) {
            this.log.warn(`Form has ${formConditions.length} conditions - this may cause API performance issues`)
        }

        return {
            description: buildFormDefinitionDescription(formLocale, this.localizationEnabled),
            formFields,
            formInputs,
            formConditions,
            formLocale,
            sampleToggleLabel: readNewIdentityToggleLabel(formFields),
        }
    }

    // ------------------------------------------------------------------------
    // Lifecycle delegators (logic in formLifecycle.ts)
    // ------------------------------------------------------------------------

    private async findFormDefinitionsByName(namePattern: string): Promise<FormDefinitionResponseV2025[]> {
        return this.lifecycle.findFormDefinitionsByName(namePattern)
    }

    private async getFormDefinitionByName(formName: string): Promise<FormDefinitionResponseV2025 | undefined> {
        return this.lifecycle.getFormDefinitionByName(formName)
    }

    /** Full definition for an id, or undefined when it no longer exists (stale search result). */
    private async getFormDefinitionByKeySafe(
        formDefinitionId: string
    ): Promise<FormDefinitionResponseV2025 | undefined> {
        try {
            return await this.lifecycle.getFormDefinitionByKey(formDefinitionId)
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            this.log.debug(`Could not fetch form definition ${formDefinitionId}: ${detail}`)
            return undefined
        }
    }

    private async createFormDefinition(
        form: CustomFormsV2025ApiCreateFormDefinitionRequest
    ): Promise<FormDefinitionResponseV2025> {
        return this.lifecycle.createFormDefinition(form)
    }

    private async createFormInstance(
        formDefinitionId: string,
        formInput: { [key: string]: any },
        recipientList: string[],
        sourceId: string,
        expire: string
    ): Promise<FormInstanceResponseV2025> {
        return this.lifecycle.createFormInstance(formDefinitionId, formInput, recipientList, sourceId, expire)
    }

    private isFormDefinitionStale(form: FormDefinitionResponseV2025): boolean {
        return this.lifecycle.isFormDefinitionStale(form)
    }

    private addFormToDelete(formDefinitionId: string, formName?: string): void {
        this.lifecycle.addFormToDelete(formDefinitionId, formName)
    }

    private kickoffFormDeleteWorkers(): void {
        this.lifecycle.kickoffFormDeleteWorkers()
    }

    /**
     * Delete a form definition
     */
    public async deleteFormDefinition(formDefinitionId: string, formName?: string): Promise<void> {
        return this.lifecycle.deleteFormDefinition(formDefinitionId, formName)
    }
}

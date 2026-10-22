import {
    CreateFormInstanceRequestV2025,
    CustomFormsV2025ApiCreateFormDefinitionRequest,
    CustomFormsV2025ApiCreateFormInstanceRequest,
    CustomFormsV2025ApiGetFormDefinitionByKeyRequest,
    CustomFormsV2025ApiPatchFormDefinitionRequest,
    CustomFormsV2025ApiPatchFormInstanceRequest,
    CustomFormsV2025ApiSearchFormDefinitionsByTenantRequest,
    CustomFormsV2025ApiSearchFormInstancesByTenantRequest,
    FormDefinitionResponseV2025,
    FormInstanceCreatedByV2025,
    FormInstanceRecipientV2025,
    FormInstanceResponseV2025,
    FormInstanceResponseV2025StateV2025,
} from 'sailpoint-api-client'
import { assert } from '../../utils/assert'
import { readUnknown } from '../../utils/safeRead'
import { ClientService } from '../clientService'
import { LogService } from '../logService'
import { FusionRun } from '../../model/fusionRun'

// ============================================================================
// Types
// ============================================================================

export type FormLifecycleDeps = {
    client: ClientService
    log: LogService
    run: FusionRun
    fusionFormExpirationDays: number
    formDeleteQueueConcurrency: number
}

// ============================================================================
// FormLifecycle — CRUD, fetch, and delete operations for custom forms
// ============================================================================

export class FormLifecycle {
    constructor(private readonly deps: FormLifecycleDeps) {}

    /**
     * Fetch forms by name pattern
     */
    async findFormDefinitionsByName(namePattern: string): Promise<FormDefinitionResponseV2025[]> {
        assert(namePattern, 'Form name pattern is required')
        assert(this.deps.client, 'Client service is required')

        const requestParameters: CustomFormsV2025ApiSearchFormDefinitionsByTenantRequest = {
            filters: `name sw "${namePattern}"`,
        }

        this.deps.log.debug(`Fetching forms with name pattern: ${namePattern}`)

        const forms = await this.deps.client.call<FormDefinitionResponseV2025>(
            (api: any, params: any) =>
                api.customForms
                    .searchFormDefinitionsByTenant(params)
                    .then((r: any) => ({ data: r.data?.results ?? [] })),
            {
                paginate: { mode: 'sequential', baseParams: requestParameters as any },
                context: 'FormService>findFormDefinitionsByName searchFormDefinitionsByTenant',
            }
        )
        this.deps.log.debug(`Found ${forms.length} form(s) matching pattern: ${namePattern}`)
        return forms
    }

    /**
     * Find form definition by exact name
     */
    async getFormDefinitionByName(formName: string): Promise<FormDefinitionResponseV2025 | undefined> {
        assert(formName, 'Form name is required')
        assert(this.deps.client, 'Client service is required')

        const requestParameters: CustomFormsV2025ApiSearchFormDefinitionsByTenantRequest = {
            filters: `name eq "${formName}"`,
        }

        this.deps.log.debug(`Searching for form definition with exact name: ${formName}`)

        const forms = await this.deps.client.call<FormDefinitionResponseV2025>(
            (api: any, params: any) =>
                api.customForms
                    .searchFormDefinitionsByTenant(params)
                    .then((r: any) => ({ data: r.data?.results ?? [] })),
            {
                paginate: { mode: 'sequential', baseParams: requestParameters as any },
                context: 'FormService>getFormDefinitionByName searchFormDefinitionsByTenant',
            }
        )
        const form = forms.find((f) => f.name === formName)
        if (form) {
            this.deps.log.debug(`Found existing form definition: ${form.id}`)
        } else {
            this.deps.log.debug(`No form definition found with name: ${formName}`)
        }
        return form
    }

    /**
     * Create a form definition
     */
    async createFormDefinition(
        form: CustomFormsV2025ApiCreateFormDefinitionRequest
    ): Promise<FormDefinitionResponseV2025> {
        assert(form, 'Form definition request is required')
        assert(form.body, 'Form definition body is required')
        assert(form.body.name, 'Form name is required')
        assert(this.deps.client, 'Client service is required')

        this.deps.log.debug(`Creating form definition: ${form.body.name}`)
        this.deps.log.debug(
            `Form has ${form.body.formElements?.length || 0} elements, ${form.body.formInput?.length || 0} inputs, ${form.body.formConditions?.length || 0} conditions`
        )

        this.deps.log.debug(`Executing form creation through client...`)
        const formInstance = await this.deps.client.call<FormDefinitionResponseV2025>(
            async (api: any) => {
                try {
                    this.deps.log.debug(`Calling customFormsApi.createFormDefinition...`)
                    const response = await api.customForms.createFormDefinition(form)
                    this.deps.log.debug(`API call completed, processing response...`)
                    return response.data
                } catch (error: any) {
                    this.deps.log.error(`Error creating form definition: ${error}`)
                    if (error?.response?.data) {
                        this.deps.log.error(`API error response: ${JSON.stringify(error.response.data)}`)
                    }
                    if (error instanceof Error) {
                        this.deps.log.error(`Error message: ${error.message}`)
                    }
                    throw error
                }
            },
            { context: 'FormService>createFormDefinition' }
        )
        assert(formInstance, 'Failed to create form definition')
        assert(formInstance.id, 'Form definition ID is missing')

        this.deps.log.debug(`Form definition created successfully: ${formInstance.id}`)
        this.deps.run.formsCreated++
        return formInstance
    }

    /**
     * Patch an existing form definition (JSON Patch).
     */
    async patchFormDefinition(
        formDefinitionID: string,
        body: Array<{ op: string; path: string; value: unknown }>
    ): Promise<FormDefinitionResponseV2025> {
        assert(formDefinitionID, 'Form definition ID is required')
        assert(body && body.length > 0, 'Form definition patch body is required')
        assert(this.deps.client, 'Client service is required')

        const requestParameters: CustomFormsV2025ApiPatchFormDefinitionRequest = {
            formDefinitionID,
            body: body as unknown as CustomFormsV2025ApiPatchFormDefinitionRequest['body'],
        }

        this.deps.log.debug(`Patching form definition: ${formDefinitionID}`)
        const updated = await this.deps.client.call<FormDefinitionResponseV2025>(
            (api: any) => api.customForms.patchFormDefinition(requestParameters).then((r: any) => r.data),
            { context: `FormService>patchFormDefinition id=${formDefinitionID}` }
        )
        assert(updated, 'Failed to patch form definition')
        assert(updated.id, 'Patched form definition ID is missing')
        return updated
    }

    /**
     * Fetch a form definition by ID (includes formElements for localization verification).
     */
    async getFormDefinitionByKey(formDefinitionID: string): Promise<FormDefinitionResponseV2025> {
        assert(formDefinitionID, 'Form definition ID is required')
        assert(this.deps.client, 'Client service is required')

        const requestParameters: CustomFormsV2025ApiGetFormDefinitionByKeyRequest = {
            formDefinitionID,
        }

        const formDefinition = await this.deps.client.call<FormDefinitionResponseV2025>(
            (api: any) => api.customForms.getFormDefinitionByKey(requestParameters).then((r: any) => r.data),
            { context: `FormService>getFormDefinitionByKey id=${formDefinitionID}` }
        )
        assert(formDefinition, 'Failed to fetch form definition')
        assert(formDefinition.id, 'Fetched form definition ID is missing')
        return formDefinition
    }

    /**
     * Create a form instance
     */
    async createFormInstance(
        formDefinitionId: string,
        formInput: { [key: string]: any },
        recipientList: string[],
        sourceId: string,
        expire: string
    ): Promise<FormInstanceResponseV2025> {
        assert(formDefinitionId, 'Form definition ID is required')
        assert(formInput, 'Form input is required')
        assert(recipientList, 'Recipient list is required')
        assert(recipientList.length > 0, 'At least one recipient is required')
        assert(sourceId, 'Source ID is required')
        assert(expire, 'Expiration date is required')
        assert(this.deps.client, 'Client service is required')

        this.deps.log.debug(
            `Creating form instance for definition ${formDefinitionId} with ${recipientList.length} recipient(s)`
        )
        const recipients: FormInstanceRecipientV2025[] = recipientList.map((x) => ({ id: x, type: 'IDENTITY' }))
        const createdBy: FormInstanceCreatedByV2025 = {
            id: sourceId,
            type: 'SOURCE',
        }

        const body: CreateFormInstanceRequestV2025 = {
            formDefinitionId,
            recipients,
            createdBy,
            expire,
            formInput,
            standAloneForm: true,
        }

        const requestParameters: CustomFormsV2025ApiCreateFormInstanceRequest = {
            body,
        }

        const response = await this.deps.client.call<FormInstanceResponseV2025>(
            (api: any) => api.customForms.createFormInstance(requestParameters).then((r: any) => r.data),
            { context: `FormService>createFormInstance formDef=${formDefinitionId}` }
        )
        assert(response, 'Failed to create form instance')
        this.deps.log.debug(`Form instance created successfully: ${response.id || 'unknown'}`)
        this.deps.run.formInstancesCreated++
        return response
    }

    /**
     * Delete a form definition
     */
    async deleteFormDefinition(formDefinitionId: string): Promise<void> {
        assert(formDefinitionId, 'Form definition ID is required')
        assert(this.deps.client, 'Client service is required')

        this.deps.log.debug(`Deleting form definition: ${formDefinitionId}`)
        await this.deps.client.call<void>(
            (api: any) => api.customForms.deleteFormDefinition({ formDefinitionID: formDefinitionId }),
            { context: `FormService>deleteForm id=${formDefinitionId}` }
        )
        this.deps.log.debug(`Form definition deleted successfully: ${formDefinitionId}`)
    }

    /**
     * Fetch form instances by definition ID
     */
    async fetchFormInstancesByDefinitionId(
        formDefinitionId?: string,
        onInstancesLoaded?: (delta: number) => void
    ): Promise<FormInstanceResponseV2025[]> {
        if (!formDefinitionId) {
            const allInstances = await this.deps.client.call<FormInstanceResponseV2025[]>(
                (api: any) => api.customForms.searchFormInstancesByTenant({}).then((r: any) => r.data ?? []),
                { context: 'FormService>searchFormInstancesByTenant formDef=all' }
            )
            return allInstances ?? []
        }

        const requestParameters: CustomFormsV2025ApiSearchFormInstancesByTenantRequest = {
            filters: `formDefinitionId eq "${formDefinitionId}"`,
        }
        let lastLoaded = 0
        const allInstances =
            (await this.deps.client.call<FormInstanceResponseV2025>(
                (api: any, params: any) =>
                    api.customForms.searchFormInstancesByTenant(params).then((r: any) => ({ data: r.data ?? [] })),
                {
                    paginate: { mode: 'sequential', baseParams: requestParameters as any },
                    context: `FormService>searchFormInstancesByTenant formDef=${formDefinitionId}`,
                    onPageProgress: (loaded) => {
                        const delta = loaded - lastLoaded
                        lastLoaded = loaded
                        if (delta > 0) onInstancesLoaded?.(delta)
                    },
                }
            )) ?? []

        const matchingInstances = allInstances.filter((instance) => instance.formDefinitionId === formDefinitionId)
        const mismatchedCount = allInstances.length - matchingInstances.length
        if (mismatchedCount > 0) {
            this.deps.log.warn(
                `searchFormInstancesByTenant returned ${mismatchedCount} instance(s) outside requested formDefinitionId=${formDefinitionId}`
            )
        }
        if (allInstances.length === 250) {
            this.deps.log.warn(
                `searchFormInstancesByTenant returned 250 instance(s) for formDefinitionId=${formDefinitionId}; results may be truncated by API page size`
            )
        }
        return matchingInstances
    }

    /**
     * Set form instance state
     */
    async setFormInstanceState(
        formInstanceID: string,
        state: FormInstanceResponseV2025StateV2025
    ): Promise<FormInstanceResponseV2025 | undefined> {
        const body: { [key: string]: any }[] = [
            {
                op: 'replace',
                path: '/state',
                value: state,
            },
        ]

        const requestParameters: CustomFormsV2025ApiPatchFormInstanceRequest = {
            formInstanceID,
            body,
        }

        return await this.deps.client.call<FormInstanceResponseV2025>(
            (api: any) => api.customForms.patchFormInstance(requestParameters).then((r: any) => r.data),
            { context: `FormService>setFormInstanceState id=${formInstanceID} state=${state}` }
        )
    }

    isFormDefinitionStale(form: FormDefinitionResponseV2025): boolean {
        const timestamp = this.readFormDefinitionTimestamp(form)
        if (!timestamp) return false

        const cutoffMs = this.deps.run.currentTimeMs() - this.deps.fusionFormExpirationDays * 24 * 60 * 60 * 1000
        return timestamp.getTime() < cutoffMs
    }

    readFormDefinitionTimestamp(form: FormDefinitionResponseV2025): Date | undefined {
        const rawTimestamp =
            readUnknown(form, 'modified') ??
            readUnknown(form, 'modifiedAt') ??
            readUnknown(form, 'created') ??
            readUnknown(form, 'createdAt')

        if (!rawTimestamp) {
            this.deps.log.warn(`Form definition ${form.id || 'unknown'} missing timestamp fields; skipping stale check`)
            return undefined
        }

        const parsed = new Date(String(rawTimestamp))
        if (Number.isNaN(parsed.getTime())) {
            this.deps.log.warn(
                `Form definition ${form.id || 'unknown'} has invalid timestamp "${String(rawTimestamp)}"`
            )
            return undefined
        }

        return parsed
    }

    addFormToDelete(formDefinitionId: string): void {
        this.deps.run.formsToDelete.add(formDefinitionId)
    }

    kickoffFormDeleteWorkers(): void {
        while (
            this.deps.run.activeFormDeleteWorkers < this.deps.formDeleteQueueConcurrency &&
            this.deps.run.formDeleteQueue.length > 0
        ) {
            this.deps.run.activeFormDeleteWorkers++
            const workerPromise = this.runFormDeleteWorker()

            // eslint-disable-next-line prefer-const
            let trackedPromise: Promise<void> = workerPromise.finally(() => {
                this.deps.run.activeFormDeleteWorkers--
                this.deps.run.pendingFormDeleteTasks.delete(trackedPromise)
                if (this.deps.run.formDeleteQueue.length > 0) {
                    this.kickoffFormDeleteWorkers()
                }
            })
            this.deps.run.pendingFormDeleteTasks.add(trackedPromise)
        }
    }

    async runFormDeleteWorker(): Promise<void> {
        while (this.deps.run.formDeleteQueue.length > 0) {
            const formId = this.deps.run.formDeleteQueue.shift()
            if (!formId) {
                continue
            }
            try {
                await this.deleteFormDefinition(formId)
            } finally {
                this.deps.run.queuedFormDeleteIds.delete(formId)
            }
        }
    }
}

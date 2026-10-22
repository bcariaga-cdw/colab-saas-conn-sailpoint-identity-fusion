import {
    createFusionDecision,
    extractAccountInfoFromFormInput,
    extractCandidateIdsFromFormInput,
} from '../formProcessor'

describe('formProcessor createFusionDecision', () => {
    it('treats SUBMITTED state as finished', async () => {
        const decision = await createFusionDecision({
            id: 'fi-1',
            state: 'SUBMITTED',
            recipients: [{ id: 'reviewer-1', type: 'IDENTITY' }],
            formInput: {
                account: 'src-1::account-1',
                name: 'Account One',
                source: 'HR',
                sourceType: 'authoritative',
            },
            formData: {
                newIdentity: false,
                identities: ['identity-123'],
                comments: 'Finalized in submitted state',
            },
        } as any)

        expect(decision).toBeDefined()
        expect(decision?.finished).toBe(true)
        expect(decision?.newIdentity).toBe(false)
        expect(decision?.identityId).toBe('identity-123')
    })

    it('rejects non-composite managed account IDs', async () => {
        const decision = await createFusionDecision({
            id: 'fi-raw-id',
            state: 'COMPLETED',
            recipients: [{ id: 'reviewer-1', type: 'IDENTITY' }],
            formInput: {
                account: 'account-1',
                name: 'Account One',
                source: 'HR',
                sourceType: 'authoritative',
            },
            formData: {
                newIdentity: false,
                identities: ['identity-123'],
            },
        } as any)

        expect(decision).toBeNull()
    })

    it('reads correlated identity id from dictionary-shaped formInput', async () => {
        const decision = await createFusionDecision({
            id: 'fi-dict-correlated',
            state: 'SUBMITTED',
            recipients: [{ id: 'reviewer-1', type: 'IDENTITY' }],
            formInput: {
                a: { id: 'account', value: 'src-1::account-1' },
                b: { id: 'name', value: 'Account One' },
                c: { id: 'source', value: 'HR' },
                d: { id: 'identityId', value: 'correlated-uuid' },
                sourceType: 'authoritative',
            },
            formData: {
                newIdentity: true,
                comments: 'Dictionary correlated identity',
            },
        } as any)

        expect(decision).toBeDefined()
        expect(decision?.correlatedIdentityId).toBe('correlated-uuid')
    })

    it('leaves sourceType unset when the form input omits it (older definitions)', async () => {
        const decision = await createFusionDecision({
            id: 'fi-no-source-type',
            state: 'COMPLETED',
            recipients: [{ id: 'reviewer-1', type: 'IDENTITY' }],
            formInput: {
                account: 'src-1::account-1',
                name: 'Account One',
                source: 'HR',
            },
            formData: {
                newIdentity: false,
                identities: ['identity-123'],
            },
        } as any)

        expect(decision).toBeDefined()
        expect(decision?.sourceType).toBeUndefined()
    })
})

describe('extractAccountInfoFromFormInput', () => {
    it('reads flat form input unchanged', () => {
        expect(
            extractAccountInfoFromFormInput({
                account: 'src::nat',
                name: 'Account One',
                source: 'HR',
            })
        ).toEqual({
            id: 'src::nat',
            name: 'Account One',
            sourceName: 'HR',
        })
    })

    it('reads account from dictionary with arbitrary keys', () => {
        expect(
            extractAccountInfoFromFormInput({
                a: { id: 'account', value: 'src::nat' },
                b: { id: 'name', value: 'Account One' },
                c: { id: 'source', value: 'HR' },
            })
        ).toEqual({
            id: 'src::nat',
            name: 'Account One',
            sourceName: 'HR',
        })
    })

    it('reads account when dictionary keys match field ids', () => {
        expect(
            extractAccountInfoFromFormInput({
                account: { id: 'account', value: 'src::nat' },
                name: { id: 'name', value: 'Account One' },
                source: { id: 'source', value: 'HR' },
            })
        ).toEqual({
            id: 'src::nat',
            name: 'Account One',
            sourceName: 'HR',
        })
    })
})

describe('extractCandidateIdsFromFormInput', () => {
    it('reads comma-separated ids from flat formInput', () => {
        expect(
            extractCandidateIdsFromFormInput({
                account: 'src::nat',
                candidates: 'uuid-1,uuid-2',
            })
        ).toEqual(['uuid-1', 'uuid-2'])
    })

    it('trims whitespace around ids', () => {
        expect(extractCandidateIdsFromFormInput({ candidates: ' uuid-1 , uuid-2 ' })).toEqual(['uuid-1', 'uuid-2'])
    })

    it('reads from dictionary-shaped formInput (definition input objects)', () => {
        const formInput = {
            a: { id: 'account', value: 'src::nat' },
            b: { id: 'candidates', value: 'id-x,id-y' },
        }
        expect(extractCandidateIdsFromFormInput(formInput)).toEqual(['id-x', 'id-y'])
    })

    it('reads from dictionary when keys match field ids', () => {
        expect(
            extractCandidateIdsFromFormInput({
                account: { id: 'account', value: 'src::nat' },
                candidates: { id: 'candidates', value: 'only-keyed' },
            })
        ).toEqual(['only-keyed'])
    })

    it('falls back to description when value is empty', () => {
        const formInput = {
            c: { id: 'candidates', description: 'only-desc' },
        }
        expect(extractCandidateIdsFromFormInput(formInput)).toEqual(['only-desc'])
    })

    it('returns empty array when candidates missing or empty', () => {
        expect(extractCandidateIdsFromFormInput({ account: 'x' })).toEqual([])
        expect(extractCandidateIdsFromFormInput({ candidates: '' })).toEqual([])
        expect(extractCandidateIdsFromFormInput(null)).toEqual([])
    })
})

describe('Processor ignores display HTML keys', () => {
    it('Processor ignores display HTML keys', async () => {
        const decision = await createFusionDecision({
            id: 'fi-html',
            state: 'SUBMITTED',
            recipients: [{ id: 'reviewer-1', type: 'IDENTITY' }],
            formInput: {
                account: 'src-1::account-1',
                name: 'Account One',
                source: 'HR',
                sourceType: 'authoritative',
                candidates: 'identity-123',
                accountHtml: '<p><b>Account One</b></p>',
                candidatesHtml: '<table><tr><td>email</td></tr></table>',
                identityHtml0: '<p>Identity 123 details</p>',
            },
            formData: {
                newIdentity: false,
                identities: ['identity-123'],
                comments: 'Approved from HTML form',
            },
        } as any)

        expect(decision).toBeDefined()
        expect(decision?.finished).toBe(true)
        expect(decision?.identityId).toBe('identity-123')
        expect(decision?.account.id).toBe('src-1::account-1')
    })

    it('produces a decision when display HTML keys are omitted', async () => {
        const decision = await createFusionDecision({
            id: 'fi-no-html',
            state: 'SUBMITTED',
            recipients: [{ id: 'reviewer-1', type: 'IDENTITY' }],
            formInput: {
                account: 'src-1::account-1',
                name: 'Account One',
                source: 'HR',
                sourceType: 'authoritative',
            },
            formData: {
                newIdentity: false,
                identities: ['identity-123'],
            },
        } as any)

        expect(decision?.identityId).toBe('identity-123')
    })
})

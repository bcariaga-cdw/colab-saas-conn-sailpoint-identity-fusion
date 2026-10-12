import { readFileSync } from 'fs'
import * as path from 'path'
import { readSettings } from '../processingControlSettings'

describe('processingControlSettings readSettings', () => {
    it('defaults deleteEmpty to false when omitted', () => {
        const raw = {}

        const result = readSettings(raw)

        expect(result.deleteEmpty).toBe(false)
    })

    it('normalizes string "true" to boolean true for deleteEmpty', () => {
        const raw = { deleteEmpty: 'true' }

        const result = readSettings(raw)

        expect(result.deleteEmpty).toBe(true)
    })

    it('normalizes string "false" to boolean false for deleteEmpty', () => {
        const raw = { deleteEmpty: 'false' }

        const result = readSettings(raw)

        expect(result.deleteEmpty).toBe(false)
    })

    it('defaults skipAccountsWithMissingId to false when omitted', () => {
        const raw = {}

        const result = readSettings(raw)

        expect(result.skipAccountsWithMissingId).toBe(false)
    })

    it('normalizes string "true" to boolean true for skipAccountsWithMissingId', () => {
        const raw = { skipAccountsWithMissingId: 'true' }

        const result = readSettings(raw)

        expect(result.skipAccountsWithMissingId).toBe(true)
    })

    it('normalizes string "false" to boolean false for skipAccountsWithMissingId', () => {
        const raw = { skipAccountsWithMissingId: 'false' }

        const result = readSettings(raw)

        expect(result.skipAccountsWithMissingId).toBe(false)
    })

    it('preserves boolean values for deleteEmpty and skipAccountsWithMissingId', () => {
        const raw = { deleteEmpty: true, skipAccountsWithMissingId: true }

        const result = readSettings(raw)

        expect(result.deleteEmpty).toBe(true)
        expect(result.skipAccountsWithMissingId).toBe(true)
    })

    it('Absent key leaves the toggle off', () => {
        const result = readSettings({})

        expect(result.promoteMainAccountWhenOriginMissing).toBe(false)
    })

    it('Help text states promote and clear', () => {
        const specPath = path.join(__dirname, '..', '..', '..', '..', '..', 'connector-spec.json')
        type SpecNode = {
            key?: string
            label?: string
            value?: unknown
            helpKey?: string
            sectionTitle?: string
            sectionHelpMessage?: string
            items?: SpecNode[]
        }
        const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { sourceConfig?: SpecNode[] }
        const sections = (spec.sourceConfig ?? []).flatMap((menu) => menu.items ?? [])
        const processingControl = sections.find((section) => section.sectionTitle === 'Processing Control')
        const toggle = (processingControl?.items ?? []).find(
            (item) => item.key === 'promoteMainAccountWhenOriginMissing'
        )

        expect(toggle?.label).toBe('Promote first found managed account to main account when origin account is missing')
        expect(toggle?.value).toBeUndefined()
        expect(toggle?.helpKey).toContain(
            'set mainAccount to the first live managed account while the origin is not a current contributor'
        )
        expect(toggle?.helpKey).toContain('clear mainAccount when the origin is a current contributor again')
        expect(processingControl?.sectionHelpMessage).toContain('Promote first found managed account')
    })
})

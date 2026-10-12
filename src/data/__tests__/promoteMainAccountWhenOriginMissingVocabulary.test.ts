import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const glossary = readFileSync(join(process.cwd(), 'docs/glossary.md'), 'utf8')

function glossaryRow(term: string): string {
    const row = glossary.split('\n').find((line) => line.startsWith(`| **${term}**`))
    if (!row) throw new Error(`Missing glossary row: ${term}`)
    return row
}

describe('promoteMainAccountWhenOriginMissing vocabulary', () => {
    it('Glossary entry for first live managed account', () => {
        const row = glossaryRow('First live managed account')

        expect(row).toContain('configured source order, then blend order within a source')
        expect(row).toContain('identity bag is not')
    })

    it('Glossary entry for origin not a current contributor', () => {
        const row = glossaryRow('Origin not a current contributor')

        expect(row).toContain('origin key is not in `accounts`')
        expect(row).toContain('resolved out of scope')
        expect(row).toContain('An unresolved scope check is not this state')
        expect(row).toContain('missing origin snapshot when refresh was skipped is not this state')
    })

    it('Processing Control entry names the handoff toggle', () => {
        const row = glossaryRow('Processing Control')

        expect(row).toContain('history retention')
        expect(row).toContain('empty-account deletion')
        expect(row).toContain('missing-identifier behavior')
        expect(row).toContain('origin-absent main account handoff')
        expect(row).toContain('promoteMainAccountWhenOriginMissing')
    })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { actions } from '../action'

const glossary = readFileSync(join(process.cwd(), 'docs/glossary.md'), 'utf8')

describe('canonical report and review communication terms', () => {
    it('glossary lists the five communication terms and does not call Fusion review a report', () => {
        expect(glossary).toContain('**Dry-run report**')
        expect(glossary).toContain('**Fusion report**')
        expect(glossary).toContain('**Aggregation report**')
        expect(glossary).toContain('**Fusion Review decision section**')
        expect(glossary).toContain('**Fusion review**')
        expect(glossary).toMatch(
            /\*\*Fusion review\*\*\s*\|[^\n]*reviewer-facing review-required communication[^\n]*Not a report/
        )
    })

    it('FusionReport entitlement names the Fusion report, not an aggregation report', () => {
        expect(glossary).toMatch(
            /\*\*FusionReport\*\*.*`report`[^\n]*\*\*Fusion report\*\*[^\n]*Not an aggregation report/
        )
        const reportAction = actions.find((action) => action.id === 'report')
        expect(reportAction?.name).toBe('Fusion report')
        expect(reportAction?.description).toMatch(/Fusion report/i)
        expect(reportAction?.description).not.toMatch(/aggregation report/i)
    })
})

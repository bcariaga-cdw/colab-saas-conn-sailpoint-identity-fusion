import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { countNdjsonLines, forEachNdjsonLine } from '../ndjson'

describe('ndjson', () => {
    let dir: string

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndjson-'))
    })

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true })
    })

    function write(name: string, content: string | Buffer): string {
        const filePath = path.join(dir, name)
        fs.writeFileSync(filePath, content)
        return filePath
    }

    it('counts non-empty lines with or without a trailing newline', () => {
        expect(countNdjsonLines(write('none.ndjson', ''))).toBe(0)
        expect(countNdjsonLines(write('missing-file.ndjson', ''))).toBe(0)
        expect(countNdjsonLines(path.join(dir, 'does-not-exist.ndjson'))).toBe(0)
        expect(countNdjsonLines(write('no-trailing.ndjson', '{"a":1}\n{"b":2}'))).toBe(2)
        expect(countNdjsonLines(write('trailing.ndjson', '{"a":1}\n{"b":2}\n'))).toBe(2)
        expect(countNdjsonLines(write('blank-lines.ndjson', '\n{"a":1}\n\n{"b":2}\n\n'))).toBe(2)
        expect(countNdjsonLines(write('crlf.ndjson', '{"a":1}\r\n{"b":2}\r\n'))).toBe(2)
    })

    it('counts correctly across small read chunks', () => {
        const content = '{"a":1}\n{"b":2}\n{"c":3}\n'
        const filePath = write('chunked.ndjson', content)
        expect(countNdjsonLines(filePath, 1)).toBe(3)
        expect(countNdjsonLines(filePath, 5)).toBe(3)
        expect(countNdjsonLines(filePath, 1024)).toBe(3)
    })

    it('iterates lines across chunk boundaries with multi-byte characters', () => {
        const records = [
            { name: 'café — naïve', index: 1 },
            { name: '日本語テキスト', index: 2 },
            { name: 'emoji 🙂 line', index: 3 },
        ]
        const content = records.map((record) => JSON.stringify(record)).join('\n') + '\n'
        const filePath = write('utf8.ndjson', content)

        for (const chunkSize of [1, 2, 3, 7, 16, 1024]) {
            const lines: string[] = []
            forEachNdjsonLine(filePath, (line) => lines.push(line), chunkSize)
            expect(lines).toHaveLength(records.length)
            expect(lines.map((line) => JSON.parse(line))).toEqual(records)
        }
    })

    it('skips empty lines and missing files', () => {
        const filePath = write('mixed.ndjson', '\n{"a":1}\n\n{"a":2}')
        const lines: string[] = []
        forEachNdjsonLine(filePath, (line) => lines.push(line))
        expect(lines).toEqual(['{"a":1}', '{"a":2}'])

        const missing: string[] = []
        forEachNdjsonLine(path.join(dir, 'nope.ndjson'), (line) => missing.push(line))
        expect(missing).toEqual([])
    })
})

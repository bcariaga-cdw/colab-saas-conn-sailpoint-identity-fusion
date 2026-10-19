import * as fs from 'fs'

/** Default read chunk for streaming NDJSON scans (1 MiB). */
const READ_CHUNK_BYTES = 1024 * 1024
const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

/**
 * Counts non-empty lines in an NDJSON file without loading it into a single string.
 *
 * Record-mode api-logs can grow past Node's maximum string length (~512 MB), so
 * `fs.readFileSync(path, 'utf-8').split('\n')` is not safe for them.
 */
export function countNdjsonLines(filePath: string, chunkSize = READ_CHUNK_BYTES): number {
    if (!fs.existsSync(filePath)) return 0

    const buffer = Buffer.allocUnsafe(Math.max(1, chunkSize))
    let fd: number | undefined
    let count = 0
    let lineHasContent = false

    try {
        fd = fs.openSync(filePath, 'r')
        let bytesRead: number
        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            for (let i = 0; i < bytesRead; i++) {
                if (buffer[i] === NEWLINE) {
                    if (lineHasContent) count++
                    lineHasContent = false
                } else {
                    lineHasContent = true
                }
            }
        }
        if (lineHasContent) count++
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
    }

    return count
}

/**
 * Invokes `callback` for each non-empty line of an NDJSON file, reading in chunks.
 *
 * Decoding happens per complete line, so multi-byte UTF-8 characters split across
 * chunk boundaries are handled correctly and the file never becomes one big string.
 */
export function forEachNdjsonLine(
    filePath: string,
    callback: (line: string) => void,
    chunkSize = READ_CHUNK_BYTES
): void {
    if (!fs.existsSync(filePath)) return

    const buffer = Buffer.allocUnsafe(Math.max(1, chunkSize))
    let fd: number | undefined
    let pending = Buffer.alloc(0)

    const emit = (raw: Buffer): void => {
        if (raw.length === 0) return
        const line = raw[raw.length - 1] === CARRIAGE_RETURN ? raw.toString('utf-8', 0, raw.length - 1) : raw.toString('utf-8')
        if (line.length > 0) callback(line)
    }

    try {
        fd = fs.openSync(filePath, 'r')
        let bytesRead: number
        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            const chunk = Buffer.from(buffer.subarray(0, bytesRead))
            const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
            let start = 0
            for (let i = 0; i < data.length; i++) {
                if (data[i] !== NEWLINE) continue
                emit(data.subarray(start, i))
                start = i + 1
            }
            pending = Buffer.from(data.subarray(start))
        }
        emit(pending)
    } finally {
        if (fd !== undefined) fs.closeSync(fd)
    }
}

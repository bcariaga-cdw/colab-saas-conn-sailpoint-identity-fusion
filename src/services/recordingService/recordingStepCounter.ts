import * as fs from 'fs'
import * as path from 'path'
import { forEachNdjsonLine } from '../../utils/ndjson'

const LOCK_RETRIES = 200
const LOCK_DELAY_MS = 2

function sleepSync(ms: number): void {
    const end = Date.now() + ms
    while (Date.now() < end) {
        /* spin */
    }
}

function withRecordingLock<T>(recordingDir: string, fn: () => T): T {
    fs.mkdirSync(recordingDir, { recursive: true })
    const lockPath = path.join(recordingDir, '.recording.lock')
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
        try {
            const fd = fs.openSync(lockPath, 'wx')
            fs.closeSync(fd)
            try {
                return fn()
            } finally {
                fs.unlinkSync(lockPath)
            }
        } catch {
            sleepSync(LOCK_DELAY_MS)
        }
    }
    throw new Error(`Could not acquire recording lock for ${recordingDir}`)
}

/** Atomically reserves the next step index for a chain (safe across concurrent operations). */
export function allocateStepIndex(recordingDir: string): number {
    return withRecordingLock(recordingDir, () => {
        const counterPath = path.join(recordingDir, '.step-counter')
        let current = 0
        if (fs.existsSync(counterPath)) {
            current = parseInt(fs.readFileSync(counterPath, 'utf-8'), 10) || 0
        }
        current++
        fs.writeFileSync(counterPath, String(current))
        return current
    })
}

/** Seeds `.step-counter` from existing steps.ndjson when counter file is absent. */
export function bootstrapStepCounter(recordingDir: string, stepsFile: string): void {
    const counterPath = path.join(recordingDir, '.step-counter')
    if (fs.existsSync(counterPath) || !fs.existsSync(stepsFile)) return

    let max = 0
    forEachNdjsonLine(stepsFile, (line) => {
        try {
            const step = JSON.parse(line) as { stepId?: string }
            const match = step.stepId?.match(/^step-(\d+)$/)
            if (match) max = Math.max(max, parseInt(match[1], 10))
        } catch {
            /* skip malformed lines */
        }
    })
    if (max > 0) {
        fs.mkdirSync(recordingDir, { recursive: true })
        fs.writeFileSync(counterPath, String(max))
    }
}

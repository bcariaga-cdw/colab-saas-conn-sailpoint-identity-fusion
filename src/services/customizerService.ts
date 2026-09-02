import { Context } from '@sailpoint/connector-sdk'
import { LogService } from './logService'

/**
 * Invokes SaaS Connectivity customized operations.
 *
 * `customizedOperation` is not part of the SDK `Context` interface — the ISC runtime injects it
 * onto the context when a customizer artifact is attached to the source. It is therefore absent
 * under local `spcx run` and absent when no customizer is deployed, so every call is feature
 * detected rather than assumed.
 *
 * @see https://developer.sailpoint.com/docs/connectivity/saas-connectivity/customizers/customized-operation
 */
export class CustomizerService {
    constructor(
        private readonly context: Context | undefined,
        private readonly log: LogService
    ) {}

    /**
     * The runtime-injected invocation function, or undefined when no customizer is attached.
     * Not bound here — the runtime implementation may rely on `this` being the context.
     */
    private get operation(): ((operationId: string, input: unknown) => Promise<unknown>) | undefined {
        const fn = (this.context as Record<string, any> | undefined)?.customizedOperation
        return typeof fn === 'function' ? fn : undefined
    }

    /** Whether a customizer is attached and able to receive customized operations. */
    public get isAvailable(): boolean {
        return this.operation !== undefined
    }

    /**
     * Invoke a customized operation and return whatever the handler produced.
     *
     * Returns undefined when no customizer is attached, when no handler is registered for the
     * operation, or when the handler throws. Customizer failures are logged and swallowed:
     * callers run inside attribute-generation locks, so a broken customizer must never abort
     * the aggregation.
     *
     * @param operationId - The operation identifier the customizer registered a handler for
     * @param payload - Serializable input passed to the handler
     */
    public async invoke<T = unknown>(operationId: string, payload: unknown): Promise<T | undefined> {
        const operation = this.operation
        if (!operation) return undefined

        const start = Date.now()
        try {
            const result = await operation.call(this.context, operationId, payload)
            this.log.debug(`Customized operation ${operationId} completed in ${Date.now() - start} ms`)
            return result as T | undefined
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            this.log.error(`Customized operation ${operationId} failed, continuing without it: ${detail}`)
            return undefined
        }
    }
}

/** Customizer service for contexts that have none (tests, local runs, service defaults). */
export class NoopCustomizerService extends CustomizerService {
    constructor(log?: LogService) {
        super(undefined, log ?? ({ debug: () => {}, error: () => {} } as unknown as LogService))
    }
}

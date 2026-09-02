import { AttributeService } from '../attributeService'
import { CustomizerService } from '../../customizerService'
import { CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION, CUSTOMIZER_OP_BEFORE_UNIQUE_GENERATION } from '../constants'

/**
 * Coverage for the SaaS Connectivity customizer hooks around unique attribute generation.
 * The contract is override-only: a handler either supplies a replacement value or the
 * connector generates one exactly as it would without a customizer attached.
 */
describe('AttributeService unique generation customizer hooks', () => {
    const makeLog = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) as any

    const makeConfig = () =>
        ({
            attributeMaps: [],
            attributeMerge: 'first',
            sources: [{ name: 'HR' }],
            normalAttributeDefinitions: [],
            uniqueAttributeDefinitions: [
                {
                    name: 'uid',
                    expression: '$firstName',
                    case: 'same',
                    normalize: false,
                    spaces: false,
                    trim: true,
                },
            ],
            skipAccountsWithMissingId: false,
            forceAttributeRefresh: false,
        }) as any

    const makeSchemas = () =>
        ({
            listSchemaAttributeNames: jest.fn(() => ['id', 'name', 'uid']),
            getSchemaAttributes: jest.fn(() => [{ name: 'id' }, { name: 'name' }, { name: 'uid' }]),
            fusionIdentityAttribute: 'id',
            fusionDisplayAttribute: 'name',
        }) as any

    const createService = (customizer?: CustomizerService, log = makeLog()) => {
        const locks = {
            withLock: jest.fn(async (_key: string, fn: () => Promise<any>) => await fn()),
            waitForAllPendingOperations: jest.fn(async () => undefined),
        } as any

        const service = new AttributeService(
            makeConfig(),
            makeSchemas(),
            {} as any,
            log,
            locks,
            undefined,
            customizer as any
        )
        return { service, log }
    }

    const createFusionAccount = (firstName = 'John') => {
        const attributeBag = {
            current: { firstName },
            previous: {},
            identity: {},
            accounts: [],
            sources: new Map<string, Record<string, any>[]>([['HR', [{ firstName, source: { name: 'HR' } }]]]),
        }

        const fusionAccount: any = {
            type: 'managed',
            needsRefresh: true,
            needsReset: false,
            name: `${firstName}-account`,
            nativeIdentityOrUndefined: `native-${firstName}`,
            sourceName: 'HR',
            identityId: `identity-${firstName}`,
            originSource: 'HR',
            originAccountId: `origin-${firstName}`,
            fromIdentity: false,
            isIdentity: false,
            isManaged: true,
            previousAttributes: {},
            sources: ['HR'],
            history: [],
            importHistory: jest.fn(),
            attributeBag,
        }

        Object.defineProperty(fusionAccount, 'attributes', {
            get: () => attributeBag.current,
            set: (value: any) => {
                attributeBag.current = value
            },
        })

        return fusionAccount
    }

    /** Stub standing in for a customizer that is attached and answering. */
    const stubCustomizer = (invoke: jest.Mock) => ({ isAvailable: true, invoke }) as unknown as CustomizerService

    const registryFor = (service: AttributeService, name: string): Set<string> =>
        (service as any).getUniqueValues(name)

    describe('when no customizer is attached', () => {
        it('generates normally and never invokes a customized operation', async () => {
            const invoke = jest.fn()
            const { service } = createService({ isAvailable: false, invoke } as unknown as CustomizerService)
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('John')
            expect(invoke).not.toHaveBeenCalled()
        })

        it('defaults to a no-op customizer when the constructor argument is omitted', async () => {
            const locks = {
                withLock: jest.fn(async (_key: string, fn: () => Promise<any>) => await fn()),
                waitForAllPendingOperations: jest.fn(async () => undefined),
            } as any
            const service = new AttributeService(makeConfig(), makeSchemas(), {} as any, makeLog(), locks)
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('John')
        })
    })

    describe('BeforeUniqueGeneration', () => {
        it('uses a value returned on the payload and registers it for collision tracking', async () => {
            const invoke = jest.fn(async (operationId: string, payload: any) =>
                operationId === CUSTOMIZER_OP_BEFORE_UNIQUE_GENERATION ? { ...payload, value: 'jsmith' } : undefined
            )
            const { service } = createService(stubCustomizer(invoke))
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('jsmith')
            expect(registryFor(service, 'uid').has('jsmith')).toBe(true)
            // Short-circuits: the After hook never runs when Before supplied the value.
            expect(invoke).toHaveBeenCalledTimes(1)
        })

        it('accepts a bare string return', async () => {
            const invoke = jest.fn(async () => 'bare-string-value')
            const { service } = createService(stubCustomizer(invoke))
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('bare-string-value')
        })

        it('sends the attribute name and a sanitized, serializable payload', async () => {
            const invoke = jest.fn(async (_operationId: string, _payload: any) => undefined)
            const { service } = createService(stubCustomizer(invoke))
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            const [operationId, payload] = invoke.mock.calls[0]
            expect(operationId).toBe(CUSTOMIZER_OP_BEFORE_UNIQUE_GENERATION)
            expect(payload.attributeName).toBe('uid')
            expect(payload.definition.expression).toBe('$firstName')
            expect(payload.account.nativeIdentity).toBe('native-John')
            expect(payload.account.attributes.firstName).toBe('John')
            expect(payload.registeredValueCount).toBe(0)
            expect(payload.generatedValue).toBeUndefined()
            // `$isUnique` is a function installed on the render context and must not cross the boundary.
            expect(payload.renderContext.isUnique).toBeUndefined()
            expect(() => JSON.stringify(payload)).not.toThrow()
        })

        it.each([
            ['undefined', undefined],
            ['a non-string value', { value: 42 }],
            ['an empty string', { value: '   ' }],
            ['an unrelated object', { somethingElse: true }],
        ])('falls through to normal generation when the handler returns %s', async (_label, response) => {
            const invoke = jest.fn(async () => response)
            const { service } = createService(stubCustomizer(invoke))
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('John')
        })

        it('honours an already-registered value — the customizer is authoritative — and logs the reuse', async () => {
            const invoke = jest.fn(async (operationId: string) =>
                operationId === CUSTOMIZER_OP_BEFORE_UNIQUE_GENERATION ? { value: 'taken' } : undefined
            )
            const { service, log } = createService(stubCustomizer(invoke))
            service.registerExistingValues('uid', ['taken'])
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('taken')
            expect(log.info).toHaveBeenCalledWith(expect.stringContaining('reused already-registered value "taken"'))
        })
    })

    describe('AfterUniqueGeneration', () => {
        it('honours an already-registered replacement value', async () => {
            const invoke = jest.fn(async (operationId: string) =>
                operationId === CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION ? { value: 'taken' } : undefined
            )
            const { service } = createService(stubCustomizer(invoke))
            service.registerExistingValues('uid', ['taken'])
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('taken')
        })

        it('replaces the generated value and moves the registry reservation', async () => {
            const invoke = jest.fn(async (operationId: string, payload: any) =>
                operationId === CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION ? { ...payload, value: 'John.Doe' } : undefined
            )
            const { service } = createService(stubCustomizer(invoke))
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('John.Doe')
            const registry = registryFor(service, 'uid')
            expect(registry.has('John.Doe')).toBe(true)
            expect(registry.has('John')).toBe(false)
        })

        it('receives the connector-generated value in the payload', async () => {
            const invoke = jest.fn(async (_operationId: string, _payload: any) => undefined)
            const { service } = createService(stubCustomizer(invoke))
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            const afterCall = invoke.mock.calls.find(([id]) => id === CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION)
            expect(afterCall?.[1].generatedValue).toBe('John')
        })

        it('leaves a single registry entry when the handler returns the value unchanged', async () => {
            const invoke = jest.fn(async (operationId: string, payload: any) =>
                operationId === CUSTOMIZER_OP_AFTER_UNIQUE_GENERATION ? { ...payload, value: 'John' } : undefined
            )
            const { service } = createService(stubCustomizer(invoke))
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('John')
            expect([...registryFor(service, 'uid')]).toEqual(['John'])
        })
    })

    describe('failure isolation', () => {
        it('completes generation when the customizer throws, and logs the failure', async () => {
            const log = makeLog()
            const customizedOperation = jest.fn(async () => {
                throw new Error('boom')
            })
            const customizer = new CustomizerService({ customizedOperation } as any, log)
            const { service } = createService(customizer, log)
            const fusionAccount = createFusionAccount()

            await service.refreshUniqueAttributes(fusionAccount)

            expect(fusionAccount.attributes.uid).toBe('John')
            expect(customizedOperation).toHaveBeenCalled()
            expect(log.error).toHaveBeenCalledWith(expect.stringContaining('boom'))
        })
    })
})

describe('CustomizerService', () => {
    const makeLog = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }) as any

    it('reports unavailable and returns undefined when the runtime injected nothing', async () => {
        const service = new CustomizerService({} as any, makeLog())

        expect(service.isAvailable).toBe(false)
        await expect(service.invoke('AnyOperation', {})).resolves.toBeUndefined()
    })

    it('reports unavailable when there is no context at all', () => {
        expect(new CustomizerService(undefined, makeLog()).isAvailable).toBe(false)
    })

    it('forwards the operation id and payload, and returns the handler result', async () => {
        const customizedOperation = jest.fn(async (_id: string, input: any) => ({ ...input, value: 'ok' }))
        const service = new CustomizerService({ customizedOperation } as any, makeLog())

        const result = await service.invoke('MyOperation', { attributeName: 'uid' })

        expect(customizedOperation).toHaveBeenCalledWith('MyOperation', { attributeName: 'uid' })
        expect(result).toEqual({ attributeName: 'uid', value: 'ok' })
    })

    it('invokes with the context as `this` so runtime implementations relying on it work', async () => {
        const context: any = {
            marker: 'the-context',
            customizedOperation: jest.fn(function (this: any) {
                return Promise.resolve(this?.marker)
            }),
        }
        const service = new CustomizerService(context, makeLog())

        await expect(service.invoke('MyOperation', {})).resolves.toBe('the-context')
    })

    it('swallows handler errors and logs them', async () => {
        const log = makeLog()
        const service = new CustomizerService(
            {
                customizedOperation: async () => {
                    throw new Error('handler exploded')
                },
            } as any,
            log
        )

        await expect(service.invoke('MyOperation', {})).resolves.toBeUndefined()
        expect(log.error).toHaveBeenCalledWith(expect.stringContaining('handler exploded'))
    })
})

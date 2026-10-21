import { accountRead } from '../accountRead'
import { rebuildFusionAccount } from '../helpers/rebuildFusionAccount'
import { ConnectorError, ConnectorErrorType } from '@sailpoint/connector-sdk'
import type { Mock } from 'vitest'

vi.mock('../helpers/rebuildFusionAccount', () => ({
    rebuildFusionAccount: vi.fn(),
}))

import { createTestRegistry } from './harness/testRegistry'

function createRegistry() {
    const registry = createTestRegistry({
        sourceConfigs: [{ name: 'fusion', correlationMode: 'none' }],
    })

    const sources = registry.sources as any
    sources.fetchAllSources = vi.fn().mockResolvedValue(undefined)
    sources.fetchFusionAccounts = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(sources, 'fusionAccounts', { value: [], writable: true, configurable: true })

    const schemas = registry.schemas as any
    schemas.setFusionAccountSchema = vi.fn().mockResolvedValue(undefined)

    const fusion = registry.fusion as any
    fusion.getISCAccount = vi.fn().mockResolvedValue({ id: 'isc-1' })
    fusion.normalizePendingFormStateForOutput = vi.fn().mockResolvedValue(undefined)

    const log = registry.log as any
    log.crash = vi.fn()
    log.metric = vi.fn()
    log.detail = vi.fn()

    const definition = registry.definition as any
    definition.initializeCounters = vi.fn().mockResolvedValue(undefined)
    definition.hasMissingUniqueAttribute = vi.fn().mockReturnValue(false)
    definition.registerUniqueValuesFromManagedSourceAccounts = vi.fn()
    definition.refreshUniqueAttributes = vi.fn().mockResolvedValue(undefined)

    return registry
}

function mockCrashThrows(registry: ReturnType<typeof createRegistry>) {
    const log = registry.log as any
    log.crash = vi.fn((message: string) => {
        throw new ConnectorError(message, ConnectorErrorType.Generic)
    })
}

describe('accountRead', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    it('rebuilds and returns a single ISC account', async () => {
        const registry = createRegistry()
        const fusionAccount = { managedKey: 'fusion-1', name: 'Fusion User' }
        ;(rebuildFusionAccount as Mock).mockResolvedValue(fusionAccount)

        await accountRead(registry, { identity: 'fusion-1', schema: { attributes: [] } } as any)

        expect(registry.sources.fetchAllSources).toHaveBeenCalledTimes(1)
        expect(registry.schemas.setFusionAccountSchema).toHaveBeenCalledTimes(1)
        expect(rebuildFusionAccount).toHaveBeenCalledWith(
            'fusion-1',
            expect.any(Object),
            expect.objectContaining({
                fusion: expect.any(Object),
                identities: expect.any(Object),
                sources: expect.any(Object),
                log: expect.any(Object),
            }),
            true
        )
        expect(registry.fusion.normalizePendingFormStateForOutput).toHaveBeenCalledTimes(1)
        expect(registry.fusion.getISCAccount).toHaveBeenCalledWith(fusionAccount)
        expect(registry.definition.refreshUniqueAttributes).toHaveBeenCalledWith(fusionAccount)
        expect(registry.sources.fetchFusionAccounts).not.toHaveBeenCalled()
        expect(registry.res.send).toHaveBeenCalledWith({ id: 'isc-1' })
    })

    it('registers tenant unique values before calculating a blank unique attribute', async () => {
        const registry = createRegistry()
        const fusionAccount = { managedKey: 'fusion-1', name: 'Fusion User' }
        ;(rebuildFusionAccount as Mock).mockResolvedValue(fusionAccount)
        ;(registry.definition as any).hasMissingUniqueAttribute.mockReturnValue(true)
        ;(registry.sources as any).fusionAccounts = [{ attributes: { UID: 'taken' } }]

        await accountRead(registry, { identity: 'fusion-1', schema: { attributes: [] } } as any)

        expect(registry.definition.initializeCounters).toHaveBeenCalledTimes(1)
        expect(registry.sources.fetchFusionAccounts).toHaveBeenCalledTimes(1)
        expect(registry.definition.registerUniqueValuesFromManagedSourceAccounts).toHaveBeenCalledWith(
            (registry.sources as any).fusionAccounts
        )
        expect(registry.definition.refreshUniqueAttributes).toHaveBeenCalledWith(fusionAccount)
    })

    it('rejects when identity is missing', async () => {
        const registry = createRegistry()
        await expect(accountRead(registry, {} as any)).rejects.toBeTruthy()
    })

    it('fails with observable message when fusion account is not found', async () => {
        const registry = createRegistry()
        mockCrashThrows(registry)
        ;(rebuildFusionAccount as Mock).mockResolvedValue(undefined)

        await expect(
            accountRead(registry, { identity: 'missing-fusion', schema: { attributes: [] } } as any)
        ).rejects.toMatchObject({ message: 'Fusion account not found for identity: missing-fusion' })

        expect(registry.res.send).not.toHaveBeenCalled()
    })

    it('re-throws a ConnectorError when encountered', async () => {
        const registry = createRegistry()
        const error = new ConnectorError('Custom error', ConnectorErrorType.NotFound)
        registry.sources.fetchAllSources.mockRejectedValue(error)

        await expect(
            accountRead(registry, { identity: 'fusion-1', schema: { attributes: [] } } as any)
        ).rejects.toThrow(error)
        expect(registry.log.crash).not.toHaveBeenCalled()
    })

    it('crashes via log.crash when a non-ConnectorError is encountered', async () => {
        const registry = createRegistry()
        const error = new Error('Unexpected error')
        registry.sources.fetchAllSources.mockRejectedValue(error)

        await accountRead(registry, { identity: 'fusion-1', schema: { attributes: [] } } as any)
        expect(registry.log.crash).toHaveBeenCalledWith('Failed to read account fusion-1', error)
    })
})




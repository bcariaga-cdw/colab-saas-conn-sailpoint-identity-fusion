import { accountDisable } from '../accountDisable'
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

    const schemas = registry.schemas as any
    schemas.setFusionAccountSchema = vi.fn().mockResolvedValue(undefined)

    const fusion = registry.fusion as any
    fusion.preProcessFusionAccounts = vi.fn().mockResolvedValue([])
    fusion.getISCAccount = vi.fn().mockResolvedValue({ id: 'isc-disabled' })
    fusion.normalizePendingFormStateForOutput = vi.fn().mockResolvedValue(undefined)

    const log = registry.log as any
    log.crash = vi.fn()
    log.detail = vi.fn()

    const definition = registry.definition as any
    definition.initializeCounters = vi.fn().mockResolvedValue(undefined)
    definition.hasMissingUniqueAttribute = vi.fn().mockReturnValue(true)
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

describe('accountDisable', () => {
    afterEach(() => {
        vi.restoreAllMocks()
        vi.clearAllMocks()
    })

    it('disables a fusion account and returns updated ISC account', async () => {
        const registry = createRegistry()
        registry.fusion.getISCAccount.mockResolvedValue({ id: 'isc-disabled' })
        const fusionAccount = { managedKey: 'fusion-1', disable: vi.fn() }
        ;(rebuildFusionAccount as Mock).mockResolvedValue(fusionAccount)

        await accountDisable(registry, { identity: 'fusion-1', schema: { attributes: [] } } as any)

        expect(registry.sources.fetchAllSources).toHaveBeenCalledTimes(1)
        expect(registry.sources.fetchFusionAccounts).not.toHaveBeenCalled()
        expect(registry.fusion.preProcessFusionAccounts).not.toHaveBeenCalled()
        expect(registry.schemas.setFusionAccountSchema).toHaveBeenCalledTimes(1)
        expect(rebuildFusionAccount).toHaveBeenCalledWith(
            'fusion-1',
            expect.any(Object),
            expect.objectContaining({
                fusion: expect.any(Object),
                identities: expect.any(Object),
                sources: expect.any(Object),
                log: expect.any(Object),
            })
        )
        expect(registry.definition.refreshUniqueAttributes).toHaveBeenCalledWith(fusionAccount)
        expect(registry.definition.registerUniqueValuesFromManagedSourceAccounts).not.toHaveBeenCalled()
        expect(fusionAccount.disable).toHaveBeenCalledTimes(1)
        expect(registry.fusion.normalizePendingFormStateForOutput).toHaveBeenCalledTimes(1)
        expect(registry.res.send).toHaveBeenCalledWith({ id: 'isc-disabled' })
    })

    it('fails with observable message when fusion account is not found', async () => {
        const registry = createRegistry()
        mockCrashThrows(registry)
        ;(rebuildFusionAccount as Mock).mockResolvedValue(undefined)

        await expect(
            accountDisable(registry, { identity: 'missing-fusion', schema: { attributes: [] } } as any)
        ).rejects.toMatchObject({ message: 'Fusion account not found for identity: missing-fusion' })

        expect(registry.res.send).not.toHaveBeenCalled()
    })
})



import { setupPhase } from '../accountListPhases'
import { createOperationTestRegistry } from '../../__tests__/harness/operationTestRegistry'

describe('setupPhase reset flags', () => {
    function createRegistry() {
        return createOperationTestRegistry()
    }

    it('resetAccounts only clears accounts and exits', async () => {
        const registry = createRegistry()
        const fusion = registry.fusion as any
        fusion.isResetAccounts.mockReturnValue(true)
        fusion.isResetForms.mockReturnValue(false)

        const result = await setupPhase(registry, undefined, { isPersistent: true })

        expect(result).toBe(false)
        expect(registry.forms.deleteExistingForms).not.toHaveBeenCalled()
        expect(registry.sources.setProcessLock).not.toHaveBeenCalled()
        expect(registry.sources.removeProcessingAttribute).toHaveBeenCalled()
        expect(fusion.disableResetAccounts).toHaveBeenCalled()
        expect(fusion.disableResetForms).not.toHaveBeenCalled()
        expect(fusion.resetState).toHaveBeenCalled()
        expect(registry.sources.resetBatchCumulativeCount).toHaveBeenCalled()
    })

    it('resetForms only deletes forms and continues', async () => {
        const registry = createRegistry()
        const fusion = registry.fusion as any
        fusion.isResetAccounts.mockReturnValue(false)
        fusion.isResetForms.mockReturnValue(true)

        const result = await setupPhase(registry, undefined, { isPersistent: true })

        expect(result).toBe(true)
        expect(registry.sources.setProcessLock).toHaveBeenCalled()
        expect(registry.sources.removeProcessingAttribute).not.toHaveBeenCalled()
        expect(registry.forms.deleteExistingForms).toHaveBeenCalled()
        expect(fusion.disableResetForms).toHaveBeenCalled()
        expect(fusion.disableResetAccounts).not.toHaveBeenCalled()
        expect(fusion.resetState).not.toHaveBeenCalled()
        expect(registry.definition.initializeCounters).toHaveBeenCalled()
    })

    it('Both flags enabled deletes forms then resets accounts', async () => {
        const registry = createRegistry()
        const fusion = registry.fusion as any
        fusion.isResetAccounts.mockReturnValue(true)
        fusion.isResetForms.mockReturnValue(true)

        const result = await setupPhase(registry, undefined, { isPersistent: true })

        expect(result).toBe(false)
        expect(registry.sources.setProcessLock).not.toHaveBeenCalled()
        expect(registry.sources.removeProcessingAttribute).toHaveBeenCalled()
        expect(registry.forms.deleteExistingForms).toHaveBeenCalled()
        expect(fusion.disableResetForms).toHaveBeenCalled()
        expect(fusion.disableResetAccounts).toHaveBeenCalled()
        expect(fusion.resetState).toHaveBeenCalled()
    })

    it('neither flag skips reset side effects', async () => {
        const registry = createRegistry()
        const fusion = registry.fusion as any
        fusion.isResetAccounts.mockReturnValue(false)
        fusion.isResetForms.mockReturnValue(false)

        const result = await setupPhase(registry, undefined, { isPersistent: true })

        expect(result).toBe(true)
        expect(registry.sources.setProcessLock).toHaveBeenCalled()
        expect(registry.sources.removeProcessingAttribute).not.toHaveBeenCalled()
        expect(registry.forms.deleteExistingForms).not.toHaveBeenCalled()
        expect(fusion.disableResetAccounts).not.toHaveBeenCalled()
        expect(fusion.disableResetForms).not.toHaveBeenCalled()
        expect(fusion.resetState).not.toHaveBeenCalled()
    })

    it('Dry-run skips reset side effects', async () => {
        const registry = createRegistry()
        const fusion = registry.fusion as any
        fusion.isResetAccounts.mockReturnValue(true)
        fusion.isResetForms.mockReturnValue(true)

        const result = await setupPhase(registry, undefined, { isPersistent: false })

        expect(result).toBe(false)
        expect(registry.sources.setProcessLock).not.toHaveBeenCalled()
        expect(registry.sources.removeProcessingAttribute).not.toHaveBeenCalled()
        expect(registry.forms.deleteExistingForms).not.toHaveBeenCalled()
        expect(fusion.disableResetAccounts).not.toHaveBeenCalled()
        expect(fusion.disableResetForms).not.toHaveBeenCalled()
        expect(fusion.resetState).not.toHaveBeenCalled()
    })

    it('Dry-run skips reset side effects with resetForms only', async () => {
        const registry = createRegistry()
        const fusion = registry.fusion as any
        fusion.isResetAccounts.mockReturnValue(false)
        fusion.isResetForms.mockReturnValue(true)

        const result = await setupPhase(registry, undefined, { isPersistent: false })

        expect(result).toBe(true)
        expect(registry.sources.removeProcessingAttribute).not.toHaveBeenCalled()
        expect(registry.forms.deleteExistingForms).not.toHaveBeenCalled()
        expect(fusion.disableResetAccounts).not.toHaveBeenCalled()
        expect(fusion.disableResetForms).not.toHaveBeenCalled()
        expect(fusion.resetState).not.toHaveBeenCalled()
        expect(registry.definition.initializeCounters).toHaveBeenCalled()
    })
})

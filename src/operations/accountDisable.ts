import { ConnectorError, StdAccountDisableInput } from '@sailpoint/connector-sdk'
import { ServiceRegistry } from '../services/serviceRegistry'
import { rebuildFusionAccount } from './helpers/rebuildFusionAccount'
import { refreshBlankUniqueAttributes } from './helpers/refreshBlankUniqueAttributes'
import { assert } from '../utils/assert'
import { ATTR_OPS_REFRESH } from '../services/definitionService/types'

/**
 * Account disable operation - Disables a fusion account.
 *
 * Disabling does **not** reset unique attribute definitions (`resetDefinition: false`).
 * Existing unique values are preserved during disable. A subsequent enable operation
 * will set `resetDefinition: true`, triggering a full unique attribute regeneration
 * to ensure collision-free values after re-enabling.
 *
 * Processing Flow:
 * 1. SETUP: Load sources and schema
 * 2. REBUILD: Reconstruct the fusion account with refreshed mapped and generated attributes
 * 3. UNIQUE: Calculate blank unique attributes without resetting populated values
 * 4. DISABLE: Mark the fusion account as disabled
 * 5. OUTPUT: Generate and return the updated ISC account representation
 *
 * @param serviceRegistry - Service registry providing access to all connector services
 * @param input - SDK input containing the account identity to disable
 */
export const accountDisable = async (serviceRegistry: ServiceRegistry, input: StdAccountDisableInput) => {
    const { log, fusion, sources, schemas, definition, res, identities } = serviceRegistry

    try {
        log.detail({ identity: input.identity, action: 'disabling account' })
        assert(input.identity, 'Account identity is required')
        const timer = log.timer()

        log.stepStart('load-sources-schema')
        await sources.fetchAllSources()
        await schemas.setFusionAccountSchema(input.schema)
        log.stepEnd('load-sources-schema')

        log.stepStart('rebuild-fusion-account')
        const fusionAccount = await rebuildFusionAccount(input.identity, ATTR_OPS_REFRESH, {
            fusion,
            identities,
            sources,
            log,
        })
        assert(fusionAccount, `Fusion account not found for identity: ${input.identity}`)
        log.debug(`Found fusion account: ${fusionAccount.name || fusionAccount.managedKey}`)
        log.stepEnd('rebuild-fusion-account')

        log.stepStart('refresh-unique-attributes')
        await refreshBlankUniqueAttributes(fusionAccount, { definition, sources, log }, false)
        log.stepEnd('refresh-unique-attributes')

        log.stepStart('disable-fusion-account')
        fusionAccount.disable()
        log.stepEnd('disable-fusion-account')

        log.stepStart('generate-account')
        await fusion.normalizePendingFormStateForOutput()
        const iscAccount = await fusion.getISCAccount(fusionAccount)
        assert(iscAccount, 'Failed to generate ISC account from fusion account')
        log.stepEnd('generate-account')

        res.send(iscAccount)
        timer.end(`✓ Account disable completed for ${input.identity}`)
    } catch (error) {
        if (error instanceof ConnectorError) throw error
        log.crash(`Failed to disable account ${input.identity}`, error)
    }
}

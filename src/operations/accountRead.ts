import { ConnectorError, StdAccountReadInput } from '@sailpoint/connector-sdk'
import { ServiceRegistry } from '../services/serviceRegistry'
import { rebuildFusionAccount } from './helpers/rebuildFusionAccount'
import { refreshBlankUniqueAttributes } from './helpers/refreshBlankUniqueAttributes'
import { assert } from '../utils/assert'
import { ATTR_OPS_REFRESH } from '../services/definitionService/types'

/**
 * Account read operation - Reads a single fusion account by identity.
 *
 * Rebuilds the fusion account with freshly mapped and generated attributes
 * to ensure the returned data reflects the current state of all source accounts.
 *
 * Processing Flow:
 * 1. SETUP: Load sources and schema
 * 2. REBUILD: Reconstruct the fusion account with refreshed attributes
 * 3. UNIQUE: Calculate blank unique attributes without resetting populated values
 * 4. OUTPUT: Generate and return the ISC account representation
 *
 * @param serviceRegistry - Service registry providing access to all connector services
 * @param input - SDK input containing the account identity to read
 */
export const accountRead = async (serviceRegistry: ServiceRegistry, input: StdAccountReadInput) => {
    const { log, fusion, schemas, sources, definition, res, identities } = serviceRegistry

    try {
        log.detail({ identity: input.identity, action: 'reading account' })
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
        }, true)
        assert(fusionAccount, `Fusion account not found for identity: ${input.identity}`)
        log.debug(`Found fusion account: ${fusionAccount.name || fusionAccount.managedKey}`)
        log.stepEnd('rebuild-fusion-account')

        log.stepStart('refresh-unique-attributes')
        await refreshBlankUniqueAttributes(fusionAccount, { definition, sources, log }, true)
        log.stepEnd('refresh-unique-attributes')

        log.stepStart('generate-account')
        await fusion.normalizePendingFormStateForOutput()
        const iscAccount = await fusion.getISCAccount(fusionAccount)
        assert(iscAccount, 'Failed to generate ISC account from fusion account')
        log.stepEnd('generate-account')

        res.send(iscAccount)
        timer.end(`✓ Account read completed for ${input.identity}`)
    } catch (error) {
        if (error instanceof ConnectorError) throw error
        log.crash(`Failed to read account ${input.identity}`, error)
    }
}


import type { FusionAccount } from '../../model/account'
import type { DefinitionService } from '../../services/definitionService'
import type { LogService } from '../../services/logService'
import type { SourceService } from '../../services/sourceService'

/**
 * Calculates blank Unique attributes without resetting values that already exist.
 *
 * When `registerTenantUniqueValues` is true and a Unique attribute is blank, Fusion
 * accounts are loaded and their Unique values are registered first so generation
 * does not collide with another account. Callers that must not fetch every Fusion
 * account (account disable) pass false.
 */
export async function refreshBlankUniqueAttributes(
    fusionAccount: FusionAccount,
    services: {
        definition: DefinitionService
        sources: SourceService
        log: LogService
    },
    registerTenantUniqueValues: boolean
): Promise<void> {
    const { definition, sources, log } = services
    await definition.initializeCounters()
    if (registerTenantUniqueValues && definition.hasMissingUniqueAttribute(fusionAccount)) {
        log.detail({ action: 'registering unique values before blank unique refresh' })
        await sources.fetchFusionAccounts()
        definition.registerUniqueValuesFromManagedSourceAccounts(sources.fusionAccounts)
    }
    await definition.refreshUniqueAttributes(fusionAccount)
}

/**
 * connector-spec.json -> Source Settings -> Processing Control
 */
import { extractBoolean } from '../../../utils/attributes'
import type { ProcessingControlSection } from '../../../model/config'

export const connectorSpecInitialValues = {
    maxHistoryMessages: 10,
} as const

export const runtimeDefaults = {
    deleteEmpty: false,
    skipAccountsWithMissingId: false,
    promoteMainAccountWhenOriginMissing: false,
    maxHistoryMessages: connectorSpecInitialValues.maxHistoryMessages,
} as const

export function readSettings(raw: Record<string, unknown>): ProcessingControlSection {
    return {
        deleteEmpty: extractBoolean(raw, 'deleteEmpty') ?? runtimeDefaults.deleteEmpty,
        skipAccountsWithMissingId:
            extractBoolean(raw, 'skipAccountsWithMissingId') ?? runtimeDefaults.skipAccountsWithMissingId,
        promoteMainAccountWhenOriginMissing:
            extractBoolean(raw, 'promoteMainAccountWhenOriginMissing') ??
            runtimeDefaults.promoteMainAccountWhenOriginMissing,
        maxHistoryMessages: (raw.maxHistoryMessages as number | undefined) ?? runtimeDefaults.maxHistoryMessages,
        cascadeAggregationEnabled: raw.cascadeAggregationEnabled as boolean | undefined,
    }
}

import * as advancedConnectionSettings from './settings/advancedConnectionSettings'
import * as attributeMappingDefinitionsSettings from './settings/attributeMappingDefinitionsSettings'
import * as connectionSettings from './settings/connectionSettings'
import * as developerSettings from './settings/developerSettings'
import * as externalSettings from './settings/externalSettings'
import * as matchingSettings from './settings/matchingSettings'
import * as normalAttributeDefinitionsSettings from './settings/normalAttributeDefinitionsSettings'
import * as processingControlSettings from './settings/processingControlSettings'
import * as reviewSettings from './settings/reviewSettings'
import * as scopeSettings from './settings/scopeSettings'
import * as sourcesSettings from './settings/sourcesSettings'
import * as uniqueAttributeDefinitionsSettings from './settings/uniqueAttributeDefinitionsSettings'

export const connectorSpecInitialValues = {
    ...connectionSettings.connectorSpecInitialValues,
    fusionFormExpirationDays: reviewSettings.connectorSpecInitialValues.fusionFormExpirationDays,
    fusionManualReviewScore: matchingSettings.connectorSpecInitialValues.fusionManualReviewScore,
    provisioningTimeout: advancedConnectionSettings.connectorSpecInitialValues.provisioningTimeout,
    fusionMaxCandidatesForForm: reviewSettings.connectorSpecInitialValues.fusionMaxCandidatesForForm,
    defaultLanguage: reviewSettings.connectorSpecInitialValues.defaultLanguage,
    ...scopeSettings.connectorSpecInitialValues,
    ...processingControlSettings.connectorSpecInitialValues,
    ...attributeMappingDefinitionsSettings.connectorSpecInitialValues,
    maxRetries: advancedConnectionSettings.connectorSpecInitialValues.maxRetries,
    requestsPerSecond: advancedConnectionSettings.connectorSpecInitialValues.requestsPerSecond,
    maxConcurrentRequests: advancedConnectionSettings.connectorSpecInitialValues.maxConcurrentRequests,
    parallelBatchSize: advancedConnectionSettings.connectorSpecInitialValues.parallelBatchSize,
    processingWait: advancedConnectionSettings.connectorSpecInitialValues.processingWait,
    heartbeatInterval: advancedConnectionSettings.connectorSpecInitialValues.heartbeatInterval,
    ...developerSettings.connectorSpecInitialValues,
    ...externalSettings.connectorSpecInitialValues,
    ...uniqueAttributeDefinitionsSettings.connectorSpecInitialValues,
    ...normalAttributeDefinitionsSettings.connectorSpecInitialValues,
    algorithm: matchingSettings.connectorSpecInitialValues.algorithm,
    enablePriority: matchingSettings.connectorSpecInitialValues.enablePriority,
    ...sourcesSettings.connectorSpecInitialValues,
} as const

export const runtimeDefaults = {
    ...connectorSpecInitialValues,
    source: sourcesSettings.runtimeDefaults.source,
    ...processingControlSettings.runtimeDefaults,
    ...matchingSettings.runtimeDefaults,
    ...developerSettings.runtimeDefaults,
    ...advancedConnectionSettings.runtimeDefaults,
    ...scopeSettings.runtimeDefaults,
    ...externalSettings.runtimeDefaults,
    ...reviewSettings.runtimeDefaults,
    ...attributeMappingDefinitionsSettings.runtimeDefaults,
    ...uniqueAttributeDefinitionsSettings.runtimeDefaults,
} as const

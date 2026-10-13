#!/usr/bin/env node
/**
 * Recommend ISC PAT scopes from an exported Fusion source config JSON.
 *
 * Usage:
 *   node scripts/recommend-pat-scopes.cjs path/to/source-config.json
 *   npm run pat-scopes:recommend -- path/to/source-config.json
 *
 * Accepts flat Fusion connector config objects or ISC exports with a
 * `connectorAttributes` array of { key, value } pairs.
 */

const fs = require('fs')
const path = require('path')

const CORE_MINIMUM = [
    'idn:accounts:manage',
    'sp:search:read',
    'idn:sources:manage',
    'idn:source-schema:manage',
]

const CONDITIONAL = {
    'idn:accounts-state:manage': 'Orphan disable non-matching accounts',
    'idn:mis-account:manage': 'Orphan Ownership mode (PATCH machine-account ownerIdentity)',
    'idn:identity:read': 'Match review, report email, or global reviewers (GET /identities/{id} for email)',
    'idn:identity-profile-attribute:read': 'Include identities in the scope (Discover Schema lists identity attributes)',
    'idn:task-management:read': 'aggregationMode: before on any managed source',
    'sp:forms:manage': 'Match step enabled (matching rules configured)',
    'sp:workflow:manage': 'Review or report email, or delayed aggregation',
    'sp:workflow-execute:external': 'Review or report email, or delayed aggregation',
    'idn:workgroup:read': 'Global reviewers, report recipients, or Fusion source governance group / workgroup',
    'idn:identity-profile:manage': 'correlationMode: reverse on any managed source',
    'idn:identity-profile-attribute:manage': 'correlationMode: reverse on any managed source',
}

function flattenConnectorAttributes(raw) {
    if (!raw || typeof raw !== 'object') {
        return {}
    }
    if (Array.isArray(raw.connectorAttributes)) {
        const flat = {}
        for (const entry of raw.connectorAttributes) {
            if (entry && entry.key != null) {
                flat[entry.key] = entry.value
            }
        }
        return flat
    }
    return raw
}

function parseSources(config) {
    const sources = config.sources
    if (Array.isArray(sources)) {
        return sources
    }
    if (typeof sources === 'string') {
        try {
            const parsed = JSON.parse(sources)
            return Array.isArray(parsed) ? parsed : []
        } catch {
            return []
        }
    }
    return []
}

function matchEnabled(config) {
    const rules = config.matchingConfigs ?? config.fusionAttributeMatches
    if (Array.isArray(rules) && rules.length > 0) {
        return true
    }
    return config.fusionManualReviewScore != null && config.fusionManualReviewScore !== ''
}

function delayedAggregationEnabled(sources) {
    return sources.some((s) => s && s.aggregationMode === 'delayed')
}

function beforeAggregationEnabled(sources) {
    return sources.some((s) => s && s.aggregationMode === 'before')
}

function reverseCorrelationEnabled(sources) {
    return sources.some((s) => s && s.correlationMode === 'reverse')
}

function orphanDisableEnabled(sources) {
    return sources.some((s) => s && s.disableNonMatchingAccounts === true)
}

function orphanOwnershipEnabled(sources) {
    return sources.some(
        (s) => s && s.sourceType === 'orphan' && s.orphanProcessingMode === 'ownership'
    )
}

function reportEmailEnabled(config) {
    return config.fusionReportOnAggregation === true
}

function workflowFeaturesEnabled(config, sources) {
    return reportEmailEnabled(config) || matchEnabled(config) || delayedAggregationEnabled(sources)
}

function globalReviewerEnabled(config) {
    return config.fusionOwnerIsGlobalReviewer === true || config.ownersAreGlobalReviewers === true
}

function identitiesInScope(config) {
    return config.includeIdentities !== false
}

function addConditional(conditional, reasons, scope) {
    if (conditional.has(scope)) return
    conditional.add(scope)
    reasons.push([scope, CONDITIONAL[scope]])
}

function recommend(configPath) {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    const config = flattenConnectorAttributes(raw)
    const sources = parseSources(config)

    const conditional = new Set()
    const reasons = []

    if (orphanDisableEnabled(sources)) {
        addConditional(conditional, reasons, 'idn:accounts-state:manage')
    }
    if (orphanOwnershipEnabled(sources)) {
        addConditional(conditional, reasons, 'idn:mis-account:manage')
    }
    if (beforeAggregationEnabled(sources)) {
        addConditional(conditional, reasons, 'idn:task-management:read')
    }
    if (matchEnabled(config)) {
        addConditional(conditional, reasons, 'sp:forms:manage')
    }
    if (workflowFeaturesEnabled(config, sources)) {
        addConditional(conditional, reasons, 'sp:workflow:manage')
        addConditional(conditional, reasons, 'sp:workflow-execute:external')
    }
    if (globalReviewerEnabled(config) || reportEmailEnabled(config)) {
        addConditional(conditional, reasons, 'idn:workgroup:read')
    }
    if (matchEnabled(config) || reportEmailEnabled(config) || globalReviewerEnabled(config)) {
        addConditional(conditional, reasons, 'idn:identity:read')
    }
    if (reverseCorrelationEnabled(sources)) {
        addConditional(conditional, reasons, 'idn:identity-profile:manage')
        addConditional(conditional, reasons, 'idn:identity-profile-attribute:manage')
    } else if (identitiesInScope(config)) {
        addConditional(conditional, reasons, 'idn:identity-profile-attribute:read')
    }

    const mapDefineOnly =
        !matchEnabled(config) &&
        !delayedAggregationEnabled(sources) &&
        !beforeAggregationEnabled(sources) &&
        !reverseCorrelationEnabled(sources) &&
        !orphanDisableEnabled(sources) &&
        !orphanOwnershipEnabled(sources) &&
        !globalReviewerEnabled(config) &&
        !reportEmailEnabled(config)

    const recommended = [...new Set([...CORE_MINIMUM, ...conditional])]

    return { configPath, mapDefineOnly, recommended, conditional: [...conditional], reasons }
}

function main() {
    const configPath = process.argv[2]
    if (!configPath) {
        console.error('Usage: node scripts/recommend-pat-scopes.cjs <source-config.json>')
        process.exit(1)
    }
    const resolved = path.resolve(configPath)
    if (!fs.existsSync(resolved)) {
        console.error(`File not found: ${resolved}`)
        process.exit(1)
    }

    const result = recommend(resolved)

    console.log(`# PAT scope recommendation for ${path.basename(resolved)}`)
    console.log('')
    if (result.mapDefineOnly) {
        console.log('Deployment pattern: Map/Define side-car (core minimum plus identity-attribute list when identities are in scope)')
    } else {
        console.log('Deployment pattern: Match or extended features (core minimum + detected conditionals)')
    }
    console.log('')
    console.log('## Recommended scopes')
    console.log('')
    for (const scope of result.recommended) {
        console.log(scope)
    }
    if (result.reasons.length > 0) {
        console.log('')
        console.log('## Conditional scopes detected')
        console.log('')
        const seen = new Set()
        for (const [scope, reason] of result.reasons) {
            if (seen.has(scope)) continue
            seen.add(scope)
            console.log(`- \`${scope}\` — ${reason}`)
        }
    }
    console.log('')
    console.log('See docs/reference/pat-scopes.md for scope-by-scope rationale.')
}

main()

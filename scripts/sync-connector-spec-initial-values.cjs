/**
 * Writes connector-spec.json -> sourceConfigInitialValues from per-settings modules under
 * `src/data/config/settings`, each exporting a flat `connectorSpecInitialValues` object.
 * Composition mirrors `src/data/config/defaults.ts` exactly.
 */
const fs = require('fs')
const path = require('path')

const repoRoot = path.join(__dirname, '..')
const specPath = path.join(repoRoot, 'connector-spec.json')
const settingsDir = path.join(repoRoot, 'src', 'data', 'config', 'settings')

function extractExportConstObjectLiteral(source, exportName) {
    const marker = `export const ${exportName} = `
    const start = source.indexOf(marker)
    if (start === -1) {
        throw new Error(`Could not find ${marker.trim()} in source`)
    }
    let i = start + marker.length
    while (i < source.length && /\s/.test(source[i])) i++
    if (source[i] !== '{') {
        throw new Error(`Expected \`{\` after export const ${exportName} =`)
    }
    const objStart = i
    let depth = 0
    for (; i < source.length; i++) {
        const c = source[i]
        if (c === '{') depth++
        else if (c === '}') {
            depth--
            if (depth === 0) return source.slice(objStart, i + 1)
        }
    }
    throw new Error(`Unclosed \`{\` in ${exportName}`)
}

function stripTrailingCommas(tsObjectLiteral) {
    return tsObjectLiteral.replace(/,(\s*[}\]])/g, '$1')
}

function parseNamedImports(source) {
    const imports = new Map()
    const importRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g
    let m
    while ((m = importRegex.exec(source))) {
        const rawSpecifiers = m[1]
        const modulePath = m[2]
        for (const raw of rawSpecifiers.split(',')) {
            const spec = raw.trim()
            if (!spec) continue
            const aliasMatch = spec.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/)
            if (aliasMatch) {
                imports.set(aliasMatch[2], modulePath)
            } else {
                imports.set(spec, modulePath)
            }
        }
    }
    return imports
}

const enumMemberValueCache = new Map()
function resolveEnumMemberValue(enumName, memberName, context) {
    const cacheKey = `${context.tsPath}::${enumName}.${memberName}`
    if (enumMemberValueCache.has(cacheKey)) {
        return enumMemberValueCache.get(cacheKey)
    }

    const modulePath = context.imports.get(enumName)
    if (!modulePath) return undefined

    const resolvedModulePath = path.resolve(path.dirname(context.tsPath), modulePath)
    const candidatePaths = [`${resolvedModulePath}.ts`, path.join(resolvedModulePath, 'index.ts')]
    const enumFilePath = candidatePaths.find((p) => fs.existsSync(p))
    if (!enumFilePath) return undefined

    const enumSource = fs.readFileSync(enumFilePath, 'utf8')
    const enumBlockRegex = new RegExp(`export\\s+enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`, 'm')
    const enumBlockMatch = enumSource.match(enumBlockRegex)
    if (!enumBlockMatch) return undefined

    const body = enumBlockMatch[1]
    const stringMemberRegex = new RegExp(`\\b${memberName}\\b\\s*=\\s*(['"])((?:\\\\.|(?!\\1)[^\\\\])*)\\1`)
    const stringMatch = body.match(stringMemberRegex)
    if (stringMatch) {
        enumMemberValueCache.set(cacheKey, stringMatch[2])
        return stringMatch[2]
    }

    const numberMemberRegex = new RegExp(`\\b${memberName}\\b\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`)
    const numberMatch = body.match(numberMemberRegex)
    if (numberMatch) {
        const numericValue = Number(numberMatch[1])
        enumMemberValueCache.set(cacheKey, numericValue)
        return numericValue
    }

    return undefined
}

function tsValueToJson(valueSlice, context) {
    const v = valueSlice.trim()
    if (v === 'true' || v === 'false' || v === 'null') return v
    if (/^-?\d+(\.\d+)?$/.test(v)) return v
    if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
        return JSON.stringify(v.slice(1, -1))
    }
    const enumMemberMatch = v.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
    if (enumMemberMatch) {
        const resolved = resolveEnumMemberValue(enumMemberMatch[1], enumMemberMatch[2], context)
        if (resolved !== undefined) return JSON.stringify(resolved)
    }
    throw new Error(`Unsupported literal in connector spec fragment: ${v.slice(0, 80)}`)
}

function objectLiteralToJson(tsObjectLiteral, context) {
    const inner = tsObjectLiteral.trim().slice(1, -1)
    const out = {}
    let pos = 0
    while (pos < inner.length) {
        while (pos < inner.length && /\s|,/.test(inner[pos])) pos++
        if (pos >= inner.length) break

        let keyEnd = pos
        let key
        if (inner[pos] === "'" || inner[pos] === '"') {
            const q = inner[pos]
            keyEnd = pos + 1
            while (keyEnd < inner.length && inner[keyEnd] !== q) {
                if (inner[keyEnd] === '\\') keyEnd++
                keyEnd++
            }
            key = inner.slice(pos + 1, keyEnd)
            keyEnd++
        } else {
            while (keyEnd < inner.length && /[\w$]/.test(inner[keyEnd])) keyEnd++
            key = inner.slice(pos, keyEnd)
        }

        while (keyEnd < inner.length && /\s/.test(inner[keyEnd])) keyEnd++
        if (inner[keyEnd] !== ':') {
            throw new Error(`Expected ':' after key near: ${inner.slice(pos, pos + 40)}`)
        }
        keyEnd++
        while (keyEnd < inner.length && /\s/.test(inner[keyEnd])) keyEnd++

        let valEnd = keyEnd
        if (inner[valEnd] === "'" || inner[valEnd] === '"') {
            const q = inner[valEnd]
            valEnd++
            while (valEnd < inner.length && inner[valEnd] !== q) {
                if (inner[valEnd] === '\\') valEnd++
                valEnd++
            }
            valEnd++
        } else {
            while (valEnd < inner.length && !/[\s,]/.test(inner[valEnd])) valEnd++
        }

        const rawVal = inner.slice(keyEnd, valEnd)
        let tail = valEnd
        while (tail < inner.length && /\s/.test(inner[tail])) tail++
        if (inner.slice(tail, tail + 2) === 'as') {
            const m = inner.slice(tail).match(/^as\s+const\b/)
            if (m) tail += m[0].length
        }
        while (tail < inner.length && /\s/.test(inner[tail])) tail++
        if (inner[tail] === ',') tail++

        out[key] = JSON.parse(tsValueToJson(rawVal, context))
        pos = tail
    }
    return out
}

const parsedCache = new Map()
function loadInitialValues(fileName) {
    if (parsedCache.has(fileName)) return parsedCache.get(fileName)
    const tsPath = path.join(settingsDir, fileName)
    const source = fs.readFileSync(tsPath, 'utf8')
    const context = {
        tsPath,
        imports: parseNamedImports(source),
    }
    const literal = stripTrailingCommas(extractExportConstObjectLiteral(source, 'connectorSpecInitialValues'))
    const parsed = objectLiteralToJson(literal, context)
    parsedCache.set(fileName, parsed)
    return parsed
}

const connection = loadInitialValues('connectionSettings.ts')
const review = loadInitialValues('reviewSettings.ts')
const matching = loadInitialValues('matchingSettings.ts')
const advancedConnection = loadInitialValues('advancedConnectionSettings.ts')
const scope = loadInitialValues('scopeSettings.ts')
const processing = loadInitialValues('processingControlSettings.ts')
const attributeMapping = loadInitialValues('attributeMappingDefinitionsSettings.ts')
const developer = loadInitialValues('developerSettings.ts')
const external = loadInitialValues('externalSettings.ts')
const uniqueDefs = loadInitialValues('uniqueAttributeDefinitionsSettings.ts')
const normalDefs = loadInitialValues('normalAttributeDefinitionsSettings.ts')
const sources = loadInitialValues('sourcesSettings.ts')

const merged = {
    ...connection,
    fusionFormExpirationDays: review.fusionFormExpirationDays,
    fusionManualReviewScore: matching.fusionManualReviewScore,
    provisioningTimeout: advancedConnection.provisioningTimeout,
    fusionMaxCandidatesForForm: review.fusionMaxCandidatesForForm,
    defaultLanguage: review.defaultLanguage,
    ...scope,
    ...processing,
    ...attributeMapping,
    maxRetries: advancedConnection.maxRetries,
    requestsPerSecond: advancedConnection.requestsPerSecond,
    maxConcurrentRequests: advancedConnection.maxConcurrentRequests,
    parallelBatchSize: advancedConnection.parallelBatchSize,
    processingWait: advancedConnection.processingWait,
    heartbeatInterval: advancedConnection.heartbeatInterval,
    ...developer,
    ...external,
    ...uniqueDefs,
    ...normalDefs,
    algorithm: matching.algorithm,
    enablePriority: matching.enablePriority,
    ...sources,
}

const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'))
spec.sourceConfigInitialValues = merged
fs.writeFileSync(specPath, JSON.stringify(spec, null, 4) + '\n', 'utf8')




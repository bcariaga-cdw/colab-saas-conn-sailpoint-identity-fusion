import { JsonPatchOperationV2025OpV2025, SourcesV2025ApiUpdateSourceRequest } from 'sailpoint-api-client'

/**
 * Builds a JSON Patch request to upsert a value under `/connectorAttributes/`
 * on an ISC source. Uses `op: 'add'` for upsert semantics (creates if missing,
 * replaces if present -- RFC 6902).
 */
export function buildSourceConfigPatch(sourceId: string, path: string, value: any): SourcesV2025ApiUpdateSourceRequest {
    return {
        id: sourceId,
        jsonPatchOperationV2025: [
            {
                op: 'add' as JsonPatchOperationV2025OpV2025,
                path,
                value,
            },
        ],
    }
}

/**
 * Builds a JSON Patch request that deletes one connector attribute path.
 * `op: 'remove'` fails when the path is absent, so callers must check first.
 */
export function buildSourceConfigRemove(sourceId: string, path: string): SourcesV2025ApiUpdateSourceRequest {
    return {
        id: sourceId,
        jsonPatchOperationV2025: [
            {
                op: 'remove' as JsonPatchOperationV2025OpV2025,
                path,
            },
        ],
    }
}

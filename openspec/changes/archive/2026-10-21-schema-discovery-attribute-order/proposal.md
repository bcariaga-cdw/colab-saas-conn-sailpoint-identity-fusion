## Why

Schema discovery builds the Fusion account schema by merging attributes from several sources, then deduplicating case-insensitively and keeping the first variant. Today that merge order is an implicit side effect of code ordering: managed source attributes are pushed before attribute mappings and definitions, so an auto-discovered source attribute silently wins a name collision against a user-configured mapping or definition. Operators get an unexpected description, type, or cardinality on a name they explicitly configured. Making the precedence explicit — definitions, then mappings, then managed account source schemas, then identity schema when identity scope is enabled — makes discovery deterministic, gives user configuration the priority it deserves, and turns the order into a tested, documented contract.

## What Changes

**Dynamic schema attribute-source order**
- From: `buildDynamicSchema` pushes fusion base → managed sources → identity → mappings → definitions → reverse-correlation; first-wins dedupe means a managed source attribute outranks a mapping or definition with the same logical name.
- To: `buildDynamicSchema` pushes fusion base → **attribute definitions → attribute mappings → managed account source schemas → identity schema (when identity scope is enabled)** → reverse-correlation; first-wins dedupe means user-configured attributes outrank auto-discovered ones.
- Reason: The precedence is currently accidental and can override explicit configuration.
- Impact: Non-breaking for schemas with no case-insensitive collisions; behavior change only when a mapping/definition name collides with a managed source or identity attribute name. Affects connector operators who rely on discovery output.

**Spec contract**
- From: the `schema-service` and `account-discover-schema-operation` specs do not state an attribute-source order.
- To: both specs state the order and the identity-scope condition, so the sequence is verifiable.
- Reason: An implicit order cannot be reviewed, tested, or relied on.
- Impact: Non-breaking; documentation and contract clarity only.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `schema-service`: add a requirement defining the attribute-source precedence order `buildDynamicSchema` uses before case-insensitive deduplication.
- `account-discover-schema-operation`: update the "Schema discovery returns account schema" requirement to state the source order and the identity-scope condition.

## Impact

- **Code:** `src/services/schemaService/schemaService.ts` (`buildDynamicSchema` push order).
- **Tests:** `src/services/schemaService/__tests__/schemaService.test.ts` (new collision-precedence cases).
- **Docs:** `docs/operations/account-discover-schema.md` (merge-order step).
- **Changelog:** `CHANGELOG.md` entry under Fixed/Changed.
- **APIs/systems:** none. No ISC contract change; discovery output shape is unchanged when no case-insensitive names collide.

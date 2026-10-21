## Context

`accountDiscoverSchema` calls `sources.fetchAllSources()` then `schemas.buildDynamicSchema()`. `buildDynamicSchema` collects candidate `SchemaAttribute` objects from several sources into one array and finishes with `dedupeSchemaAttributesByName`, which keeps the **first** case-insensitive variant and drops later ones. Because dedupe is first-wins, the push order is the precedence order.

The current push order is fusion base attributes → managed account source schemas → identity schema attributes → attribute mappings → attribute definitions → reverse-correlation attributes. That ordering is incidental, and it means an auto-discovered managed source attribute outranks a user-configured attribute mapping or definition with the same logical name. This change makes the precedence intentional and part of the connector's spec contract.

Constraints:
- The dedupe algorithm is unchanged (case-insensitive, first-wins) and must stay in `dedupeSchemaAttributesByName`.
- The schema-ingestion path (`setFusionAccountSchema`) is unchanged.
- Discovery must keep working when the identity fetch fails (log and continue).

## Goals / Non-Goals

**Goals:**
- Make `buildDynamicSchema` collect attributes in the order: attribute definitions → attribute mappings → managed account source schemas → identity schema attributes (when identity scope is enabled).
- Give user-configured attributes (definitions, mappings) precedence over auto-discovered ones on case-insensitive name collisions, with definitions outranking mappings.
- Encode the order in the `schema-service` and `account-discover-schema-operation` specs and cover it with tests.

**Non-Goals:**
- Changing the dedupe algorithm or its first-wins semantics.
- Reordering attributes *within* a single source's attribute list.
- Moving fusion base structural attributes or reverse-correlation attributes.
- Changing the schema-ingestion path or the ISC wire contract.

## Decisions

### D1: Push order is the precedence contract

- **Choice**: Reorder the `pushAttribute` calls in `buildDynamicSchema` to fusion base → attribute definitions → attribute mappings → managed account source schemas → identity schema attributes → reverse-correlation attributes.
- **Reason**: Dedupe keeps the first variant, so making the push order explicit is the smallest change that produces the required precedence. It touches one method and needs no new data structures.
- **Considered alternatives**: (a) Give `dedupeSchemaAttributesByName` an explicit per-source priority parameter — rejected: more surface area than the requirement needs and changes the shared helper. (b) Sort the merged array by source rank before dedupe — rejected: equivalent outcome, but a sort obscures the intended sequence compared with an ordered push.

### D2: Identity schema attributes come last among the four, and only when identity scope is enabled

- **Choice**: Keep the identity fetch guarded by `this.config.includeIdentities !== false` and push identity attributes after managed account source schemas.
- **Reason**: User-confirmed precedence. It preserves the existing behavior where a managed source attribute wins a collision against an identity attribute (for example `firstname` over `FirstName`), while still letting identity attributes fill names that no other source provides.
- **Considered alternatives**: Identity before managed sources, or identity first — both rejected because they would let discovered identity attributes override managed source or user-configured attributes.

### D3: Fusion base and reverse-correlation attributes keep their positions

- **Choice**: Leave fusion base attributes first and reverse-correlation attributes last.
- **Reason**: Fusion base attributes (`status`, `actions`, `reviews`, etc.) are connector-owned structural attributes and must always be present; reverse-correlation attributes are a distinct concern and remain lowest precedence. Neither is part of the four-source requirement, but both are recorded so the full sequence is unambiguous.
- **Considered alternatives**: Including them in the precedence contract — rejected as scope creep beyond the requested behavior.

## Risks / Trade-offs

- [Risk] A deployment relies on a managed source attribute winning a collision against a mapping/definition of the same name; after this change the mapping/definition wins. → Mitigation: the change is scoped to case-insensitive collisions only; document the new precedence in `docs/operations/account-discover-schema.md` and the changelog, and add explicit tests for each collision pair.
- [Trade-off] More source names now resolve to user-configured metadata (description, type, cardinality) than before. → Reason: this is the intended behavior; user configuration should describe the attribute.
- [Risk] Reordering pushes could accidentally move a base attribute. → Mitigation: a test asserts base fusion attributes are still present and dedupe output has no duplicate lowercase names.

## Migration Plan

N/A — no deployment, endpoint, or data migration. The change is a pure code reorder plus spec and test updates. Rollback is reverting the commit; discovery output is only affected when case-insensitive attribute names collide.

## Open Questions

None.

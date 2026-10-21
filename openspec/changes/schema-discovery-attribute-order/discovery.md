## Scope

**In:** Make schema discovery (`SchemaService.buildDynamicSchema`) account for attribute sources in the order **attribute definitions → attribute mappings → managed account source schemas → identity schema** (identity only when identity scope is enabled), and encode that order as the connector's contract for case-insensitive name-collision resolution.
**Out:** The dedupe algorithm itself (case-insensitive, first-wins — unchanged), the order of attributes *within* one source, fusion base structural attributes, reverse-correlation attributes, and the schema-ingestion path (`setFusionAccountSchema`).

## Language

No new ubiquitous-language terms. This change reuses existing canonical terms; a conflict check against `openspec/specs/ubiquitous-language/spec.md` found no drift.

- **Attribute Mapping** (canonical, reused): a configured rule that maps source attributes to a Fusion account attribute name. Glossary: *Attribute Mapping Definitions*.
- **Attribute Definition** (canonical, reused): a Normal or Unique definition rule that computes a Fusion account attribute value. Glossary: *Normal attribute definition*, *Unique attribute definition*.
- **Managed source / managed account source** (canonical, reused): an authoritative source whose accounts enter Map, Define, and Match.
- **Identity scope** (canonical, reused): the set of identities included via `includeIdentities` / `identityScopeQuery`.
- **Discovery attribute-source order** (`draft`): the fixed precedence sequence in which `buildDynamicSchema` collects candidate attributes before case-insensitive dedupe. Not proposed for promotion — it is a spec-level behavior, not a user-facing glossary noun.

_Avoid_: "merge order" as an undefined phrase; always name the sequence.

## Decisions

- **Context:** `buildDynamicSchema` merges candidate attributes and then calls `dedupeSchemaAttributesByName`, which keeps the **first** case-insensitive variant. The current push order is fusion base → managed sources → identity → mappings → definitions → reverse-correlation, so a managed source attribute currently wins a name collision against a mapping or definition of the same logical name.
- **Q1 — Does order matter for correctness?** Yes. Because dedupe is first-wins, push order is precedence. The desired precedence must be explicit rather than an accident of code ordering.
- **Q2 — What is the desired precedence?** Definitions first, then mappings, then managed account source schemas. User-configured attributes outrank auto-discovered ones, and definitions outrank mappings.
- **Q3 — Where does identity schema sit?** After managed sources (user-confirmed): definitions → mappings → managed sources → identity schema. Identity attributes are the lowest-precedence of the four and only participate when identity scope is enabled (`includeIdentities !== false`).
- **Q4 — Do fusion base and reverse-correlation attributes move?** No. Fusion base structural attributes stay first (they are always present and connector-owned); reverse-correlation attributes stay last. They are outside the four-source contract but recorded so the full sequence is unambiguous.
- **Chosen direction:** Reorder the `buildDynamicSchema` push sequence to definitions → mappings → managed sources → identity, and state the order as a requirement in the `schema-service` and `account-discover-schema-operation` specs.

## Open questions

None. The one open fork (identity placement) was resolved during discovery: identity schema attributes are considered **after** managed account source schemas and only when identity scope is enabled.

## Scenarios discussed

- A mapping and a managed source attribute share a logical name with different casing → mapping variant is kept.
- A definition and a managed source attribute collide → definition variant is kept.
- A mapping and a definition collide → definition variant is kept.
- A managed source attribute and an identity attribute collide → managed source variant is kept (preserves the existing `firstname` over `FirstName` behavior).
- Identity scope disabled (`includeIdentities: false`) → identity attributes are not fetched and cannot participate.
- Identity fetch fails → error is logged, remaining sources still build the schema (existing behavior retained).
- Two variants inside one managed source → first variant from that source's attribute list is kept (unchanged).

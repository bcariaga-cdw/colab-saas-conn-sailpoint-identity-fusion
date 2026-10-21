## 1. Reorder dynamic schema attribute sources

- [x] 1.1 In `src/services/schemaService/schemaService.ts`, reorder the `buildDynamicSchema` `pushAttribute` sequence to: fusion base attributes → attribute definitions → attribute mappings → managed account source schemas → identity schema attributes (only when `includeIdentities !== false`) → reverse-correlation attributes.
- [x] 1.2 Keep the identity fetch guard and error handling unchanged: skip the fetch when identity scope is disabled, and log-and-continue when the fetch fails.
- [x] 1.3 Confirm `dedupeSchemaAttributesByName` still applies once at the end as the first-wins case-insensitive dedupe, and that the method returns the schema unchanged in shape.

## 2. Tests

- [x] 2.1 Add a test asserting an attribute definition variant wins a case-insensitive collision against a managed source attribute.
- [x] 2.2 Add a test asserting an attribute definition variant wins a case-insensitive collision against an attribute mapping.
- [x] 2.3 Add a test asserting an attribute mapping variant wins a case-insensitive collision against a managed source attribute.
- [x] 2.4 Confirm the existing managed-source-outranks-identity test still passes (e.g. `firstname` from a managed source beats `FirstName` from identity).
- [x] 2.5 Add a test asserting identity schema attributes are not fetched and do not appear when `includeIdentities` is `false`.
- [x] 2.6 Add a test asserting the full merged output has no duplicate lowercase names and still contains every fusion base structural attribute.

## 3. Verification

- [x] 3.1 Confirm canonical test command: `npm test` (global Vitest suite; scenario suite is `npm run test:scenario`).
- [x] 3.2 Run `npm test` and confirm all tests pass.
- [x] 3.3 Run `npm run lint` and confirm no type, unused-code, or style violations.
- [x] 3.4 All delta spec scenarios covered by named automated tests (coverage evidence for `/opsx:verify`).

## 4. Documentation

- [x] 4.1 Update `docs/operations/account-discover-schema.md` merge-order step to state definitions → mappings → managed account sources → identity schema.
- [x] 4.2 Update the `buildDynamicSchema` JSDoc to state the attribute-source order and the identity-scope condition.

## 5. Changelog

- [x] 5.1 Create or update changelog entry for this change.
- [x] 5.2 Confirm entry covers user-visible changes from proposal Capabilities.

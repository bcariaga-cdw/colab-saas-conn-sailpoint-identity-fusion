## Why

Null and undefined attribute keys are removed only inside `SchemaService.getFusionAttributeSubset`, immediately before an ISC account is sent to the platform. Fusion accounts still carry those keys from the moment they are built out of a persisted account, so every later stage holds attributes that will be thrown away. Stripping them when the Fusion account is built keeps the attribute bags lean for the whole run and removes that late cleanup.

## What Changes

**Fusion account attribute bags**
- From: `FusionAccount.applyFactorySeed` copies `current` and `previous` as given, including keys whose value is `null` or `undefined`. Map may copy a `null` identity-bag value onto the current bag because it only deletes `undefined`.
- To: Seeding `current` and `previous` omits nullish keys. Replacing the current bag omits them again. Map's identity-bag fallback does not copy `null`. Boolean `false`, numeric `0`, blank strings, and empty arrays stay on the Fusion account.
- Reason: The account that flows through Map, Define, and output should already be free of keys that have no value.
- Impact: Non-breaking for the platform payload, which already omitted these keys. `$previous` sees a missing key instead of an explicit null. Source snapshots and `attributeBag.identity` are unchanged.

**Platform attribute subset**
- From: `getFusionAttributeSubset` omits schema attributes whose value is `null` or `undefined`, and also omits blank strings and empty arrays after cast.
- To: The subset still skips a schema attribute that is absent (`undefined`), so it does not invent null keys for the rest of the schema. It no longer strips a present `null`. It still omits blank strings and empty arrays after cast, with the same `id` and `name` exemption, and it still keeps `false` and `0`.
- Reason: Skipping absent attributes is projection. Stripping `null` is the late cleanup this change moves onto the Fusion account.
- Impact: Breaking relative to the schema-service requirement that the subset itself omits `null`. Callers that pass a Fusion account bag with no null keys see the same payload as today.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `fusion-service`: Add a requirement that `attributeBag.current` and `attributeBag.previous` omit keys whose value is `null` or `undefined` when the Fusion account is seeded, and that replacing the current bag omits them again. `false`, `0`, blank strings, and empty arrays remain.
- `schema-service`: Change the platform-subset requirement so it still skips absent attributes and no longer omits a present `null`. Blank-string and empty-array omission stays.

## Impact

- `src/model/fusionAccount.ts` — `applyFactorySeed` and `setMappedAttributes` strip nullish keys from the bags they install
- `src/services/mappingService/mappingService.ts` — identity-bag fallback skips `null`; the current-bag replacement does not keep nullish keys
- `src/services/schemaService/schemaService.ts` — `getFusionAttributeSubset` still skips absent attributes and stops stripping a present `null`; blank and empty omission stays
- `src/model/__tests__/fusionAccount.test.ts`, mapping tests, and `src/services/schemaService/__tests__/schemaService.test.ts` — cover the bag invariant and drop the subset's nullish-omission cases
- `openspec/specs/fusion-service/spec.md` and `openspec/specs/schema-service/spec.md` — requirement wording via this change's deltas; sync at archive
- No configuration change. Source snapshots, `attributeBag.identity`, list-merge null elements, and `FusionAccount.toISCAccount` are out of scope

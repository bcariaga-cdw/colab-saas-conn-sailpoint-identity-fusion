## 1. Fusion account attribute bag strip

- [x] 1.1 Add an `omitNullishAttributeKeys` helper next to the bag utilities in `src/model/` (e.g. `fusionAccountUtils.ts`): it deletes keys whose value is `null` or `undefined` in place and leaves every other value, including `false`, `0`, `""`, `[]`, and arrays that contain null elements
- [x] 1.2 Call it from `FusionAccount.applyFactorySeed` on the `attributeBagCurrent` and `attributeBagPrevious` copies before installing them, so all four factory paths seed lean bags
- [x] 1.3 Call it from `FusionAccount.setMappedAttributes` before replacing `attributeBag.current`

## 2. MappingService bag writes

- [x] 2.1 In `applyMappedValue`'s identity-bag fallback, copy the identity-bag value only when it is neither `null` nor `undefined`; blank strings still copy, so do not use `hasValue` here
- [x] 2.2 Assign Map's finished bag through `fusionAccount.setMappedAttributes(attributes)` instead of writing `attributeBag.current` directly in `mapAttributes`

## 3. SchemaService platform subset

- [x] 3.1 In `getFusionAttributeSubset`, stop stripping a schema attribute whose value is a present `null`: cast it per the schema definition and emit it as `null` (`castAttributeValue` already returns `null` for a nullish input), while still skipping absent (`undefined`) schema attributes so the subset does not invent keys
- [x] 3.2 Keep `emittedPlatformValue` blank-string / empty-array rules, the `id` / `name` exemption, `false` and `0` retention, and the no-input-mutation guarantee exactly as today

## 4. Tests

- [x] 4.1 `src/model/__tests__/fusionAccount.test.ts`: seeding strips nullish keys from `current` and `previous` (`fromFusionAccount`, `fromIdentity`, `fromManagedAccount` paths) and keeps `active: false`, `employeeNumber: 0`, `notes: ""`, `reviews: []`
- [x] 4.2 Same file: `setMappedAttributes` omits nullish keys from an installed bag, and `attributeBag.identity` plus `attributeBag.sources` snapshots keep raw null values
- [x] 4.3 MappingService tests: the identity-bag fallback does not copy a `null` identity-bag value and still copies a blank string, and Map installs its finished bag through `setMappedAttributes`
- [x] 4.4 `src/services/schemaService/__tests__/schemaService.test.ts`: replace the present-`null` omission cases with present-`null` emitted as `null` (including `id: null`); keep the absent-attribute, blank/empty, and internal-bag-unchanged cases green
- [x] 4.5 Regression: platform payloads for connector-built accounts stay identical — full suite and scenario replay suite pass with no recording churn

## 5. Verification

- [x] 5.1 Confirm canonical test command: `npm test` (plus `npm run test:scenario` for the scenario replay suite)
- [x] 5.2 All delta spec scenarios covered by named automated tests (fusion-service seed/replace scenarios; schema-service present-null, absent, and blank scenarios)
- [x] 5.3 `npm run lint` passes (type, dead-code, and style gates)

## 6. Documentation

- [x] 6.1 Confirm no user-facing docs describe the platform subset stripping nulls (only an unrelated troubleshooting row mentions null attribute values today); update `docs/reference/` pages only if any describe this behavior

## 7. Changelog

- [x] 7.1 Create or update the `CHANGELOG.md` entry for this change via changelog-generator during apply — no entry: changelog-generator records no user-visible change (platform payload unchanged), approved by user
- [x] 7.2 Confirm the entry covers the user-visible behavior from proposal Capabilities (lean Fusion account attribute bags; the platform subset no longer strips present nulls) — no release section per the internal-only determination

## 1. Config and connector spec

- [x] 1.1 Add `promoteMainAccountWhenOriginMissing: boolean` to `ProcessingControlSection` in `src/model/config.ts`
- [x] 1.2 Default `promoteMainAccountWhenOriginMissing` to `false` in `processingControlSettings` `runtimeDefaults`, and read it with `extractBoolean` so a missing key is off (design D3)
- [x] 1.3 Add the Processing Control toggle in `connector-spec.json` with label "Promote first found managed account to main account when origin account is missing", no `value` that turns it on, and help text that states both halves: set `mainAccount` to the first live managed account while the origin is not a current contributor, and clear `mainAccount` when the origin is a current contributor again
- [x] 1.4 Extend the Processing Control `sectionHelpMessage` so the section intro names this toggle alongside history, empty-account deletion, and missing-identifier behavior

## 2. Handoff in processFusionAccount

- [x] 2.1 In `FusionService.processFusionAccount`, after the managed-account layer and origin-in-scope resolution and immediately before `applyAttributeProcessing`, apply the rule only when the toggle is on (design D4). Do not add it to `AccountAssembly.assembleAccount`
- [x] 2.2 When the origin is not a current contributor, set `mainAccount` to the first live managed account. Managed-origin absence is the origin key missing from `accounts` after blend and prune. Identity-origin absence is `originIdentityInScope === false`. Do not treat a missing snapshot or unresolved scope as absent (design D1, D2)
- [x] 2.3 Choose the first live managed account in configured source order, then blend order within a source, excluding the identity bag. Use materialized `attributeBag.sources` when this run built them; otherwise order linked `accounts` keys. Do not use `$accounts[0]` after `mainAccount` has been moved to the front (design D6)
- [x] 2.4 When the origin is a current contributor, or no live managed account remains, clear `mainAccount` by removing the value, including an operator-stored value. Leave `originAccount` unchanged (design D1, D5)
- [x] 2.5 When the value changes, set `needsRefresh` before Map and append one history line naming the previous and new value. When the value does not change, do not set `needsRefresh` for this rule and do not append history (design D4, D7)
- [x] 2.6 Leave an explicit attribute map free to replace `mainAccount` later in that same Map

## 3. Tests

- [x] 3.1 Test "Absent key leaves the toggle off" in `src/data/config/settings/__tests__/processingControlSettings.test.ts`
- [x] 3.2 Test "Help text states promote and clear" against `connector-spec.json` (no enabling initial value, label, and both help halves)
- [x] 3.3 Test "Managed-origin account promotes the first live managed account" (`originAccount` unchanged, `needsRefresh` set, one history line)
- [x] 3.4 Test "First live managed account follows configured source order"
- [x] 3.5 Test "First live managed account follows blend order within one source"
- [x] 3.6 Test "Identity bag is not the first live managed account" (not the identity id, and the account is not marked orphan)
- [x] 3.7 Test "No live managed account clears mainAccount"
- [x] 3.8 Test "Unchanged mainAccount does not force refresh"
- [x] 3.9 Test "Managed-origin account clears a stored mainAccount while the origin key remains"
- [x] 3.10 Test "Identity-origin account clears mainAccount when the origin identity is in scope"
- [x] 3.11 Test "Origin returns on a later run and clears mainAccount"
- [x] 3.12 Test "Toggle off leaves mainAccount unchanged when the origin key is gone"
- [x] 3.13 Test "Absent key leaves mainAccount unchanged"
- [x] 3.14 Test "Skipped refresh does not promote from a missing origin snapshot"
- [x] 3.15 Test "Unresolved identity scope does not change mainAccount"
- [x] 3.16 Test "Turning the toggle off leaves a previously promoted mainAccount in place"
- [x] 3.17 Test "Explicit map wins over the handoff in the same run" (handoff value applied before Map, map value persisted)
- [x] 3.18 Add `src/services/fusionService/__tests__/promoteMainAccountWhenOriginMissing.test.ts` for 3.3–3.17, using `createFusionServiceTestContext`. Name each test after its scenario title

## 4. Verification

- [x] 4.1 Confirm canonical test command: `npm test`
- [x] 4.2 All delta spec scenarios covered by named automated tests in sections 3 and 5
- [x] 4.3 Run `npm test -- src/data/config/settings/__tests__/processingControlSettings.test.ts src/services/fusionService/__tests__/promoteMainAccountWhenOriginMissing.test.ts src/data/__tests__/promoteMainAccountWhenOriginMissingVocabulary.test.ts`
- [x] 4.4 Run `npm run lint`

## 5. Documentation

- [x] 5.1 Update `docs/use-guides/configuration/configuring-sources-and-scope.md` Processing control table with the toggle, default off, and both promote-while-absent and clear-when-present behavior
- [x] 5.2 Update `docs/glossary.md`: extend **Processing Control** with the origin-absent main account handoff (`promoteMainAccountWhenOriginMissing`); add **first live managed account** and **origin not a current contributor**
- [x] 5.3 Update `docs/reference/config-to-phases.md` so this toggle is mapped to Refresh (`processFusionAccount`), including single-account read, not only Output
- [x] 5.4 Update `docs/reference/standard-account-schema.md` `mainAccount` so it states that, when the toggle is on, `processFusionAccount` sets or clears it before Map
- [x] 5.5 Test "Glossary entry for first live managed account", "Glossary entry for origin not a current contributor", and "Processing Control entry names the handoff toggle" in `src/data/__tests__/promoteMainAccountWhenOriginMissingVocabulary.test.ts` against `docs/glossary.md`

## 6. Changelog

- [x] 6.1 Create or update changelog entry for this change via changelog-generator
- [x] 6.2 Confirm the entry covers the opt-in toggle, default off with no change for existing sources, promote while the origin is absent, clear when the origin is back, and that `originAccount` and merge algebra stay unchanged

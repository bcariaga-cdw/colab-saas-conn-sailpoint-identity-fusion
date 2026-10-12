## Why

When a Fusion account's origin is gone, Main account merge keeps the last Fusion values: the origin snapshot is unavailable, and nothing writes a successor into `mainAccount`. A stored `mainAccount` also keeps winning after the origin returns. Operators need an opt-in Processing Control switch that points `mainAccount` at the first remaining managed account while the origin is gone and clears it when the origin is back, without changing existing sources until they enable it.

## What Changes

**Origin-absent main account handoff**
- From: `mainAccount` changes only when an operator or an attribute map writes it. If the origin snapshot is not loaded, Main account merge preserves the values already on the Fusion account. A stored `mainAccount` stays after the origin returns.
- To: Processing Control toggle `promoteMainAccountWhenOriginMissing`, label "Promote first found managed account to main account when origin account is missing", default off when the key is absent. While on, `processFusionAccount` runs after the managed-account layer and origin-in-scope resolution, and before Map. If the origin is not a current contributor, set `mainAccount` to the first live managed account. If the origin is a current contributor again, clear `mainAccount`, including an operator-stored value. No live managed account: clear it. A changed value sets `needsRefresh` so Map follows it in that same run. `originAccount` stays immutable. An explicit map that writes `mainAccount` can replace the value later in that Map.
- Reason: Attributes should follow a remaining managed account only when an operator asks, and the origin should lead again when it returns.
- Impact: **Non-breaking** while the toggle is off (existing sources and new sources). **Behavior change** for sources that turn it on: stored `mainAccount` is cleared whenever the origin is still present, and set to the first live managed account whenever the origin is not.

**Unchanged**
- Main account merge, Origin account merge, and First found merge algebra.
- `missing-accounts` (uncorrelated keys) and designated snapshot unavailable. A skipped refresh or an unresolved identity-scope check does not count as the origin being absent.
- Turning the toggle off later does not revert a `mainAccount` already written.
- A history line when `mainAccount` changes is optional design detail, not a separate capability.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `fusion-service`: While the toggle is on, set or clear `mainAccount` in `processFusionAccount` before Map for managed-origin and identity-origin accounts, and refresh when the value changes.
- `ubiquitous-language`: Promote **first live managed account** and **origin not a current contributor**. Extend the **Processing Control** glossary entry to include this toggle.

## Impact

- `connector-spec.json` — Processing Control toggle; help text states both the promote-while-absent and clear-when-present halves. No initial value that turns existing sources on.
- `src/data/config/settings/processingControlSettings.ts` — runtime default `false` when the key is absent
- `src/model/config.ts` — `ProcessingControlSection`
- `src/services/fusionService/fusionService.ts` — rule inside `processFusionAccount` (aggregation refresh and single-account read)
- Tests under `src/services/fusionService/__tests__/`
- Docs: `docs/use-guides/configuration/configuring-sources-and-scope.md`, `docs/glossary.md`, `docs/reference/config-to-phases.md` (this toggle acts in Refresh, not only Output), `docs/reference/standard-account-schema.md` if `mainAccount` description should mention the toggle
- Changelog via changelog-generator at apply close
- No ISC API change and no migration of stored `mainAccount` values

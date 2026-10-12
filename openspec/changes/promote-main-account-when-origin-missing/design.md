## Context

Main account merge reads the `mainAccount` snapshot when that key is loaded this run, otherwise the origin snapshot. Nothing writes a successor into `mainAccount` when the origin is gone, so the Fusion account keeps its last mapped values. A stored `mainAccount` also keeps winning after the origin returns.

`FusionService.processFusionAccount` already runs the managed-account layer (blend and prune, including claim-only when live snapshots are not required) and resolves `originIdentityInScope` before Map. Aggregation refresh and single-account read both use that method. `AccountAssembly.assembleAccount` does not. `DefinitionService.buildOrderedAccountList` already orders managed snapshots by configured source order, then blend order within a source, and excludes that ordering from the later move of `mainAccount` to `$accounts[0]`.

Operators asked for an opt-in Processing Control switch. Discovery locked the behavior: follow while absent, both origin types, default off, run before Map, leave `originAccount` immutable, and select the first live managed account rather than the First found merge strategy.

## Goals / Non-Goals

**Goals:**

- Add Processing Control toggle `promoteMainAccountWhenOriginMissing`, off when the key is absent.
- While it is on, set or clear `mainAccount` inside `processFusionAccount` before Map, for managed-origin and identity-origin Fusion accounts.
- A changed value sets `needsRefresh` so Map in that same invocation follows it.
- Help text states both halves: promote while the origin is not a current contributor, and clear when the origin is a current contributor again.

**Non-Goals:**

- Changing `originAccount`, Main account merge, Origin account merge, or First found merge.
- Treating a skipped refresh or an unresolved identity-scope check as the origin being absent.
- Defaulting the toggle on for existing or new sources.
- Reverting a stored `mainAccount` when an operator turns the toggle off later.
- Putting the rule on the thin `assembleAccount` path.

## Decisions

### D1: Follow while absent

- **Choice**: While the toggle is on and the origin is not a current contributor, set `mainAccount` to the first live managed account. When the origin is a current contributor again, clear `mainAccount`, including a value an operator stored. No live managed account: clear it. If the value would not change, leave it and do not set `needsRefresh` for this rule.
- **Reason**: Attributes should follow a remaining managed account only while the origin is gone, and the origin should lead again when it returns.
- **Considered alternatives**: Promote once and leave the stored value when the origin returns. Rejected: a stored `mainAccount` would keep winning after the origin is back.

### D2: Both origin types, with the signals that already exist

- **Choice**: Managed-origin uses membership of the origin key in `accounts` after this run's managed-account layer. Identity-origin uses resolved `originIdentityInScope === false`. `undefined` does not count as absent.
- **Reason**: Those are the post-layer facts `processFusionAccount` already has. Snapshot absence is designated snapshot unavailable, including when refresh was skipped and snapshots were not materialized.
- **Considered alternatives**: Treat a missing origin snapshot as absent. Rejected: claim-only refresh leaves the origin key in `accounts` and does not load the snapshot.

### D3: Default off, including a missing key

- **Choice**: `processingControlSettings` reads the key with `extractBoolean`, falling back to `runtimeDefaults.promoteMainAccountWhenOriginMissing = false`. `ProcessingControlSection` gains a required boolean. `connector-spec.json` adds the toggle with no `value` that turns sources on, matching `deleteEmpty`.
- **Reason**: On would clear a stored `mainAccount` on every Fusion account whose origin is still present. Absent key must stay off for existing sources and new ones.
- **Considered alternatives**: Connector-spec initial value `true`. Rejected in discovery after that impact was spelled out.

### D4: One write site, before Map, only on `processFusionAccount`

- **Choice**: Run the rule in `processFusionAccount` after the managed-account layer and origin-in-scope resolution, and immediately before `applyAttributeProcessing`. Unique registration stays where it is: it records already-stored unique values and does not read `mainAccount`. When the value changes, set `needsRefresh` before Map. Clear by removing the attribute, not by writing an empty string. Append one history line only when the value changes.
- **Reason**: Aggregation refresh and single-account read share this method. Map, including an explicit attribute map that writes `mainAccount`, still runs afterward and can replace the value. Define builds `$accounts` after that write, so the same invocation follows the new `mainAccount` without moving the account to index 0 before the rule chooses it.
- **Considered alternatives**: Shared `assembleAccount` recipe. Rejected: IdentityProcessor and DecisionProcessor use that thin path, and this rule is fusion-account maintenance, not match assembly.

### D5: `originAccount` stays the creation pointer

- **Choice**: The rule reads `originAccount` and never writes it.
- **Reason**: It is the immutable origin key. `mainAccount` is the override Map already honors.

### D6: First live managed account uses source order, not First found

- **Choice**: Candidates are managed-source accounts still linked in `accounts`. The identity bag is not a candidate. Order matches `buildOrderedAccountList`: configured `config.sources` order, then any remaining sources, and blend order within a source. When this run materialized `attributeBag.sources`, take that order and skip the Identities source. When this run did not materialize snapshots, order the linked `accounts` keys with managed-account source info the same way. Do not treat an empty snapshot map as "no live managed account" while `accounts` is non-empty. Do not use `$accounts[0]` after `mainAccount` has been moved to the front.
- **Reason**: That is the order operators already see for `$accounts` before the main-account override. The connector-spec label stays the agreed string, "Promote first found managed account to main account when origin account is missing". Help text uses **first live managed account** and **origin not a current contributor**, not First found and not "missing account".

### D7: History line when the value changes

- **Choice**: When the rule changes `mainAccount`, append one history message naming the previous value and the new value (or that it was cleared). No message when the value is unchanged.
- **Reason**: Processing Control already retains account history. The contract remains the `mainAccount` value; the line is the audit of that write.

## Risks / Trade-offs

- [Risk] Turning the toggle on clears stored `mainAccount` whenever the origin is still a current contributor. -> Mitigation: default off, and help text states the clear-when-present half before an operator enables it.
- [Risk] Claim-only refresh has no snapshots, so a snapshot lookup would look like "no live managed account" and clear `mainAccount`. -> Mitigation: D2 and D6 key off `accounts` membership and linked keys, not snapshot presence.
- [Risk] An explicit attribute map can replace `mainAccount` later in the same Map. -> Mitigation: accepted. The map is the later writer; the rule only seeds the value Map starts from.
- [Trade-off] A changed `mainAccount` forces Map on that account this run. -> Reason for acceptance: otherwise Main account merge would keep the previous Fusion values until some other refresh.
- [Trade-off] The field label says "first found" and "missing" while the glossary does not. -> Reason for acceptance: the label was locked with operators. Help text and glossary use the canonical terms.

## Migration Plan

N/A — no deployment or stored-data migration. Existing sources keep their current `mainAccount` until an operator enables the toggle. Turning it off later stops new writes and leaves the current `mainAccount` in place. Rollback is disabling the toggle.

## Open Questions

None.

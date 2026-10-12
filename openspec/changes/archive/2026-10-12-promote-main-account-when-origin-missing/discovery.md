## Scope

In: a Processing Control toggle, off when the key is absent, that while enabled writes `mainAccount` to the first live managed account when the origin is not a current contributor and clears `mainAccount` when the origin is a current contributor again, before Map, for both managed-origin and identity-origin Fusion accounts. Out: changing `originAccount`, Main account merge or Origin account merge algebra, First found merge, treating a skipped refresh or an unresolved scope check as origin-absent, and defaulting the toggle on for existing sources.

## Language

**First live managed account** (`promote`):
The first managed-source account still linked on the Fusion account, in configured source order, then blend order within a source. The identity bag is not one.
_Avoid_: First found (that name is the Map merge strategy); origin account; main account

**Origin not a current contributor** (`promote`):
For a managed-origin Fusion account, the origin key is not in `accounts` after this run's blend and prune. For an identity-origin Fusion account, the origin identity is resolved out of scope. An unresolved scope check is not this state.
_Avoid_: missing account (an uncorrelated key in `missing-accounts`); designated snapshot unavailable (the origin snapshot was not loaded this Map, including when refresh was skipped)

**Processing Control** (canonical — amend at specs):
The glossary sentence lists history retention, empty-account deletion, and missing-identifier behavior. This toggle is another account-maintenance control in that section. Specs phase extends that entry. Not a new term.
_Avoid_: a new section name

## Decisions

Context: Main account merge keeps the values already on the Fusion account when the origin snapshot is not loaded, and nothing writes a successor into `mainAccount`. A stored `mainAccount` also keeps winning after the origin returns. Operators asked for a Processing Control option to hand `mainAccount` to another managed account while the origin is gone.

Q1: What does the option do to `mainAccount`?
Chosen: **follow while absent.** While the origin is not a current contributor, set `mainAccount` to the first live managed account. When the origin is a current contributor again, clear `mainAccount`, including a value an operator stored. No live managed account: clear it. If the value would not change, leave it and do not force refresh.

Q2: Which Fusion accounts?
Chosen: **both.** Managed-origin uses membership in `accounts`. Identity-origin uses the existing resolved `originIdentityInScope === false` signal. `undefined` (not resolved) does not count as absent.

Q3: Default?
Chosen: **off.** The request started as default on. That was reversed because "on" clears stored `mainAccount` on every Fusion account whose origin is still present. Absent key means off, for existing sources and new ones. Turning the option off later stops new writes and leaves the current `mainAccount` in place.

Q4: When does it run?
Chosen: **in `processFusionAccount`, after the managed-account layer and origin-in-scope resolution, before Map.** A changed `mainAccount` sets `needsRefresh` so Map runs in that same invocation. An explicit attribute map that writes `mainAccount` can replace the value later in that Map. The same method covers aggregation refresh and single-account read.

Q5: `originAccount`?
Chosen: **leave it.** It stays the immutable creation pointer.

Q6: What does "first" mean in the label?
Chosen: **first live managed account**, not the First found merge strategy. Writing `mainAccount` still affects consumers that already honor it: Main account merge, First found's priority slot, `$accounts[0]`, and the `$originSource` Source-name token.

## Open questions

None. A history line when `mainAccount` changes is optional audit detail for design; the contract is the `mainAccount` value, not the log line.

## Scenarios discussed

- Option off or key absent: `mainAccount` unchanged, including when the origin key is gone.
- Managed-origin, origin key still in `accounts`, stored `mainAccount` set: clear `mainAccount` before Map.
- Managed-origin, origin key not in `accounts`, another managed account live: `mainAccount` becomes that first live managed account; `originAccount` unchanged; Map follows it this run.
- Managed-origin, origin gone, no other live managed account: clear `mainAccount`.
- Identity-origin, origin identity resolved out of scope, managed accounts remain: promote the first live managed account (account stays non-orphan).
- Identity-origin, origin identity in scope: clear `mainAccount`.
- Identity-origin, scope not resolved (`originIdentityInScope` undefined): do not touch `mainAccount`.
- Fusion account skipped refresh (contributor list not rebuilt this run): do not treat a missing snapshot as origin-absent.
- Origin returns on a later run: clear `mainAccount` so the origin leads again.
- Explicit map writes `mainAccount` in the same Map after this rule: the map's value is what persists.
- Option turned off after a previous promotion: stored `mainAccount` stays until something else changes it.

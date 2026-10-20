## Scope

In: when a Fusion account is built, omit attribute keys whose value is `null` or `undefined` from `attributeBag.current` and `attributeBag.previous`, and keep that true when the current bag is replaced. Platform output stops being the place that strips those keys.

Out: blank-string and empty-array omission (still in `SchemaService.getFusionAttributeSubset`, after schema cast). Null elements inside a multi-valued value (list merge still keeps them; multi-valued cast still compacts them). Source snapshots and `attributeBag.identity` (mapping inputs). A configuration toggle. `FusionAccount.toISCAccount` (test-only; it is not the path that sends accounts to ISC).

## Language

**Fusion account** (canonical — reuse):
The consolidated account produced by Map and Define. Here, the object whose attribute bags must not carry nullish keys.
_Avoid_: ISC account, when the in-memory model is meant.

**ISC account** (canonical — reuse):
Any account object from Identity Security Cloud. Here, both the persisted account a Fusion account is built from and the payload sent back to the platform.
_Avoid_: Fusion account, for the platform payload.

**Nullish attribute** (`draft`):
An attribute key whose value is `null` or `undefined`. Not promoted — ordinary language, not a new domain noun.
_Avoid_: empty attribute (that already covers blank strings and empty arrays, which this change does not move).

## Decisions

Context: `SchemaService.getFusionAttributeSubset` skips schema attributes whose value is `null` or `undefined` before the ISC account is sent. Factories copy `account.attributes` onto both bags with those keys intact (`FusionAccount.applyFactorySeed`). Map then copies `attributeBag.current` and only deletes a key when the mapped result is `undefined`; a `null` identity-bag fallback (`!== undefined`) can be copied. Define already deletes a key when a definition result is nullish. Blank strings and empty arrays are a later output rule that depends on schema cast, including the `id` / `name` exemption and the numeric/boolean cast of `""` to `0` or `false`.

Q1: What moves?
Chosen: **Nullish keys only** (`null` and `undefined`). Boolean `false`, numeric `0`, blank strings, and empty arrays stay on the Fusion account. Blank strings and empty arrays are still omitted at platform output.

Q2: Where is it enforced?
Chosen: **On the Fusion account attribute bag at build, and again when the current bag is replaced.** `applyFactorySeed` strips `current` and `previous` as they are seeded. Replacing the current bag (Map's assignment, `setMappedAttributes`) strips again so a null written during Map does not survive. Map's identity-bag fallback treats `null` the same as `undefined` and does not copy it. No proxy on the hot attribute path.

Q3: Which bags?
Chosen: **`current` and `previous` only.** Both are the Fusion account attribute bag copied from the ISC account at build. Source snapshots and `attributeBag.identity` stay as stored so Map still sees source values and skips nullish ones with `hasValue`.

Q4: Does platform output still strip nullish keys?
Chosen: **No for explicit `null`.** `getFusionAttributeSubset` still skips a schema attribute that is absent (`undefined`), so the schema loop does not invent null keys. It no longer strips a present `null`. Blank-string and empty-array omission stays after cast. The platform payload stays free of null keys because the bag already is. A missing key and a nullish key are the same for Fusion account attributes, including `$previous`.

Q5: Is there a setting?
Chosen: **No.** Always omit. The original output change rejected a toggle for the same reason.

## Open questions

None.

## Scenarios discussed

- Persisted account `{ department: null, name: "Ada Wong", active: false, employeeNumber: 0, notes: "" }` builds a Fusion account whose current and previous bags have no `department` key and still have `name`, `active`, `employeeNumber`, and `notes`
- A key whose value is `undefined` is likewise absent after build
- `id: null` is absent on the Fusion account; `id: ""` and `name: "   "` stay on the Fusion account and are still sent
- A source snapshot may still contain `department: null`; Map does not copy that key onto the Fusion account
- An identity attribute that is `null` is not copied onto the current bag by the identity fallback
- `reviews: []` stays on the Fusion account and is still omitted from the platform payload
- A list-merge value `[null, "A"]` is unchanged on the Fusion account; multi-valued cast still drops the null element at output
- `getFusionAttributeSubset` still omits `department: ""` and `reviews: []`, and still emits `false` and `0`

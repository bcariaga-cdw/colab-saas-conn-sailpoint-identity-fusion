## Context

`SchemaService.getFusionAttributeSubset` is the last step before an ISC account is sent. It skips any schema attribute whose value is `null` or `undefined`, then casts the rest and omits blank strings and empty arrays. Fusion account factories copy the persisted attribute object onto `attributeBag.current` and `attributeBag.previous` through `FusionAccount.applyFactorySeed` without removing those keys. Map starts from a copy of `current` and deletes a key only when the mapped result is `undefined`. Its identity-bag fallback copies a value whenever it is not `undefined`, so an explicit `null` is written. Define already deletes a key when a definition result is nullish.

The platform payload is already free of null keys. The Fusion account that Map, Define, Velocity (`$previous`), and the rest of the run see is not.

Blank-string and empty-array omission stays in the subset. That rule runs after schema cast: a blank string on a numeric or boolean attribute becomes `0` or `false` and must be kept, and `id` and `name` stay when they are blank. Those cases are not nullish keys.

This change stays inside the connector process: the Fusion account model, Map's bag replacement, and the schema subset. No new service or external system.

## Goals / Non-Goals

**Goals:**

- A Fusion account's `current` and `previous` bags have no key whose value is `null` or `undefined` from the moment they are seeded.
- Replacing the current bag cannot put those keys back.
- `getFusionAttributeSubset` no longer strips explicit `null` keys. It still skips attributes that are absent, and blank-string and empty-array omission is unchanged.
- The ISC account payload for an account built by this connector stays free of null keys, as it is today.

**Non-Goals:**

- Omitting blank strings or empty arrays from the Fusion account bag.
- Removing null elements inside a multi-valued array (list merge still keeps them; multi-valued cast still compacts them).
- Stripping source snapshots or `attributeBag.identity`.
- A configuration toggle.
- Changing `FusionAccount.toISCAccount`.
- Wrapping the attribute bag in a proxy.

## Decisions

### D1: Strip keys at the two places that install a bag

- **Choice**: Add `omitNullishAttributeKeys` that deletes keys whose value is `null` or `undefined` and leaves every other value, including `false`, `0`, `""`, and `[]`. Call it from `applyFactorySeed` on the current and previous copies, and from `setMappedAttributes` before the current bag is replaced. Map assigns the finished bag through `setMappedAttributes` instead of writing `attributeBag.current` directly.
- **Reason**: Factories already copy attributes before seeding, so the strip mutates the Fusion account's copy and not the persisted ISC account. Map is the only production replacement of the current bag, and `setMappedAttributes` is that seam today but has no callers. One install path covers seed and Map.
- **Considered alternatives**: A proxy on the bag that drops nullish sets. Rejected because attribute reads sit on the aggregation hot path. A final sweep inside `getFusionAttributeSubset`. Rejected because that is the late cleanup this change removes. Stripping only at seed. Rejected because Map's identity-bag fallback can write `null` after seed.

### D2: Map does not copy a null identity value

- **Choice**: The identity-bag fallback copies a value only when it is neither `null` nor `undefined`. Otherwise it follows the existing delete path.
- **Reason**: `setMappedAttributes` would also drop the key, but the fallback should not write a nullish value onto the working bag in the first place. `hasValue` is the wrong check here: it also rejects blank strings, which must still be copied.
- **Considered alternatives**: Rely only on the strip inside `setMappedAttributes`. Rejected because the working copy would still hold the null until the replacement.

### D3: Platform subset stops stripping null keys, and still skips absent ones

- **Choice**: `getFusionAttributeSubset` still skips a schema attribute whose bag value is `undefined`, because that attribute is not on the account. The schema loop must not invent `"attr": null` for every missing schema attribute. It no longer skips an explicit `null`. `emittedPlatformValue` stays the blank-string and empty-array filter. A present `null` is cast and emitted as `null`.
- **Reason**: Skipping `undefined` is projection onto the keys the account actually has. Skipping `null` is the late cleanup this change removes. After D1 and D2 the bags the connector sends have no `null` keys, so the payload stays free of them.
- **Considered alternatives**: Delete both checks. Rejected because every absent schema attribute would be sent as `null`. Keep skipping `null` as a safety net. Rejected because that is the send-time cleaning this change moves.

### D4: Leave mapping inputs alone

- **Choice**: Do not strip source snapshots or `attributeBag.identity`.
- **Reason**: Those objects are inputs. Map already ignores a nullish source value through `hasValue`. Stripping them would change snapshot identity and is outside the Fusion account attribute bag that is sent to the platform.
- **Considered alternatives**: Strip every object on the attribute bag, including `sources` and `identity`. Rejected for that reason.

## Risks / Trade-offs

- [Risk] An in-place `attributes[name] = null` after Map would now be sent to the platform, because the subset no longer drops it. Define already deletes on a nullish result, and the other in-place writers assign a real value or delete. -> Mitigation: tests lock the seed and post-Map bags. Do not add a second strip at send time.
- [Risk] Velocity `$previous.department` for a persisted `null` becomes a missing key. -> Mitigation: accepted. A nullish Fusion account attribute and a missing one are the same. Quiet references already treat both as empty.
- [Trade-off] Blank strings and empty arrays still ride on the Fusion account until platform output. -> Reason for acceptance: emptiness is judged after schema cast, which does not belong in account construction.

## Migration Plan

N/A — no deployment, schema, or stored-data migration. The next aggregation builds Fusion accounts without nullish keys and sends the same platform payload as today. Rollback is reverting the change.

## Open Questions

None.

# Define: Attribute Definition

The **Define** step controls how attributes are generated using Apache Velocity expressions, unique identifiers, UUIDs, or counters. This happens after Attribute Mapping (if sources are configured) and before Match scoring (for normal attributes).

---

## When to use Attribute Definition

| Goal                        | Use Attribute Definition                      | Example                                        |
| --------------------------- | --------------------------------------------- | ---------------------------------------------- |
| Generate unique usernames   | Yes (Unique type)                             | `jsmith`, `jsmith1`, `jsmith2`                 |
| Assign stable UUIDs         | Yes (UUID type)                               | `a3f2e8b4-7c2d-4f9e-8a1b-3c5d6e7f8g9h`         |
| Sequential employee numbers | Yes (Counter type)                            | 1000, 1001, 1002...                            |
| Computed attributes         | Yes (Normal type with expression)             | Full name from first + last; formatted dates   |
| Normalize/format values     | Yes (Normal type with expression + utilities) | Parse address, format phone, proper case names |

---

## Global settings

| Field                                             | Purpose                                     | Recommended value                                                                  |
| ------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Maximum attempts for unique Define generation** | Cap on retries for generating unique values | 20 (default); increase for large datasets with high collision risk (e.g. 50–200) |

**Why this matters:** For **Unique** type attributes, if the generated value already exists, the connector appends a counter and retries. This setting prevents infinite loops if the expression always produces the same value.

---

## Per-attribute definition configuration

For each attribute you want to generate, add an **Attribute Definition**:

| Field                                 | Type                | Purpose                                                                                       | Options / Example                                                                               |
| ------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **Attribute Name**                    | String (required)   | Name of generated attribute                                                                   | `username`, `uuid`, `employeeNumber`, `fullName`, `formattedHireDate`                           |
| **Apache Velocity expression**        | String (required)   | Template to compute value (required for both Normal and Unique)                               | `#set($i=$firstname.substring(0,1))$i$lastname` for Normal; same with `$counter` appended for Unique |
| **Case selection**                    | Dropdown (required) | Text case transformation                                                                      | Do not change, Lower case, Upper case, Capitalize                                               |
| **Attribute Type**                    | Dropdown (required) | Generation behavior                                                                           | **Normal** (standard computed attribute) or **Unique** (must be unique across accounts). UUID and incremental counter are sub-modes of **Unique**: include `$UUID` in the expression for UUID generation; toggle **Use incremental counter?** for sequential IDs. |
| **Counter start value**               | Integer             | Starting number when **Use incremental counter?** is on                                       | 1, 1000, 50000                                                                                  |
| **Minimum counter digits**            | Integer             | Zero-padding for the counter (Unique type)                                                    | 3 → `001`, `002`; 5 → `00001`                                                                   |
| **Maximum length**                    | Integer (optional)  | Truncate to this length                                                                       | 20; counter preserved at end for Unique                                                         |
| **Normalize special characters?**     | Boolean             | Remove special chars/quotes                                                                   | Yes for usernames/IDs                                                                           |
| **Remove spaces?**                    | Boolean             | Remove all whitespace                                                                         | Yes for usernames/IDs                                                                           |
| **Trim leading and trailing spaces?** | Boolean             | Strip leading/trailing whitespace                                                             | Yes for most attributes                                                                         |
| **Use incremental counter?**          | Boolean (optional)  | Unique type only: when `true`, `$counter` always increments instead of resetting on collision | Yes for counters that must never reuse a value; No (default) for collision-based disambiguation |
| **Refresh on each aggregation?**      | Boolean             | Recalculate every run (Normal type only)                                                      | Yes if dynamic; No if stable                                                                    |

**Screenshot placeholder:** Attribute Definition with examples.
Attribute definition example

---

## Attribute types explained

### Normal type

**Behavior:** Standard computed attribute; recalculated based on **Refresh on each aggregation?** setting.

| Refresh setting | Behavior                       | Use case                                                            |
| --------------- | ------------------------------ | ------------------------------------------------------------------- |
| Yes             | Recalculated every aggregation | Dynamic values that should update (full name, age, formatted dates) |
| No              | Calculated once; persisted     | Stable values (initial assignment, one-time calculations)           |

**Examples:**

```velocity
# Full name (refresh: Yes)
$firstname $lastname

# Formatted hire date (refresh: No, unless hireDate changes)
$Datefns.format($hireDate, 'MMMM dd, yyyy')

# Years of service (refresh: Yes, dynamic)
$Math.floor($Datefns.differenceInDays($Datefns.now(), $hireDate) / 365)
```

### Unique type

**Behavior:** Must be unique across all Fusion accounts; connector adds disambiguation counter on collision. Unique attributes are only computed when a Fusion account is **first created** or when an existing account is **activated** (an internal mechanism to reset unique attributes). They are not refreshed by **Force attribute refresh on next aggregation?** (located at **Advanced Settings → Developer Settings**; applies only to Normal-type attributes).

**How it works:**

1. Generate value from expression
2. Check if value exists on any account
3. If unique → use value
4. If collision → append counter (starting at 1), check again
5. Repeat up to **Maximum attempts**

**Counter format:** `{base value}{counter}` (e.g. `jsmith1`, `jsmith2`)
**Zero-padding:** Use **Minimum counter digits** to pad counter (e.g. digits=3 → `jsmith001`)

> **Note:** If a **Maximum length** is configured, the connector intelligently truncates the surrounding text to ensure the `$counter` is perfectly preserved without being chopped off, even if the counter is injected in the middle of a string.

**`$isUnique(value)` helper:** Unique definitions can call `$isUnique(...)` inside the Velocity expression to test whether a candidate value is currently free after the same trim/case/spaces/normalize/maxLength rules are applied. Use this to choose between candidate formats before the connector falls back to automatic `$counter` disambiguation.

> **Template safety note:** The connector auto-appends `$counter` to unique expressions that do not already reference `$counter` or `$UUID`, but the auto-append is **skipped when the expression contains Velocity directives** (`#if`, `#set`, `#else`, `#end`, etc.) because appending after `#end` would break parsing. In that case include `$counter` explicitly in your expression (or use `$UUID`).

**Examples:**

```
Expression: #set($i=$firstname.substring(0,1))$i$lastname
Case: Lower case
Normalize: Yes
Spaces: Yes

Firstname="John", Lastname="Smith"
→ Generate: "jsmith"
→ Check: Already exists
→ Append counter: "jsmith1"
→ Check: Unique
→ Result: "jsmith1"
```

```velocity
## Conditional candidate selection using $isUnique
#set($base = "$firstname.$lastname")
#set($alt = "$firstname$lastname")
#if($isUnique($base))
  $base
#elseif($isUnique($alt))
  $alt
#else
  $base
#end
```

### Unique sub-mode: UUID

**Behavior:** Generates an immutable universally unique identifier (v4 UUID). The expression is **required**; include `$UUID` anywhere in the expression and the connector injects a fresh v4 UUID per attempt.

**Characteristics:**

- Globally unique (extremely low collision probability)
- Immutable (never changes once generated)
- Format: 36 characters (8-4-4-4-12 hex digits)
- Example: `a3f2e8b4-7c2d-4f9e-8a1b-3c5d6e7f8a9b`

**Use cases:**

- **Native identity** in ISC (stable reference that never changes)
- **Account name** when you need immutable identifier
- Cross-system correlation (UUID as common key)

**Example expression:**

```velocity
$UUID
```

### Unique sub-mode: Incremental counter

**Behavior:** Sequential incrementing number; each account gets the next number in sequence. The counter is persistent (survives across aggregations) and always increments.

**How it works:**

1. The connector reads the current counter value for this attribute from state.
2. It increments, applies **Minimum counter digits** for zero-padding, and substitutes `$counter` in the expression.
3. The new counter value is persisted for the next account.

**Fields:**

- **Use incremental counter?** (Unique type only): turn on to switch from collision-based disambiguation to a persistent, always-incrementing counter.
- **Counter start value:** First number in sequence (e.g. 1, 1000, 50000). Ignored unless the persistent counter has not been seeded yet.
- **Minimum counter digits:** Zero-padding (e.g. 5 → `00001`, `00002`).

**Example expression with prefix:**

```velocity
# Employee number with prefix
EMP-$counter

Counter start: 1000, Digits: 5
→ EMP-01000, EMP-01001, EMP-01002
```

---

## Apache Velocity context

The **Apache Velocity expression** field provides a powerful templating language with access to utilities and data.

### Available data

| Source                        | What you can access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Example                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Mapped account attributes** | All attributes from Attribute Mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `$jobTitle`, `$department`, `$email`                                       |
| **Source account attributes** | Direct source attributes (if no mapping)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `$firstname`, `$lastname`, `$hireDate`                                     |
| **Identity attributes**       | When Include identities = Yes. `$identity.name` is the root identity name. `$name` falls back to the identity name for identity-based accounts when no mapped attribute named `name` exists.                                                                                                                                                                                                         
                                                                                                                                                                                                               | `$identity.name`, `$identity.employeeNumber`, `$name`                      |
| **$accounts**                 | Managed account snapshots: source **`attributes`** plus nested **`source`** (`id`, `name` — managed accounts only for `id`), nested **`schema`** (`id` = native identity, `name` = display name), and **`IIQDisabled`**. The top-level **`$originAccount`** is the composite `sourceId::nativeIdentity` key for the origin row only. Ordered by configured source order, then account insertion order within each source, then unknown sources appended. If `mainAccount` contains a valid managed account key, that account is moved to index 0. | `$accounts[0].source.name`, `$accounts[0].schema.name`, `$accounts[0].schema.id` |
| **$sources**                  | Map of source name → list of managed account snapshots (the same shape as `$accounts[]` entries). Access with `$sources.get('SourceName')` (dot access is not supported on a Map).                                                                                                                                                                                                                                                                                                                                                                 | `$sources.get("Workday")`                                                  |
| **$previous**                 | Previous generated account state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `$previous.username`                                                       |
| **$originSource**             | Source that originally created the Fusion account (when available)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `Identities`, `Workday`                                                    |
| **$originAccount**            | String id of the identity or managed account that originally created the Fusion account (same as the `originAccount` attribute). For managed origins this is the composite `sourceId::nativeIdentity`; for identity origins this is the identity id.                                                                                                                                                                                                                                                                                              | Use as a scalar in expressions                                             |
| **$account**                  | Snapshot for the origin only: same shape as `$accounts[]` entries when the origin is a managed account; when the origin is **Identities** and identity attributes are available, identity-backed fields are used first (then synthetic identity row if needed). Use **`$originAccount`** for the composite key or identity id string. Identity-backed rows use **`source.name`** = **`Identities`** (no `source.id`) and **`schema`** for display name and id; `$account.name` is also available for identity-backed rows. Note: `$account` is the origin snapshot — when `mainAccount` points elsewhere, `$accounts[0]` will differ from `$account`. | `$originAccount`, `$account.schema.name`, `$account.source.name`, `$account.name` |
| **Special variables**         | `$counter` (Unique type, collision mode renders empty on first try, padded suffix on subsequent attempts; auto-append is skipped when the expression uses Velocity directives), `$UUID` (Unique type, fresh v4 per attempt when referenced), `$isUnique(value)` (Unique type, returns true if the value is not already registered) | `$counter` in expression for Unique type                                   |

### Available utilities

#### $Math (JavaScript Math object)

Standard mathematical operations (`$Math.round(x)`, `$Math.floor(x)`, `$Math.ceil(x)`, `$Math.max(a, b)`, `$Math.min(a, b)`, `$Math.abs(x)`).

#### $Datefns (date-fns library)

Advanced date formatting and manipulation (`$Datefns.format(date, format)`, `$Datefns.parse(date, format)`, `$Datefns.addDays(date, n)`, `$Datefns.differenceInDays(date1, date2)`, etc.).

#### $AddressParse (address parsing)

Parse and normalize US addresses (`$AddressParse.getCityState(city)`, `$AddressParse.parse(address)`).

#### $Normalize (data normalization)

Standardize common data formats (`$Normalize.phone(number)`, `$Normalize.date(date)`, `$Normalize.name(name)`).
`Normalize.phone` also accepts an optional default country code for local numbers, for example: `$Normalize.phone($phone, "GB")`. If the phone string already includes an international prefix (for example `+1`), that explicit prefix is used instead of the default.
For ambiguous numeric dates, `Normalize.date` accepts an optional priority argument:
`$Normalize.date($birthDate, "dd-MM-yyyy,MM-dd-yyyy")` (default) or
`$Normalize.date($birthDate, "MM-dd-yyyy,dd-MM-yyyy")`.

---

## Order of operations

Understanding the sequence helps design correct configurations:

| Step | Phase                 | Action                                                | Example                                                                                |
| ---- | --------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1    | **Attribute Mapping** | Merge per mapping rules (MAP)                         | Map `[title, jobTitle]` → `jobTitle`, merge: first found → "Engineer"                  |
| 2    | **Normal Define**     | Generate non-unique attributes from mapped data       | Generate `fullName` from `$firstname $lastname` → "John Smith"                         |
| 3    | **Match / Scoring**   | Compare normal attributes against existing identities | Normal attributes feed into Match scoring                                              |
| 4    | **Unique Define**     | Generate unique attributes with collision detection   | Generate `username` from `$firstname.$lastname` → "jsmith" (or "jsmith1" on collision) |

**Key insights:**

- Normal attribute definitions run **before** Match matching. Their output is available to the scoring engine and to unique definitions.
- Unique attribute definitions run **after** all Match matching has completed (as a global pass over every account). They can reference normal attribute values but not the other way around.
- Attribute Definition expressions can reference attributes created by Attribute Mapping. Ensure mapped attributes exist before referencing in expressions.

---

## nativeIdentity and account name immutability

The `nativeIdentity` (account identifier) and account `name` (display attribute) are **set at creation time and never changed afterwards**, even if an attribute definition would otherwise overwrite them.

- If you define a **unique attribute** that maps to the same schema attribute as the fusion identity attribute, it will only be generated once (at account creation). Subsequent aggregations and enable/disable cycles will not change it for identity-linked accounts.
- Use a **UUID** unique attribute as native identity when you need a truly immutable, stable reference.

### Unique attribute reset on enable/disable

Use regular unique attribute schemas to define attributes you may want to change, like usernames or email aliases. Disabling and then re-enabling a Fusion account triggers a **unique attribute reset**:

- **Disable**: preserves all existing unique attribute values.
- **Enable**: resets and regenerates all unique attribute values, ensuring collision-free values after the account has been inactive.

---

## Customizer hooks for unique generation

Unique generation exposes two [SaaS Connectivity customized operations](https://developer.sailpoint.com/docs/connectivity/saas-connectivity/customizers/customized-operation), so a customizer can supply unique values that Velocity cannot express — a lookup against an external system, for example.

| Operation identifier                    | Fires                                     | Effect of returning a value          |
| --------------------------------------- | ----------------------------------------- | ------------------------------------ |
| `IdentityFusion:BeforeUniqueGeneration` | Before the connector generates a value    | Generation is skipped entirely       |
| `IdentityFusion:AfterUniqueGeneration`  | After the connector generated a value     | Replaces the generated value         |

Both identifiers are **stable** — the attribute being generated arrives in the payload as `attributeName`, so one handler serves every configured unique attribute.

### Writing a handler

Customizers are a **separate artifact** from the connector, built with `createConnectorCustomizer()` and attached to the source. Nothing in this connector registers handlers.

```typescript
import { createConnectorCustomizer } from '@sailpoint/connector-sdk'

export const customizer = async () =>
    createConnectorCustomizer().customizedOperation('IdentityFusion:BeforeUniqueGeneration', async (context, input) => {
        if (input.attributeName === 'uid') {
            input.value = `${input.account.attributes.firstName}.${input.account.attributes.lastName}`.toLowerCase()
        }
        return input
    })
```

Set `value` on the input and return it (returning a bare string also works). Return the input untouched — or omit the handler — and the connector generates the value as usual.

### Payload

```typescript
{
    attributeName: string          // which unique attribute is being generated
    definition: {...}              // the configured unique attribute definition
    account: {
        name, nativeIdentity, sourceName, identityId,
        originSource, originAccountId, isIdentity, needsReset,
        attributes                 // current fusion attributes
    }
    renderContext: {...}           // Velocity variables, function values removed
    registeredValueCount: number   // how many values are already taken
    generatedValue?: string        // AfterUniqueGeneration only
}
```

The full set of used values is **not** sent — it can hold tens of thousands of entries per attribute. Use `$isUnique` in the expression, or `registeredValueCount`, if you need a sense of scale.

### Rules and limits

Once a handler returns a value it is the **authoritative source** for that attribute, and the connector does not second-guess it:

- **Collision detection does not apply to a returned value.** If it is already in use the connector keeps it anyway and logs the reuse at info level. Deliberately reusing a value — deriving several accounts from one authoritative identifier, for example — is a supported outcome. Uniqueness is your handler's responsibility; use `$isUnique` in the expression instead if you want the connector to enforce it.
- **Transforms are not applied** to a returned value. `case`, `trim`, `spaces`, `normalize`, and `maxLength` shape connector-generated values only.
- **Empty or non-string returns are ignored**, falling back to normal generation.
- **Handler errors never fail an aggregation.** They are logged and treated as "no override".
- **The hooks are inert without a customizer.** `customizedOperation` is injected onto the context by the ISC runtime only when a customizer is attached to the source, so these hooks do nothing during local `spcx run` and cost nothing when unused.
- The hooks fire once per account per unique attribute, inside the per-attribute generation lock. A slow handler will slow aggregation proportionally.

---

## Preventing Fusion account creation (empty nativeIdentity skip pattern)

One can purposely generate an **empty** `nativeIdentity` in conjunction with the **"Skip accounts with a missing identifier"** processing option to prevent specific managed accounts or identities from generating Fusion accounts.

1. Define an attribute definition (normal or unique) that maps to the fusion identity attribute.
2. Design the expression so it evaluates to an empty string for accounts you want to exclude.
3. Enable **"Skip accounts with a missing identifier"** in Processing Control settings.

```velocity
## Example: only generate identity for accounts with an email
#if($email && $email != "")
  $email
#end
```

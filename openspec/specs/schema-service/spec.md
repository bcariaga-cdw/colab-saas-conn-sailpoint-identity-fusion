# schema-service Spec

## Purpose

The schema service (`src/services/schemaService/`) defines the connector's account schemas. It owns the `AccountSchema` and `SchemaAttribute` types, the `fusionAccountSchemaAttributes` catalog in `src/data/schema.ts`, and the `FusionAttribute` TypeScript enum that mirrors it. The enum must be a string-valued mirror of the catalog (excluding `name` and `id`) so that code can refer to attributes by a stable, type-checked symbol. This spec defines the contract between the catalog data, the enum, and the schema descriptions the connector advertises to SailPoint.
## Requirements
### Requirement: FusionAttribute enum exists

The connector MUST export a TypeScript `enum` named `FusionAttribute` from `src/data/schema.ts`. The enum MUST be string-valued, and the runtime value of each member MUST equal the `name` of a corresponding entry in `fusionAccountSchemaAttributes`. The enum MUST NOT include `name` or `id`.

#### Scenario: Every member is a string with the expected value

- **WHEN** a developer inspects `FusionAttribute.MissingAccounts`
- **THEN** its value is the string `"missing-accounts"`
- **AND** the same is true for every other member of the enum

#### Scenario: The enum contains the eleven current default attributes

- **WHEN** a developer iterates the enum members
- **THEN** it contains exactly: `History`, `Statuses`, `Actions`, `Accounts`, `MissingAccounts`, `Reviews`, `Sources`, `MainAccount`, `OriginSource`, `OriginAccount`, `IdentityId`

#### Scenario: The enum excludes the structural identity keys

- **WHEN** a developer inspects the enum members
- **THEN** it does NOT contain `name` or `id` (those are SDK structural keys, not default attribute references)

### Requirement: Internal call sites use the enum

Every internal call site that reads, writes, or otherwise references a default Fusion schema attribute name in production code MUST pass a `FusionAttribute` member instead of a raw string literal. This includes `attributeToSet` arguments, attribute-bag `bag[...]` keys, `readPathString` path elements that name a default attribute, and the `groupAttribute` field in the dynamic schema builder.

#### Scenario: Production code references the enum for reads

- **WHEN** the connector reads the persisted `missing-accounts` collection during `FusionAccount.fromFusionAccount`
- **THEN** the call is `attributeToSet(attributes, FusionAttribute.MissingAccounts)`
- **AND** the same pattern is used for `History`, `Statuses`, `Actions`, `Accounts`, `Reviews`, `Sources`, `MainAccount`, `OriginSource`, `OriginAccount`, and `IdentityId` at every site that currently uses a raw string

#### Scenario: Production code references the enum for writes

- **WHEN** the connector syncs collection state into the attribute bag via `syncCollectionAttributesToBag`
- **THEN** each `bag[...]` write uses `bag[FusionAttribute.<Member>]` instead of a quoted string

#### Scenario: Dynamic schema builder references the enum

- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the `groupAttribute` field is set to `FusionAttribute.Actions`

#### Scenario: Test fixtures simulating persisted data still use string literals

- **WHEN** a unit test constructs a persisted fusion account with an `accounts: ['src-a::user-1']` or `missing-accounts: ['src-a::missing-1']` array read from storage
- **THEN** the array may still be a `string[]` literal because the test is simulating deserialized data, not invoking the production code path

### Requirement: Enum and schema array cannot drift

A unit test in `src/data/__tests__/schema.test.ts` MUST assert the contract between `FusionAttribute` and `fusionAccountSchemaAttributes`:

- Every enum member's string value MUST equal the `name` of some entry in `fusionAccountSchemaAttributes`.
- The enum MUST have exactly eleven members (the current count, after excluding `name` and `id`).
- The enum MUST NOT contain the string values `"name"` or `"id"`.

#### Scenario: A default attribute is added in only one place

- **WHEN** a developer adds a new entry to `fusionAccountSchemaAttributes` but forgets to add a matching `FusionAttribute` member
- **THEN** the test still passes (the test asserts the enum is a subset of the schema; adding to the schema is allowed without enum change)
- **AND** the developer's code review is expected to catch the missing enum member

#### Scenario: An enum member is added that has no matching schema entry

- **WHEN** a developer adds a new `FusionAttribute` member but forgets to add the matching `fusionAccountSchemaAttributes` entry
- **THEN** the contract test fails with a clear message identifying the orphan value

### Requirement: Platform attribute subset omits attributes absent from the bag

`getFusionAttributeSubset` MUST omit any schema-defined attribute that is absent from the input bag (value `undefined`). It MUST NOT invent keys for schema attributes the input bag does not carry, and it MUST NOT mutate the input bag.

#### Scenario: Unset attribute is omitted from subset

- **GIVEN** a fusion attribute bag where schema attribute `department` is absent (not present on the bag)
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST NOT contain a `department` key

#### Scenario: Internal bag unchanged

- **GIVEN** a fusion attribute bag with `department` set to `null` and `reviews` set to `[]`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the input attribute bag MUST NOT be mutated
- **AND** `department` on the input MUST still be `null`
- **AND** `reviews` on the input MUST still be `[]`
- **AND** only the returned subset object differs from the input bag

### Requirement: Platform attribute subset omits blank strings and empty arrays

`getFusionAttributeSubset` MUST omit a schema attribute whose emitted value is a blank string (`""` or whitespace-only) or an empty array. For a multi-valued attribute it MUST remove blank string elements first and MUST omit the attribute when no elements remain, while still emitting one that has at least one non-blank element without its blank elements. Emptiness MUST be judged with `trim` and MUST NOT rewrite a non-blank string.

#### Scenario: Populated attribute is retained

- **GIVEN** a fusion attribute bag where `name` is `"Ada Wong"`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `name: "Ada Wong"`

#### Scenario: Blank string is omitted

- **GIVEN** a fusion attribute bag where schema attribute `department` is `""`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST NOT contain a `department` key

#### Scenario: Whitespace-only string is omitted

- **GIVEN** a fusion attribute bag where schema attribute `department` is `"   "`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST NOT contain a `department` key

#### Scenario: Surrounding whitespace on a non-blank string is preserved

- **GIVEN** a fusion attribute bag where schema attribute `department` is `"  Finance  "`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `department: "  Finance  "`

#### Scenario: Empty multi-valued array is omitted

- **GIVEN** a fusion attribute bag where `reviews` is `[]`
- **AND** `reviews` is schema-defined as multi-valued
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST NOT contain a `reviews` key

#### Scenario: Multi-valued array of only blank strings is omitted

- **GIVEN** a fusion attribute bag where `reviews` is `["", "  "]`
- **AND** `reviews` is schema-defined as multi-valued
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST NOT contain a `reviews` key

#### Scenario: Mixed multi-valued array drops blank elements

- **GIVEN** a fusion attribute bag where `reviews` is `["ok", "", "  "]`
- **AND** `reviews` is schema-defined as multi-valued
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `reviews: ["ok"]`

### Requirement: Platform attribute subset keeps id and name when blank

`getFusionAttributeSubset` MUST still emit the schema attributes named `id` and `name` when their emitted value is a blank string. Any other schema attribute whose emitted value is a blank string MUST be omitted.

#### Scenario: Blank identity attribute is retained

- **GIVEN** a fusion attribute bag where `id` is `""`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `id: ""`

#### Scenario: Whitespace-only display attribute is retained

- **GIVEN** a fusion attribute bag where `name` is `"   "`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `name: "   "`

#### Scenario: Blank required attribute other than id or name is omitted

- **GIVEN** a fusion attribute bag where `employeeId` is `""`
- **AND** `employeeId` is schema-defined as a required string
- **AND** `employeeId` is not `id` or `name`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST NOT contain an `employeeId` key

### Requirement: Platform attribute subset emits present null and non-empty values

An explicit `null` input MUST NOT be stripped from the platform-facing subset: it is cast per the schema definition and emitted as `null`. Nullish-key omission from the Fusion account attribute bags at build is owned by fusion-service, not by this subset. Boolean `false`, numeric `0`, and any other emitted value that is not a blank string or an empty array MUST still be included. A blank string cast to `0` or `false` by the numeric or boolean cast MUST be included as that cast result.

#### Scenario: Present null attribute is emitted as null

- **GIVEN** a fusion attribute bag where `id` is `null`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `id: null`

#### Scenario: Boolean false is retained

- **GIVEN** a fusion attribute bag where `active` is `false`
- **AND** `active` is schema-defined as boolean
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `active: false`

#### Scenario: Numeric zero is retained

- **GIVEN** a fusion attribute bag where `employeeNumber` is `0`
- **AND** `employeeNumber` is schema-defined as int
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `employeeNumber: 0`

#### Scenario: Blank string on a numeric attribute is emitted as zero

- **GIVEN** a fusion attribute bag where `employeeNumber` is `""`
- **AND** `employeeNumber` is schema-defined as int
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `employeeNumber: 0`

#### Scenario: Blank string on a boolean attribute is emitted as false

- **GIVEN** a fusion attribute bag where `active` is `""`
- **AND** `active` is schema-defined as boolean
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `active: false`

#### Scenario: String zero is retained

- **GIVEN** a fusion attribute bag where schema attribute `department` is `"0"`
- **WHEN** `getFusionAttributeSubset` is called
- **THEN** the returned object MUST contain `department: "0"`

### Requirement: Schema attributes deduplicated case-insensitively

The schema service MUST deduplicate `SchemaAttribute` entries by case-insensitive name. When two or more attributes share the same lowercase name, the service MUST retain the first attribute encountered in processing order and MUST discard all subsequent variants without merging their metadata.

#### Scenario: Managed source and identity attribute name collision

- **GIVEN** a managed source account schema containing attribute `firstname`
- **AND** identity schema attributes containing attribute `FirstName`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the returned schema MUST contain exactly one attribute whose lowercase name is `firstname`
- **AND** that attribute MUST be the first variant encountered in merge order

#### Scenario: Multiple casing variants within one source

- **GIVEN** a managed source account schema containing both `Username` and `username`
- **WHEN** `SchemaService.buildDynamicSchema` constructs the dynamic `AccountSchema`
- **THEN** the returned schema MUST contain exactly one attribute whose lowercase name is `username`
- **AND** that attribute MUST be the first variant from the source attribute list

#### Scenario: Schema ingestion deduplicates input attributes

- **GIVEN** an input `AccountSchema` whose `attributes` array contains both `LastName` and `lastname`
- **WHEN** `SchemaService.setFusionAccountSchema` is called with that schema
- **THEN** internal schema attribute name lists MUST contain exactly one entry whose lowercase name is `lastname`
- **AND** `getFusionAttributeSubset` MUST NOT emit both `LastName` and `lastname` keys for the same logical attribute

#### Scenario: No duplicate lowercase names in output

- **GIVEN** any combination of fusion, managed, identity, mapping, definition, and reverse-correlation attributes with case-insensitive overlaps
- **WHEN** `SchemaService.buildDynamicSchema` returns
- **THEN** no two entries in `attributes` MAY share the same lowercase `name`

### Requirement: Standard schema attribute descriptions require composite managed account keys

The `fusionAccountSchemaAttributes` descriptions for `accounts`, `missing-accounts`, and `originAccount` MUST state that managed source account references use composite managed account keys (`sourceId::nativeIdentity`) only. They MUST NOT describe legacy raw ID or backwards-compatibility support.

#### Scenario: Accounts attribute description is composite-only

- **WHEN** a developer reads the `accounts` entry in `fusionAccountSchemaAttributes`
- **THEN** the description SHALL reference composite managed account keys
- **AND** SHALL NOT mention legacy raw IDs or backwards compatibility

#### Scenario: Missing-accounts attribute description is composite-only

- **WHEN** a developer reads the `missing-accounts` entry in `fusionAccountSchemaAttributes`
- **THEN** the description SHALL reference composite managed account keys
- **AND** SHALL NOT mention legacy raw IDs or backwards compatibility

#### Scenario: OriginAccount attribute description distinguishes identity ID from composite key

- **WHEN** a developer reads the `originAccount` entry in `fusionAccountSchemaAttributes`
- **THEN** the description SHALL state that identity-origin accounts store an identity ID
- **AND** managed-source origins SHALL require a composite managed account key
- **AND** SHALL NOT mention legacy managed source account ID backwards compatibility



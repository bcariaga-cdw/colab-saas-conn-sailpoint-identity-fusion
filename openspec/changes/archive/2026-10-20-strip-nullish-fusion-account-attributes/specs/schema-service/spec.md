## REMOVED Requirements

### Requirement: Fusion attribute subset omits empty values from platform output

**Reason**: Nullish-key omission moved to Fusion account build time (`fusion-service`), so the platform subset no longer strips a present `null`. The contract is restated as three focused requirements: **Platform attribute subset omits attributes absent from the bag**, **Platform attribute subset omits blank strings and empty arrays**, and **Platform attribute subset emits present null and non-empty values**.

**Migration**: Treat a present `null` on the platform subset as emitted (`null`) and a missing key as absent. Connector-built Fusion accounts never carry nullish keys on their attribute bags, so their platform payloads are unchanged. Blank-string and empty-array rules are unchanged.

---

## ADDED Requirements

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

---

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

---

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

---

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

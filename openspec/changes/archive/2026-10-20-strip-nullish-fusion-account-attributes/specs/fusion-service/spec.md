## ADDED Requirements

### Requirement: Fusion account attribute bags omit nullish keys

When a Fusion account is seeded, `attributeBag.current` and `attributeBag.previous` MUST omit every key whose value is `null` or `undefined`. When the current attribute bag is replaced, the installed bag MUST omit those keys again. The seeded and replaced bags MUST keep boolean `false`, numeric `0`, blank strings, and empty arrays. Source snapshots and `attributeBag.identity` MUST NOT be stripped by this rule.

#### Scenario: Seeded current bag omits nullish keys

- **GIVEN** a persisted ISC account whose attributes include `department: null`, `notes: undefined`, and `name: "Ada Wong"`
- **WHEN** a Fusion account is seeded from that account via `FusionAccount.fromFusionAccount`
- **THEN** `attributeBag.current` MUST NOT contain `department`
- **AND** `attributeBag.current` MUST NOT contain `notes`
- **AND** `attributeBag.current` MUST contain `name: "Ada Wong"`

#### Scenario: Seeded previous bag omits nullish keys

- **GIVEN** a persisted ISC account whose attributes include `department: null` and `name: "Ada Wong"`
- **WHEN** a Fusion account is seeded from that account via `FusionAccount.fromFusionAccount`
- **THEN** `attributeBag.previous` MUST NOT contain `department`
- **AND** `attributeBag.previous` MUST contain `name: "Ada Wong"`

#### Scenario: Seeded bag keeps false, zero, blank strings, and empty arrays

- **GIVEN** a persisted ISC account whose attributes include `active: false`, `employeeNumber: 0`, `notes: ""`, and `reviews: []`
- **WHEN** a Fusion account is seeded from that account via `FusionAccount.fromFusionAccount`
- **THEN** `attributeBag.current` MUST contain `active: false`
- **AND** `attributeBag.current` MUST contain `employeeNumber: 0`
- **AND** `attributeBag.current` MUST contain `notes: ""`
- **AND** `attributeBag.current` MUST contain `reviews: []`

#### Scenario: Replacing the current bag omits nullish keys

- **GIVEN** a Fusion account
- **WHEN** its current attribute bag is replaced with `department: null`, `notes: undefined`, and `name: "Ada Wong"`
- **THEN** `attributeBag.current` MUST NOT contain `department`
- **AND** `attributeBag.current` MUST NOT contain `notes`
- **AND** `attributeBag.current` MUST contain `name: "Ada Wong"`

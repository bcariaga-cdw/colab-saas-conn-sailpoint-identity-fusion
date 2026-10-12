## ADDED Requirements

### Requirement: Processing Control toggle for origin-absent main account handoff defaults off

The connector SHALL expose Processing Control toggle `promoteMainAccountWhenOriginMissing` with label "Promote first found managed account to main account when origin account is missing". Help text SHALL state both halves: while enabled, set `mainAccount` to the first live managed account when the origin is not a current contributor, and clear `mainAccount` when the origin is a current contributor again. The connector spec SHALL NOT set an initial value that turns the toggle on. When the key is absent, runtime configuration SHALL read the toggle as off.

#### Scenario: Absent key leaves the toggle off

- **GIVEN** Processing Control settings with no `promoteMainAccountWhenOriginMissing` key
- **WHEN** settings are read
- **THEN** the toggle SHALL be off

#### Scenario: Help text states promote and clear

- **GIVEN** the Processing Control section in the connector spec
- **WHEN** an operator reads the toggle help
- **THEN** the help SHALL state that an enabled toggle sets `mainAccount` to the first live managed account while the origin is not a current contributor
- **AND** the help SHALL state that an enabled toggle clears `mainAccount` when the origin is a current contributor again

### Requirement: processFusionAccount hands mainAccount to the first live managed account while the origin is absent

While `promoteMainAccountWhenOriginMissing` is on, `FusionService.processFusionAccount` SHALL, after the managed-account layer and origin-in-scope resolution and before Map, set `mainAccount` to the first live managed account when the origin is not a current contributor and at least one live managed account remains. The identity bag SHALL NOT be selected. `originAccount` SHALL stay unchanged. A changed value SHALL set `needsRefresh` and SHALL append one history line. An unchanged value SHALL NOT set `needsRefresh` for this rule. The rule SHALL NOT run on `AccountAssembly.assembleAccount`.

#### Scenario: Managed-origin account promotes the first live managed account

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin key is not in `accounts` after this run's blend and prune
- **AND** another managed account is still linked
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be that first live managed account
- **AND** `originAccount` SHALL be unchanged
- **AND** `needsRefresh` SHALL be true so Map follows `mainAccount` in that same run
- **AND** history SHALL include one line for the change

#### Scenario: First live managed account follows configured source order

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin is not a current contributor
- **AND** linked managed accounts on two configured sources
- **AND** `mainAccount` currently names the account on the later source
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL name the account on the earlier configured source

#### Scenario: First live managed account follows blend order within one source

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin is not a current contributor
- **AND** two linked managed accounts on the same source, in blend order
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL name the earlier account in that blend order

#### Scenario: Identity bag is not the first live managed account

- **GIVEN** the toggle is on
- **AND** an identity-origin Fusion account whose origin identity is resolved out of scope
- **AND** at least one managed account is still linked
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL name that first live managed account
- **AND** `mainAccount` SHALL NOT be the identity id
- **AND** the Fusion account SHALL NOT be marked orphan

#### Scenario: No live managed account clears mainAccount

- **GIVEN** the toggle is on
- **AND** a Fusion account whose origin is not a current contributor
- **AND** no managed account is still linked
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared
- **AND** `needsRefresh` SHALL be true

#### Scenario: Unchanged mainAccount does not force refresh

- **GIVEN** the toggle is on
- **AND** a Fusion account whose origin is not a current contributor
- **AND** `mainAccount` is already the first live managed account
- **AND** the account does not otherwise need refresh
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay that account
- **AND** this rule SHALL NOT set `needsRefresh`

### Requirement: processFusionAccount clears mainAccount when the origin is a current contributor

While `promoteMainAccountWhenOriginMissing` is on, `processFusionAccount` SHALL clear `mainAccount` before Map when the origin is a current contributor, including a value an operator stored. Clearing SHALL remove the value. A changed value SHALL set `needsRefresh` and SHALL append one history line.

#### Scenario: Managed-origin account clears a stored mainAccount while the origin key remains

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin key is still in `accounts`
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared before Map
- **AND** `needsRefresh` SHALL be true

#### Scenario: Identity-origin account clears mainAccount when the origin identity is in scope

- **GIVEN** the toggle is on
- **AND** an identity-origin Fusion account whose origin identity is resolved in scope
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared

#### Scenario: Origin returns on a later run and clears mainAccount

- **GIVEN** the toggle is on
- **AND** a Fusion account whose `mainAccount` was set to a live managed account while the origin was not a current contributor
- **AND** on this run the origin is a current contributor again
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared

### Requirement: Skipped refresh and an unresolved scope check do not count as origin-absent

`processFusionAccount` SHALL NOT treat a missing origin snapshot as the origin being absent when this run did not rebuild the contributor list. `processFusionAccount` SHALL NOT treat unresolved `originIdentityInScope` as the origin being absent. While the toggle is off, or the key is absent, `processFusionAccount` SHALL leave `mainAccount` unchanged.

#### Scenario: Toggle off leaves mainAccount unchanged when the origin key is gone

- **GIVEN** the toggle is off
- **AND** a managed-origin Fusion account whose origin key is not in `accounts`
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be unchanged

#### Scenario: Absent key leaves mainAccount unchanged

- **GIVEN** Processing Control has no `promoteMainAccountWhenOriginMissing` key
- **AND** a Fusion account whose origin is not a current contributor
- **AND** `mainAccount` is unset
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay unset

#### Scenario: Skipped refresh does not promote from a missing origin snapshot

- **GIVEN** the toggle is on
- **AND** this run did not rebuild the contributor list
- **AND** the origin key is still in `accounts`
- **AND** the origin snapshot is not loaded
- **AND** `mainAccount` is unset
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay unset

#### Scenario: Unresolved identity scope does not change mainAccount

- **GIVEN** the toggle is on
- **AND** an identity-origin Fusion account whose `originIdentityInScope` is unresolved
- **AND** `mainAccount` is set
- **AND** a managed account is still linked
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be unchanged

#### Scenario: Turning the toggle off leaves a previously promoted mainAccount in place

- **GIVEN** the toggle is off
- **AND** `mainAccount` already names a live managed account from an earlier run when the toggle was on
- **AND** the origin is a current contributor on this run
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay that live managed account

### Requirement: An explicit attribute map can replace mainAccount after the handoff

An explicit attribute map that writes `mainAccount` in the same Map SHALL replace the value this rule wrote. The value that persists SHALL be the map's value.

#### Scenario: Explicit map wins over the handoff in the same run

- **GIVEN** the toggle is on
- **AND** the origin is not a current contributor
- **AND** an explicit attribute map writes `mainAccount`
- **WHEN** `processFusionAccount` runs
- **THEN** the persisted `mainAccount` SHALL be the value the map wrote
- **AND** the handoff value SHALL have been applied before that Map

## ADDED Requirements

### Requirement: Glossary defines first live managed account

The ubiquitous-language glossary SHALL define **first live managed account** as the first managed-source account still linked on the Fusion account, in configured source order, then blend order within a source. The identity bag SHALL NOT be a first live managed account. The entry SHALL NOT use this name for the First found merge strategy, for the origin account, or for `mainAccount`.

#### Scenario: Glossary entry for first live managed account

- **GIVEN** a reader consults the ubiquitous-language glossary
- **WHEN** they look up which managed account is chosen when the origin is not a current contributor
- **THEN** it SHALL contain a **first live managed account** entry
- **AND** the entry SHALL state the order is configured source order, then blend order within a source
- **AND** the entry SHALL state the identity bag is not one

### Requirement: Glossary defines origin not a current contributor

The ubiquitous-language glossary SHALL define **origin not a current contributor** as follows. For a managed-origin Fusion account, the origin key is not in `accounts` after this run's blend and prune. For an identity-origin Fusion account, the origin identity is resolved out of scope. An unresolved scope check SHALL NOT be this state. A missing origin snapshot when refresh was skipped SHALL NOT be this state. The entry SHALL NOT use this name for an uncorrelated key in `missing-accounts`, or for designated snapshot unavailable.

#### Scenario: Glossary entry for origin not a current contributor

- **GIVEN** a reader consults the ubiquitous-language glossary
- **WHEN** they look up when the origin no longer contributes to the Fusion account
- **THEN** it SHALL contain an **origin not a current contributor** entry
- **AND** the entry SHALL distinguish a managed-origin key missing from `accounts` from an identity-origin identity resolved out of scope
- **AND** the entry SHALL exclude an unresolved scope check and a skipped refresh whose origin snapshot was not loaded

### Requirement: Glossary Processing Control entry includes the origin-absent main account handoff

The ubiquitous-language glossary **Processing Control** entry SHALL remain the Source Settings section for account maintenance. It SHALL keep history retention, empty-account deletion, and missing-identifier behavior, and SHALL also name the origin-absent main account handoff toggle (`promoteMainAccountWhenOriginMissing`). This SHALL NOT add a new section name.

#### Scenario: Processing Control entry names the handoff toggle

- **GIVEN** a reader consults the ubiquitous-language glossary
- **WHEN** they look up Processing Control
- **THEN** the **Processing Control** entry SHALL list history retention, empty-account deletion, missing-identifier behavior, and the origin-absent main account handoff
- **AND** the entry SHALL name `promoteMainAccountWhenOriginMissing`

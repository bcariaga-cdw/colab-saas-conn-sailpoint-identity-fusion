# account-discover-schema Spec

## Purpose

The account-discover-schema operation returns the account schema used by ISC. This spec defines the contract for schema discovery behavior.

## Requirements

### Requirement: Schema discovery returns account schema

The account-discover-schema operation SHALL fetch all configured sources and build a dynamic Fusion account schema from attribute definitions, attribute mappings, and managed account source schemas in that order, plus identity schema attributes when identity scope is enabled, then return that schema via `res.send`.

#### Scenario: Successful schema discovery

- **GIVEN** a valid connector configuration with managed sources and attribute definitions
- **WHEN** the account-discover-schema operation is invoked
- **THEN** the connector SHALL fetch all sources
- **AND** SHALL build the dynamic account schema via `buildDynamicSchema()`
- **AND** SHALL return the complete account schema with all attribute definitions

#### Scenario: Schema discovery with custom attributes

- **GIVEN** normal and unique attribute definitions configured in connector settings
- **WHEN** the account-discover-schema operation is invoked
- **THEN** the returned schema SHALL include attributes derived from those definitions

#### Scenario: Schema discovery follows the attribute-source order

- **GIVEN** attribute definitions, attribute mappings, and managed source schemas that define the same logical attribute with different casing
- **WHEN** the account-discover-schema operation is invoked
- **THEN** the returned schema SHALL contain exactly one attribute for that logical name
- **AND** it SHALL be derived from the attribute definition
- **AND** when identity scope is enabled, identity schema attributes SHALL be considered only after managed account source schemas

### Requirement: Discovered schema has no case-insensitive duplicate attribute names

The account-discover-schema operation MUST return a schema whose attribute list contains at most one entry per case-insensitive attribute name.

#### Scenario: Discover schema after merging identity and managed attributes

- **GIVEN** configured managed sources and identity attributes that define the same logical attributes with different casing (e.g. `FirstName` vs `firstname`)
- **WHEN** the account-discover-schema operation is invoked
- **THEN** the returned schema MUST NOT contain both `FirstName` and `firstname`
- **AND** the returned schema MUST contain exactly one attribute for each logical name

#### Scenario: Discover schema acceptable to ISC API

- **GIVEN** a connector deployment where schema discovery previously failed due to case-insensitive duplicate attribute names
- **WHEN** the account-discover-schema operation is invoked with the fixed connector
- **THEN** the returned schema MUST be valid for ISC schema registration (no case-insensitive name collisions)

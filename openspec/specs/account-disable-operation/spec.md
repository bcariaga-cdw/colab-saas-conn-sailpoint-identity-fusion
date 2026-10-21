# account-disable Spec

## Purpose

The account-disable operation disables an existing account. This spec defines the contract for account disablement behavior.
## Requirements
### Requirement: Account disable rebuilds with REFRESH and preserves unique values

The account-disable operation SHALL rebuild the target Fusion account with attribute operations REFRESH (remap and redefine without unique reset), calculate blank Unique attributes, mark the Fusion account disabled, and return the ISC Fusion account representation. Populated Unique attribute values SHALL be preserved during disable; full unique regeneration SHALL occur on a subsequent account-enable operation. Calculating a blank Unique attribute SHALL NOT fetch or pre-process all Fusion accounts.

#### Scenario: Successful disable preserves unique values

- **GIVEN** an enabled Fusion account with established unique attribute values
- **WHEN** the account-disable operation is invoked
- **THEN** the connector SHALL rebuild with attribute operations REFRESH
- **AND** SHALL NOT reset unique attribute definitions during disable
- **AND** SHALL mark the Fusion account disabled
- **AND** SHALL return the ISC account via `res.send`

#### Scenario: Blank unique attribute is calculated without a tenant fetch

- **GIVEN** an enabled Fusion account with a blank Unique attribute
- **WHEN** the account-disable operation is invoked
- **THEN** the connector SHALL calculate the blank Unique attribute
- **AND** SHALL NOT fetch or pre-process all Fusion accounts
- **AND** SHALL NOT reset Unique attributes that already have a value

#### Scenario: Missing identity fails with observable message

- **GIVEN** account-disable input without an identity value
- **WHEN** the account-disable operation is invoked
- **THEN** the operation SHALL fail with message `Account identity is required`

#### Scenario: Fusion account not found fails with observable message

- **GIVEN** disable input referencing an identity with no Fusion account
- **WHEN** the account-disable operation is invoked
- **THEN** the operation SHALL fail with a message matching `Fusion account not found for identity: <identity>`

### Requirement: Account disable does not pre-process all Fusion accounts

Unlike account-enable, the account-disable operation SHALL NOT fetch and pre-process all Fusion accounts before rebuilding the target account, including when a Unique attribute is blank.

#### Scenario: Disable skips global preprocess

- **GIVEN** multiple Fusion accounts exist in the tenant
- **WHEN** the account-disable operation is invoked for one identity
- **THEN** the connector SHALL NOT require a global pre-process pass of all Fusion accounts


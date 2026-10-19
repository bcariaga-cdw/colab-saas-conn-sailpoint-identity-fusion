## ADDED Requirements

### Requirement: Successful Fusion review form definition deletes are retained once

During an operation run, the system SHALL retain each Fusion review form definition whose delete succeeds, once per form definition id. Retention SHALL include Reset forms, completed or cancelled review cleanup, and a definition deleted so it can be recreated. When the delete caller has the form definition name, the retained record SHALL include that name.

#### Scenario: Reset forms retains the deleted definition name

- **GIVEN** Reset forms deletes a Fusion review form definition whose name is known
- **WHEN** that delete succeeds
- **THEN** the run SHALL retain that definition once
- **AND** the retained record SHALL include the form definition name

#### Scenario: Cleanup delete is retained

- **GIVEN** a completed or cancelled Fusion review form definition is deleted by review cleanup
- **WHEN** that delete succeeds
- **THEN** the run SHALL retain that definition for the aggregation report

#### Scenario: Replace-before-recreate delete is retained

- **GIVEN** a Fusion review form definition is deleted so a replacement can be created
- **WHEN** that delete succeeds
- **THEN** the run SHALL retain that definition for the aggregation report

#### Scenario: The same definition is retained once

- **GIVEN** the same Fusion review form definition id is successfully deleted more than once on the run
- **WHEN** the run prepares data for the aggregation report
- **THEN** that form definition id SHALL appear once

### Requirement: Failed deletes and cancelled instances are not retained as deletions

A failed Fusion review form definition delete SHALL NOT be retained. Cancelling a leftover form instance SHALL NOT be retained as a deleted definition.

#### Scenario: Failed delete is not retained

- **GIVEN** a Fusion review form definition delete fails
- **WHEN** the run prepares data for the aggregation report
- **THEN** that definition SHALL NOT be retained as deleted

#### Scenario: Cancelled instance is not a deletion

- **GIVEN** Reset forms cancels a leftover form instance and deletes its form definition
- **WHEN** the run prepares data for the aggregation report
- **THEN** the cancelled instance SHALL NOT be retained as a deleted Fusion review form definition
- **AND** the deleted definition SHALL be retained

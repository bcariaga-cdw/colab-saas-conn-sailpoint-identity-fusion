## ADDED Requirements

### Requirement: Aggregation report lists Fusion Review Deletions last

When an aggregation report is rendered for a run that successfully deleted one or more Fusion review form definitions, the report SHALL end with a **Fusion Review Deletions** section. Each deleted definition SHALL appear once, by form definition name, after the Fusion Reviews account cards.

#### Scenario: Deleted definitions are the last section

- **GIVEN** a persistent aggregation successfully deleted two Fusion review form definitions
- **AND** those definitions have names
- **WHEN** the aggregation report is rendered
- **THEN** the last section SHALL be **Fusion Review Deletions**
- **AND** it SHALL list both form definition names
- **AND** it SHALL appear after the Fusion Reviews account cards

### Requirement: Fusion Review Deletions row uses the form definition id when the name is missing

A Fusion Review Deletions row SHALL show the form definition id when the form definition name was not captured.

#### Scenario: Missing name shows the form definition id

- **GIVEN** a persistent aggregation successfully deleted one Fusion review form definition
- **AND** the form definition name was not captured
- **WHEN** the aggregation report is rendered
- **THEN** the Fusion Review Deletions row SHALL show that form definition id

### Requirement: Fusion Review Deletions is omitted when nothing was deleted

The report SHALL omit **Fusion Review Deletions** when no Fusion review form definition was successfully deleted. A dry-run report and a Fusion report SHALL omit the section when their deletion list is empty.

#### Scenario: No deletions omits the section

- **GIVEN** a persistent aggregation deleted no Fusion review form definitions
- **WHEN** the aggregation report is rendered
- **THEN** the report SHALL NOT contain a Fusion Review Deletions section

#### Scenario: Dry-run report without deletions omits the section

- **GIVEN** a dry-run report whose deletion list is empty
- **WHEN** the dry-run report is rendered
- **THEN** the report SHALL NOT contain a Fusion Review Deletions section

### Requirement: Fusion Review Deletions heading follows the recipient locale

When localization is enabled, the **Fusion Review Deletions** heading SHALL use the recipient locale’s translation. The row SHALL keep the stored form definition name.

#### Scenario: Localized heading keeps stored form names

- **GIVEN** localization is enabled and the aggregation report recipient locale is Spanish
- **AND** the aggregation successfully deleted a Fusion review form definition
- **WHEN** the aggregation report is rendered
- **THEN** the section heading SHALL be the Spanish translation of **Fusion Review Deletions**
- **AND** the row SHALL show the stored form definition name

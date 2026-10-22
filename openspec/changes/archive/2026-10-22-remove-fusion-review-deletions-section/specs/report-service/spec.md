## ADDED Requirements

### Requirement: Aggregation report has no Fusion Review Deletions section

The aggregation report SHALL NOT include a **Fusion Review Deletions** section for any run. Report rendering SHALL NOT depend on deleted Fusion review form definitions.

#### Scenario: Aggregation report omits the section after deletions

- **GIVEN** a persistent aggregation that successfully deleted one or more Fusion review form definitions
- **WHEN** the aggregation report is rendered
- **THEN** the report SHALL NOT contain a Fusion Review Deletions section

#### Scenario: Fusion report and dry-run report omit the section

- **GIVEN** a Fusion report or a dry-run report is rendered
- **WHEN** the report HTML is produced
- **THEN** the report SHALL NOT contain a Fusion Review Deletions section

---

## REMOVED Requirements

### Requirement: Aggregation report lists Fusion Review Deletions last

**Reason**: The aggregation report no longer renders a Fusion Review Deletions section.

**Migration**: Read connector logs or ISC Custom Forms for Fusion review form definition deletion history.

### Requirement: Fusion Review Deletions row uses the form definition id when the name is missing

**Reason**: The row no longer exists.

**Migration**: None; no row is rendered.

### Requirement: Fusion Review Deletions is omitted when nothing was deleted

**Reason**: The section is removed for every run, not only runs that deleted nothing.

**Migration**: None; the section is never rendered.

### Requirement: Fusion Review Deletions heading follows the recipient locale

**Reason**: The heading and its `fusion_review_deletions` locale strings are removed.

**Migration**: None; no localized heading remains.

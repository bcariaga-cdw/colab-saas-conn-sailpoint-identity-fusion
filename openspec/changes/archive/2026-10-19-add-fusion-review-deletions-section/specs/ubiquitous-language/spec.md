## ADDED Requirements

### Requirement: Glossary defines Fusion Review Deletions

The ubiquitous-language glossary SHALL define **Fusion Review Deletions** as the last section of an aggregation report. It names the Fusion review form definitions deleted during that aggregation. It SHALL NOT be a separate report, and it SHALL NOT list cancelled form instances. Documentation and specs SHALL NOT call it a deleted forms report, a form cleanup section, or a Reset forms log.

#### Scenario: Glossary lists Fusion Review Deletions

- **WHEN** the glossary is consulted for aggregation report sections
- **THEN** it SHALL contain **Fusion Review Deletions**
- **AND** SHALL define it as the last section of an aggregation report listing Fusion review form definitions deleted during that aggregation
- **AND** SHALL NOT define it as a report of its own or as a list of cancelled form instances

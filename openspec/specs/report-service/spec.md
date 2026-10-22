# report-service Spec

## Purpose

The report service resolves account identifiers for report links, mapping Fusion accounts and managed account keys to their canonical ISC account IDs, and provides a unified interface for report generation, rendering, directory management, and email delivery.

## Requirements

### Requirement: Unified report building, rendering, and directory management

The Report module MUST provide a consolidated interface for creating report payloads, rendering report HTML outputs via `EmailService`, managing output directories (`mkdir`), resolving recipient identity owners via `IdentityService`, and delivering reports. Dry-run reports SHALL use `includeNonMatches: false` (consolidated counters only, matching the default aggregation report behavior) and SHALL render through the same Handlebars template and email delivery path. When localization is enabled, report rendering MUST resolve locale via `resolveEffectiveLocale` for the primary recipient (identity language attribute, then `defaultLanguage`, then `'en'`). Review form locale is owned by the form service (reviewer locale) and is out of scope for report rendering.

#### Scenario: End-to-end report generation and directory creation

- **GIVEN** report target parameters and payload data
- **WHEN** `ReportService.generateReport` or `deliverReport` is called
- **THEN** the required destination directory is created if missing
- **AND** the report document is built, rendered to HTML via `EmailService` with the resolved locale when localization is enabled, and saved to disk
- **AND** delivery email is dispatched to recipient owners with a localized subject when localization is enabled

#### Scenario: Dry-run report uses aggregation report alignment

- **GIVEN** a dry-run mode execution has completed
- **WHEN** the dry-run report is generated
- **THEN** non-matched accounts SHALL appear as consolidated counters in the report stats, not as per-account rows
- **AND** the report SHALL use the same Handlebars template and `FusionReportEmailData` shape as the aggregation report
- **AND** the report title SHALL be `'Identity Fusion Dry Run Report'` when localization is disabled
- **AND** the report title MUST use the localized dry-run title when localization is enabled and a translation key exists
- **AND** the title SHALL remain distinct from the aggregation report title and the Fusion report title

### Requirement: Report titles distinguish dry-run, Fusion, and aggregation reports
Rendered HTML and email subjects MUST use distinct titles for the **dry-run report**, **Fusion report**, and **aggregation report**. All three MUST use the same Handlebars template family and `FusionReportEmailData` shape. When localization is disabled, the dry-run report title MUST be `'Identity Fusion Dry Run Report'`, the Fusion report title MUST be `'Identity Fusion Report'`, and the aggregation report title MUST be `'Identity Fusion Aggregation Report'`. When localization is enabled, each title MUST use its own translation key.

#### Scenario: Aggregation report title is not the Fusion report title
- **GIVEN** localization is disabled
- **WHEN** an aggregation report email is delivered
- **THEN** the rendered title MUST be `'Identity Fusion Aggregation Report'`
- **AND** MUST NOT be `'Identity Fusion Report'`

#### Scenario: Fusion report title is Identity Fusion Report
- **GIVEN** localization is disabled
- **WHEN** a Fusion report email is delivered after the `report` action
- **THEN** the rendered title MUST be `'Identity Fusion Report'`

### Requirement: Fusion report is the same Match preview as the dry-run report
A Fusion report MUST use `includeNonMatches: false` (consolidated non-match counters) and MUST include the same Match preview slices as a dry-run report for the same in-memory tracker (identity matches, deferred matches, failed matching entries). Recipients MUST be global owners. The Fusion report MUST NOT persist Fusion outcomes.

#### Scenario: Fusion report and dry-run report share Match cards
- **GIVEN** the same Match tracker slices from a non-persistent preview run
- **WHEN** a Fusion report is rendered
- **THEN** potential-match account cards SHALL match a dry-run report built from that tracker
- **AND** non-matched accounts SHALL appear as consolidated counters, not per-account rows

### Requirement: Resolve report account ID from a FusionAccount
The `resolveReportAccountId` function SHALL return the ISC account ID to use in report links for a given `FusionAccount`, preferring the stored ISC id and falling back to resolving the managed account key via `SourceService`.

#### Scenario: FusionAccount has a stored ISC account id
- **WHEN** `fusionAccount.iscAccountId` is set
- **THEN** `resolveReportAccountId` MUST return that value without calling `SourceService`

#### Scenario: FusionAccount has no ISC account id but has a managed account key
- **WHEN** `fusionAccount.iscAccountId` is missing and `fusionAccount.managedAccountId` is present
- **THEN** `resolveReportAccountId` MUST call `SourceService.resolveIscAccountIdForManagedKey` with the managed key and return the resolved id

#### Scenario: FusionAccount has neither id
- **WHEN** both `fusionAccount.iscAccountId` and `fusionAccount.managedAccountId` are missing
- **THEN** `resolveReportAccountId` MUST return `undefined`

---

### Requirement: Resolve report account ID from a managed account key
The `resolveReportAccountIdValue` function SHALL resolve an arbitrary account id value to an ISC account id using `SourceService`, returning `undefined` for empty inputs.

#### Scenario: Raw value is a managed account key
- **WHEN** the input value is a non-empty managed account key
- **THEN** `resolveReportAccountIdValue` MUST call `SourceService.resolveIscAccountIdForManagedKey` and return the resolved id

#### Scenario: Raw value is empty
- **WHEN** the input value is `undefined` or empty
- **THEN** `resolveReportAccountIdValue` MUST return `undefined` without calling `SourceService`

### Requirement: Localized report rendering and delivery

When `enableLocalization` is enabled, `ReportService` MUST resolve the effective locale for report recipients and MUST pass that locale to report HTML rendering and email subjects.

#### Scenario: Aggregation report uses recipient locale

- **GIVEN** `enableLocalization` is `true`
- **AND** the primary report recipient identity resolves to locale `'es'`
- **WHEN** `ReportService` delivers an aggregation report email
- **THEN** `renderFusionReportHtml` MUST receive locale `'es'`
- **AND** the rendered HTML MUST contain Spanish translations for i18n template keys
- **AND** the email subject MUST be localized

#### Scenario: Dry-run report uses recipient locale

- **GIVEN** `enableLocalization` is `true`
- **AND** a dry-run report is generated with email delivery enabled
- **WHEN** the report HTML is rendered
- **THEN** the effective recipient locale MUST be applied the same way as aggregation reports

#### Scenario: Localization disabled for reports

- **GIVEN** `enableLocalization` is `false` or unset
- **WHEN** `ReportService` renders any report
- **THEN** the effective locale MUST be `'en'`

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

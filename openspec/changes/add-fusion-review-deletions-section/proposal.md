## Why

An aggregation report tells owners what the run matched and decided, but it never says which Fusion review form definitions that run deleted. Reset forms, completed-review cleanup, and a definition deleted so it can be recreated all remove reviews with no line in the email. Owners then cannot tell which reviews disappeared on that aggregation. The next aggregation report should list those deletions in their own last section.

## What Changes

**Fusion Review Deletions section**
- From: The aggregation report ends with Fusion Reviews account cards (or “No accounts included”) and does not list deleted Fusion review form definitions.
- To: When that aggregation successfully deleted one or more Fusion review form definitions, the report’s last section is **Fusion Review Deletions** and lists those definitions by name (form definition id only when the name was not captured). The section is absent when nothing was deleted.
- Reason: Owners need a record of reviews removed on that run without opening ISC Custom Forms.
- Impact: Non-breaking. Existing sections stay. Dry-run reports and Fusion reports that delete nothing do not gain an empty section.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-service`: Aggregation report HTML includes a Fusion Review Deletions section as the last section when that run deleted Fusion review form definitions.
- `form-service`: Successful Fusion review form definition deletes on the run are retained, once per definition, for that report.
- `ubiquitous-language`: Add **Fusion Review Deletions** as the last section of an aggregation report, distinct from a separate report and from cancelled form instances.

## Impact

- `FormService` delete paths (`deleteExistingForms`, the cleanup worker, and replace-before-recreate) and `FusionRun` run state that the report reads.
- Aggregation report payload (`FusionReportEmailData`), the shared `fusion-report` Handlebars template, and locale strings. The section renders only when the list is non-empty, so the dry-run report and the Fusion report stay unchanged when they have no deletions.
- Recorded `reports/aggregation.json` includes the same list when an aggregation report snapshot is written.
- Operator docs that list aggregation report contents: `docs/use-guides/configuration/review-forms-and-reviewers.md` and `docs/operations/account-list.md`.
- No change to when forms are deleted, to form instance cancellation, or to report delivery recipients.

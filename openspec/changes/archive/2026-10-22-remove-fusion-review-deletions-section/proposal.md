## Why

The aggregation report ends with a **Fusion Review Deletions** section listing the Fusion review form definitions deleted on that run. That section exposes internal form-definition cleanup owners cannot act on, and it is the only reason the run retains deleted-form state, threads a form-name argument through every delete path, adds a report-payload field, carries ten locale strings, and lives in the shared report template. Removing it removes that surface and its maintenance cost without changing when or whether forms are deleted.

## What Changes

**Fusion Review Deletions section**
- From: The aggregation report’s last section lists the Fusion review form definitions deleted on that run (form name, id fallback). Run state, the report payload, ten locale strings, docs, and spec requirements support it.
- To: The section, its data path, locale strings, docs, and spec requirements are removed. Form deletion behavior is unchanged.
- Reason: The section reports internal cleanup owners cannot act on, at the cost of run state, snapshot fields, delete-path plumbing, and locale strings.
- Impact: Breaking for anyone who read the section; every other report section is unchanged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `report-service`: Remove the four Fusion Review Deletions requirements and add one requirement that the aggregation report has no such section.
- `form-service`: Remove the two requirements that retain successful Fusion review form definition deletes for the report.
- `ubiquitous-language`: Remove the glossary requirement and the canonical-terms entry for **Fusion Review Deletions**.

## Impact

- `src/model/fusionRun.ts`: remove `DeletedFusionReviewForm`, `deletedFusionReviewForms`, `fusionReviewFormNamesById`, `rememberFusionReviewFormName`, `recordDeletedFusionReviewForm`, and their snapshot/restore fields.
- `src/services/formService/formService.ts` and `formLifecycle.ts`: drop the `formName` argument from `deleteFormDefinition`, `addFormToDelete`, and `deleteReplacedFormDefinition`, and the remember/record calls.
- `src/services/fusionService/types.ts` and `fusionService.ts`: remove `fusionReviewDeletions` and the report copy step.
- `src/services/emailService/helpers.ts` and `locales.ts`: remove the template block, the payload field, and the `fusion_review_deletions` key in all ten dictionaries.
- Tests: `fusionRun.test.ts`, `formService.test.ts`, `fusionService.report.test.ts`, `reportService.test.ts`, `reportVocabulary.test.ts`.
- Docs: `docs/glossary.md`, `docs/operations/account-list.md`, `docs/use-guides/configuration/review-forms-and-reviewers.md`.
- `CHANGELOG.md`: a new removal entry (historical entries unchanged).
- No change to when forms are deleted, to form instance cancellation, or to report recipients.

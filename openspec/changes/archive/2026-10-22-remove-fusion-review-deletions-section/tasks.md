## 1. Remove report rendering and payload

- [x] 1.1 Remove the `{{#if fusionReviewDeletions}}` block from `DEFAULT_FUSION_REPORT_TEMPLATE` in `src/services/emailService/helpers.ts` (D1; scenario: Aggregation report omits the section after deletions).
- [x] 1.2 Remove the `fusionReviewDeletions` field and the `DeletedFusionReviewForm` import from `FusionReportEmailData` in `src/services/emailService/helpers.ts` (D1).
- [x] 1.3 Remove `fusionReviewDeletions` from `FusionReport` and the `DeletedFusionReviewForm` import in `src/services/fusionService/types.ts` (D1).
- [x] 1.4 Remove the `fusionReviewDeletions` copy step from `FusionService.generateReport` in `src/services/fusionService/fusionService.ts` (D1).

## 2. Remove run-state retention and delete-path plumbing

- [x] 2.1 Remove `DeletedFusionReviewForm`, `deletedFusionReviewForms`, `fusionReviewFormNamesById`, `rememberFusionReviewFormName`, and `recordDeletedFusionReviewForm` from `src/model/fusionRun.ts`; remove their `snapshot()` and `restore()` fields (D1).
- [x] 2.2 Remove the `recordDeletedFusionReviewForm` call from `deleteFormDefinition` and the `rememberFusionReviewFormName` call from `addFormToDelete` in `src/services/formService/formLifecycle.ts`; drop the now-unused `formName` parameter from both (D2).
- [x] 2.3 Remove the `rememberFusionReviewFormName` calls from `deleteReplacedFormDefinition` and `fetchFormInstances`, and drop the now-unused `formName` parameter from `deleteReplacedFormDefinition` in `src/services/formService/formService.ts`; update `deleteFormDefinition` / `addFormToDelete` wrappers and their callers to the new signatures (D2).

## 3. Remove locale strings

- [x] 3.1 Remove the `fusion_review_deletions` key from all ten dictionaries in `src/services/emailService/locales.ts` (D3).

## 4. Update tests

- [x] 4.1 Remove the deletion tests from `src/services/__tests__/reportService.test.ts` and replace them with assertions that the aggregation, Fusion, and dry-run reports contain no Fusion Review Deletions section (D5; scenarios: Aggregation report omits the section after deletions; Fusion report and dry-run report omit the section).
- [x] 4.2 Remove the `recordDeletedFusionReviewForm` test case from `src/services/fusionService/__tests__/fusionService.report.test.ts`.
- [x] 4.3 Remove the retention assertions from `src/services/formService/__tests__/formService.test.ts` and delete any test that exists only for retention.
- [x] 4.4 Remove the retention snapshot/restore test from `src/model/__tests__/fusionRun.test.ts`.
- [x] 4.5 Remove the "Glossary lists Fusion Review Deletions" test from `src/data/__tests__/reportVocabulary.test.ts`.

## 5. Verification

- [x] 5.1 Confirm canonical test command: `npm test` (global suite) and `npm run lint`.
- [x] 5.2 All delta spec scenarios covered by named automated tests (coverage evidence for `/opsx:verify`).
- [x] 5.3 Confirm no production reference remains: `grep -rn "fusionReviewDeletions\|deletedFusionReviewForms\|fusion_review_deletions\|DeletedFusionReviewForm" src/` returns no hits. The remaining "Fusion Review Deletions" strings are the intentional absence assertions in `reportService.test.ts`.
- [x] 5.4 `npm run lint` passes (no unused code, no dead exports).

## 6. Documentation

- [x] 6.1 Remove the **Fusion Review Deletions** row from the Report and review communications table in `docs/glossary.md`.
- [x] 6.2 Remove the **Fusion Review Deletions** bullet from the aggregation report contents list in `docs/operations/account-list.md`.
- [x] 6.3 Remove the **Fusion Review Deletions** bullet from **Aggregation report contents** in `docs/use-guides/configuration/review-forms-and-reviewers.md`.
- [x] 6.4 `npm run lint:docs-guides` passes; the changed docs pass `npx markdownlint` (the pre-existing `docs/CHANGELOG.md` MD024 failures are unrelated and untouched by this change).

## 7. Changelog

- [x] 7.1 Add a removal entry to `CHANGELOG.md` via the changelog-generator skill (D4).
- [x] 7.2 Confirm the entry covers the user-visible change: the aggregation report no longer renders the Fusion Review Deletions section.

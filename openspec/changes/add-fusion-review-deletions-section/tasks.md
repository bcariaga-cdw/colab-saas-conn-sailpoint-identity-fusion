## 1. Retain successful deletes

- [x] 1.1 Add a run-scoped list of successfully deleted Fusion review form definitions (`formDefinitionId`, optional `formName`) on `FusionRun`, deduped by id, and include it in snapshot and restore beside the existing form-delete queue (`src/model/fusionRun.ts`, `src/model/__tests__/fusionRun.test.ts`) (D1; scenario: The same definition is retained once).
- [x] 1.2 Record a definition when `deleteFormDefinition` succeeds. Pass the form definition name from `deleteExistingForms`. For the cleanup worker and `deleteReplacedFormDefinition`, pass a name stored when that definition was loaded or queued earlier in the run; otherwise record the id only (D1, D2; scenarios: Reset forms retains the deleted definition name; Cleanup delete is retained; Replace-before-recreate delete is retained).
- [x] 1.3 Do not record a failed `deleteFormDefinition`, and do not record a cancelled leftover form instance (`src/services/formService/__tests__/formService.test.ts`) (scenarios: Failed delete is not retained; Cancelled instance is not a deletion).

## 2. Aggregation report section

- [x] 2.1 Copy the retained list onto the aggregation report payload (`FusionReportEmailData`) so rendered HTML and `reports/aggregation.json` use the same rows (D1; scenario: Deleted definitions are the last section).
- [x] 2.2 Render **Fusion Review Deletions** in `DEFAULT_FUSION_REPORT_TEMPLATE` after the accounts `if` / `else` block, inside the report card, only when the list length is greater than zero. Each row shows `formName` or, when that is empty, `formDefinitionId` (D3, D4; scenarios: Deleted definitions are the last section; Missing name shows the form definition id; No deletions omits the section; Dry-run report without deletions omits the section).
- [x] 2.3 Add i18n key `fusion_review_deletions` with English value `Fusion Review Deletions` and a translation in every other dictionary in `src/services/emailService/locales.ts`. Do not translate stored form names (D5; scenario: Localized heading keeps stored form names).
- [x] 2.4 Cover the section in `src/services/__tests__/reportService.test.ts`: last position, name row, id fallback, omitted when empty, omitted on an empty dry-run payload, Spanish heading with the stored name.

## 3. Verification

- [x] 3.1 Confirm canonical test command: `npx vitest run src/model/__tests__/fusionRun.test.ts src/services/formService/__tests__/formService.test.ts src/services/__tests__/reportService.test.ts src/services/emailService/__tests__/locales.test.ts src/data/__tests__/reportVocabulary.test.ts`
- [x] 3.2 All delta spec scenarios covered by named automated tests (coverage evidence for `/opsx:verify`).
- [x] 3.3 Run `npm test` (global suite) and `npm run lint`.

## 4. Documentation

- [x] 4.1 Update `docs/use-guides/configuration/review-forms-and-reviewers.md` so **Aggregation report contents** lists **Fusion Review Deletions** last: form definition names deleted on that aggregation, omitted when none were deleted.
- [x] 4.2 Update `docs/operations/account-list.md` **Report contents** with the same last section.
- [x] 4.3 Add **Fusion Review Deletions** to `docs/glossary.md` under report and review communications (scenario: Glossary lists Fusion Review Deletions).
- [x] 4.4 JSDoc on the `FusionRun` deletion list and the report payload field.

## 5. Changelog

- [x] 5.1 Create changelog entry via changelog-generator during apply.
- [x] 5.2 Confirm entry covers: aggregation report gains a last **Fusion Review Deletions** section listing Fusion review form definitions deleted on that run; the section is omitted when nothing was deleted.

## Context

The aggregation report is HTML from the shared `fusion-report` Handlebars template (`DEFAULT_FUSION_REPORT_TEMPLATE` in `src/services/emailService/helpers.ts`). The same template renders the dry-run report and the Fusion report.

The Fusion Review Deletions section was added on 2026-10-19. Its data path:

- `FormLifecycle.deleteFormDefinition(id, name?)` calls `run.recordDeletedFusionReviewForm(id, name)` after a successful ISC delete.
- `FormService.deleteExistingForms`, `FormLifecycle.addFormToDelete`, `FormLifecycle.runFormDeleteWorker`, and `FormService.deleteReplacedFormDefinition` feed names into that record; `run.rememberFusionReviewFormName` stores names so id-only deletes can still be labeled.
- `FusionService.generateReport` copies `run.deletedFusionReviewForms` onto `FusionReportEmailData.fusionReviewDeletions`.
- The template renders the section when that array is non-empty, using the `fusion_review_deletions` i18n key in all ten locale dictionaries.

`run.deletedFusionReviewForms` and `run.fusionReviewFormNamesById` also serialize in `snapshot()` / `restore()`.

No other consumer reads the deleted-form state. The `formName` argument on the delete methods exists only to label report rows.

## Goals / Non-Goals

**Goals:**

- Remove the Fusion Review Deletions section from every report the shared template renders.
- Remove the run state, report payload, delete-path name plumbing, i18n strings, tests, docs, and spec requirements that exist only for that section.
- Leave form deletion behavior, form instance cancellation, and every other report section unchanged.

**Non-Goals:**

- Changing which Fusion review form definitions are deleted, or when.
- Changing form instance cancellation.
- Changing report recipients, titles, or any other section.

## Decisions

### D1: Remove the data path, not just the template block

- **Choice**: Delete the template block, the `fusionReviewDeletions` payload field, the `fusionService` copy step, the `deletedFusionReviewForms` / `fusionReviewFormNamesById` run state, and the `recordDeletedFusionReviewForm` / `rememberFusionReviewFormName` methods.
- **Reason**: That state is read only by the removed section. Leaving it would keep dead run state, snapshot fields, and delete-path calls.
- **Considered alternatives**: Hide only the template block. Rejected — it leaves unused state and method calls, and `knip` would flag the dead code.

### D2: Drop the `formName` argument from the delete paths

- **Choice**: Remove the `formName` parameter from `deleteFormDefinition`, `addFormToDelete`, and `deleteReplacedFormDefinition`, and update their callers.
- **Reason**: The parameter existed only to name report rows. With the record method gone it would be an unused argument (ESLint `no-unused-vars` with `^_` ignore pattern).
- **Considered alternatives**: Rename the parameter to `_formName`. Rejected — it leaves a misleading signature and dead call-site arguments.

### D3: Remove the i18n key from every dictionary

- **Choice**: Delete `fusion_review_deletions` from all ten locale dictionaries in `locales.ts`.
- **Reason**: No template references it once the section is gone. Leaving it would fail any locale key-parity or dead-string check and mislead translators.
- **Considered alternatives**: Keep the key for future reuse. Rejected — no consumer and it invites drift.

### D4: Keep the historical changelog entry, add a removal entry

- **Choice**: Leave the 2026-10-19 changelog entry that announced the section. Add a new removal entry for this change.
- **Reason**: The changelog is release history; the section did ship. Removal is its own user-visible change.
- **Considered alternatives**: Edit the old entry. Rejected — rewrites history.

### D5: Spec removal plus one positive absence requirement

- **Choice**: REMOVE the four `report-service` requirements and the two `form-service` retention requirements, REMOVE the `ubiquitous-language` glossary requirement (and its canonical-terms row), and ADD one `report-service` requirement that the aggregation report has no Fusion Review Deletions section.
- **Reason**: The removals drop the contract; the ADDED requirement gives `/opsx:verify` a positive, testable assertion that survives archive.
- **Considered alternatives**: Removals only. Rejected — no positive contract for the new behavior.

## Risks / Trade-offs

- [Risk] A hidden consumer reads `run.deletedFusionReviewForms` or `report.fusionReviewDeletions`. -> Mitigation: the grep inventory shows only the files in proposal Impact; type removal surfaces any missed reference at compile time.
- [Risk] Removing the `formName` argument breaks a caller. -> Mitigation: TypeScript strict mode flags every call site; update all callers in the same change.
- [Risk] A recording snapshot contains the removed fields. -> Mitigation: extra JSON fields are ignored on restore; no recorded fixture references the fields.
- [Trade-off] Operators lose an in-report deletion record. -> Reason for acceptance: the user asked for removal; deletion history remains available in logs and ISC Custom Forms.

## Migration Plan

N/A — no deployment or data migration. Reports sent after this change lack the section. Old recordings that carry the removed snapshot fields restore normally because the fields are ignored.

Archive-owned edit: delete the **Fusion Review Deletions** row from the Report and review communications table under `## Canonical Terms` in `openspec/specs/ubiquitous-language/spec.md`. Archive sync merges requirements only, so this canonical-terms row is removed by hand when the change is archived.

## Open Questions

None.

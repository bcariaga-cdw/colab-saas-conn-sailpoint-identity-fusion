## Scope

Remove the **Fusion Review Deletions** section from the Fusion report / aggregation report and remove all code, run state, i18n strings, tests, docs, and spec requirements that exist only to render it. Out: changing when or whether Fusion review form definitions are deleted, and touching any other report section.

## Language

**Fusion Review Deletions** (`conflicts-with-canonical` — being removed):
The last section of an aggregation report, listing the Fusion review form definitions deleted on that run. This change removes the term from the glossary and the ubiquitous-language spec.
_Avoid_: (term is retired)

**aggregation report** (`conflicts-with-canonical` — keep canonical):
The HTML/email produced after a persistent account-list when owner reporting is enabled. Title: Identity Fusion Aggregation Report. The shared `fusion-report` template also renders the Fusion report and the dry-run report.
_Avoid_: Fusion report

**Fusion review form definition** (`conflicts-with-canonical` — keep canonical):
The ISC Custom Forms definition named from `fusionFormNamePattern` plus the managed account’s identity and, when localization is enabled, the locale group’s reviewer locale.
_Avoid_: form instance, in-flight review

## Decisions

Context: the section was added on 2026-10-19. It is rendered only in the shared `fusion-report` Handlebars template from `report.fusionReviewDeletions`, copied from `run.deletedFusionReviewForms`. That run state is populated by `recordDeletedFusionReviewForm` (called from `deleteFormDefinition`), and `fusionReviewFormNamesById` / `rememberFusionReviewFormName` exist only to name id-only deletes for the report. Ten locale dictionaries carry a `fusion_review_deletions` heading.

- Remove the rendered section and the whole data path that feeds it: template block, `fusionReviewDeletions` report payload, `FusionReportEmailData` field, `deletedFusionReviewForms` and `fusionReviewFormNamesById` run state, snapshot/restore fields, and the `recordDeletedFusionReviewForm` / `rememberFusionReviewFormName` methods.
- Remove the `formName` argument threaded through `deleteFormDefinition`, `addFormToDelete`, and `deleteReplacedFormDefinition`; it existed only to label report rows.
- Remove the i18n key `fusion_review_deletions` from all ten dictionaries.
- Form deletion behavior is unchanged: definitions are still deleted on the same paths, at the same times.
- Remove the four `report-service` requirements, the two `form-service` retention requirements, and the `ubiquitous-language` glossary requirement plus its canonical-terms row. Add one `report-service` requirement stating the section is absent.
- Update the operator docs that list report contents. Keep the historical changelog entry; add a removal entry for this change.

## Open questions

None. The user asked for a full removal and chose the opsx route.

## Scenarios discussed

- A persistent aggregation deletes form definitions. The report no longer renders a Fusion Review Deletions section.
- The Fusion report and dry-run report are unchanged (they never rendered the section because their deletion list was always empty).
- Deletes still happen; only the report line and its supporting state are gone.
- Snapshot/restore no longer carry deleted-form state.
- Localized report headings are unchanged for every other section.

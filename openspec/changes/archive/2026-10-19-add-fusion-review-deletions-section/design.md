## Context

The aggregation report is HTML from the shared `fusion-report` Handlebars template (`DEFAULT_FUSION_REPORT_TEMPLATE` in `src/services/emailService/helpers.ts`). Section order today is processing statistics, phase timing, warnings, errors, Fusion Review Decisions, Fusion Blends, then Fusion Reviews account cards (or “No accounts included”). Decisions and blends render only when their arrays are non-empty.

Fusion review form definitions are deleted on a persistent aggregation in three places, all through `deleteFormDefinition`:

- Reset forms in setup (`FormService.deleteExistingForms`), which has the definition name.
- The output-phase cleanup queue (`formLifecycle.runFormDeleteWorker`), which has only the definition id unless the name was stored earlier.
- Replace-before-recreate (`FormService.deleteReplacedFormDefinition`), which has only the id.

`await-form-deletes` runs at the end of the persistent output phase, before the report epilogue. If the pipeline fails earlier, the epilogue still runs and can only list deletes that already succeeded.

The dry-run report and the Fusion report use the same template and do not delete Fusion review form definitions.

## Goals / Non-Goals

**Goals:**

- Show **Fusion Review Deletions** as the last section of the aggregation report when that run successfully deleted one or more Fusion review form definitions.
- List each deleted definition once, by its form definition name, falling back to the form definition id.
- Keep the section off any report whose deletion list is empty.

**Non-Goals:**

- Changing which definitions are deleted, or when.
- Listing cancelled leftover form instances.
- Adding a deletions section to a dry-run report or Fusion report that deleted nothing.
- Changing report recipients, titles, or earlier sections.

## Decisions

### D1: Record a successful delete on the run, then copy it onto the report payload

- **Choice**: When `deleteFormDefinition` succeeds, append `{ formDefinitionId, formName? }` to a run-scoped list. Dedupe by `formDefinitionId`. The aggregation report builder copies that list onto `FusionReportEmailData`.
- **Reason**: The epilogue already runs after the persistent delete drain, and the same run object is what the report reads. Recording at success covers Reset forms, the cleanup worker, and replace-before-recreate without a second ISC query.
- **Considered alternatives**: Diff Custom Forms before and after the run (extra API calls, misses a definition recreated under another name). Read only `formsToDelete` (that set is cleared as work is queued, and Reset forms never uses it).

### D2: Capture the name at the call site that has it

- **Choice**: Pass the definition name into the success record when the caller has the definition (`deleteExistingForms`). For id-only deletes, record a name if one was stored when the definition was queued or loaded earlier in the run; otherwise leave the name empty and the report row shows the id.
- **Reason**: The cleanup queue and replace-before-recreate do not receive the definition body. The name is the label operators see in ISC (`fusionFormNamePattern - account [source] (id)`, plus `[locale]` when localization is on).
- **Considered alternatives**: Always show only the id (opaque). Fetch the definition again before delete (extra read on every cleanup).

### D3: Omit the section when the list is empty

- **Choice**: The template renders Fusion Review Deletions only when the array length is greater than zero, same as Fusion Review Decisions and Fusion Blends.
- **Reason**: Most aggregations delete nothing. An empty heading would change every report, including dry-run and Fusion reports that share the template.
- **Considered alternatives**: Always show the heading with “none”. Rejected because the request is a list of deletions, and the existing optional sections stay hidden when empty.

### D4: Place the section after the accounts block

- **Choice**: After the `{{#if accounts}}` / `{{else}}` block (both branches already close their table row), add a new row for Fusion Review Deletions, still inside the report card, so it is last whether or not account cards rendered.
- **Reason**: The accounts markup splits the card’s table rows. Inserting the section inside that `if` would drop it when there are no account cards.
- **Considered alternatives**: Put it before Fusion Reviews. Rejected because the request makes it the last section.

### D5: English heading is the literal string; other locales get a translation

- **Choice**: i18n key `fusion_review_deletions` is `Fusion Review Deletions` in English and a translated heading in every other dictionary in `locales.ts`. Form names are not translated.
- **Reason**: Report section headings already go through `{{i18n ...}}`. The requested English title stays exact.

## Risks / Trade-offs

- [Risk] A failed pipeline never reaches `await-form-deletes`, so queued cleanup deletes that did not finish are absent from the report. -> Mitigation: List only deletes that succeeded before the report was built. Reset forms deletions from setup are still listed. Do not block the epilogue on a second drain.
- [Risk] Replace-before-recreate and the cleanup worker can both target the same id. -> Mitigation: Dedupe by form definition id so the section lists that definition once.
- [Risk] An id-only delete with no stored name shows an opaque id. -> Mitigation: Store the name whenever the run already loaded the definition; id is the fallback, not the default for Reset forms.
- [Trade-off] The shared template grows a conditional section. -> Reason for acceptance: empty data leaves dry-run and Fusion report HTML unchanged.

## Migration Plan

N/A — no deployment or data migration. Reports already sent are unchanged. The next aggregation report includes the section only when that run deleted Fusion review form definitions.

Acceptance: a persistent aggregation that deletes at least one Fusion review form definition renders **Fusion Review Deletions** after every other section, with one row per deleted definition. A run that deletes none does not render the section.

## Open Questions

None.

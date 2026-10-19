## Scope

Add a **Fusion Review Deletions** section as the last section of the aggregation report, listing the Fusion review form definitions deleted on that aggregation. Out: changing when or whether forms are deleted, listing cancelled form instances, and showing the section on a dry-run report or Fusion report that deleted nothing.

## Language

**Fusion Review Deletions** (`promote`):
The last section of an aggregation report. It names the Fusion review form definitions deleted during that aggregation.
_Avoid_: deleted forms report, form cleanup section, Reset forms log

**aggregation report** (`conflicts-with-canonical` — keep canonical):
The HTML/email produced after a persistent account-list when owner reporting is enabled. Title: Identity Fusion Aggregation Report.
_Avoid_: Fusion report

**Fusion review form definition** (`conflicts-with-canonical` — keep canonical):
The ISC Custom Forms definition named from `fusionFormNamePattern` plus the managed account’s identity and, when localization is enabled, the locale group’s reviewer locale.
_Avoid_: form instance, in-flight review

**Reset forms** (`conflicts-with-canonical` — keep canonical):
The Developer Setting (`resetForms`) that closes in-flight Fusion reviews by deleting matching Fusion review form definitions and leftover instances.
_Avoid_: Reset accounts

## Decisions

Context: Operators get an aggregation report after a persistent account-list, but nothing in that HTML lists which Fusion review form definitions the run deleted. Deletions happen on three paths today: Reset forms (`deleteExistingForms`), the completed/cancelled cleanup queue (`runFormDeleteWorker`), and the inline delete of a definition that must not be reused. The shared Handlebars template also renders the dry-run report and the Fusion report. Current section order ends with the Fusion Reviews account cards (or “No accounts included”).

- The section heading in English is **Fusion Review Deletions**. Other locales get the same i18n key pattern as Fusion Review Decisions and Fusion Blends.
- The list is every Fusion review form definition whose delete succeeded on that aggregation, from every delete path. A failed delete is omitted. A cancelled leftover form instance is omitted.
- Each row is the form definition name operators already see in ISC. If the name was not captured, the row is the form definition id.
- The section is rendered only when that list is non-empty, matching Fusion Review Decisions and Fusion Blends. A run that deleted nothing does not show an empty section.
- It is the last section, after the Fusion Reviews cards or the no-accounts message.
- Dry-run and the Fusion report keep the shared template. They do not invent a deletions list. Because those runs do not delete Fusion review form definitions, the section stays absent there.

## Open questions

None. Row content (form definition name, id only as fallback) and “omit when empty” are recorded assumptions from the request for a list of deleted Fusion review forms on that run.

## Scenarios discussed

- Persistent aggregation deletes two form definitions (one via Reset forms, one via completed-review cleanup). The aggregation report’s last section is Fusion Review Deletions and lists both names.
- Persistent aggregation deletes nothing. The section is absent. Existing sections stay in their current order.
- A delete fails. That definition is not listed.
- Reset forms cancels leftover instances and deletes the definitions. Only the deleted definitions appear.
- Dry-run report and Fusion report for a run that deleted nothing do not show the section.
- Localization enabled and the recipient locale is Spanish. The section heading uses the Spanish translation; the form names stay the stored definition names.

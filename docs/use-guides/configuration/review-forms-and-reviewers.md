# Review forms and reviewers

Configure **Attribute Matching Settings → Review Settings** — form attributes, expiration, candidate limits, aggregation reports, and localization-related review fields.

**Configuration reference:** [Attribute Matching Settings — Review](../../configuration/matching.md)

For reviewer assignment and access profiles, see [Managing reviewers](managing-reviewers.md). For runtime behavior after a match is found, see [Match flow reference](../../reference/match-flow.md).

!!! note "Didactic guide"
    This page explains **how and when** to configure review settings. For field keys, types, defaults, and constraints, see the linked **Configuration reference**.

---

## Review settings

| Field | Purpose | Recommended value |
| --- | --- | --- |
| **List of Fusion account attributes to include in form** | Attributes shown to reviewer | `name`, `email`, `department`, `manager`, `hireDate`, `phone` |
| **Manual review expiration days** | Form expiration | 7 (default); adjust based on SLA |
| **Maximum candidates per review form** | Limit of potential matches shown on form | 3 (default); valid range 1–15 |
| **Owners are global reviewers?** | Add Fusion source owner and governance group to all review forms | Yes for pilots |
| **Send report to owner on aggregation?** | Email an **aggregation report** after each aggregation | Yes (useful for monitoring) |

!!! note
    When the candidate limit is exceeded, only the highest-scoring potential matches are included.

For localization (**Default Language**, **Identity Language Attribute**, **reviewer locale**), see [Managing reviewers — Localization and reviewer experience](managing-reviewers.md#localization-and-reviewer-experience). Fusion review forms use the same reviewer locale as the Fusion review email.

### What reviewers see

The Fusion review form display is **DESCRIPTION HTML** aligned with the Fusion review email: account context, configured form attributes, identity and account links (when ISC URLs can be built), and a score table for every candidate (columns: attribute, value, algorithm, threshold, result, score; match/miss/combined row colors). All candidate score tables remain visible for comparison. When a reviewer chooses an identity in the identities SELECT, an identity details panel appears below it with that identity's configured form attributes, laid out like the account context panel. The **new identity / no match** toggle and the identities SELECT remain the decision controls. Display is not a stack of TEXT fields.

A form layout change does not rewrite in-flight reviews. To recut open reviews onto this layout, run **Reset forms?** once on a persistent aggregation — see [Reset Fusion state](../operation/reset-fusion-state.md). There is no per-account review reset flag.

### Aggregation report contents

When **Send report to owner on aggregation?** is enabled, the **aggregation report** includes:

- High-level summary (date, total analyzed accounts, potential matches)
- Processing statistics (managed/fusion/review metrics, processing time, memory usage)
- Potential match details with candidate identity score breakdowns
- Failed matching entries (for example, form creation constraints/errors)
- Warning block when more than one Fusion account is found for the same identity
- Compact aggregation issues summary with warning/error counts and short sampled messages
- **Fusion Review Deletions** (last section): the form definition names deleted on that aggregation. The section is omitted when nothing was deleted.

To preview Match outcomes without persisting changes, use a **dry-run report** ([Analyze changes with dry-run](../operation/analyze-with-dry-run.md)) or request a **Fusion report** via the `report` entitlement. Neither is an aggregation report.

---

## Choosing form attributes

Include attributes that help reviewers decide if identities are matches:

| Attribute | Why include | Example |
| --- | --- | --- |
| **name** | Primary identifier | John Smith vs J. Smith |
| **email** | Usually unique | `john.smith@company.com` vs `jsmith@company.com` |
| **department** | Context for verification | Engineering vs IT |
| **manager** | Organizational context | Same manager → likely same person |
| **hireDate** | Temporal context | Hired same day → suspicious |
| **phone** | Contact verification | Same phone → likely match |
| **employeeId** | Business key | Same ID → investigate if different |

---

## Tuning review workload

| Concern | Resolve in |
| --- | --- |
| Match thresholds and algorithms | [Tuning matching algorithms](tuning-matching-algorithms.md) · [Match tuning cookbooks](match-tuning-cookbooks.md) |
| Reviewer assignment and SLAs | [Managing reviewers — Workload and SLA tuning](managing-reviewers.md#workload-and-sla-tuning) |
| Validate before production | [Analyze changes with dry-run](../operation/analyze-with-dry-run.md) |

!!! tip "Ambiguous reviews"
    For identical name/email with conflicting DOB or policy-sensitive fields, see [Real-world matching examples (anonymized)](tuning-matching-algorithms.md#real-world-matching-examples-anonymized).

---

## Related guides

| Topic | Guide |
| --- | --- |
| Reviewer assignment | [Managing reviewers](managing-reviewers.md) |
| Match rules and scoring | [Matching identities](matching-identities.md) |
| Runtime flow (form creation → decision) | [Match flow reference](../../reference/match-flow.md) |
| Correlation after link decisions | [Managing correlation](managing-correlation.md) |

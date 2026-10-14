# Managing reviewers

This guide covers reviewer assignment, access profiles, and workload patterns for Identity Fusion NG manual Match review — who can decide on potential duplicates and how to scale review across sources.

**Configuration reference:** [Attribute Matching Settings — Review](../../configuration/matching.md)

For form fields, expiration, and review settings, see [Review forms and reviewers](review-forms-and-reviewers.md). For runtime flow, see [Match flow reference](../../reference/match-flow.md).

!!! note "Didactic guide"
    This page explains **how and when** to assign and govern reviewers. For field keys, types, defaults, and constraints, see the linked **Configuration reference**.

## Reviewer model

Identity Fusion NG supports two reviewer assignment models. Pick one — or combine them.

| Approach | Best for | How it works |
| --- | --- | --- |
| **Global reviewers (simple)** | Pilots, small teams, or when one governance group should see every form | Enable **Owners are global reviewers?** and assign the Fusion **source owner** and/or **governance group** in ISC. Those identities are added to every review form across all managed sources — no entitlement aggregation or access profiles required for reviewer assignment. |
| **Per-source entitlements (fine-grained)** | Production teams with distinct ownership per managed source | Run **Entitlement Aggregation**, then assign `<Source Name> reviewer` entitlements through ISC access profiles so only the right people receive forms for each source. |

| Mechanism | Scope | Configuration |
| --- | --- | --- |
| **Global reviewer** | All managed sources | **Owners are global reviewers?** in Attribute Matching Settings → Review, plus Fusion **source owner** and/or **governance group** on the Fusion source in ISC |
| **Per-source reviewer entitlement** | One managed source | `<Source Name> reviewer` entitlement on the Fusion source, assigned via access profiles |
| **Fusion report** | Read-only Match preview (HTML email) | `FusionReport` (`report`) entitlement — generates a **Fusion report**, not an aggregation report |

When **Owners are global reviewers?** is enabled, the connector resolves reviewer identities from the Fusion source **owner** (a single identity, or all members when the owner is a governance group) and from the source **governance group** (management workgroup) when configured. See [Governance group](../../glossary.md#deployment-and-integration) in the glossary.

## Global reviewers (simple setup)

For the fastest path to a working review workflow:

1. In ISC, open your Fusion source and assign a **source owner** (identity or governance group) and/or a **governance group** (management workgroup) with the people who should review matches.
2. In **Attribute Matching Settings → Review**, enable **Owners are global reviewers?**.
3. Run account aggregation — review forms notify the resolved owner and governance-group members on every managed source.

No entitlement aggregation or reviewer access profiles are required for this model. Re-run aggregation after changing the source owner or governance group membership.

!!! tip "When to use global reviewers"
    Global reviewers suit pilots, early Match tuning, and small deployments where one IAM or governance team handles all sources. For distinct team ownership per source, use per-source entitlements below.

## Per-source reviewers (fine-grained control)

For each managed source that can generate review forms:

1. Run **Entitlement Aggregation** on the Fusion source so reviewer entitlements exist.
2. Go to **Admin → Access Profiles → New Access Profile**.
3. Name: `<Source Name> Reviewer` (for example `Workday Reviewer`).
4. Source: your Identity Fusion NG source.
5. Add entitlement: `<Source Name> reviewer`.
6. Assign the access profile to users or groups who should review matches for that source.

| Access profile | Entitlement | Typical assignment |
| --- | --- | --- |
| **Workday Reviewer** | Workday reviewer | HR or source owners |
| **Active Directory Reviewer** | Active Directory reviewer | Directory / IAM team |
| **Global Reviewer (optional)** | Multiple reviewer entitlements | Identity governance lead team — use when combining entitlements with global reviewers |

## Global vs per-source reviewers

| Approach | Pros | Cons |
| --- | --- | --- |
| **Global reviewers only** | No entitlement aggregation or access profiles; easy to set up via source owner and governance group | Same people receive every form across all sources |
| **Per-source entitlements only** | Clear ownership; smaller form queues per team | Requires entitlement aggregation after each new source |
| **Hybrid** | Governance group or owner as safety net; source teams handle day-to-day via entitlements | Requires documenting both assignment paths |

Forms notify every assigned reviewer — global and entitlement-based; the **first completed submission** wins — other pending forms for the same case close automatically.

## Fusion report access profile

Create a separate profile for stakeholders who need match visibility without review authority:

| Access profile | Entitlement | Purpose |
| --- | --- | --- |
| **Fusion Report** | Fusion report (`report`) | Auditors, governance leads — same Match preview as dry-run, without deciding on a review form |

Enable **Send report to owner on aggregation?** in Review Settings to email an **aggregation report** (title **Identity Fusion Aggregation Report**) to configured report recipients. That email is not a Fusion report. **Fusion review** (review-required form/email) is a separate product.

## Localization and reviewer experience

When **Enable localized user communications?** is on:

- **Reviewer locale** is the language of the Fusion review email **and** the Fusion review form. It is the identity language attribute when set, then **Default Language**, then English.
- **Default Language** is the connector-wide fallback. English is selected by default.
- Reviewers who share a **reviewer locale** share one Fusion review form definition (**locale group**). Reviewers with different languages get different definitions; toggle and SELECT labels stay in the same language as the form HTML.
- When localization is off, forms stay English and there is no `[locale]` suffix on definition names.

Set **Default Language** when reviewers without a language attribute should see a non-English locale.

## Workload and SLA tuning

| Setting | Purpose | Starting point |
| --- | --- | --- |
| **Manual review expiration days** | Auto-close stale forms | 7 days; increase if SLAs are longer |
| **Maximum candidates per review form** | Cap identities shown per form | 3 (range 1–15) |
| **Enable automatic merge** + threshold | Reduce manual volume after tuning | Off initially; enable when false-positive rate is acceptable |

Monitor review metrics:

| Metric | Target signal |
| --- | --- |
| **False positive rate** | High "create new" decisions → raise thresholds |
| **Reviewer overload** | Form backlog → enable automatic merge or add reviewers |
| **Form expiration rate** | Many timeouts → increase expiration days or notify reviewers |

See [Match tuning cookbooks](match-tuning-cookbooks.md) and [Tuning matching algorithms](tuning-matching-algorithms.md) for threshold and algorithm tuning.

## Enforced correlation role (reviewer context)

Reviewers who choose **Link to existing identity** expect managed accounts to correlate on the next aggregation. That requires **Correlate missing accounts on aggregation** or an **enforced correlation role** — not **Do not correlate** alone.

See [Managing correlation](managing-correlation.md) for correlation mode details.

## Dry-run before production review load

To preview match volume and report content without creating forms or persisting correlation, see [Analyze changes with dry-run](../operation/analyze-with-dry-run.md).

## Related guides

| Topic | Guide |
| --- | --- |
| Form attributes and review settings | [Review forms and reviewers](review-forms-and-reviewers.md) |
| Match runtime flow | [Match flow reference](../../reference/match-flow.md) |
| Match rules and thresholds | [Matching identities](matching-identities.md) |
| Correlation after link decisions | [Managing correlation](managing-correlation.md) |
| First aggregation setup | [Getting started — Setup checklist](../../getting-started/index.md#setup-checklist) |




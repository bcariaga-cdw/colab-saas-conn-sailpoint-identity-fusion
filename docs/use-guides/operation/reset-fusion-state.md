# Reset Fusion state

Use this guide when you need to **safely rebuild Fusion account data or clear review forms** — testing major config changes, recovering from inconsistent state, or starting with a clean slate in non-production environments.

**Configuration reference:** [Advanced Settings — Developer Settings](../../configuration/advanced.md) · **Field reference:** [#resetaccounts](../../configuration/advanced.md#resetaccounts) · [#resetforms](../../configuration/advanced.md#resetforms)

!!! note "Didactic guide"
    This page explains **when and how** to use reset flags and related developer settings. For field keys, types, defaults, and constraints, see the linked **Configuration reference**.

---

## When you need this

| Scenario | Use | Alternative |
| --- | --- | --- |
| Testing major config changes in dev | **Reset accounts?** once | Dry-run first — see [Analyze changes with dry-run](analyze-with-dry-run.md) |
| Clear in-flight Fusion reviews (and recut layout after a form change) | **Reset forms?** once | Manual form cleanup in ISC (if feasible) |
| Schema changes (mapping/definition) | Maybe reset accounts | Discover Schema is usually sufficient |
| Stuck `processing` config option | **Reset accounts?** once | Removes the `processing` connector attribute left by an unfinished run |
| Production environment | ⚠️ **Rarely** | High impact; coordinate with stakeholders |

The **Developer Settings** section help in the ISC source configuration UI displays the **installed connector version**. Use it to confirm which build is deployed.

![Developer Settings - Configuration](../../assets/images/advanced-settings-developer.png)

---

## Reset flags overview

| Field | Risk | What it does |
| --- | --- | --- |
| **Reset accounts?** | High | Clears persisted Fusion account state; reset run emits zero accounts |
| **Reset forms?** | Medium | Closes in-flight Fusion reviews (matching definitions, and leftover instances) so rematch can issue restyled forms |
| **Force attribute refresh** | Medium | One-run Normal attribute recalculation |

Both reset flags **automatically turn off after one aggregation**.

### Combined behavior

| Reset accounts? | Reset forms? | Result |
| --- | --- | --- |
| No | No | Normal aggregation |
| Yes | No | Account reset only — zero accounts emitted |
| No | Yes | In-flight Fusion reviews closed — aggregation continues |
| Yes | Yes | Forms deleted, then account reset — zero accounts emitted |

---

## Workflow: reset accounts

**What reset accounts does:**

- Clears persisted Fusion account state (attributes, history, processing flags)
- Removes the `processing` connector attribute when that option is present on the source
- Emits zero accounts on the reset run; the following aggregation rebuilds from scratch
- Does NOT delete source accounts, identities, or review forms (unless **Reset forms?** is also enabled)

**Steps:**

1. Enable **Reset accounts?** = Yes (and **Reset forms?** = Yes if you also need forms cleared)
2. Save configuration
3. Run account aggregation (reset run emits zero accounts)
4. Run aggregation again to rebuild accounts
5. Flags auto-disable after the run that consumed them

!!! warning
    - **Data loss:** Account reset deletes Fusion account history, processing state, and custom attributes
    - **Performance:** Full rebuild can take hours for large datasets (10k+ accounts)
    - **Identity impact:** If Fusion is authoritative, identities may be temporarily impacted
    - **Coordination:** Notify stakeholders before resetting in production

---

## Workflow: reset forms only

**What reset forms does:**

- Closes in-flight Fusion reviews: deletes Fusion review form definitions that match the Fusion form name pattern, and cancels leftover open instances if definition delete leaves them
- Aggregation continues normally unless **Reset accounts?** is also enabled
- Managed accounts held by those reviews re-enter Match on the same run
- A form layout change (for example DESCRIPTION HTML restyle) does not migrate pending instances by itself — operators run **Reset forms?** when they want the inbox recut
- There is no per-account review reset flag

Use when review form definitions are stale, after a form layout change, or when open reviews should be reissued.

---

## Force attribute refresh

**Purpose:** Trigger a one-run recalculation of Normal attribute definitions without wiping account state.

Enable **Force attribute refresh**, run one aggregation, then confirm the flag auto-disables. Useful after changing Velocity templates or normalization rules when a full account reset is not warranted.

---

## Other developer settings

These settings affect performance and testing but do not reset state:

| Field | Purpose |
| --- | --- |
| **Enable concurrency check?** | Detect concurrent aggregation attempts |
| **Managed accounts batch size** | Batch size for managed account fetches |
| **Scoring concurrency limit** | Parallelism for Match scoring |

See [Advanced Settings — Developer Settings](../../configuration/advanced.md) for defaults and ranges. For API queue tuning, see [Tune API performance](tune-api-performance.md).

---

## Dry-run and reset flags

If **Reset accounts?** or **Reset forms?** is enabled, dry-run detects the flag and exits early without applying the reset. Use a persistent aggregation when you intend to perform a reset — see [Analyze changes with dry-run](analyze-with-dry-run.md).

---

## Troubleshooting

| Issue | Possible cause | Solution |
| --- | --- | --- |
| **Reset not working** | Flag still enabled after run | Flags auto-disable after one run; verify connector version supports reset flags |
| **Zero accounts after reset run** | Expected on reset run | Run aggregation again to rebuild |
| **Forms reappear unexpectedly** | New Match outcomes | Expected — review forms queue from new potential matches |
| **Stuck processing** | Unfinished prior run left the `processing` config option | Run aggregation with **Reset accounts?** — that run removes the option |

For broader recovery scenarios, see [Troubleshooting — Reset and recovery](../validation-and-troubleshooting/troubleshooting.md#category-8-reset-and-recovery).

---

## Related guides

| Topic | Guide |
| --- | --- |
| Validate changes without reset | [Analyze changes with dry-run](analyze-with-dry-run.md) |
| Monitor rebuild progress | [Monitor aggregation progress](monitor-aggregation-progress.md) |
| Performance during large rebuild | [Tune API performance](tune-api-performance.md) |

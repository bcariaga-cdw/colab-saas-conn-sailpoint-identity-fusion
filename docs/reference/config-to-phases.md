# Configuration to account-list phases

Map Fusion **Configuration** settings to **account-list** pipeline phases, steps, and searchable log prefixes. Use this page when troubleshooting aggregations — grep logs for the prefixes below, then trace back to the settings that drive that phase.

For the full phase narrative, see [Account list](../operations/account-list.md).

## Phase overview

| Phase | Log prefix | Primary settings areas |
| --- | --- | --- |
| 1 Setup | `PHASE 1 Setup` | Source Settings (sources, reset flags), Advanced → Developer Settings |
| 2 Fetch | `PHASE 2 Fetch` | Source Settings (scope, sources), Attribute Matching → Review (forms) |
| 3 Refresh | `PHASE 3 Refresh` | Attribute Mapping, Attribute Definition, correlation mode, Processing Control `promoteMainAccountWhenOriginMissing` |
| 4 Process | `PHASE 4 Process` | Attribute Matching (Match rules, review), Source types, correlation |
| 5 Output | `PHASE 5 Output` | Source Settings → Processing Control, Developer Settings |
| Epilogue | `EPILOGUE report` | Attribute Matching → Review (`fusionReportOnAggregation`) |

## Identity scope and baseline

| Setting | Config menu | Phase / step | Log signals |
| --- | --- | --- | --- |
| **Include identities in the scope?** | Source Settings → Scope | Fetch (identities loaded); Process `process-identities` | `DETAIL` identity counts; identity sweep progress |
| **Identity Scope Query** | Source Settings → Scope | Fetch | Filtered identity fetch size in Fetch `STATUS` |
| **Authoritative account sources** | Source Settings → Sources | Fetch (managed accounts); Process sweeps | Per-source account counts in Fetch |

Identities and correlated managed accounts form the Match **baseline**. See [Glossary — Baseline](../glossary.md#processing-states-and-outcomes).

## Reset and developer flags

| Setting | Config menu | Phase | Behavior |
| --- | --- | --- | --- |
| **Reset accounts?** | Advanced → Developer Settings | Setup | Clears fusion state; emits zero accounts; exits early |
| **Reset forms?** | Advanced → Developer Settings | Setup | Closes in-flight Fusion reviews (matching definitions and leftover instances) |
| **Force attribute refresh on next aggregation?** | Advanced → Developer Settings | Setup (flag cleared); Refresh/Process | Normal attributes recalculated when definitions run |

## Source type and Match sweep

| Setting | Config menu | Phase / step | Log signals |
| --- | --- | --- | --- |
| **Source type** (Authoritative / Records / Orphan) | Source Settings → per source | Process `uncorrelated-sweep` | Record → `record-unique-registration`; Orphan → drop |
| **Include record accounts in Match** | Source Settings → Records source | Process | Match scoring vs bulk unique registration |
| **Disable non-matching accounts** | Source Settings → Orphan source | Process `await-disable-ops` | Disable actions on managed source |
| **Deferred candidate matching** | Source Settings → per source | Process Match | Deferred match outcomes; `deferred` candidate type |
| **Matching rules** | Attribute Matching → Matching | Process `uncorrelated-sweep` | Match discovery/applied headlines; `EVENT_SUMMARY` |

## Correlation

| Setting | Config menu | Phase | Log signals |
| --- | --- | --- | --- |
| **Correlation mode: correlate** | Source Settings → per source | Refresh | `correlations link=` on Refresh STATUS |
| **Correlation mode: reverse** | Source Settings → per source | Setup (schema validation) | Reverse correlation setup in Setup |
| Merge decisions from forms | Attribute Matching → Review | Fetch (discovered); Refresh (applied) | `DECISION DISCOVERED` / `MERGE DECISION APPLIED` |

## Aggregation timing

| Setting | Config menu | Phase | Log signals |
| --- | --- | --- | --- |
| **aggregationMode: before** | Source Settings → per source | Setup (pre-aggregation poll) | Task polling; `idn:task-management:read` scope required |
| **aggregationMode: delayed** | Source Settings → per source | Output `schedule-aggregations` | Delayed workflow scheduling |

## Processing control

| Setting | Config menu | Phase / step | Behavior |
| --- | --- | --- | --- |
| **Promote first found managed account to main account when origin account is missing** (`promoteMainAccountWhenOriginMissing`) | Source Settings → Processing Control | Refresh `processFusionAccount`, including single-account read | Off when the key is absent. While on, sets `mainAccount` to the first live managed account before Map when the origin is not a current contributor, and clears `mainAccount` before Map when the origin is a current contributor again. |

## Review and reporting

| Setting | Config menu | Phase / step | Log signals |
| --- | --- | --- | --- |
| **fusionManualReviewScore** | Attribute Matching → Matching | Process Match | Review form creation |
| **fusionEnableAutoMerge** | Attribute Matching → Matching | Process Match | Auto-merge outcomes; `decisions(…Aa)` segment |
| **fusionReportOnAggregation** | Attribute Matching → Review | Epilogue | `EPILOGUE report START` / report email `DETAIL` |

## Connection and observability

| Setting | Config menu | All phases | Log signals |
| --- | --- | --- | --- |
| **Heartbeat interval** | Advanced → Advanced Connection | All | `STATUS` and `EVENT_SUMMARY` every N seconds |
| **Max concurrent requests** | Advanced → Advanced Connection | Fetch, Output | `api=` queue segment on STATUS |
| **External logging enabled** | Advanced → External Settings | All | Logs at external endpoint |

## Quick grep reference

| Symptom | Grep for |
| --- | --- |
| Phase stuck or slow | `PHASE`, `STATUS`, `WARN STALL` |
| Match activity | `EVENT_SUMMARY`, `DECISION`, `decisions(` |
| Correlation drain | `correlations link=`, `completed=`, `pending=` |
| Form issues | `form-reconcile`, `400.1.409` |
| API queue backlog | `api-queue`, `api=` |

## Related guides

- [Troubleshooting](../use-guides/validation-and-troubleshooting/troubleshooting.md)
- [Monitor aggregation progress](../use-guides/operation/monitor-aggregation-progress.md)
- [Tune API performance](../use-guides/operation/tune-api-performance.md)
- [Account list operation](../operations/account-list.md)


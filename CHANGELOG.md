# Changelog

All notable changes to **Identity Fusion NG** — the ISC connector for Map → Define → Match identity fusion, scenario recording/replay, and supporting tooling.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates use ISO 8601.

---

## 2026-10-12 · v2.2.0

### ✨ New Features

- **Optional handoff of main account when the origin is not a current contributor** — Processing Control adds **Promote first found managed account to main account when origin account is missing** (`promoteMainAccountWhenOriginMissing`). The toggle is off when the key is absent, so existing sources keep their current `mainAccount`. While it is on, Refresh sets `mainAccount` to the first live managed account before Map when the origin is not a current contributor, and clears `mainAccount` when the origin is a current contributor again, including a value an operator stored. `originAccount` and the Main account, Origin account, and First found merge rules stay unchanged.

---

## 2026-10-07 · v2.2.0

### ✨ New Features

- **Skip Fusion accounts with duplicate names** — A new Developer Setting keeps the first Fusion account registered for a Fusion identity and skips later accounts that resolve to the same identity with a different account key. Disabled by default, so the existing last-registered-wins behavior is unchanged unless the setting is enabled.

---

## 2026-10-06 · v2.2.0

### ⚠️ Breaking Changes

- **ISC account output omits blank strings and empty arrays** — Accounts sent to Identity Security Cloud no longer include a schema attribute whose value, after schema cast, is a blank string or an empty array. Blank string elements are dropped from a multi-valued attribute first, and the attribute is omitted when nothing remains. `id` and `name` are still sent when they are blank. Boolean false and numeric zero are still sent. A blank string on a numeric or boolean attribute is still sent as 0 or false.
    - Callers that expected an empty list, such as `reviews: []`, on the account payload should treat a missing key as empty. A missing key does not clear a value already stored in Identity Security Cloud.

---

## 2026-09-30 · v2.2.0

### ⚠️ Breaking Changes

- **Later explicit maps can read an earlier map's new attribute** — Explicit attribute maps run in Attribute Mapping list order. When an earlier map produces a value, a later map in the same run reads that prior mapped value instead of a live snapshot of the same name, for every merge strategy. Maps that only name raw snapshot attributes keep their current results. If a map should keep the snapshot, place it above the map that writes that name, or remove that name from Existing attributes. A selective map still evaluates only the maps it requests.

---

## 2026-09-28 · v2.2.0

### ✨ New Features

- **Orphan sources can assign an owner to unowned machine accounts** — Source Settings shows Orphan processing mode when Source type is Orphan accounts. Assignment stays the default and keeps today's correlation behavior, including discarding machine accounts. Ownership scores machine accounts that do not already have an owner identity, including accounts that are already correlated or linked on a Fusion account, and writes the selected identity as that account's owner. It does not correlate the account or attach it to a Fusion account.
- **Ownership non-matches follow the existing disable toggle** — When no identity matches, Ownership drops the account and does not set an owner. Disable non-matching accounts still queues a disable, including after a reviewer says there is no match.
- **Ownership reviews ask for an owner identity** — Review forms for Ownership mode describe choosing an owner identity. Assignment-mode orphan forms still describe merging the account into an identity.

---

## 2026-09-24 · v2.2.0

### 🔧 Improvements

- **Fusion review forms restore selected identity details** — Selecting an identity now shows its configured form attributes beneath the identities dropdown, using the same layout as the account context panel. Score tables for all candidates remain visible for comparison. Existing in-flight reviews keep their current layout until **Reset forms?** runs.
- **Attribute definitions can read this run's statuses, actions, and reviews** — `$statuses`, `$actions`, and `$reviews` in Velocity now use live collection state, including values applied after a Fusion account is created in the same aggregation. `$previous.statuses` (and the same for actions/reviews) is still last run's snapshot. Expressions that already referenced `$statuses`, `$actions`, or `$reviews` now see current-run values instead of the previous aggregation.

### 🐛 Fixes

- **Accepted merge without a persisted Fusion account still correlates** — When a reviewer merges an orphan account and the unique-id expression suppresses a Fusion account for the target identity, the next aggregation no longer rematches that account and reissues a review. Correlation runs from the completed decision before the uncorrelated sweep.
- **Fusion attributes stay intact after a quiet Refresh then a same-run merge** — When a Fusion account absorbs linked managed accounts without copying live snapshots, then later merges another account in the same aggregation, Map no longer wipes names and other Main-account attributes, and Define still sees the original source snapshot for expressions such as `$sources.MelonHRM[0].employeeId`. Operators can re-run aggregation after upgrade to restore accounts already wiped.

---

## 2026-09-23 · v2.2.0

### 🔧 Improvements

- **Refresh drops managed links owned by another Fusion identity** — When a Fusion account still references a managed source account that now belongs to another Fusion identity, Refresh removes the stale local link and leaves the account available for the owning identity to claim. Remaining contributors are remapped; a managed-origin Fusion account that loses its last managed link becomes orphan.

---

## 2026-09-18 · v2.2.0

### 🐛 Fixes

- **Correlated accounts keep the identity alias when identity scope is off** — Newly created Fusion accounts from correlated managed source accounts now use the identity alias for their display attribute instead of Normal or Unique definition output. Identity data remains unavailable to Define, and persisted Fusion accounts keep their existing display values.

---

## 2026-09-09 · v2.2.2

### 🔧 Improvements

- **Fusion review forms use reviewer locale** — When localization is enabled, Fusion review forms use the same language as the review email: identity language attribute, then **Default Language**, then English. Reviewers who share a language share one form definition; mixed-language reviewer sets get one definition per locale group (`[locale]` in the name). **Reset forms?** deletes every locale variant for matching accounts, not only the Default Language name. Localization off stays one English definition with no suffix.

---

## 2026-09-08 · v2.2.1

### 🔧 Improvements

- **Fusion review forms use DESCRIPTION HTML aligned with the review email** — Reviewers see account context, identity and account links, and a score table for every candidate (attribute, value, algorithm, threshold, result, score, with the same match/miss/combined colors as email). The new-identity / no-match toggle and identities SELECT remain the decision controls. In-flight reviews keep their existing layout until **Reset forms?** runs.
- **Reset forms closes open Fusion reviews** — On the next persistent aggregation, **Reset forms?** deletes matching Fusion review form definitions and cancels leftover open instances so those accounts can rematch on the same run. Dry-run still does not apply the flag.
- **Paginated fetches abort on a gateway-failure pool, with no 30s wait** — When enough in-flight pages on one pagination stream have seen HTTP 504 or timeout and have not yet succeeded (`min(10, this stream’s window)`), Identity Fusion sheds that stream and throws `PaginationError` immediately. There is no cooldown and no probe. Sequential and searchAfter fail on the first gateway failure. Paginated 504s still use at most one extra retry; OFFSET paging, HTTP 429 Retry-After, and non-paginated queue retries are unchanged. This is not a global API kill switch and does not replace OFFSET paging.

---

## 2026-09-03 · v2.2.0

### 🔧 Improvements

- **Paginated fetches cooldown once, then abort on 504/timeout storms** — After three consecutive gateway failures (HTTP 504 or request timeout) on one pagination stream, Identity Fusion sheds that stream’s in-flight pages, waits 30 seconds, probes the next needed page once, and resumes on success. A failed probe or a second streak fails Fetch/account-list with `PaginationError` instead of stacking skip-scans. Paginated 504s use at most one extra retry; OFFSET paging, HTTP 429 Retry-After, and non-paginated queue traffic are unchanged. This is not a global API kill switch.

## 2026-08-28 · v2.2.0

### ⚠️ Breaking Changes

- **Fetch STATUS uses independent inventory counters** — Account-list Fetch heartbeats now report `fusion-accounts=done/total`, `managed-accounts=done/total`, and (when identity Fetch runs) `identities=done/total` on one STATUS line, each with its own interval delta. Fetch no longer uses a single last-writer `progress=` fraction with unit `fetched` or `ingested`. This is a log-contract change only: Map, Define, and aggregation output are unchanged. Refresh and Process still use `progress=` (`refreshed`, `analyzed`, and so on). DETAIL `action=ingesting identities|fusion-accounts` may still appear.
-   - Migration: Log scrapers that match Fetch `progress=`, `fetched`, or `ingested` must switch to the population tokens (`fusion-accounts=`, `managed-accounts=`, `identities=`). Do not require an `identities=` segment when identity Fetch is skipped.
- **Map clears attributes that sources stopped publishing** — On a full Map, implicit candidates are live-snapshot keys plus names already on the Fusion account (minus control keys and Unique definition names). A vanished snapshot key is deleted instead of persisting forever. Normal definition names still merge when a live snapshot carries them and are never cleared. Velocity definitions that read those inputs recompute on refresh. Covers mapping-service and ubiquitous-language.
    - Migration: To retain a value after its source drops it, add an explicit attribute mapping row or a Normal attribute definition for that name. Removing a definition row lets its leftover value clear on the next full Map.

### ✨ New Features

- **STATUS heartbeats include process CPU** — Account-list `STATUS` lines now emit optional `cpu={percent}%` after `mem=` (integer percent of one core over the actual sample window; may exceed 100). The token is omitted when no previous sample exists. Do not alert on high CPU alone — read it with progress Δ and `api=` (healthy Refresh is often CPU-hot and API-idle). Log scrapers that treat STATUS as a fixed field list should allow optional `cpu=` after `mem=`.

### 🔧 Improvements

- **Fusion report is the same Match preview as dry-run** — Requesting the `report` entitlement now runs dry-run Match analysis (writes inhibited, no account-list stream) and emails **Identity Fusion Report** to global owners. The post-aggregation owner email is now **Identity Fusion Aggregation Report**. Dry-run remains **Identity Fusion Dry Run Report**. Match cards are captured even when **Send report to owner on aggregation?** is off.
- **Unchanged Fusion accounts skip copying managed source attributes** — Quiet Refresh still visits every Fusion row and claims linked managed accounts so Process cannot rematch them, but it no longer copies those accounts' attributes onto the Fusion row when source data did not change. Always recalculate, force attribute refresh, new blends, deletions, and over-threshold managed `modified` still copy this run's snapshots so Map and Velocity `$accounts` / `$sources` can read them.
- **Identity match scoring allocates less work on non-matches** — Comparing a managed account to existing identities no longer builds a per-rule score breakdown unless the pair meets the review threshold. Passing matches still store the same per-rule scores (including skipped rules). Aggregation configuration is unchanged.
- **Name-matcher scoring reuses token splits and phonetic codes** — During an aggregation, each distinct name token is split and Double-Metaphone encoded once instead of once per identity comparison. Match scores and thresholds are unchanged.
- **Always recalculate** replaces **Refresh on each aggregation?** — The Normal definition toggle label and help now state that the expression re-runs even when managed source data is unchanged. The stored `refresh` config key is unchanged.
- **Refresh logs an aggregate workload summary** — After Refresh processes Fusion accounts, one `DETAIL refresh workload` line reports account count and millisecond totals for prelude, managed-account layer, unique registration, Map, Normal Define, correlation, and finalize, plus definition and queue-scan counters. Use it to compare before/after Refresh optimizations. Aggregation output is unchanged.
- **Refresh STATUS uses one consistent progress counter** — Refresh heartbeats now report `progress=done/total refreshed(Δ+N/interval)` in the same shape as other non-Fetch `progress=` units. The redundant standalone `refreshed(N)` counter is removed; Map and Define refresh behavior is unchanged. Log scrapers matching Refresh `processed(Δ` or `refreshed(N)` should migrate to the `refreshed` progress unit.
- **Processing wait time is capped at 180 seconds** — Platform keep-alive (`processingWait`) defaults to 180 seconds and cannot exceed that. Existing sources stored above 180 are clamped at runtime.
- **Normal Define honors per-definition refresh and copies Velocity context once per account** — Definitions with Refresh off skip evaluation when the Fusion account is unchanged (no source-data refresh, reset, or force attribute refresh) and already has a value. Definitions with Refresh on still run every aggregation. Each account builds one null-prototype render context for the Define pass instead of copying caller context per definition. Datefns format regexes are cached by format string.
- **Refresh re-blends previous and missing managed accounts by key** — Persisted Fusion rows look up `previousAccountIds` and `missingAccountIds` in the managed-account work queue instead of scanning every queue entry. Blend, claim, and uncorrelated status behavior is unchanged.
- **Unchanged Fusion accounts skip Refresh-off Map and Define** — Fusion accounts no longer treat every managed account with a real modified date as dirty. Refresh-off Map and Define run when the managed account is newer than the Fusion account beyond a short grace window, or on new blend, delete, or force refresh.
- **Existing Unique values register without waiting on the uniqueness lock** — Refresh and Process unique registration insert Unique values already on the account without queuing behind the per-attribute uniqueness lock. Newly generated Unique values still take that lock for check-then-add. Uniqueness of generated values is unchanged.
- **Accounts missing indexed mandatory attributes skip the identity corpus scan** — When trigram blocking is built and a managed account has no value for any mandatory rule with minimum similarity greater than zero, matching uses an empty candidate set instead of scoring every identity. Process reports `mandatoryMissingBlockCount` separately from a full-scan fallback.
- **Identity matching uses recall-safe blocking and true top-K selection** — Binary and LIG3 mandatory rules reduce identity comparisons with proven-safe indexes, while Jaro-Winkler and other rules without a safe blocker retain full-baseline recall. Match now ranks all scored identities before retaining review candidates and automatic-merge targets, so review forms may list stronger identities that previously appeared after the first-K cutoff. Process logs full-scan fallback, comparison count, and candidate-set totals.

### 🐛 Fixes

- **Normal pass-through definitions receive same-named source values again** — On a full Map, Normal definition names now merge from live snapshots before Define transforms them, so expressions such as `$CRSID` no longer resolve to a stale or literal value. Unique definition names remain excluded from implicit Map, and Map still never clears Normal or Unique definition-owned values. Covers mapping-service and ubiquitous-language.
- **Developer Settings help shows the installed connector version** — The ISC section help now displays the exact connector package version and lint rejects stale help after a version change. The section title and generated Configuration reference remain version-free.
- **Threshold-zero mandatory attributes no longer filter identity candidates** — Mandatory match rules with minimum similarity unset or zero are not added to the trigram index, so identities that lack that attribute can still match on other rules.
- **Map no longer strips bracketed tokens from source values** — Attribute mapping copies live snapshot strings as-is. A job title such as `Unestablished Senior Occupational Health Adviser [AVH]` is no longer reduced to `AVH`. Concatenate merge still wraps distinct values in brackets on output; the persisted `sources` field is unchanged.

### 📚 Documentation

- **Account terminology distinguishes accounts from table rows** — Operator documentation and living specifications now call Fusion accounts, managed source accounts, identity-origin Fusion accounts, and origin snapshots by their canonical names. **Row** remains valid for real tables such as mappings, scores, and HTML reports; the `rowsSent` summary field is unchanged and counts streamed Fusion accounts.
- **Glossary: source snapshot materialization and claim-only absorb** — Documents how Refresh can claim linked managed accounts without copying live source attributes, and that this is not skipping Refresh or Map merge.
- **Glossary: dry-run report, Fusion report, aggregation report, Fusion Review decision section, Fusion review** — Distinguishes analysis emails from the post-aggregation owner email and from Fusion review (the review-required form), and aligns the FusionReport entitlement with Fusion report.

---

## 2026-08-24

### ⚠️ Breaking Changes

- **Unmapped same-named attributes refresh with the default merge** — On a full Map, attributes that appear on live snapshots but have no mapping row now follow the stored default attribute merge (First found, List, Main account, and so on). They are no longer left at create-time seed across refresh. Map still does not walk the full Fusion schema. When the identity bag is present, Identities is a first-class snapshot that `mainAccount` or `originAccount` can name. **Migration:** No configuration change is required. The next aggregation after upgrade refreshes those keys. To keep a create-time value, add a mapping row or pin Origin account merge.

### 🐛 Fixes

- **Disabled identity scope no longer leaks identity attributes into managed-origin Map or Define** — When Include identities is off, managed-origin rows exclude the Identities snapshot from mapped and unmapped merges, and Velocity no longer receives their identity bag, identity alias, or Identities origin account. Managed account attributes remain available normally; identity-origin global reviewer rows retain their required identity context.
- **Normal definitions still read mapped source attributes** — Velocity evaluation copies inherited current-bag keys into the null-prototype render context. Templates such as `${firstname} ${lastname}` resolve after Map instead of remaining literal. Own context keys and helpers still override same-named bag keys.
- **Non-matched-only ticks no longer emit EVENT_SUMMARY matches** — During uncorrelated sweep, `STATUS` already shows analyzed progress delta and cumulative `matches(Nn/Mm/Aa/Dd)`. Heartbeat now skips `EVENT_SUMMARY matches non-matched=+N/interval` when that is the only match activity. Review, automatic-merge, deferred, decision, email, and correlation summaries still emit.
- **Match scoring skip is logged as info when scoring is off** — When both automatic merge and manual review are disabled, the connector logs that managed accounts will be treated as NonMatched at INFO instead of ERROR. Missing reviewers while manual review is still on remains ERROR.
- **Parallel offset pagination no longer hangs or spins** — A failed or empty page in the sliding window is recorded and surfaced instead of being dropped by `Promise.race`, and a missing page in sequence now fails rather than looping without awaiting. A zero `parallelBatchSize` is treated as a window of one so pagination can still start.
- **Uncorrelated match sweep stays responsive** — The managed-account sweep now yields the event loop at a bounded cadence during pre-scoring, outcome dispatch, and the deferred drain. Previously these loops awaited work that resolved without I/O, which only queues microtasks — Node drains those before running any timer, so a large sweep silenced STATUS, the platform keep-alive, and buffered log output for its full duration and the platform reset the aggregation. Most visible on first runs, where an empty identity pool sends every account through the deferred drain.
- **Large Fetch cache registration stays responsive** — Identity and Fusion-account bulk ingest now yields between bounded chunks so operation heartbeat and platform keep-alive timers continue running. STATUS distinguishes cache registration from HTTP retrieval with `progress=… ingested`; this does not extend the platform command timeout.

### 🔧 Improvements

- **Default keep-alive interval is 250 seconds** — New sources send platform keep-alive (`processingWait`) every 250 seconds instead of 60. Existing sources keep their stored Processing wait time.
- **Faster Fusion Map and Define on the assembly hot path** — Mapping and Normal Define now do less per-account copying, snapshot scanning, and debug work during account assembly (including Match `assembleManagedAccount`). Mapped values and Velocity results are unchanged.
- **Uncorrelated sweep finishes review forms and non-matches faster** — After identity scoring, those outcomes can overlap up to the existing Fusion parallel batch cap (12 by default, or the managed-account batch size when it is lower). Automatic merges still apply one at a time. No new setting and no migration.
- **Process-phase record unique registration overlaps Map work** — Match-disabled Record accounts register unique values in parallel batches up to the Fusion parallel cap (12 by default, or the managed-account batch size when it is lower). Unique-set contents are unchanged; unique-set writes still serialize per attribute name.
- **Correlated skip-linked is no longer logged at INFO per account** — Already-linked correlated drops and correlated-orphan non-matches stay off the INFO stream at default log level. After the correlated sweep, one DETAIL line reports skip-linked count and remaining work-queue size. Match outcomes and STATUS totals are unchanged.
- **Output Unique generation evaluates Velocity outside the unique registry lock** — Unique templates (including `$UUID` inject) run without holding `unique:${name}`. That lock only checks and inserts the registered value, so Output-batch Unique work can overlap. Collision still uses an empty `$counter` on the first attempt; uniqueness is unchanged. Unique generation stays JIT on Output, not Process.

### ✨ New Features

- **New Fusion accounts are searchable by status** — Fusion accounts created in the current aggregation now carry the read-only `new` status entitlement. The marker is removed when a later aggregation reconstructs the account from its previous Fusion account, making it a one-aggregation signal.
- **Event-loop watchdog** — Operations that run a keep-alive now sample the event loop and emit `WARN EVENT_LOOP blocked <duration>` when timers are starved, naming the phase, step, and progress counter on both sides of the gap, plus a worst-block summary when the operation ends. Warnings are also written unbuffered to stdout, since a blocked loop stops the logger draining its own buffer. See the observability reference.
- **Main and origin account attribute merging** — New Fusion configurations now default mapped attributes to the selected `mainAccount`, falling back to the immutable origin account only when no valid main account exists. Per-attribute mappings can also pin values to the origin account. Both modes select one account snapshot with no fallback to other accounts; existing configurations keep their stored merge strategy.

### 📚 Documentation

- **ISC configuration help no longer repeats the same doc link** — Section overviews keep extra guides in See also; the primary configuration reference stays on the section documentation link.
- **Scenario recording Vitest is opt-in** — `npm test` no longer discovers files under `src/operations/__tests__/scenario/`. Use `npm run test:scenario` for that suite. Named golden replay of one recording is unchanged: `npm run test-recording -- tenant/scenario`.

---

## 2026-08-17

### ⚠️ Breaking Changes

- **Automatic merge without reviewers now scores and merges** — When **Enable automatic merge** is on and a managed source has no reviewers configured, Match scoring now runs for that source. Accounts at or above the automatic merge threshold merge without review; all other scored outcomes register as **non-matched** instead of partial matches or review forms. Previously, no-reviewer sources skipped scoring entirely. **Migration:** If you enable automatic merge without reviewers intentionally, no config change is required — expect merges for high-confidence scores after upgrade. If you relied on the old skip-scoring behavior, leave automatic merge disabled until reviewers are configured.

### ✨ New Features

- **Enable manual review toggle** — Restores an explicit **`fusionEnableManualReview`** setting (default **on**). Match scoring runs when automatic merge is enabled **or** when manual review is enabled with valid reviewers. After scoring, outcomes are evaluated in order: automatic merge threshold, then manual review (when enabled and reviewers exist), otherwise non-match.

---

## 2026-08-14

### ⚠️ Breaking Changes

- **Normal attribute definitions clear on falsy or failed evaluation** — When a Normal attribute definition runs during aggregation and the Velocity template fails or produces empty/falsy output, the connector now **removes** the attribute from the Fusion account instead of preserving the previously stored value. Core schema attributes (`id`, `name`) still receive safe defaults. **Migration:** Use `$previous` in Velocity expressions to retain the last value when source input is missing, or mark attributes **Static** for write-once behavior.

---

## 2026-08-13

### 📚 Documentation

- **Slimmer ISC configuration inline help** — `connector-spec.json` section help uses HTML overviews plus separate `docLink`/`docLinkLabel` fields (per ISC connector spec); field `helpKey` strings are plain text only. Detailed reference remains on the MkDocs site. `npm run lint` enforces format via `scripts/check-connector-spec-help.cjs`.

---

## 2026-08-11

### 🐛 Fixes

- **Scenario replay simulated recording time** — Replay now evaluates form stale cleanup at each step's recorded timestamp (`steps.ndjson` / `scenario.recordedAt`) instead of wall clock. Fixes false golden drift on aged scenario recordings (for example multi-step account-list with form-driven outcomes) without re-recording. Applies to in-process harness (`npm run test-recording`) and spawned replay CLI (`npm run replay`).

---

## 2026-08-09

### ⚠️ Breaking Changes

- **Correlated entitlement Remove rejected on account-update** — Removing the `correlated` or `correlate` action entitlement via account-update now fails with `Correlated entitlement cannot be removed: <value>`. The correlated entitlement is derived from whether all managed source accounts are linked in the Fusion identity; it cannot be revoked through entitlement removal. **Migration:** Do not provision Remove changes for correlated/correlate tokens; rely on aggregation output to reflect correlation state.

### 🔧 Improvements

- **FusionAccount collaborator API** — Internal TypeScript callers mutate account state through `collections` / `correlation` / `layers` instead of flat `FusionAccount` pass-throughs. No tenant-facing connector behavior change.

### 📚 Documentation

- **Specs and glossary aligned to collaborator model** — Living `fusion-service` requirements replace deleted `FusionAccountState` / rule-module / facade contracts. Ubiquitous language and glossary define Fusion account collaborators and fix **Fusion account name** (`FusionAccount.name`, not `state.name`). `FusionCorrelation` is disambiguated from business correlation.
- **Matching delegation specs reconciled** — Living specs document the three-layer match architecture (FusionService pipeline → `MatchOutcomeDispatcher` → `MatchingService` scoring). Retires `ManagedAccountMatchingRunner`; aligns `configureScoring({ captureBreakdown })`. Spec-only; no connector behavior change.
- **Source metadata index specs reconciled** — Living `fusion-run` and `source-service` specs document the dual-index pattern (`sourcesById` discovery session + `run.sourcesByName` cross-service), managed-only name map after reviewer initialization, and name-only snapshot contract. Spec-only; no connector behavior change.

---

## 2026-08-08

### ⚠️ Breaking Changes

- **Legacy raw managed account IDs removed from schema attributes** — The `accounts`, `missing-accounts`, and `originAccount` attributes no longer accept plain ISC account UUIDs without the composite `sourceId::nativeIdentity` form (except `originAccount` when `originSource` is `Identities`, which continues to store an identity ID). Non-composite values are dropped during load with a diagnostic warning. **Migration:** Before upgrading, patch persisted Fusion account attributes to composite managed account keys or re-aggregate sources so references are rewritten.

---

## 2026-08-03

### 🐛 Fixes

- **Scenario replay verification** — Completes offline golden replay for recorded scenarios. Registers `testConnection` in the replay harness and stubs workflow email calls during replay. Persists v1.1.0 matching/aggregation report runs per account-list step. `FusionRun` snapshots include finished form decisions for faithful multi-step replay. Added `npm run refresh-scenario-reports` for migrating stale scenario artifacts.

---

## 2026-07-31

### ✨ New Features

- **Automated scenario replay** — `npm run replay` now auto-feeds all scenario steps through a spawned local proxy-server connector with live terminal output, per-step banners, golden verification (unless `--no-verify`), and `replay-report.json` in the scenario directory. Debug flags: `--step`, `--pause-on-fail`, `--no-verify`. Shared replay utilities live in `src/operations/scenarioReplay/`.

### 🔧 Improvements

- **Tenant-scoped log and recording paths** — External log and recording artifact paths are now tenant-scoped on shared proxy hosts. Default disk log path is `logs/<tenant>/fusion-{YYYYMMDD}.log` and scenario recordings write to `recordings/<tenant>/{scenarioName}/`, where `<tenant>` is derived from connection Base URL (fallback `unknown-tenant`). Explicit `LOG_FILE` override is unchanged. Local recording scripts honor `BASEURL` for tenant folder selection.

### ⏳ Deprecated

- **`npm run record`** — warns and points operators to External Settings as the canonical capture path. Terminology unified to **scenario**; deprecated chain aliases remain for one release. Replay mode fails fast unless `ReplayApiAdapter` is wired — no live ISC egress.

### 📚 Documentation

- **Documentation hardening** — Getting started subsection (Day 1–7 checklist, first-aggregation verification, guide decision tree), glossary terms for umbrella/side-car/sources scope/identity scope, config-to-phases troubleshooting reference, match tuning cookbooks, PAT scope recommender (`npm run pat-scopes:recommend`), operation architecture diagram PNGs, MkDocs edit-on-GitHub, and placeholder cleanup across Use guides.

---

## 2026-07-30

### ⚠️ Breaking Changes

- **External Settings unification** — Unified **External Settings** under Advanced Settings — replaces separate Proxy Settings and Developer Settings external logging. Removed config keys `proxyEnabled`, `proxyUrl`, `proxyPassword`, and `externalLoggingUrl`. New keys: `externalProcessingEnabled`, `externalTargetUrl`, `externalTargetPassword`, `externalProxyEnabled`, `externalRecordingEnabled`, `recordingName`, `externalLoggingEnabled`, `externalLoggingLevel`. Operators must re-save sources with External Settings. External logging routes by role: HTTP POST from ISC (direct), disk append on proxy server (`LOG_FILE` or `logs/fusion-{YYYYMMDD}.log`), noop on proxy client. ISC **Recording chain name** activates record mode when gateway + proxy + recording are enabled. `proxy-service`, `log-service`, and `recording-service` specs updated.

### 🔧 Improvements

- **Localized review forms** — Fusion review forms localize via **Default Language** when **Enable localized user communications?** is on (not per-reviewer identity language). Form strings use `form_*` keys in `locales.ts`.
- **Reviewer decision logging now mirrors match discovery** — Info headlines `… DECISION DISCOVERED` / `… DECISION APPLIED` for merge, new identity, no-match, and auto-merge outcomes; compact `decisions(Nn/Mm/NMnm/Aa)` segments on `STATUS`, `DETAIL`, and phase-complete lines; `EVENT_SUMMARY decisions …` interval deltas during Process. Merge decisions log on Fetch (discovered) and Refresh (applied); new-identity decisions log on Fetch and Process (`STEP process-decisions`). Advanced connection settings guide, account-list operation doc, glossary, and `log-service` spec updated.
- **Matching results in recordings** — Record-mode account-list now writes `reports/matching-results.json` with identity matches, deferred matches (per-attribute scores), non-matches, failed matches, and sweep summary counts. Record mode automatically enables managed-account report capture. `manifest.json` and `scenario.json` reference `matchingResultsPath`. Re-record existing chains to populate the new artifact.

### 🐛 Fixes

- **Account schema discovery deduplicates attribute names case-insensitively** — when managed-source and identity attributes share a logical name with different casing (e.g. `FirstName` + `firstname`), the connector keeps the first variant and drops later duplicates. Prevents ISC API rejection of discover payloads with case-insensitive name collisions. Schema ingestion (`setFusionAccountSchema`) applies the same dedup so runtime attribute output cannot emit both casings.

### 📚 Documentation

- **MkDocs site restructure** — Restructured MkDocs site into six top-level sections (Home, Getting started, Configuration reference, Use guides, Glossary, Technical reference). Configuration pages are generated from `connector-spec.json` via `scripts/generate-config-docs.cjs`. Use guides moved to `docs/use-guides/` with legacy redirect stubs at `docs/guides/*`. README slimmed to a landing page; Home no longer syncs from README.

---

## 2026-07-29

### ✨ New Features

- **Offline recording verification CLI** — Added `npm run test-recording -- <chainName>` for offline golden verification of recorded chains — auto-runs scenario steps, reports output drift, exits non-zero on failure. Chain replay Vitest tests no longer scan local `recordings/` artifacts; harness mechanics validated via self-contained fixtures. CJS finalize scripts preserve connector-written `scenario.json` config on re-finalize.

### 🔧 Improvements

- **Pluggable recording store** — Pluggable `RecordingStore` interface with NDJSON default (`api-log.ndjson`, `steps.ndjson`, `phases.ndjson`, `manifest.json`, `scenario.json`). Finalize-once lifecycle retains `steps.ndjson` across multi-operation chains. `npm run record` verifies manifest/scenario/api-log on exit.

### 🐛 Fixes

- **Record mode now produces complete replay artifacts via `resolveRecordingConfig()` env bridge** — `RECORD_MODE`, `RECORD_CHAIN_NAME`, and `VERBOSE_RECORDING` resolve into `FusionConfig.recording` during config load so `ServiceRegistry` and `FusionRun` share one source of truth.

---

## 2026-07-28

### ✨ New Features

- **Added `$MD5(input)` Velocity context helper for lowercase hex MD5 digests in Normal and Unique attribute definitions** — use `$MD5($email)` for deterministic identifiers compatible with downstream systems. Returns empty string for null, non-string, or whitespace-only input. Documented in the define guide and connector-spec UI help. `definition-service` spec updated.

---

## 2026-07-27

### 🔧 Improvements

- **Account-list correlation log format** — Account-list correlation logs no longer report `correlated-action=` (that counter is for non-aggregation entitlement grants such as `accountUpdate`). `EVENT_SUMMARY`, `PHASE END`, and Output/Epilogue `STATUS` lines now include **completed** (PATCH resolved) and **pending** (queue snapshot) drain segments alongside `link=` and `merge=` enqueue totals — for example `correlations link=2000/2000 completed=147 pending=1853`. Log monitors should grep `completed=` and `pending=` instead of `correlated-action=` during accountList. `log-service` and `account-list-operation` specs updated.
- **Correlation activity logging** — now distinguishes **link** (correlation-on-aggregation during Refresh), **merge** (merge-decision-driven PATCH during Process), and **correlated-action** (entitlement newly granted when all missing accounts clear). `EVENT_SUMMARY` and `PHASE END` lines use `correlations link=triggers/accounts merge=triggers/accounts correlated-action=… skipped=…` instead of the legacy `correlations triggered=N accounts=M` format. Refresh `STATUS` lines include a cumulative correlation segment when link or merge activity occurred. Skip buckets aggregate silent non-PATCH reasons (`noIdentity`, `noSourceContext`, `wrongMode`, `noIscAccountId`). Log monitors should migrate grep patterns from `correlations triggered=` to `correlations link=`. `log-service`, `account-list-operation`, and `ubiquitous-language` specs updated.
- **ISC account output omits nullish attribute keys** — `SchemaService.getFusionAttributeSubset` no longer emits explicit `"attr": null` entries for sparse mapped attributes; empty arrays and populated values unchanged. Internal attribute bags are not mutated. `schema-service` spec updated.
- **Unified structured log format across all connector operations** — every host-visible INFO line now follows `[context] KIND payload`. Account-list phases emit paired `PHASE N Name START` / `PHASE N Name END elapsed=` boundaries (colon-style `PHASE N: Description (elapsed)` host lines removed). The report terminal block uses `EPILOGUE report START` / `EPILOGUE report END elapsed=`. New **`DETAIL`** kind for operational milestones (`sources=3`, `action=email sent`, workflow resolution, fusion sweep progress). Config bootstrap messages use `[config] DETAIL` via `bootstrapLog`. Non-accountList operations (`accountCreate`, `accountEnable`/`Disable`, `accountRead`/`Update`, `testConnection`, `entitlementList`, `accountDiscoverSchema`) emit `STEP slug START` / `STEP slug END elapsed=` instead of PhaseTimer prose. Email sends log one `DETAIL` line per invocation; batch activity surfaces via `EVENT_SUMMARY email=+N/interval` during Process phase. Log monitors should grep `PHASE`, `STEP`, `EPILOGUE`, `DETAIL`, and `STATUS` prefixes. `log-service`, `account-list-operation`, and `ubiquitous-language` specs updated.

### 🐛 Fixes

- **Provisioning timeout now starts when each queued API call begins HTTP execution, not when it is enqueued** — FIFO queue wait and rate-limit slot wait no longer consume the timeout budget. Retry attempts receive a fresh timeout per attempt. Fixes background correlation PATCHes aborting with generic `Aborted` after ~300s wall time while still waiting in queue during Output/Epilogue. `ApiQueue` propagates `abortSignal.reason` on rejection (timeout messages preserved). STATUS `api=` segment `q` now includes rate-limiter wait (`queueLength + rateLimitWaitCount`) so operators see pending work during drain. Advanced connection settings guide and `client-service` / `log-service` specs updated.
- **Link-to-existing form decisions** — Authorized link-to-existing form decisions again PATCH-correlate managed accounts when the source uses `correlationMode: correlate`, even after `assembleAccount` blends the row off `missing-accounts`.

---

## 2026-07-26

### ⚠️ Breaking Changes

- **Align Match-outcome vocabulary on merge** — renamed config keys (`fusionEnableAutoMerge`, `fusionAutoMergeScore`), report wire value `merge-existing-identity`, `FusionDecision.automaticMerge`, run state `autoMergedIdentityIds`, and user-facing form/history strings. Retired assign/link/automatic-assignment synonyms for Match outcomes. Status wire values `authorized` and `auto` unchanged. One-time config read migration from legacy keys. `ubiquitous-language`, `matching-service`, `fusion-run`, and `log-service` specs updated.

### 🔧 Improvements

- **Dry-run full account-list pipeline** — Dry-run mode on `std:account:list` now runs the full account-list pipeline and streams identical `StdAccountListOutput` rows (including JIT unique attributes). ISC write calls are inhibited at `DryRunApiAdapter` instead of skipping Match, Correlation, and Output logic; `rowsSent` reflects the number of streamed accounts. Dry-run is mutually exclusive with record/replay mode. Supersedes the 2026-07-23 dry-run correlation suppression via `setPersistentRun`. `account-list-operation`, `client-service`, and `fusion-service` specs updated.

---

## 2026-07-25

### 🔧 Improvements

- **Account-list STEP boundaries for managed-account init** — Account-list Process and Output phases now emit STEP boundaries for **managed account initialization** (`managed-account-init`, trigram and linked-account key index build before the correlated sweep) and **clear managed accounts** (`clear-managed-accounts`, non-record mode only, with account counts on START/END). Closes hidden wall-time gaps in phase timing reports where ~2 minutes of Process phase and Output phase work was previously unattributed. `account-list-operation` spec updated.
- **Independent reset toggles for accounts and forms** — Split Developer Settings reset into independent **Reset accounts?** (`resetAccounts`) and **Reset forms?** (`resetForms`) toggles — both default to off and auto-disable after one persistent aggregation. Account reset clears fusion state and emits zero accounts without deleting review forms unless **Reset forms?** is also enabled. Form reset deletes all Fusion review form definitions and allows aggregation to continue. Legacy connector attribute `reset` still maps to `resetAccounts` on read; disable clears both keys. `account-list-operation` and `fusion-service` specs updated.

### 🐛 Fixes

- **Pending review forms deplete work queue** — Pending Fusion review forms again **deplete the managed-account work queue during Fetch** — `FormService` normalizes composite keys from form input, claims via run inventory when instances are pending, and retains inventory metadata (including optional `identityId`) after claim. **Partial matches** now call `claimAccount` after successful review form creation in the same aggregation run. **`getOrCreateFormDefinition`** recovers from duplicate-name ISC conflicts (409 / `400.1.409`) by retrying exact-name lookup. Prevents duplicate form work and `400.1.409` errors when accounts awaiting reviewer decision re-enter Match. `form-service`, `fusion-run`, and `match-outcome-dispatch` specs updated.
- **Correlated accounts linked via persisted Fusion keys** — Correlated managed accounts linked only via **persisted Fusion account keys** (`previousAccountIds` / missing references) or matching **identity-origin Fusion rows** are recognized as already linked — `isManagedAccountLinkedInFusion` centralizes the check used by the correlated sweep and Match pre-filter. `FusionAccount.previousAccountIdsSet` exposes persisted keys for the linked-key index.
- **Managed account key from nested source.id** — `buildManagedAccountKey` / `getManagedAccountKeyFromAccount` accept accounts whose `sourceId` is only present on nested `source.id`, matching ISC account shapes that previously produced no composite key.
- **Fusion report email delivery** — Fusion **report email delivery** hydrates missing owner/recipient identities before resolving addresses, falls back to identity profile fetch when cache lacks email attributes, and logs owner type/id counts when no recipients are found. `SourceService.fetchGlobalOwnerIdentityIds` resolves workgroup members via a per-workgroup cache. Fusion report Handlebars `processingStatsCards` helper no longer requires a redundant report-date argument.

---

## 2026-07-24

### 🔧 Improvements

- **Sliding-window parallel account pagination** — Parallel account pagination now uses a **sliding-window** scheduler instead of sequential batch barriers — when one page completes, the next offset is enqueued immediately (up to `parallelBatchSize` in-flight pages per stream). Removes straggler idle slots on large Fetch runs. `parallelBatchSize` is no longer capped to `maxConcurrentRequests` at construction; the shared API queue still enforces global concurrency. Fetch `onPageProgress` / STATUS `fetched` deltas update after each page completes. See advanced-connection-settings guide.
- **Pipeline progress on STATUS heartbeat** — STATUS heartbeat lines now show **pipeline progress delta** on `progress=done/total` (optional unit: `fetched`, `processed`, `analyzed`, `sent`, `registered`) separately from **api-queue throughput**. The queue segment is relabeled from `queue … processed=` to `api-queue … completed=` so local pipeline work is not confused with HTTP queue completions. Fetch phase updates progress during paginated loads. Log scrapers matching `queue processed=` should migrate to `api-queue completed=`.
- **Record unique registration phase** — Record-type sources with **Include record accounts in Match** disabled now bulk-register unique attribute values in a dedicated **record unique registration** phase after the correlated sweep and before uncorrelated match scoring. Thousands of record-only accounts no longer enter the match sweep or run full Map/Define assembly — only selective attribute maps whose targets coincide with unique definitions (plus passthrough when the source attribute name matches) are evaluated, then values are registered and accounts are removed from the work queue. Process logs include a `record-unique-registration` step with `registered` progress. Form decision no-match outcomes reuse the same registration helper. See source-configuration guide. `account-list-operation`, `definition-service`, `mapping-service`, and `matching-service` specs updated.
- **Configurable operation heartbeat interval** — Operation heartbeat interval is now configurable in Advanced Settings → Advanced Connection Settings as **Heartbeat interval (seconds)** (`heartbeatInterval`). Default is **10 seconds** (was an internal 30-second constant). Runtime value remains `statsLoggingIntervalMs` for STATUS and EVENT_SUMMARY emission during `accountList`. Set to 30 to restore prior log frequency.
- **Heartbeat queue and work pending labels** — Operation heartbeat `STATUS` lines now include `queue-pending` labels when the API queue is backed up and `work-pending` counts for disable ops, form candidates, review URLs, and deferred match candidates. `WARN STALL` lines include pending queue labels. `METRIC` duration fields use human-readable elapsed format (`567MS`, `1.2S`) instead of raw milliseconds.
- **Sliding-window API rate limiter** — Replaced uniform RPS spacing in `ApiQueue` with a sliding-window rate limiter aligned to ISC tenant limits (default 80 request starts per 10s, hard cap 100/10s). Concurrency slots now count only in-flight HTTP work, not rate-limit waits — improving Fetch-phase throughput on large tenants. Legacy `requestsPerSecond` still derives an equivalent window cap. Advanced Connection Settings defaults: `maxConcurrentRequests` 20 (UI max 30), new `parallelBatchSize` 12 (range 1–16). See advanced-connection-settings guide for tuning on strict tenants.
- **Provisioning timeout aborts in-flight HTTP** — `ClientService` aborts in-flight HTTP when `provisioningTimeout` elapses — merged caller `abortSignal` and timeout propagate to axios via `SdkApiAdapter`, so timed-out requests no longer hold queue slots or sockets. Client-service spec updated; queue, rate limiter, abort, and adapter tests expanded (75 clientService tests).
- **Unified accountList operation heartbeat** — Unified `accountList` operation heartbeat replaces standalone `Queue Stats:` and `Memory usage` log lines. A configurable `STATUS` line reports phase, step, progress, queue delta, and memory; `EVENT_SUMMARY` lines aggregate match and correlation activity; `WARN STALL` fires when the API queue stops completing. Default interval is now 10 seconds (see **Heartbeat interval** in Advanced Connection Settings). Per-account match/correlation INFO lines are summarized into the heartbeat (detail remains at debug). Log monitors should grep `STATUS` / `WARN STALL` instead of `Queue Stats:` / `Memory usage`.
- **Replaced `slice(i, i + 3)` with `substring(i, i + 3)` in trigram index extraction and query (`extractTrigrams`, `queryAttributeIndex`)** — identical trigram sets and candidate results, fewer transient string allocations on the matching pre-filter hot path. `matching-service` spec documents padded substring window invariants.

### 🐛 Fixes

- **Correlated orphan managed account hydration** — Correlated orphan managed accounts (correlated on the source but not linked to a Fusion row) now hydrate out-of-scope identities in the Process phase, immediately before the correlated account sweep, instead of during Fetch when the Fusion account map is empty. `MatchOutcomeDispatcher` applies the identity layer to each new Fusion account created from those orphans so display-attribute overrides can use `identityAlias`. Fetch phase no longer performs this hydration pass. Process logs include an `orphan-identity-hydration` step. `fusion-run` and `account-list-operation` specs updated.

---

## 2026-07-23

### ⚠️ Breaking Changes

- **Dry-run merged into account-list** — Removed `custom:dryrun` command. Dry-run analysis is now a mode of `std:account:list` activated via `{ dryRun: { enabled: true } }` on the input. Output rows are 1-to-1 `StdAccountListOutput` (no `matchingStatus` / `reportCategories` / `review` decorations). Analysis detail lives in the HTML report (`saveFile: true`) or email (`sendEmail`). See README §"Dry-run mode" for migration. `OperationContext` enum removed (replaced by boolean flags). `PipelineMode` union deleted; `RunDescriptor` struct unified persistence/output policy. Phase exports removed from `corePipeline.ts`; `executeRun` replaces `PipelineRunner`. Net deletion of ~2,900 lines across 32 files. All 971 tests pass.

### 🔧 Improvements

- **Replaced `Object.values().find()` linear scans in `formProcessor` dictionary-path extractors (`readCorrelatedIdentityId`, `extractAccountInfoFromFormInput`, `extractCandidateIdsFromFormInput`) with direct key lookup plus `for...in` fallback** — same extracted values, no values-array allocation per field read. Fixed object-shaped `name`/`source` fields on the account-object branch. Added `form-service` spec requirement and expanded `formProcessor.test.ts` coverage (flat, arbitrary-key, direct-key, correlated-identity dictionary paths).
- **Replaced boolean match-flag arrays in `jaroSimilarity` with zero-initialized `Uint8Array` buffers** — same Jaro-Winkler scores, less allocation overhead on hot string comparisons.
- **Added run-scoped `fullScanFallbackCount` on `FusionRun` when trigram candidate blocking falls** — back to a full identity scan (managed account missing all mandatory trigram attributes). `MatchingService.getCandidates` emits throttled warnings (first 5, then every 100th); `accountList` process phase logs a run summary when the count is non-zero.
- **Added `fusionAccountsIterable()` on `FusionRun` for zero-copy iteration over fusion accounts;** — linked-account index build and decision processing now iterate without `Array.from`/`allFusionAccounts` copies. Defensive-copy getter preserved for callers that mutate arrays.
- **Hardened HTTPS connection pooling in `SdkApiAdapter` with explicit socket bounds** — (`maxSockets: 50`, `maxFreeSockets: 10`, `keepAliveMsecs: 30s`, `timeout: 60s`) so burst ISC API traffic reuses connections without unbounded socket growth. Client-service spec updated; `sdkApiAdapter.test.ts` covers agent options and shared `Configuration` wiring.
- **Replaced the dual full-Account snapshot (`managedAccountsAllById`) with a lightweight `managedAccountInventory` on `FusionRun`** — Work queue depletion no longer requires retaining every `Account` object through output phase; form, report, and fusion-layer consumers use `hasManagedAccount` / `getManagedAccountInfo` accessors. Snapshot/restore serializes inventory metadata instead of full accounts.
- **Identity-sweep non-match comparisons no longer allocate `ScoreReport[]` breakdown arrays or skipped-report padding** — Fast path uses combined-score totals only (`evaluateRuleTotals`); LIG3 upper-bound checks avoid skip `ScoreReport` allocation. Threshold-passing matches re-run once with full breakdown (matches are rare). Deferred candidates and report-capture runs unchanged. Wired via `MatchingService.setCaptureBreakdown()` from `FusionService.initializeManagedAccountProcessing`. LIG3 upper-bound helpers colocated in `scoringHelpers` (`lig3UpperBound`, `lig3UpperBoundSkipIfUnreachable`).
- **Capped managed-account identity and deferred scoring concurrency via new developer setting `scoringMaxConcurrency` (default 12, max 50). `scoreManagedAccounts` now uses `promiseAllBatched` instead of uncapped `Promise.all` over the full batch** — peak memory during Match no longer scales with `managedAccountsBatchSize` (default 100). Batch grouping unchanged; scoring throughput is independently tunable under Advanced Settings → Developer Settings.
- **Replaced the inline "PHASE 6" report block with a failure-isolated `reportEpilogue()` helper that always runs after the pipeline** — reports survive stream crashes. Dry-run emission reordered (file → email → summary, most-durable-first) so a broken `res.send` connection never loses the HTML report or email. PHASE 6/7 log markers renamed to "Epilogue:". Ubiquitous-language spec gains the **Epilogue** term. `accountList` pipeline errors are captured, reports emitted, then the error is rethrown (runs still fail, but never silently).

### 🐛 Fixes

- **Dry-run mode no longer writes correlation state to ISC** — `CorrelationManager.applyPerSourceCorrelationIfNeeded` now guards on a runtime persistence flag (`FusionService.setPersistentRun`) so "Correlate missing accounts on aggregation" is a no-op in dry-run. The delayed-aggregation sender workflow fetch is also suppressed in dry-run.

---

## 2026-07-22

### 🔧 Improvements

- **Re-cut messaging responsibilities along domain nouns into three dedicated modules** — `WorkflowService` (encapsulating delayed workflow prefetching, lookup, creation, access token resolution, and execution), `EmailRenderer` (handling Handlebars helper initialization, templates, locales, and cell truncation using clean domain DTOs), and `ReportService` (consolidating report building, decision mapping, output directory setup `mkdir`, HTML output, and email delivery). Added `WorkflowService` to `ServiceRegistry` and updated operations to delegate directly. All 1,002 unit tests pass 100%, with zero linter errors.
- **Collapsed the `FusionAccount` facade into three behavior-rich sub-objects** — `FusionCollections` (all collection sets, statuses, actions, reviews, sources, matches, history), `FusionCorrelation` (correlation promises, status updates, deferred operations), and `FusionLayers` (identity/managed-account/decision layer methods + matcher logic) — each with private state. Deleted 13 files: `FusionAccountState`, `FusionAccountBase`, `FusionAccountAccessors`, `FusionAccountMatcher`, and 8 rule modules under `fusionAccountRules/`. Net reduction of 1,417 lines. No behavioral changes; all 989 tests pass. Moved `AggregationTracker`, managed-account processing state machine, trigram blocking index, normalization caches (`normalizedCache`, `nameNormalizedCache`), form counters, and form delete queue from `FusionService`, `MatchingService`, `FormService`, and `SourceService` into `FusionRun`. Deleted 4 dead fossil fields from `FormService` and 2 dead inventory fields from `SourceService`. Removed vestigial pass-through getters from `FusionService`. Consolidated `managedAccountsAllById` on `FusionRun` as the canonical location. Expanded `snapshot()`/`restore()` to include all newly-moved state. Added `run` parameter to `ReportService` for consistent direct access (pattern already used by `FormService`, `SourceService`, `IdentityService`).
- **Audited and unified run-scoped state access across all services** — every service that needs `FusionRun` state receives it as a direct constructor parameter (6 services: `FormService`, `SourceService`, `IdentityService`, `FusionService`, `MatchingService`, `ReportService`); infrastructure-only services (`ClientService`, `LogService`, `LockService`, `EntitlementService`, `MessagingService`, `SchemaService`, `MappingService`, `DefinitionService`, `CorrelationManager`) do not hold `run`. No service accesses `run` through another service.
- **Completed the account-assembly recipe extraction** — removed 4 duplicated `isAggregationAccountListMode` and `shouldPruneDeletedManagedAccounts` method copies from `FusionService`, `DecisionProcessor`, and `MatchOutcomeDispatcher`, delegating all 6 call sites to the canonical `AccountAssembly` collaborator. Removed unused `commandType`/`operationContext` constructor params from `DecisionProcessor`. Net reduction of 14 lines. No behavioral changes; all 994 tests pass.

### 🐛 Fixes

- **FusionService.setReviewerForSource fix** — Fixed pre-existing bug in `FusionService.setReviewerForSource` where `sourceAccount` (undefined) was used instead of `fusionAccount`.

---

## 2026-07-21

### 🔧 Improvements

- **Match outcome dispatcher module** — Deepened the Match step into a single `MatchOutcomeDispatcher` module in `src/services/matchingService/`, absorbing the old `ManagedAccountAnalyzer`, `ManagedAccountMatchingRunner`, and `ManagedAccountOutcomeHandler`; removed duplicated resolution switches from `FusionService`; added `runMatchSweep(accounts, batchSize): MatchSweepResult` as the single public seam.
- **Account assembly recipe extraction** — Extracted the shared account-assembly recipe into `src/services/accountAssembly/AccountAssembly`, removing duplicated mode-gate / layer-application / Map/Define / registration code across `FusionService`, `IdentityProcessor`, and `DecisionProcessor`.
- **FusionRun as Match state source of truth** — Tightened `FusionRun` as the single source of truth for Match state by adding `queueDisableOperation`, `removeMatchAccount`, `trackFailed`, and deferred-candidate registry verbs; deduplicated `sourcesByName` between `SourceService` and `FusionRun`; moved `AggregationTracker` to `src/model/`.
- **Broken matching/fusion/form import cycles** — Broke the `matchingService ⇄ fusionService ⇄ formService` import cycles by moving match predicates, the deferred-match log formatter, and event-loop yield into their correct homes (`matchingService/`, `utils/`); moved shared run/report types (`OperationContext`, `FusionReportBlend`) to `src/model/`.
- **Match outcome dispatch in ubiquitous language** — Added **Match outcome dispatch** to the ubiquitous-language spec and glossary, clarifying that `MatchingService` owns the Match step while `FusionService` owns operation-run orchestration.
- **Simplified lock and work queue types** — Removed over-engineered `LockService` and `WorkQueue` interfaces in favor of using concrete classes directly to simplify internals and update specifications.
- **Native UUID and FormData APIs** — Replaced external dependencies (`uuid` and `form-data`) with native Node.js APIs (`crypto.randomUUID()` and `FormData`) to reduce package footprint.
- **Streamlined memory management in output** — Streamlined memory management by removing `streamAndClearEligibleAccounts` and `uniqueAttributesPhase`, integrating JIT unique attribute generation directly into the final aggregation output stream to reduce pipeline complexity while retaining strict OOM protections.
- **Early-return Fusion Account streaming** — Implemented early return architecture for Fusion Accounts to mitigate OOM risks by streaming and clearing eligible accounts directly within the pipeline. Refactored `IdentityService` to batch missing identity requests using Lucene OR queries, resolving N+1 latency bottlenecks.

---

## 2026-07-20

### ✨ New Features

- **Implemented trigram-based identity matching utilities and added comprehensive unit tests** — for core services.

### 🔧 Improvements

- **FusionRun centralized state container** — Introduced `FusionRun`, a centralized state container that encapsulates all per-run state (`identityMap`, `managedAccountsById`, matching states, maps, and form decisions), completely managing state mutations.
- **Map, Define, and Match service extraction** — Extracted `MapService`, `DefineService`, and `MatchService` from the legacy `AttributeService` and `ScoringService`, separating concerns and improving testability.
- **FusionRun injection for fusion processors** — Rationalized dependency interfaces for fusion processors and handlers by injecting the `FusionRun` container directly instead of passing scattered service instances.
- **RecordingService FusionRun snapshots** — Simplified `RecordingService` to seamlessly snapshot the `FusionRun` state directly.

### 🐛 Fixes

- **Aggregation event search query escaping** — Updated aggregation event search query to properly escape source names and use regex matching for more robust event discovery in `SourceService`.

---

## 2026-07-19

### 🔧 Improvements

- **Run vs operation identifier distinction** — Restored the `run` vs `operation` distinction for per-run identifiers, replaced `unmatched` with `non-matched`, and removed the backward-compatible `pass` alias from the `sweep` field in `recordingService`.
- **Aligned codebase with master ubiquitous-language spec: rewrote `openspec/specs/ubiquitous-language/spec.md` with canonical** — terms, account taxonomy, operation/run/phase/sweep vocabulary, matching vs scoring distinction, and retired-terms table. Updated `docs/concepts/glossary.md` to mirror the spec. Renamed code symbols to match canonical terms: `ManagedAccountPassRunner` → `ManagedAccountMatchingRunner`, `analyzeIdentityPhase`/`analyzeDeferredPhase` → `scoreIdentityCandidates`/`scoreDeferredCandidates`, `MatchCandidateType.NewUnmatched` → `MatchCandidateType.Deferred`, `runCorrelatedManagedAccountPrePass` → `runCorrelatedAccountSweep`, `hasIdentityBackedMatches` → `hasIdentityCandidateMatches`. Replaced retired terms across code, docs, and specs: `raw account` → `managed source account`, `identity-based` → `identity-origin`, `unmatched` → `non-matched`, `pass`/`Pass 1/Pass 2` (matching traversal) → `sweep`/`identity scoring sweep`/`deferred scoring sweep`. Removed `wireCandidateType` translation in dry-run payload (now emits `deferred` directly).

---

## 2026-07-17

### 🔧 Improvements

- **FusionAccount rule module refactor** — Refactored `FusionAccount` into a dedicated `FusionAccountState` data container and focused rule modules (`constructionRules`, `layerRules`, `statusRules`, `actionRules`, `reviewRules`, `correlationRules`, `historyRules`), with `FusionAccount` retained as a thin delegation facade. No public API or behavior changed; improves maintainability and makes the large account model easier to review and extend.
- **Extracted Velocity template evaluation into a dedicated `templateEvaluator.ts` module with** — `evaluateAttributeTemplate` and `applyOutputTransforms` functions. Standard Velocity semantics now apply: unresolved variables render literally (`$var` → `"$var"`); use `$!var` for quiet suppression.

---

## 2026-07-15

### ✨ New Features

- **Added `$Normalize.ascii` Velocity helper for transliterating non-ASCII characters to ASCII,** — with optional language-specific digraph rules (German, Nordic).
- **Added `$String` to available Velocity template helpers in connector-spec.** — Added `$String` to available Velocity template helpers in connector-spec.

### 🔧 Improvements

- **Added Static option to Normal attribute definitions** — attributes are evaluated only when they have no value, preventing recalculation on subsequent aggregations.

---

## 2026-07-01

### 🔧 Improvements

- **Included identity name in account context and added support for** — match-based display attribute overrides during identity-name resolution.

### 🐛 Fixes

- **Fixed unintended automatic account pruning during identity and decision processing cycles.** — Fixed unintended automatic account pruning during identity and decision processing cycles.

---

## 2026-06-26

### 🔧 Improvements

- **Added a new Binary (Exact Match) algorithm to Fusion attribute match configuration** — It returns a score of 100 only when the two values are identical strings (case- and whitespace-sensitive) and 0 otherwise, making threshold configuration trivial for stable identifiers (employee IDs, UUIDs, pre-normalized emails). Forgiving comparison can still be achieved by pre-normalizing values in **Define** before applying Binary.
- **Refactored connector internals: added `SourceService` getters for delayed-aggregation and reverse-correlation** — sources, consolidated account-create identity-name resolution into a shared `resolveIdentityNameFromCreateInput` helper, aligned composite managed-account key handling (now normalized consistently via `getManagedAccountKeyFromAccount`), introduced `OperationContext` enum for `FusionService`, extracted batching into a dedicated module (`src/services/fusionService/batching.ts`), and added `isSet`/`isNotSet` aliases plus type-safe `Account.attributes` helpers and `FusionAccount` attribute accessors (`getAttribute`, `getStringAttribute`, `hasAttribute`).
- **Added per-operation C4 container diagrams (`.drawio`) under `docs/operations/diagrams/` for `testConnection`,** — `accountList`, `accountRead`, `accountCreate`, `accountUpdate`, `accountEnable`, `accountDisable`, `entitlementList`, `accountDiscoverSchema`, and `custom:dryrun`.

### 📚 Documentation

- **Added an optional Skip match if threshold not met toggle on Fusion attribute match rules** — When enabled, non-mandatory rules whose computed similarity is below their configured minimum are excluded from the weighted combined match score, so weak signals no longer drag the combined score down. Mandatory rules are always evaluated regardless of this toggle. Documented in the matching guide and the README matching rules reference.
- **Clarified and tightened operation documentation (`account-read`, `account-create`, `account-enable`, `account-update`, `entitlement-list`)** — to reflect current setup, rebuild, cascade-aggregation, and output flows.

---

## 2026-06-24

### 🔧 Improvements

- **Replaced exact-match auto-assignment with configurable threshold-based automatic assignment settings.** — Replaced exact-match auto-assignment with configurable threshold-based automatic assignment settings.
- **Added cascade aggregation and localization settings to the connector specification.** — Added cascade aggregation and localization settings to the connector specification.
- **Added parent key and value constraints to the automatic assignment** — match score field.
- **Made `fusionAutoMergeScore` mandatory and enforced strict threshold validation against the** — manual review score.
- **Consolidated Fusion account identity-name resolution: `IdentityInfo` now exposes distinct `id`,** — alias `name`, and human-readable `displayName` chains; `FusionAccount.name` resolves to the source title only; `fusionDisplayAttribute` and `fusionIdentityAttribute` are now immutable once set (with a UUID fallback for missing identity attributes); identity decisions use mapping/definition config for display resolution. The Fusion Review Decisions card now renders human-readable account names and links the "Created new identity" entry to the ISC account page.

### 📚 Documentation

- **Added a localization guide and documented the cascade aggregation process.** — Added a localization guide and documented the cascade aggregation process.

---

## 2026-06-23

### 🔧 Improvements

- **Version update procedure** — Implemented a version update procedure for the Identity Fusion NG connector.

---

## 2026-06-22

### ✨ New Features

- **Added `$isUnique(value)` helper for Unique Velocity expressions.** — Added `$isUnique(value)` helper for Unique Velocity expressions.

### 🔧 Improvements

- **Updated project dependencies and internal modules within `.opencode`.** — Updated project dependencies and internal modules within `.opencode`.
- **Renamed `fusionAverageScore` to `fusionManualReviewScore` and implemented identity attribute schema discovery.** — Renamed `fusionAverageScore` to `fusionManualReviewScore` and implemented identity attribute schema discovery.
- **Streamlined identity name assignment in FusionAccount and FusionService.** — Streamlined identity name assignment in FusionAccount and FusionService.
- **Identity-origin scope and identity attribute** — Identity-origin accounts are now orphaned only when their origin identity is outside the configured identity scope. Identity-origin accounts now set the Fusion identity attribute to the source identity id.
- **Consolidated UUID and incremental-counter generation as sub-modes of the Unique attribute type.** — Consolidated UUID and incremental-counter generation as sub-modes of the Unique attribute type.
- **Improved Velocity context for identity-backed accounts and `$sources` Map access.** — Improved Velocity context for identity-backed accounts and `$sources` Map access.
- **Updated connector-spec help text and `docs/guides/define.md` for the new Unique/UUID/counter behavior.** — Updated connector-spec help text and `docs/guides/define.md` for the new Unique/UUID/counter behavior.
- **Updated dependencies and npm `allowScripts` policy; added OpenSec support.** — Updated dependencies and npm `allowScripts` policy; added OpenSec support.
- **Added AI-powered PR review workflows using Cursor and OpenCode agents.** — Added AI-powered PR review workflows using Cursor and OpenCode agents.
- **Refactored `getManagedAccountKeyFromAccount` to return `buildManagedAccountKey` directly.** — Refactored `getManagedAccountKeyFromAccount` to return `buildManagedAccountKey` directly.
- **Counter-aware maxLength for Unique definitions** — Added counter-aware `maxLength` truncation for Unique definitions: counter character width is reserved from the budget before prefix truncation, ensuring the assembled value (prefix + counter) does not exceed `maxLength`.

### 🐛 Fixes

- **Identity schema discovery** — Fixed identity schema discovery bugs (undefined names, casing overwrites, type mapping, and error propagation).
- **maxLength output transform ordering** — Fixed `maxLength` output transform ordering — now applied after trim/case/spaces/normalize, so final value is exactly ≤ `maxLength` instead of shorter due to post-truncation trimming.

### 🗑️ Removed

- **Removed legacy \_id Velocity fallback** — Removed legacy `_id` fallback from Velocity Context account snapshots.

### 📚 Documentation

- **Renamed tenant attribute to mainAccount** — Renamed `tenant` mapped attribute reference to `mainAccount` in connector logic and documentation.

---

## 2026-06-21

### 🔧 Improvements

- **Initialized Repomix configuration and ignore patterns.** — Initialized Repomix configuration and ignore patterns.

---

## 2026-06-19

### 🔧 Improvements

- **Extended orphan detection to identity-origin Fusion accounts and formalized architectural specifications.** — Extended orphan detection to identity-origin Fusion accounts and formalized architectural specifications.
- **Unified identity-name precedence and removed legacy flat-key fallbacks in Velocity snapshots.** — Unified identity-name precedence and removed legacy flat-key fallbacks in Velocity snapshots.

---

## 2026-06-18

### 🔧 Improvements

- **Added OpenSpec support for change-managed specifications.** — Added OpenSpec support for change-managed specifications.

---

## 2026-06-12

### 🔧 Improvements

- **Synced `connector-spec.json` with default values.** — Synced `connector-spec.json` with default values.

### 🐛 Fixes

- **Fixed infinite loops in uniqueness counter generation.** — Fixed infinite loops in uniqueness counter generation.

---

## 2026-05-29

### 🔧 Improvements

- **Introduced full i18n localization support for email templates and connector communications.** — Introduced full i18n localization support for email templates and connector communications.
- **Added support for complex JSON objects in attribute handling, ensuring** — schema casting preserves non-string types.
- **Overhauled matching configuration in the connector specification, improving auto-assignment logic** — and adding conditional visibility for thresholds.
- **Updated candidate badge reporting in Fusion reports to use 'Auto'** — and 'Manual' badges based on the configured automatic assignment match score threshold, replacing the legacy 'Exact' badge.

---

## 2026-05-28

### 🔧 Improvements

- **Refactored the internal client service to support new API adapters** — and improved queue management.

---

## 2026-05-27

### 🔧 Improvements

- **Enhanced schema discovery to dynamically include identity schema attributes when** — identities are in scope.

---

## 2026-05-21

### 🔧 Improvements

- **Refactored `FusionService`, `FormService`, and `AttributeService` extracting helper functions to `helpers.ts`** — modules to improve maintainability and separate concerns.
- **Refactored `FusionAccount` logic and extracted validation logic.** — Refactored `FusionAccount` logic and extracted validation logic.

### 🐛 Fixes

- **Fixed `tsconfig.json` configuration for TypeScript compilation.** — Fixed `tsconfig.json` configuration for TypeScript compilation.

---

## 2026-05-08

### 🔧 Improvements

- **Refactored `execute` method in `src/services/proxyService.ts` to reduce complexity and improve maintainability.** — Refactored `execute` method in `src/services/proxyService.ts` to reduce complexity and improve maintainability.
- **Refactored `ensureIdentityProfileMapping` in `src/services/sourceService/sourceService.ts` for readability.** — Refactored `ensureIdentityProfileMapping` in `src/services/sourceService/sourceService.ts` for readability.

---

## 2026-05-07

### 🔧 Improvements

- **Added missing test cases for `trigramIndex.ts` to improve test coverage.** — Added missing test cases for `trigramIndex.ts` to improve test coverage.
- **Improved performance by batching concurrent API calls in `fetchAccountSchema`.** — Improved performance by batching concurrent API calls in `fetchAccountSchema`.
- **Bound identity enrichment batch sizes using `promiseAllBatched` to resolve unbounded** — API concurrency issues.
- **Optimize N+1 fetch in `getRecipientEmails` by batch fetching missing identities.** — Optimize N+1 fetch in `getRecipientEmails` by batch fetching missing identities.

---

## 2026-04-29

### 🔧 Improvements

- **Improved performance by caching listSourceSchemas API results.** — Improved performance by caching listSourceSchemas API results.

### 📚 Documentation

- **Added PR CI review orchestration with refactor, documentation, and README changelog gates.** — Added PR CI review orchestration with refactor, documentation, and README changelog gates.
- **Added deterministic PR quality checks for refactor review, code documentation** — review, and docs/changelog review.

# account-list Spec

## Purpose

The account-list operation streams accounts to ISC aggregation. This spec defines the contract for account listing behavior, including an optional non-persistent dry-run mode.
## Requirements
### Requirement: Account list streams all accounts

The system SHALL stream all available accounts when the account-list operation is invoked. In dry-run mode (`dryRun.enabled: true`), the system SHALL stream all accounts non-persistently without modifying state. Managed account scope SHALL be narrowed only by source configuration filters applied during Fetch (see source-service spec for Accounts API filter and Accounts JMESPath filter). Account-list SHALL NOT accept or honor list-input filter criteria on `StdAccountListInput`.

#### Scenario: Successful account listing

- **WHEN** the account-list operation is invoked
- **THEN** the system SHALL stream all fusion accounts eligible for output from the scoped aggregation run

#### Scenario: Account listing with filters

- **REMOVED** — superseded by **Accounts API filter narrows managed fetch scope during account-list**. Original wording incorrectly implied list-input filter criteria; intent is source configuration Accounts API filter applied at Fetch time.

#### Scenario: Accounts API filter narrows managed fetch scope during account-list

- **GIVEN** a managed source configured with an Accounts API filter (`accountFilter`)
- **WHEN** the account-list operation runs Fetch phase
- **THEN** the source service SHALL apply the filter server-side when calling the ISC Accounts API
- **AND** managed source accounts excluded by the filter SHALL NOT enter the work queue, matching pipeline, or output as new Fusion accounts from that source fetch
- **AND** scope narrowing SHALL NOT rely on list-input filter criteria on the account-list invocation

#### Scenario: Successful dry-run listing

- **WHEN** the account-list operation is invoked in dry-run mode
- **THEN** the system SHALL stream all eligible fusion accounts without persisting any state changes

### Requirement: Account list supports an optional dry-run input parameter

The account-list operation SHALL accept an optional `dryRun` input object with fields `enabled` (boolean, default false), `saveFile` (boolean, optional), and `sendEmail` (string or array of strings, optional). When `enabled` is true, the operation SHALL activate dry-run mode: full pipeline execution with write API calls inhibited at the client adapter.

#### Scenario: Platform invocation without dryRun parameter

- **WHEN** the account-list operation is invoked by the platform without the `dryRun` input parameter
- **THEN** the system SHALL execute a persistent aggregation, identical to current behavior

#### Scenario: Dry-run mode with enabled flag

- **WHEN** the account-list operation is invoked with `{ dryRun: { enabled: true } }`
- **THEN** the system SHALL execute all phases including Output account streaming
- **AND** ISC write API calls SHALL be inhibited at the DryRunApiAdapter without mutating the tenant

#### Scenario: Dry-run mode saveFile option

- **WHEN** the account-list operation is invoked with `{ dryRun: { enabled: true, saveFile: true } }`
- **THEN** the system SHALL write the dry-run summary and HTML report to the `./reports/` directory on the connector host

#### Scenario: Dry-run mode sendEmail option

- **WHEN** the account-list operation is invoked with `{ dryRun: { enabled: true, sendEmail: "reviewer@example.com" } }`
- **THEN** the system SHALL deliver the dry-run report email to the specified recipients

#### Scenario: Sub-options ignored when dryRun not enabled

- **WHEN** the account-list operation is invoked with `{ dryRun: { saveFile: true } }` without `enabled: true`
- **THEN** the system SHALL execute a normal persistent aggregation and ignore the `saveFile` option

### Requirement: Dry-run mode streams 1-to-1 StdAccountListOutput objects

In dry-run mode, the account-list operation SHALL stream `StdAccountListOutput` objects via `res.send` that match persistent aggregation output for the same ISC input state. Objects SHALL use the standard shape (`key`, `attributes`, `disabled`) and SHALL NOT carry legacy enrichment payloads (`matchingStatus`, `reportCategories`, `sourceStatus`, `correlationStatus`, `review`, synthetic `orphan-deferred:*` stubs).

#### Scenario: Dry-run output shape matches aggregation output

- **WHEN** the account-list operation runs in dry-run mode
- **THEN** each streamed `StdAccountListOutput` object SHALL contain only `key`, `attributes`, `disabled`, and standard `StdAccountListOutput` fields

#### Scenario: Dry-run output includes JIT unique attributes

- **GIVEN** Fusion accounts requiring unique attribute refresh during output
- **WHEN** the account-list operation runs in dry-run mode
- **THEN** streamed Fusion accounts SHALL include generated unique attribute values produced by the same JIT output path as persistent aggregation

### Requirement: Dry-run mode streams only StdAccountListOutput objects via res.send

In dry-run mode, `res.send` SHALL emit only `StdAccountListOutput` objects, matching persistent aggregation for the same ISC input state. The operation SHALL NOT send a summary or other non-account payload via `res.send`.

#### Scenario: Dry-run res.send matches persistent aggregation

- **WHEN** the account-list operation completes Fusion account streaming in dry-run mode
- **THEN** every `res.send` call SHALL be a standard `StdAccountListOutput` object
- **AND** no summary or metadata object SHALL be sent via `res.send`

### Requirement: Dry-run mode logs a run summary to console

After the pipeline completes (and after any dry-run report artifacts are written when requested), the account-list operation in dry-run mode SHALL log a run summary object to `console.log` containing: `rowsSent` (count of streamed Fusion accounts), identity/managed-account/fusion-account totals, issue summary (warnings/errors), total processing time, and report output paths (if applicable).

#### Scenario: Run summary logged after streaming

- **WHEN** the account-list operation completes in dry-run mode
- **THEN** the system SHALL log a summary object to `console.log`
- **AND** `rowsSent` in the summary SHALL equal the number of Fusion accounts sent via `res.send`

### Requirement: Dry-run report captures Match slices without aggregation-on-owner
When account-list runs in dry-run mode, the connector SHALL populate Match report tracker slices (identity matches, deferred matches, analyzed non-matches, failed matching) even when **Send report to owner on aggregation?** is disabled. Capture SHALL NOT require the retired `custom:dryrun` operation context.

#### Scenario: Dry-run Match cards without aggregation report setting
- **GIVEN** dry-run mode with `saveFile` or `sendEmail` enabled
- **AND** `fusionReportOnAggregation` is false
- **WHEN** Process completes
- **THEN** the dry-run report SHALL include potential-match account cards from the tracker
- **AND** SHALL NOT persist Fusion review forms or correlation writes

### Requirement: Dry-run report aligns with aggregation report
The dry-run report SHALL use `includeNonMatches: false` (consolidated counters only, no per-account non-matched rows) and SHALL render through the same Handlebars template and email delivery path as the aggregation report. The report title SHALL use the `'Identity Fusion Dry Run Report'` constant to distinguish analysis from the aggregation report and from the Fusion report.

#### Scenario: Dry-run report email matches aggregation report structure
- **WHEN** a dry-run report email is delivered
- **THEN** the email SHALL use the same subject format, Handlebars template, and section layout as the aggregation report
- **AND** the title SHALL be `'Identity Fusion Dry Run Report'`

### Requirement: Report epilogue emits reports regardless of pipeline outcome
The account-list operation SHALL execute a report epilogue after the processing pipeline completes, whether the pipeline succeeded or failed. The epilogue SHALL emit the configured reports (the aggregation report for persistent runs; the HTML file and/or email report for dry-run) even when the pipeline failed partway, including when `res.send` throws mid-stream. Each epilogue step SHALL be isolated so that one failing step does not prevent the remaining steps from running. After the epilogue completes, the operation SHALL rethrow any captured pipeline error so that failed runs are still marked failed.

#### Scenario: Aggregation report emitted despite stream failure
- **GIVEN** a persistent aggregation with the fusion report enabled
- **WHEN** `res.send` throws while accounts are being streamed to the platform
- **THEN** the aggregation report SHALL still be generated and delivered
- **AND** the operation SHALL rethrow the original error after the epilogue completes

#### Scenario: Epilogue step failure does not mask pipeline error
- **GIVEN** a pipeline that failed with an original error
- **WHEN** an epilogue report step also fails
- **THEN** the epilogue failure SHALL be logged as a warning
- **AND** the original pipeline error SHALL be the error propagated to the platform

#### Scenario: Successful run emits reports without error
- **WHEN** the pipeline completes successfully
- **THEN** the epilogue SHALL emit the configured reports
- **AND** the operation SHALL complete normally

### Requirement: Dry-run mode performs no write side effects

In dry-run mode, the account-list operation SHALL NOT mutate the ISC tenant. All ISC API write calls (PATCH, POST, DELETE, create/update/delete method names) SHALL be inhibited at the `DryRunApiAdapter` without delegating to the live SDK. Read API calls SHALL pass through to the tenant. Business logic that depends on write responses SHALL receive synthetic responses from the adapter shadow store so the pipeline can complete.

#### Scenario: Write API calls inhibited in dry-run

- **GIVEN** a dry-run invocation where the pipeline would create forms, correlate accounts, or patch source configuration
- **WHEN** the corresponding write API methods are invoked through `ClientService`
- **THEN** the live SDK SHALL NOT receive the write call
- **AND** the adapter SHALL return a synthetic response sufficient for downstream code to continue

#### Scenario: Read API calls pass through in dry-run

- **GIVEN** a dry-run invocation
- **WHEN** the pipeline fetches identities, accounts, forms, or source configuration
- **THEN** read API calls SHALL delegate to the live SDK unchanged

#### Scenario: Correlation-on-aggregation suppressed in dry-run

- **GIVEN** a managed source configured with `correlationMode: 'correlate'`
- **WHEN** the account-list operation runs in dry-run mode and missing accounts are detected
- **THEN** correlation logic SHALL execute in-process
- **AND** no correlation PATCH SHALL reach the ISC tenant

#### Scenario: Correlation-on-aggregation still runs in persistent mode

- **GIVEN** a managed source configured with `correlationMode: 'correlate'`
- **WHEN** the account-list operation runs a persistent aggregation and missing accounts are detected
- **THEN** correlation-on-aggregation SHALL execute and PATCH the ISC tenant as before

#### Scenario: Delayed-aggregation sender not fetched in dry-run

- **GIVEN** one or more sources configured for delayed aggregation
- **WHEN** the account-list operation runs in dry-run mode
- **THEN** the delayed-aggregation sender workflow SHALL NOT be fetched

### Requirement: Dry-run emits report artifacts before the console run summary
In dry-run mode with `saveFile` and/or `sendEmail` requested, the operation SHALL write the HTML report file and/or deliver the report email BEFORE logging the run summary to `console.log` (most-durable-first ordering).

#### Scenario: Report file written before console summary
- **GIVEN** a dry-run invocation with `{ dryRun: { enabled: true, saveFile: true } }`
- **WHEN** the pipeline completes
- **THEN** the HTML report file SHALL be written before the run summary is logged to `console.log`

#### Scenario: Report email delivered before console summary
- **GIVEN** a dry-run invocation with `{ dryRun: { enabled: true, sendEmail: "reviewer@example.com" } }`
- **WHEN** the pipeline completes
- **THEN** the report email SHALL be delivered before the run summary is logged to `console.log`

#### Scenario: Report artifacts preserved when account streaming fails
- **GIVEN** a dry-run invocation with `saveFile` requested
- **WHEN** the pipeline fails during account streaming but the epilogue runs
- **THEN** the HTML report file SHALL still be attempted on disk

### Requirement: Failed aggregations persist no state
State persistence is all-or-nothing: when the account-list pipeline fails for any reason, including a mid-stream `res.send` failure, the operation SHALL NOT persist attribute state or batch cumulative counts.

#### Scenario: Stream failure skips state persistence
- **WHEN** `res.send` throws while accounts are being streamed during a persistent aggregation
- **THEN** attribute state SHALL NOT be saved
- **AND** batch cumulative counts SHALL NOT be saved
- **AND** form cleanup and other Output sub-steps after `send-accounts` SHALL NOT run

#### Scenario: Successful run persists state
- **WHEN** a persistent aggregation completes successfully
- **THEN** attribute state and batch cumulative counts SHALL be saved as before

### Requirement: Account-list operation runs an operation heartbeat

The account-list operation SHALL start an operation heartbeat at the beginning of the run and stop it in a `finally` block so the heartbeat is active for the full pipeline and epilogue. The heartbeat SHALL use the configured `statsLoggingIntervalMs` interval from Advanced Connection Settings (default 10 seconds).

#### Scenario: Heartbeat active for entire account-list run

- **GIVEN** a persistent account-list aggregation begins
- **WHEN** the pipeline executes through Output and the report epilogue
- **THEN** STATUS heartbeat lines SHALL be emitted at the configured interval throughout the run
- **AND** the heartbeat SHALL stop when the operation handler completes

#### Scenario: Heartbeat stopped on pipeline failure

- **GIVEN** the account-list pipeline fails during Process phase
- **WHEN** the report epilogue runs and the operation rethrows the error
- **THEN** the heartbeat SHALL still have emitted STATUS lines up to the failure window
- **AND** the heartbeat SHALL stop in `finally` without leaking the interval

#### Scenario: Default 10 second interval for account-list heartbeat

- **GIVEN** a source configuration with default Advanced Connection Settings
- **WHEN** a persistent account-list aggregation runs for more than 10 seconds
- **THEN** at least one STATUS heartbeat line SHALL appear within the first 10 seconds

### Requirement: Account-list pipeline logs phase and step boundaries

The account-list operation SHALL emit PHASE START and PHASE END lines at each major phase boundary (Setup, Fetch, Refresh, Process, Output) and STEP START/END lines at named sub-steps within Process and Output (including identity processing, **managed account initialization**, **orphan identity hydration**, correlated sweep, **record unique registration**, uncorrelated sweep, await-disable-ops, form reconciliation, **clear managed accounts** (Output, non-record mode only), send-accounts, form cleanup, save-state, schedule-aggregations, await-form-deletes). On persistent runs, Output sub-steps after `send-accounts` (`form-cleanup`, `save-state`, `schedule-aggregations`, `await-form-deletes`) SHALL run only after account streaming completes successfully. PHASE END lines SHALL include `elapsed=` duration and SHALL include correlation activity detail suffix when link, merge, completed, or skip counters are non-zero for that phase. Correlation detail on account-list PHASE END lines SHALL NOT include `correlated-action=`. Phase timing data for HTML report breakdowns SHALL be captured internally without emitting colon-style `PHASE N: Description (elapsed)` host lines.

#### Scenario: Process phase visible during long matching run

- **GIVEN** Process phase takes more than one heartbeat interval
- **WHEN** an operator reads logs mid-run
- **THEN** a `PHASE 4 Process START` line SHALL appear before matching work
- **AND** subsequent STATUS lines SHALL show `phase=Process` with the active step name

#### Scenario: Phase end logged after setup

- **GIVEN** Setup phase completes
- **WHEN** Fetch phase is about to begin
- **THEN** a `PHASE 1 Setup END elapsed=` line SHALL appear
- **AND** no colon-style `PHASE 1:` timing line SHALL appear

#### Scenario: Refresh phase end reports link correlation activity

- **GIVEN** correlation-on-aggregation PATCH ran during Refresh for multiple fusion accounts
- **WHEN** Refresh phase completes
- **THEN** a `PHASE 3 Refresh END` line SHALL include cumulative link correlation totals in its detail suffix

#### Scenario: Process phase end reports bulk link enqueue on first run

- **GIVEN** a first account-list run after reset with no existing Fusion accounts
- **WHEN** Process phase completes after enqueuing link PATCHes for managed accounts
- **THEN** a `PHASE 4 Process END` line SHALL include cumulative `link=` enqueue totals
- **AND** the detail SHALL NOT include `correlated-action=`

#### Scenario: Record unique registration step visible during bulk registration

- **GIVEN** thousands of record-only managed accounts with match disabled
- **WHEN** the record unique registration step runs
- **THEN** a STEP START line for `record-unique-registration` SHALL appear before uncorrelated sweep
- **AND** STATUS progress during that step SHALL use unit `registered` rather than `analyzed`

#### Scenario: Managed account initialization step visible before correlated sweep

- **GIVEN** a persistent account-list operation with fusion identities loaded
- **WHEN** the Process phase runs managed-account processing initialization (trigram index and linked-account key index build)
- **THEN** a STEP START line for `managed-account-init` SHALL appear after process-decisions (or identity cache handling) and before `orphan-identity-hydration`
- **AND** a matching STEP END line for `managed-account-init` SHALL appear before the correlated sweep STEP START line

#### Scenario: Clear managed accounts step visible at Output phase start

- **GIVEN** a persistent account-list operation not in record mode
- **WHEN** the Output phase begins
- **THEN** a STEP START line for `clear-managed-accounts` SHALL appear before `send-accounts`
- **AND** a matching STEP END line for `clear-managed-accounts` SHALL appear before subsequent Output sub-steps

#### Scenario: Send accounts step runs before persistent-only output side effects

- **GIVEN** a persistent account-list operation not in dry-run mode
- **WHEN** the Output phase runs through form cleanup and state persistence
- **THEN** a STEP START line for `send-accounts` SHALL appear before `form-cleanup`
- **AND** STEP lines for `save-state`, `schedule-aggregations`, and `await-form-deletes` SHALL appear after `send-accounts`

#### Scenario: Clear managed accounts step omitted in record mode

- **GIVEN** a persistent account-list operation in record mode
- **WHEN** the Output phase begins and managed accounts cache is retained
- **THEN** no STEP line for `clear-managed-accounts` SHALL be emitted

---

### Requirement: Account-list process phase runs record unique registration before uncorrelated sweep

The account-list Process phase SHALL run record unique registration after the correlated managed-account sweep and before the uncorrelated match sweep. Accounts handled in this step SHALL be removed from the managed-account work queue.

#### Scenario: Uncorrelated sweep queue excludes pre-registered record accounts

- **GIVEN** 5000 record-only accounts with match disabled and 200 authoritative uncorrelated accounts
- **WHEN** record unique registration completes
- **THEN** the uncorrelated sweep SHALL process approximately 200 accounts
- **AND** STATUS for uncorrelated sweep SHALL NOT count the 5000 record-only accounts

### Requirement: Account-list aggregates match and correlation logs at INFO

During account-list execution, per-account match discovery (`MATCH FOUND`, `EXACT MATCH FOUND`, deferred variants) and correlation trigger messages SHALL NOT be emitted at INFO level. Instead, callers SHALL record events into `OperationRunContext` via `recordEvent` and correlation activity helpers, and the heartbeat SHALL summarize them in `EVENT_SUMMARY` lines. Correlation PATCH activity SHALL be classified as **link** (correlation-on-aggregation) or **merge** (merge-decision-driven). Correlation PATCH completion SHALL be recorded via `recordCorrelationCompleted`. Correlated-action entitlement grants SHALL NOT be recorded or reported during account-list aggregation. Immediate `warn` and `error` lines for matching and correlation failures SHALL remain unchanged.

#### Scenario: Match discovery summarized not streamed

- **GIVEN** 50 managed accounts receive partial matches during uncorrelated sweep
- **WHEN** the operation runs with default INFO log level
- **THEN** individual `MATCH FOUND:` INFO lines SHALL NOT appear for each account
- **AND** EVENT_SUMMARY lines SHALL report aggregate match counts per heartbeat tick

#### Scenario: Correlation triggers summarized

- **GIVEN** correlation is triggered for multiple fusion accounts during Process phase
- **WHEN** the operation runs with default INFO log level
- **THEN** individual `Triggering correlation for` INFO lines SHALL NOT appear
- **AND** EVENT_SUMMARY lines SHALL report aggregate correlation link counts

#### Scenario: Link correlation summarized during Refresh

- **GIVEN** correlation-on-aggregation PATCH is triggered for multiple fusion accounts during Refresh phase
- **WHEN** the operation runs with default INFO log level
- **THEN** individual `Triggering correlation for` INFO lines SHALL NOT appear
- **AND** EVENT_SUMMARY lines SHALL report link correlation counts per heartbeat tick
- **AND** `PHASE 3 Refresh END` SHALL include cumulative link correlation totals

#### Scenario: Merge correlation summarized during Process

- **GIVEN** authorized merge decisions trigger correlation PATCH during Process phase
- **WHEN** the operation runs with default INFO log level
- **THEN** EVENT_SUMMARY lines SHALL report merge correlation counts separately from link counts

#### Scenario: Correlated-action grants visible at INFO

- **GIVEN** multiple fusion accounts become fully correlated during an account-list aggregation
- **WHEN** the operation runs with default INFO log level
- **THEN** EVENT_SUMMARY and phase END lines SHALL NOT report correlated-action grant totals

#### Scenario: Correlation drain visible during Output and Epilogue

- **GIVEN** Process phase enqueued 2000 link PATCHes and Output phase begins while PATCHes remain pending
- **WHEN** the operation runs with default INFO log level
- **THEN** STATUS lines during Output or Epilogue SHALL report `completed=` and `pending=` correlation drain segments
- **AND** EVENT_SUMMARY and phase END lines SHALL NOT report `correlated-action=`

---

### Requirement: Account-list process phase hydrates orphan correlated identities before correlated sweep

The account-list Process phase SHALL hydrate out-of-scope identities for orphan correlated managed accounts (correlated on the source, unlinked from loaded Fusion accounts, still on the work queue after refresh) after managed-account processing is initialized and immediately before the correlated managed-account sweep. The Fetch phase SHALL NOT perform this hydration pass.

#### Scenario: Hydration runs in process phase not fetch phase

- **WHEN** the account-list operation completes the Fetch phase
- **THEN** the connector SHALL NOT have invoked orphan correlated identity hydration
- **WHEN** the Process phase reaches the correlated managed-account sweep
- **THEN** orphan correlated identity hydration SHALL have completed immediately beforehand

#### Scenario: Orphan hydration step is logged

- **GIVEN** at least one orphan correlated managed account on the work queue with an out-of-scope `identityId`
- **WHEN** the Process phase runs
- **THEN** a STEP START line for `orphan-identity-hydration` (or equivalent canonical step name) SHALL appear before the correlated sweep STEP START line

### Requirement: Fetch phase drives pipeline progress for heartbeat STATUS

During the account-list Fetch phase, long-running loads SHALL update Fetch population counters on `OperationRunContext` after each registration batch (managed-account page registration, fusion-account ingest chunk, identity ingest chunk) so STATUS lines show each inventory advancing between heartbeat ticks. Managed-account Fetch SHALL update `managed-accounts` using the aggregate registered count across in-flight managed sources. Fusion-account Fetch SHALL update `fusion-accounts`. Identity Fetch SHALL update `identities` when identity Fetch runs. When a census is known (for example from `X-Total-Count`), that counter's total SHALL reflect it; otherwise total MAY equal the running registered count. Fetch STATUS SHALL NOT use a single `progress=` unit of `fetched` or `ingested`. Pipeline progress deltas on STATUS SHALL be per population and SHALL remain independent of the api-queue completed delta.

#### Scenario: STATUS shows fetch progress during managed-account pagination

- **GIVEN** a persistent account-list operation in Fetch phase loading managed accounts across multiple pages
- **AND** at least one heartbeat interval elapses during fetch
- **WHEN** an operator reads STATUS lines
- **THEN** at least one STATUS line SHALL include `phase=Fetch` and `managed-accounts=`
- **AND** the managed-accounts `done` SHALL increase while pages are registered

#### Scenario: Fetch progress delta updates between batch-sized page groups

- **GIVEN** parallel managed-account pagination with page size 250 and heartbeat interval 10 seconds
- **AND** pages complete steadily through a sliding window
- **WHEN** multiple STATUS ticks occur during Fetch
- **THEN** managed-accounts `done` SHALL increase by less than a full window of pages between ticks when fewer than a full window of pages complete in the interval
- **AND** population counter deltas SHALL remain independent of the api-queue completed delta

#### Scenario: Fetch progress delta independent of api-queue delta

- **GIVEN** Fetch phase loads pages through the API queue
- **WHEN** a STATUS tick occurs mid-fetch
- **THEN** the line MAY show both a non-zero population-counter delta and a non-zero api-queue completed delta
- **AND** the two deltas SHALL remain separate fields on the STATUS line

#### Scenario: Fusion and managed counters do not overwrite each other

- **GIVEN** Fetch is loading Fusion accounts and managed accounts concurrently
- **AND** at least one heartbeat interval elapses
- **WHEN** an operator reads STATUS lines
- **THEN** a STATUS line MAY include both `fusion-accounts=` and `managed-accounts=`
- **AND** neither total SHALL replace the other

### Requirement: Refresh phase drives pipeline progress for heartbeat STATUS

During the account-list Refresh phase, `processFusionAccounts` SHALL update `OperationRunContext` progress via `setProgress` at Fusion-account batch boundaries so STATUS lines show Refresh advancement between heartbeat ticks. Progress unit SHALL be `refreshed`. Progress `done`/`total` SHALL count Fusion accounts visited in that walk, not a `needsRefresh` subset. Process-phase `batchProcess` callers (identities, fusion identity decisions, correlated sweep) SHALL continue to use unit `processed` unless they pass a different unit.

#### Scenario: STATUS shows refreshed progress during Fusion-account Refresh

- **GIVEN** a persistent account-list operation in Refresh phase walking Fusion accounts
- **AND** at least one heartbeat interval elapses during that walk
- **WHEN** an operator reads STATUS lines
- **THEN** at least one STATUS line SHALL include `phase=Refresh` and `progress=` with unit `refreshed`
- **AND** pipeline progress delta SHALL increase while Fusion accounts complete batches

#### Scenario: Process batch progress unit stays processed

- **GIVEN** Process phase is walking identities or correlated managed accounts via `batchProcess` without an explicit progress unit
- **WHEN** `setProgress` is invoked from that helper
- **THEN** the progress unit SHALL be `processed`
- **AND** the helper SHALL NOT report those accounts as unit `refreshed`

### Requirement: Setup phase SHALL handle independent resetAccounts and resetForms flags

During Phase 1 Setup of a persistent account-list aggregation, the connector SHALL evaluate `resetForms` and `resetAccounts` independently. When `resetForms` is enabled, the connector SHALL close in-flight Fusion reviews: it SHALL delete all Fusion review form definitions matching the Fusion form name pattern via `FormService.deleteExistingForms()`, and if ISC leaves form instances for those definitions, it SHALL cancel or delete those instances in the same Setup pass so no open Fusion review instances remain for the deleted definitions. The connector SHALL then patch `resetForms` back to `false`, and continue Setup unless `resetAccounts` is also enabled. When `resetAccounts` is enabled, the connector SHALL remove the `processing` connector attribute when present, patch `resetAccounts` back to `false` (and legacy `reset` to `false` if present), clear persisted fusion state, reset batch cumulative counters, and return from Setup without proceeding to later phases (zero accounts emitted). A persistent reset SHALL NOT acquire the processing lock, so an existing `processing` value cannot block the reset. Setup MUST NOT patch or replace still-pending Fusion review form definitions on a normal aggregation solely to apply a newer form layout.

#### Scenario: resetAccounts only clears accounts and exits

- **GIVEN** a persistent aggregation with `resetAccounts` enabled and `resetForms` disabled
- **WHEN** Setup runs
- **THEN** the connector SHALL NOT call `FormService.deleteExistingForms()`
- **AND** the connector SHALL remove the `processing` connector attribute when present
- **AND** the connector SHALL clear fusion state and exit Setup early with zero accounts
- **AND** the connector SHALL patch `resetAccounts` to `false`

#### Scenario: resetForms only deletes forms and continues

- **GIVEN** a persistent aggregation with `resetForms` enabled and `resetAccounts` disabled
- **AND** Fusion review form definitions exist with open instances
- **WHEN** Setup runs
- **THEN** the connector SHALL call `FormService.deleteExistingForms()`
- **AND** those in-flight reviews SHALL be closed (no remaining open instances for the deleted definitions)
- **AND** the connector SHALL patch `resetForms` to `false`
- **AND** Setup SHALL continue through the normal aggregation pipeline
- **AND** managed accounts previously held by those reviews SHALL be eligible to rematch on the same run

#### Scenario: Both flags enabled deletes forms then resets accounts

- **GIVEN** a persistent aggregation with both `resetAccounts` and `resetForms` enabled
- **WHEN** Setup runs
- **THEN** the connector SHALL close Fusion reviews before clearing fusion state
- **AND** the connector SHALL remove the `processing` connector attribute when present
- **AND** the connector SHALL patch both flags to `false`
- **AND** Setup SHALL exit early with zero accounts

#### Scenario: Dry-run skips reset side effects

- **GIVEN** a dry-run aggregation with `resetAccounts` or `resetForms` enabled
- **WHEN** Setup runs
- **THEN** the connector SHALL NOT delete forms, cancel instances, patch config, or clear fusion state
- **AND** when `resetAccounts` is enabled, Setup SHALL still exit early without emitting accounts

#### Scenario: Restyle does not migrate pending instances without Reset forms

- **GIVEN** an in-flight Fusion review whose definition was created before a form layout change
- **AND** `resetForms` is disabled
- **WHEN** a persistent aggregation runs
- **THEN** the connector SHALL NOT replace that pending definition solely to apply the new layout
- **AND** the in-flight review SHALL remain until the reviewer responds, the form expires, or **Reset forms?** runs

### Requirement: Developer settings SHALL expose resetAccounts and resetForms with false defaults

The connector configuration parser SHALL read `resetAccounts` and `resetForms` as boolean Developer Settings. Both SHALL default to `false` when omitted. The parser SHALL treat legacy `reset` as `resetAccounts` when `resetAccounts` is not explicitly set.

#### Scenario: Omitted flags default to false

- **WHEN** developer settings are parsed without `resetAccounts` or `resetForms`
- **THEN** both values SHALL be `false`

#### Scenario: Legacy reset key maps to resetAccounts

- **WHEN** developer settings contain `reset: true` and no `resetAccounts` key
- **THEN** `resetAccounts` SHALL be `true`
- **AND** `resetForms` SHALL remain `false` unless explicitly set

### Requirement: Dry-run mode runs the full accountList pipeline

In dry-run mode, the account-list operation SHALL execute the same Setup, Fetch, Refresh, Process, and Output phases as a persistent aggregation. Dry-run SHALL NOT skip Match outcomes (automatic merge, review forms), correlation logic, orphan disable queuing, or account output streaming. Write side effects to the ISC tenant SHALL be inhibited at the client API adapter boundary rather than by skipping business logic.

#### Scenario: Dry-run executes output streaming

- **GIVEN** a dry-run invocation with `{ dryRun: { enabled: true } }`
- **WHEN** the pipeline reaches Phase 5 Output
- **THEN** the system SHALL invoke `forEachISCAccount` and stream each account via `res.send`
- **AND** `rowsSent` in the console run summary SHALL equal the number of Fusion accounts sent

#### Scenario: Dry-run runs Match and Correlation logic

- **GIVEN** a dry-run invocation with managed accounts that trigger exact match, partial match, or correlation-on-aggregation
- **WHEN** the Process phase executes
- **THEN** the same Match and Correlation code paths SHALL run as in a persistent aggregation
- **AND** ISC write API calls SHALL be inhibited at the adapter without mutating the tenant

### Requirement: Dry-run and record mode are mutually exclusive

The account-list operation SHALL reject invocations where `dryRun.enabled` is true and recording mode is `record` or `replay`. The operation SHALL fail fast with a clear error before any pipeline phase executes.

#### Scenario: Dry-run with record mode rejected

- **GIVEN** connector configuration with `recording.mode: 'record'`
- **WHEN** account-list is invoked with `{ dryRun: { enabled: true } }`
- **THEN** the operation SHALL fail with an error indicating dry-run and record mode cannot be combined

#### Scenario: Dry-run with replay mode rejected

- **GIVEN** connector configuration with `recording.mode: 'replay'`
- **WHEN** account-list is invoked with `{ dryRun: { enabled: true } }`
- **THEN** the operation SHALL fail with an error indicating dry-run and replay mode cannot be combined

### Requirement: Dry-run counter simulation does not persist to tenant

In dry-run mode, incremental unique-attribute counters MAY advance in-memory during processing and output so projected attribute values match a persistent run. The operation SHALL NOT persist counter state or batch cumulative counts to the ISC tenant. Counter reads at setup (`initializeCounters`) SHALL remain real API reads.

#### Scenario: In-memory counters advance during dry-run output

- **GIVEN** a dry-run invocation with counter-based unique attribute definitions
- **WHEN** new Fusion accounts require generated unique values during output
- **THEN** in-memory counter state SHALL advance to produce projected values in streamed accounts

#### Scenario: Tenant counter state unchanged after dry-run

- **GIVEN** a dry-run invocation that advances in-memory counters
- **WHEN** the operation completes successfully
- **THEN** no `updateSource` PATCH for fusion state or batch cumulative counts SHALL reach the ISC tenant

---

### Requirement: Account-list operational milestones use DETAIL lines

During account-list execution, operational milestones (managed sources loaded, accounts collected per source, workflow resolution, mode selection) SHALL be emitted as `DETAIL` lines rather than free-form INFO prose. Email sends SHALL emit a single `DETAIL email sent` line per invocation with `subject`, `recipients`, and optional `formId`. Batch email activity during uncorrelated sweep SHALL additionally be summarized via `EVENT_SUMMARY email=+N/interval`.

#### Scenario: Source collection logged as DETAIL

- **GIVEN** a managed source finishes account collection
- **WHEN** the fetch phase records the result
- **THEN** the connector host SHALL receive a DETAIL line including `source=` and `collected=` keys
- **AND** the line SHALL NOT match free-form prose `Source X: collected N account(s)`

#### Scenario: Single email detail line per send

- **GIVEN** a fusion review email is sent during uncorrelated sweep
- **WHEN** the email workflow completes successfully
- **THEN** exactly one DETAIL line describing the send SHALL appear at INFO level
- **AND** no second INFO line describing the same send SHALL appear

---

### Requirement: Process-phase correlated sweep reports skip-linked volume in aggregate

During the account-list Process-phase correlated sweep, skip-linked drops (correlated managed accounts already linked in Fusion) SHALL NOT produce per-account INFO lines. After the sweep (or on the correlated-sweep STEP END), the connector SHALL emit at most one INFO-level DETAIL (or STEP END detail fields) that includes the skip-linked drop count and remaining work-queue size. Immediate warn and error lines for matching and correlation failures SHALL remain unchanged.

#### Scenario: Skip-linked volume is one DETAIL not N INFO lines

- **GIVEN** 2000 correlated managed accounts already linked in Fusion
- **WHEN** the Process-phase correlated sweep runs at default INFO log level
- **THEN** individual INFO lines that name each dropped managed account SHALL NOT appear
- **AND** one DETAIL or STEP END SHALL report the skip-linked count for that sweep

#### Scenario: Record unique registration remains a Process step before uncorrelated sweep

- **GIVEN** match-disabled Record managed accounts on the work queue
- **WHEN** Process phase runs
- **THEN** record unique registration SHALL still complete after the correlated sweep and before the uncorrelated match sweep
- **AND** those Record accounts SHALL still be removed from the uncorrelated sweep queue

### Requirement: Unique attributes remain JIT on Output while generation may overlap within a batch

The account-list Output phase SHALL still generate Unique attributes Just-In-Time immediately before serializing each Fusion account (`FusionService.forEachISCAccount` / `processOutputBatch`). The operation SHALL NOT generate Unique attributes during Process to bypass Output. Unique generation for accounts in the same fusion-parallel Output batch MAY overlap. Generated values SHALL remain unique per attribute across the run. Per-account skip-linked Process INFO rules in this change do not alter the `StdAccountListOutput` object shape.

#### Scenario: Unique generation stays on the Output send path

- **GIVEN** Fusion accounts that need Unique attribute refresh
- **WHEN** account-list Output streams Fusion accounts
- **THEN** Unique generation SHALL run immediately before each Fusion account is serialized
- **AND** Process phase SHALL NOT have already persisted newly generated Unique values for those accounts solely to speed Output

#### Scenario: Output batch Unique generation may overlap

- **GIVEN** a fusion-parallel Output batch of accounts that all need Unique generation
- **WHEN** `processOutputBatch` runs with unique refresh enabled
- **THEN** Unique generation for those accounts MAY proceed concurrently
- **AND** streamed Fusion accounts SHALL still contain distinct Unique attribute values for each account

### Requirement: Refresh phase records aggregate sub-step workload metrics

During account-list Refresh phase, the connector SHALL accumulate per-sub-step timing and workload counters while processing persisted Fusion accounts via `FusionService.processFusionAccount`. Sub-step buckets SHALL include at minimum: `prelude`, `managedLayer`, `uniqueRegister`, `map`, `normalDefine`, `correlation`, and `finalize`. Metrics SHALL aggregate across all Refresh accounts in the run. The connector SHALL NOT emit per-account METRIC or INFO lines for these sub-steps.

#### Scenario: Refresh emits aggregate workload summary

- **GIVEN** a persistent account-list operation processes at least one Fusion account during Refresh
- **WHEN** Refresh phase completes
- **THEN** the connector host SHALL receive one DETAIL line with action `refresh workload`
- **AND** the line SHALL include total Refresh account count and per-bucket millisecond totals

#### Scenario: Sub-step metrics recorded only during Refresh

- **GIVEN** `processFusionAccount` is invoked during Process phase or account-read rebuild
- **WHEN** sub-step timing hooks execute
- **THEN** Refresh-phase metrics SHALL NOT increment
- **AND** aggregation behavior SHALL remain unchanged

#### Scenario: Empty Refresh skips workload summary

- **GIVEN** Refresh phase completes with zero Fusion accounts processed
- **WHEN** metrics are flushed
- **THEN** no `refresh workload` DETAIL line SHALL be emitted

### Requirement: Map and Normal Define sub-steps are measured separately

When Refresh records attribute-processing time, Map (`MappingService.mapAttributes`) and Normal Define (`DefinitionService.refreshNormalAttributes`) SHALL contribute to distinct sub-step buckets `map` and `normalDefine` rather than a single combined timer.

#### Scenario: Map and Define buckets appear in workload summary

- **GIVEN** at least one Fusion account with `needsRefresh` true during Refresh
- **WHEN** Refresh workload summary is emitted
- **THEN** the summary SHALL include separate `mapMs` and `normalDefineMs` fields (or equivalent keys)
- **AND** both values SHALL be greater than zero when attribute processing ran

### Requirement: Account list process phase reports match observability counters

When managed-account processing completes, the account list process phase SHALL log a summary when identity-phase Match observability counters on FusionRun are non-zero, including `mandatoryMissingBlockCount` when accounts were blocked with zero candidates due to missing indexed mandatory attributes, `fullScanFallbackCount` when getCandidates returned undefined and the full identity baseline was scored, `identityComparisonCount` for identity-phase comparisons, and `identityCandidateSetSizeSum` for the sum of identity pool sizes scored.

#### Scenario: Mandatory missing block summary
- **GIVEN** `run.mandatoryMissingBlockCount` is greater than zero after managed-account matching
- **WHEN** the process phase epilogue runs
- **THEN** a log line SHALL report the mandatory missing block count and explain that those accounts scored zero identity candidates

#### Scenario: Full-scan fallback summary
- **GIVEN** `run.fullScanFallbackCount` is greater than zero after managed-account matching
- **WHEN** the process phase epilogue runs
- **THEN** a log line SHALL report the full-scan fallback count and explain that those accounts scored the Fusion identity baseline

#### Scenario: Identity comparison summary
- **GIVEN** `run.identityComparisonCount` is greater than zero after managed-account matching
- **WHEN** the process phase epilogue runs
- **THEN** a log line SHALL report `identityComparisonCount` and `identityCandidateSetSizeSum`




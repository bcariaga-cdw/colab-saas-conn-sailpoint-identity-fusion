# fusion-service Spec

## Purpose

The fusion service (`src/services/fusionService/`) is the orchestrator for the Fusion account model: it builds `FusionAccount` instances from managed sources and identity data, blends new managed accounts into existing Fusion accounts, and produces the `FusionReportAccount` / `FusionReportBlend` report records used by the connector's account and report operations. This spec defines the contract for how a managed account becomes a Fusion account, the blending semantics, and the report-side vocabulary that downstream operations consume.
## Requirements
### Requirement: Account Blending Terminology
The system SHALL use the term "blending" to refer to the process of merging a managed account into a Fusion account.

#### Scenario: Blended managed account history log
- **WHEN** a managed account is absorbed into a Fusion account
- **THEN** the Fusion account history SHALL log "Blended managed account [Account Name] ([Source Name])"

### Requirement: Report Tracking of Account Blends
The system SHALL track blending events during processing to populate the aggregation report payload.

#### Scenario: Recording a blending event
- **WHEN** a managed account is successfully set/absorbed into a Fusion account
- **AND** history recording is not skipped for that account key
- **THEN** the system SHALL record a blending event containing the target Fusion identity name, identity link, and the blended account's name, source, and account link

### Requirement: missing-accounts attribute MUST restore uncorrelated account references

When a Fusion account is reconstructed from persisted platform attributes, the `missing-accounts` collection MUST be restored into the internal missing-account reference set. It MUST NOT be loaded from the correlated `accounts` collection.

#### Scenario: persisted missing-accounts are restored as missing references
- **GIVEN** a persisted Fusion account with `missing-accounts: ["src-a::user-1"]` and `accounts: ["src-a::user-2"]`
- **WHEN** the account is initialized via `FusionAccount.fromFusionAccount`
- **THEN** the missing-account reference set contains `"src-a::user-1"`
- **AND** the missing-account reference set does not contain `"src-a::user-2"`

#### Scenario: correlated accounts are not restored as missing references
- **GIVEN** a persisted Fusion account with `accounts: ["src-a::user-2"]` and no `missing-accounts` attribute
- **WHEN** the account is initialized via `FusionAccount.fromFusionAccount`
- **THEN** the missing-account reference set is empty
- **AND** the previous correlated account reference set contains `"src-a::user-2"`

### Requirement: Factory methods initialize core state consistently

Each static factory method MUST produce a `FusionAccount` whose core scalar fields (`type`, `managedKey`, `name`, `sourceName`, `disabled`, `needsRefresh`, `identityInfo`, `iscAccountId`, `modified`) are set from the provided input.

Feature: Fusion account construction
Rule: `FusionAccount` factory methods initialize core scalar state from their inputs.

#### Scenario: fromIdentity initializes identity-origin core state
- **GIVEN** an `IdentityDocument` with `id: 'id-1'`, `name: 'Jane Doe'`, `disabled: false`
- **WHEN** `FusionAccount.fromIdentity(identity)` is called
- **THEN** the resulting account has `type` of `'identity'`
- **AND** `managedKey` is `'Identities::id-1'`
- **AND** `name` is `'Jane Doe'`
- **AND** `sourceName` is `'Identities'`
- **AND** `disabled` is `false`

#### Scenario: fromManagedAccount initializes managed-origin core state
- **GIVEN** an SDK `Account` with `sourceId: 'src-a'`, `nativeIdentity: 'nat-1'`, `sourceName: 'Source A'`, `id: 'isc-1'`
- **WHEN** `FusionAccount.fromManagedAccount(account)` is called
- **THEN** the resulting account has `type` of `'managed'`
- **AND** `managedKey` is `'src-a::nat-1'`
- **AND** `sourceName` is `'Source A'`
- **AND** `iscAccountId` is `'isc-1'`

### Requirement: fromFusionAccount restores persisted collection state

`FusionAccount.fromFusionAccount` MUST restore the internal collection sets (`_missingAccountIds`, `_reviews`, `_statuses`, `_actions`, `previousAccountIds`) and history from the persisted account attributes.

Feature: Fusion account construction
Rule: `fromFusionAccount` reconstructs internal collection and history state from persisted attributes.

#### Scenario: persisted accounts restore the previous account reference set
- **GIVEN** a persisted fusion account whose `attributes.accounts` contains `'src-a::correlated-1'`
- **WHEN** `FusionAccount.fromFusionAccount(account)` is called
- **THEN** `previousAccountIds` contains `'src-a::correlated-1'`

#### Scenario: persisted history restores the internal history trail
- **GIVEN** a persisted fusion account whose `attributes.history` contains `['[2026-01-01] event']`
- **WHEN** `FusionAccount.fromFusionAccount(account)` is called
- **THEN** `history` contains `'[2026-01-01] event'`

### Requirement: Identity-origin accounts carry baseline status

Accounts created from an identity OR reconstructed from a persisted identity-origin record MUST have the `baseline` status and the `Identities` source.

Feature: Fusion account construction
Rule: Identity-origin fusion accounts always carry the `baseline` status marker and `Identities` source.

#### Scenario: fromIdentity sets baseline status
- **GIVEN** an `IdentityDocument` with `id: 'id-1'`
- **WHEN** `FusionAccount.fromIdentity(identity)` is called
- **THEN** `statuses` contains `'baseline'`
- **AND** `sources` contains `'Identities'`

#### Scenario: fromFusionAccount re-asserts missing baseline for identity-origin records
- **GIVEN** a persisted identity-origin fusion account with `attributes.originSource: 'Identities'` and empty `attributes.statuses`
- **WHEN** `FusionAccount.fromFusionAccount(account)` is called
- **THEN** `statuses` contains `'baseline'`
- **AND** `sources` contains `'Identities'`

### Requirement: Managed-origin creation paths set uncorrelated state

Accounts created from an uncorrelated managed account or a fusion decision MUST be marked as uncorrelated and track the managed account key as missing.

Feature: Fusion account construction
Rule: Managed-origin creation paths initialize uncorrelated state.

#### Scenario: fromManagedAccount marks the account uncorrelated
- **GIVEN** an SDK `Account` with `sourceId: 'src-a'`, `nativeIdentity: 'nat-1'`
- **WHEN** `FusionAccount.fromManagedAccount(account)` is called
- **THEN** `statuses` contains `'uncorrelated'`
- **AND** `missingAccountIds` contains `'src-a::nat-1'`
- **AND** `needsReset` is `true`

#### Scenario: fromFusionDecision marks the account uncorrelated
- **GIVEN** a `FusionDecision` whose account has `sourceId: 'src-b'`, `nativeIdentity: 'nat-2'`
- **WHEN** `FusionAccount.fromFusionDecision(decision)` is called
- **THEN** `statuses` contains `'uncorrelated'`
- **AND** `missingAccountIds` contains `'src-b::nat-2'`

### Requirement: First-time Fusion account factories add new status

`FusionAccount.fromIdentity`, `FusionAccount.fromManagedAccount`, and `FusionAccount.fromFusionDecision` SHALL add the `new` status entitlement. Those constructors create a Fusion account whose origin is not a previous Fusion account. Call sites MUST use `StatusEntitlement.New`. Identity reuse of an existing Fusion account (`findFusionAccountForIdentity`) SHALL NOT add `new` solely because the identity is being processed.

#### Scenario: fromIdentity adds new
- **GIVEN** an `IdentityDocument` with `id: 'id-1'`
- **WHEN** `FusionAccount.fromIdentity(identity)` is called
- **THEN** `statuses` SHALL contain `'new'`
- **AND** `statuses` SHALL contain `'baseline'`

#### Scenario: fromManagedAccount adds new
- **GIVEN** an SDK `Account` with `sourceId: 'src-a'`, `nativeIdentity: 'nat-1'`
- **WHEN** `FusionAccount.fromManagedAccount(account)` is called
- **THEN** `statuses` SHALL contain `'new'`
- **AND** `statuses` SHALL contain `'uncorrelated'`

#### Scenario: fromFusionDecision adds new
- **GIVEN** a `FusionDecision` whose account has `sourceId: 'src-b'`, `nativeIdentity: 'nat-2'`
- **WHEN** `FusionAccount.fromFusionDecision(decision)` is called
- **THEN** `statuses` SHALL contain `'new'`
- **AND** `statuses` SHALL contain `'uncorrelated'`

#### Scenario: Identity reuse does not add new
- **GIVEN** an existing Fusion account already registered for the identity's managed accounts
- **WHEN** `IdentityProcessor` reuses that account for a recreated identity
- **THEN** the processor SHALL NOT add `'new'` solely because of reuse
- **AND** if that account was reconstructed from a previous Fusion account, `'new'` SHALL remain absent

### Requirement: fromFusionAccount removes new status

When a Fusion account is reconstructed from a previous Fusion account via `FusionAccount.fromFusionAccount`, the connector SHALL remove the `new` status entitlement even if the persisted `statuses` attribute still contains it. Reconstruction SHALL NOT add `new`.

#### Scenario: Persisted new is stripped
- **GIVEN** a persisted Fusion account whose `attributes.statuses` contains `'new'`
- **WHEN** `FusionAccount.fromFusionAccount(account)` is called
- **THEN** `statuses` SHALL NOT contain `'new'`

#### Scenario: Reconstruction without new stays without new
- **GIVEN** a persisted Fusion account whose `attributes.statuses` does not contain `'new'`
- **WHEN** `FusionAccount.fromFusionAccount(account)` is called
- **THEN** `statuses` SHALL NOT contain `'new'`

### Requirement: fromFusionAccount restores identity linkage from persisted attributes

When the SDK `Account` does not expose `identityId` directly, `fromFusionAccount` MUST recover it from `attributes.identityId` and fold it into the account's `IdentityInfo`.

Feature: Fusion account construction
Rule: Persisted `identityId` attribute restores the account's identity linkage.

#### Scenario: identityId attribute restores identity linkage
- **GIVEN** a persisted fusion account with no top-level `identityId` and `attributes.identityId: 'identity-1'`
- **WHEN** `FusionAccount.fromFusionAccount(account)` is called
- **THEN** `identityId` is `'identity-1'`
- **AND** `identityIdAttribute` is `'identity-1'`

#### Scenario: whitespace-only identityId attribute is ignored
- **GIVEN** a persisted fusion account with `attributes.identityId: '   '`
- **WHEN** `FusionAccount.fromFusionAccount(account)` is called
- **THEN** `identityId` is undefined

### Requirement: FusionAccount SHALL expose collaborator sub-objects

`FusionAccount` MUST expose three readonly collaborator instances: `collections` (`FusionCollections`), `correlation` (`FusionCorrelation`), and `layers` (`FusionLayers`). `FusionAccount` MUST own core identity fields and the attribute bag. Collaborators MUST own the mutable slices described in ubiquitous language for each collaborator. `FusionAccountState` and `fusionAccountRules/*` MUST NOT exist.

#### Scenario: Collaborators are present on a new FusionAccount

- **GIVEN** a configured `FusionAccount`
- **WHEN** an account is constructed via a factory method
- **THEN** `account.collections`, `account.correlation`, and `account.layers` are defined
- **AND** each is an instance of the corresponding collaborator type

### Requirement: Callers SHALL use the collaborator API for account mutations

Production and test callers outside `FusionAccount` itself MUST mutate statuses, actions, reviews, account-id sets, history, matches, and correlation promises through `fusionAccount.collections` or `fusionAccount.correlation`. `FusionAccount` MUST NOT expose flat 1:1 pass-through mutators for those concerns (for example `addStatus` that only forwards to `collections.statuses.add`). Layer enrichment that must bind the attribute bag and identity fields MAY remain as orchestration methods on `FusionAccount` (for example `addIdentityLayer`, `addManagedAccountLayer`) that delegate to `FusionLayers`.

#### Scenario: Status mutation goes through collections

- **GIVEN** a `FusionAccount` instance
- **WHEN** a caller adds a status entitlement
- **THEN** the caller invokes a method on `fusionAccount.collections` (or a nested collection API it exposes)
- **AND** `FusionAccount` does not provide a flat `addStatus` pass-through

#### Scenario: Identity layer enrichment uses FusionAccount orchestration

- **GIVEN** a `FusionAccount` instance and an `IdentityDocument`
- **WHEN** a caller applies the identity layer
- **THEN** the caller invokes `fusionAccount.addIdentityLayer(identity)` (or an equivalent orchestration API on `FusionAccount`)
- **AND** that method delegates to `FusionLayers.addIdentityLayer` with the account's attribute bag and identity bindings

### Requirement: Collaborators SHALL encapsulate their mutable state

`FusionCollections`, `FusionCorrelation`, and `FusionLayers` MUST keep collection and flag state private (or otherwise not publicly mutable sets). Factory and hydrate paths on `FusionAccount` MUST use documented collaborator construction or hydrate methods. Call sites MUST NOT use `_internal_*` accessors to mutate collaborator state from `FusionAccount` factories or from external callers.

#### Scenario: Factory hydration does not use _internal_ mutators

- **GIVEN** a persisted ISC account used with `FusionAccount.fromFusionAccount`
- **WHEN** collection attributes are restored
- **THEN** restoration goes through public or package-documented hydrate APIs on `FusionCollections` / `FusionLayers`
- **AND** the factory path does not call `_internal_*` setters on the collaborator

### Requirement: Previous bag preserves prior-aggregation collection mirrors

When a Fusion account is constructed from persisted ISC account attributes (for example via `FusionAccount.fromFusionAccount` or other factory paths that seed `attributeBagPrevious` from stored attributes), `attributeBag.previous` MUST be populated with the persisted collection mirror attributes (`accounts`, `missing-accounts`, `statuses`, `actions`, `reviews`, `sources`, `history`, and other collection-backed fields present on the stored account). That snapshot MUST remain available for Velocity as `$previous` for the duration of the aggregation run. `syncCollectionAttributesToBag` MUST NOT overwrite `attributeBag.previous`.

#### Scenario: Persisted fusion account exposes collection mirrors in $previous

- **GIVEN** a persisted fusion account whose stored attributes include `statuses`, `actions`, and `accounts`
- **WHEN** the account is loaded via the fusion-account factory
- **THEN** `attributeBag.previous` contains those collection mirror arrays
- **AND** Velocity context `$previous.statuses`, `$previous.actions`, and `$previous.accounts` are available for attribute definitions

#### Scenario: Sync does not clobber the previous snapshot

- **GIVEN** a fusion account whose `attributeBag.previous` was seeded at factory load
- **WHEN** collection sets are mutated during the run and `syncCollectionAttributesToBag()` is called
- **THEN** `attributeBag.previous` retains the factory-seeded collection mirror values
- **AND** only `attributeBag.current` receives the updated collection mirrors from sync

### Requirement: Collection sync writes the current attribute bag

`FusionAccount.syncCollectionAttributesToBag()` MUST copy `accounts`, `missing-accounts`, `statuses`, `actions`, `reviews`, and `sources` (and other collection mirrors owned by `FusionCollections`) into `attributeBag.current` via `FusionCollections.syncToBag`. The method MUST NOT mirror those collection arrays into `attributeBag.previous`; prior-aggregation collection mirrors in `attributeBag.previous` are seeded at factory load (see previous requirement).

#### Scenario: Sync updates current bag

- **GIVEN** a Fusion account with non-empty status and account-id collections
- **WHEN** `syncCollectionAttributesToBag()` is called
- **THEN** `attributeBag.current` contains array representations of those collections
- **AND** the contract does not require those same collection mirrors to be written into `attributeBag.previous`

### Requirement: FusionService owns managed-account pipeline phases

FusionService SHALL orchestrate the managed-account Process-phase pipeline in order: (1) `initializeManagedAccountProcessing`, (2) correlated account sweep, (3) record unique registration, (4) uncorrelated sweep, followed by disable-operation drain and form reconciliation as defined elsewhere. FusionService SHALL NOT duplicate match outcome resolution logic inside private methods — all match dispatch for managed accounts SHALL go through `MatchOutcomeDispatcher.runMatchSweep()`.

#### Scenario: Process phase runs pipeline phases in order

- **WHEN** the account-list process phase executes managed-account processing
- **THEN** FusionService SHALL run managed-account init, correlated sweep, record unique registration, and uncorrelated sweep in that order
- **AND** each phase SHALL use the public methods defined on FusionService for that phase

#### Scenario: Correlated account sweep remains a FusionService pipeline phase

- **WHEN** `processCorrelatedManagedAccounts` runs
- **THEN** FusionService SHALL filter managed accounts with `uncorrelated === false`
- **AND** FusionService SHALL orchestrate per-account processing before the uncorrelated batch sweep
- **AND** the correlated account sweep SHALL NOT be classified as the identity-scoring or deferred-drain sweep owned by MatchOutcomeDispatcher

### Requirement: FusionService delegates match outcome dispatch to MatchOutcomeDispatcher

FusionService SHALL delegate managed-account match outcome dispatch to `MatchOutcomeDispatcher.runMatchSweep()`. FusionService SHALL NOT call MatchOutcomeDispatcher scoring internals (for example `scoreIdentityPhase`, deferred drain helpers) or invoke `MatchingService` comparison methods directly to perform a sweep. FusionService MAY call `MatchingService.buildTrigramIndex` during `initializeManagedAccountProcessing`.

#### Scenario: Uncorrelated sweep delegates to MatchOutcomeDispatcher

- **WHEN** `processUncorrelatedManagedAccounts` drains the remaining work queue
- **THEN** FusionService SHALL call `matchOutcomeDispatcher.runMatchSweep(accounts, batchSize)` once with the full remaining queue
- **AND** FusionService SHALL NOT invoke `MatchingService.processUncorrelatedManagedAccounts`

#### Scenario: Single-account processing delegates to MatchOutcomeDispatcher

- **WHEN** `processManagedAccount` handles one managed account
- **THEN** FusionService SHALL call `matchOutcomeDispatcher.runMatchSweep([account], 1)`
- **AND** FusionService SHALL NOT implement its own outcome resolution switch for that account

#### Scenario: Scoring prep during init is permitted

- **WHEN** `initializeManagedAccountProcessing` completes
- **THEN** FusionService SHALL have called `matchingService.buildTrigramIndex` with the current fusion identity iterable
- **AND** FusionService SHALL NOT call `matchingService.configureScoring`
- **AND** FusionService SHALL have seeded deferred candidates and built the linked-account key index as part of the same init phase

#### Scenario: FusionService does not orchestrate sweep scoring internals

- **WHEN** a managed-account sweep runs
- **THEN** FusionService SHALL NOT call `scoreIdentityPhase` or deferred drain helpers directly
- **AND** those steps SHALL execute only inside `MatchOutcomeDispatcher.runMatchSweep`

### Requirement: FusionService receives state via FusionRun

FusionService SHALL access all shared run state through FusionRun at construction time. Internal state previously held on FusionService (`_tracker`, `_managedAccountProcessingState`, `_managedAccountProcessingStartedAt`, `_managedAccountProcessingBatchSize`) SHALL live on FusionRun. Pass-through getters that expose raw FusionRun maps or sets (`sourcesByName`, `reviewersBySourceId`, `sourcesWithoutReviewers`, `autoMergedIdentityIds`, `fusionAccounts`, `fusionIdentities`, `totalFusionAccountCount`) SHALL NOT exist on FusionService — callers SHALL access FusionRun directly.

FusionService MAY expose a small set of operation-facing methods that delegate to FusionRun without exposing mutable collections:

- `getFusionIdentity(identityId)` — stable lookup API for provisioning operations
- `setTracker(tracker)` — orchestration hook that delegates to `run.setTracker()`
- `fusionIdentitiesExcluding(excludeIds)` — filtered identity iteration for scoring prep

FusionService SHALL NOT expose a public `tracker` getter. Internal code that requires a non-null tracker SHALL use a private `requireTracker()` helper with invariant enforcement.

Services that receive FusionRun (ReportService, FormService, MatchOutcomeDispatcher, processors) SHALL read run state from `run` directly, not through FusionService getters.

#### Scenario: FusionService reads fusion accounts from FusionRun
- **WHEN** FusionService needs to iterate fusion accounts
- **THEN** it SHALL read from run.fusionAccountMap, not this.fusionAccountMap

#### Scenario: FusionService reads sources by name from FusionRun
- **WHEN** FusionService needs to resolve a source by name
- **THEN** it SHALL read from run.sourcesByName
- **AND** there SHALL be no `sourcesByName` getter on FusionService delegating to `run`

#### Scenario: FusionService delegates tracker to FusionRun
- **WHEN** FusionService initializes aggregation tracking
- **THEN** it SHALL call `run.setTracker(tracker)` rather than storing `this._tracker`
- **AND** sub-components SHALL access the tracker via `run.getTracker()`

#### Scenario: ReportService reads tracker from FusionRun
- **WHEN** ReportService builds an aggregation or dry-run report
- **THEN** it SHALL call `run.getTracker()` with local non-null enforcement
- **AND** it SHALL NOT read tracker via a FusionService getter

#### Scenario: Operation-facing identity lookup remains on FusionService
- **WHEN** a provisioning operation needs the fusion identity for a processed identity
- **THEN** it MAY call `fusion.getFusionIdentity(identityId)`
- **AND** FusionService SHALL delegate to `run.getFusionIdentity(identityId)`

#### Scenario: FusionService delegates processing phase state to FusionRun
- **WHEN** FusionService manages the managed account processing lifecycle
- **THEN** it SHALL call `run.startManagedAccountProcessing()` and `run.resetManagedAccountProcessing()`
- **AND** there SHALL be no `_managedAccountProcessingState` field on FusionService

### Requirement: Match report slices are captured for dry-run and Fusion report
`FusionService` SHALL populate managed-account Match report tracker slices when the operation run is in dry-run mode, when aggregation-on-owner reporting is enabled, or when record mode is active. Capture SHALL NOT depend solely on the command not being account-list.

#### Scenario: Dry-run account-list captures slices
- **GIVEN** account-list dry-run mode
- **AND** `fusionReportOnAggregation` is false
- **WHEN** a managed account completes Match analysis
- **THEN** the aggregation tracker SHALL receive the corresponding match, deferred, or non-match report row

#### Scenario: Fusion report nested pipeline captures slices
- **GIVEN** the `report` action nested preview pipeline with dry-run mode active
- **WHEN** a managed account completes Match analysis
- **THEN** the aggregation tracker SHALL receive the corresponding report row
- **AND** ISC write calls for forms, merge, and correlation SHALL remain inhibited

### Requirement: Processors receive explicit state and service dependencies

IdentityProcessor, DecisionProcessor, and CorrelationManager SHALL receive their dependencies explicitly rather than through a single FusionService reference, and SHALL delegate account assembly recipe steps to the `AccountAssembly` service.

#### Scenario: IdentityProcessor reads state from FusionRun
- **WHEN** IdentityProcessor needs to access fusionIdentityMap or fusionAccountMap
- **THEN** it SHALL read from its own `run` parameter, not through fusionService getters
- **AND** it SHALL use `AccountAssembly` for account assembly operations.

#### Scenario: DecisionProcessor reads state from FusionRun
- **WHEN** DecisionProcessor needs to iterate fusionAccountMap or fusionIdentityMap
- **THEN** it SHALL read from its own `run` parameter, not through fusionService getters
- **AND** it SHALL access sourcesByName through run and use `AccountAssembly` for account assembly.

#### Scenario: CorrelationManager receives explicit service dependencies
- **WHEN** CorrelationManager is constructed
- **THEN** it SHALL receive IdentityService, SourceService, and an isAggregationMode callback
- **AND** it SHALL NOT receive a FusionService reference

### Requirement: FusionService retains pipeline orchestration

FusionService SHALL retain responsibility for pipeline phase coordination (setup, fetch, refresh, process, output), reviewer management, identity processing delegation, ISC account output, and report generation.

#### Scenario: Pipeline phases still orchestrated by FusionService
- **WHEN** the aggregation pipeline runs
- **THEN** phase transitions SHALL be coordinated by FusionService
- **AND** MappingService, DefinitionService, and MatchingService SHALL be invoked at the appropriate phase boundaries

### Requirement: FusionService avoids redundant delegation wrappers

FusionService SHALL NOT wrap outcome handler methods with single-line delegation methods. Internal references to outcome handlers SHALL directly access `this.outcomeHandler` to improve readability and maintainability.

#### Scenario: Calling outcome handlers directly
- **WHEN** FusionService evaluates match outcomes
- **THEN** it calls methods directly on `this.outcomeHandler` (e.g. `this.outcomeHandler.handleIdentityMatch`) rather than proxying through `this.handleIdentityMatch`

### Requirement: Unique attributes SHALL be generated Just-In-Time during output streaming

The system SHALL NOT eagerly filter and output Fusion accounts prior to the final output phase to bypass memory constraints. Instead, the system SHALL stream all Fusion accounts uniformly during the final output phase via `FusionService.forEachISCAccount`, evaluating and generating unique attributes Just-In-Time immediately prior to serialization. Bulk listing helpers such as `listISCAccounts` SHALL NOT be used on the account-list output path.

#### Scenario: JIT Unique Attribute Generation prevents memory accumulation

- **WHEN** the aggregation output phase iterates through Fusion accounts
- **AND** a Fusion account requires unique attribute generation
- **THEN** the system SHALL generate the unique attributes exactly before serializing the account
- **AND** the system SHALL immediately remove the serialized account from memory

#### Scenario: Single account reads preserve unique attribute state

- **WHEN** a single Fusion account is processed outside of an aggregation context (e.g. account read)
- **THEN** the JIT output hook SHALL NOT advance unique attribute counters inappropriately

#### Scenario: Dry-run accountList simulates counters in-memory for output

- **WHEN** the account-list operation runs in dry-run mode and output streaming refreshes unique attributes
- **THEN** incremental counters MAY advance in-memory to produce projected unique values in streamed accounts
- **AND** counter persistence to the ISC tenant SHALL NOT occur (persistent output tail skipped in dry-run)

### Requirement: processFusionAccount composes the extended account-assembly recipe

`FusionService.processFusionAccount` SHALL compose the shared `AccountAssembly` steps (`addManagedAccountLayer`, `applyAttributeProcessing`) together with fusion-specific orchestration that callers of the thin `assembleAccount` recipe do not perform: reviewer layers, identity and merge-decision layers, unique-attribute registration, per-source correlation, and run registration. IdentityProcessor and DecisionProcessor SHALL continue to use `AccountAssembly.assembleAccount` for the thin path; Phase-2 refresh and single-account rebuild paths SHALL use `processFusionAccount`.

#### Scenario: Phase-2 refresh uses extended recipe
- **WHEN** `FusionService.processFusionAccounts` refreshes persisted fusion accounts during aggregation
- **THEN** each account SHALL be built via `processFusionAccount`
- **AND** the method SHALL invoke `AccountAssembly.addManagedAccountLayer` and `AccountAssembly.applyAttributeProcessing`
- **AND** the method SHALL apply reviewer, identity, correlation, and registration steps before returning the processed account

### Requirement: FusionService delegates mode-gate logic to AccountAssembly

FusionService SHALL delegate aggregation-mode detection (`isAggregationAccountListMode`) and prune-delete gating (`shouldPruneDeletedManagedAccounts`) to the injected `AccountAssembly` collaborator. FusionService SHALL NOT own its own copies of these methods.

#### Scenario: Aggregation mode checked via AccountAssembly
- **WHEN** FusionService needs to determine if the current operation is an aggregation account-list run
- **THEN** it SHALL call `this.accountAssembly.isAggregationAccountListMode()`
- **AND** the method definition SHALL NOT exist on FusionService

#### Scenario: Prune-delete gating checked via AccountAssembly
- **WHEN** FusionService needs to determine whether to prune deleted managed accounts
- **THEN** it SHALL call `this.accountAssembly.shouldPruneDeletedManagedAccounts()`
- **AND** the method definition SHALL NOT exist on FusionService

### Requirement: DecisionProcessor delegates mode-gate logic to AccountAssembly

DecisionProcessor SHALL delegate aggregation-mode detection to the injected `AccountAssembly` collaborator. DecisionProcessor SHALL NOT own its own copy of `isAggregationAccountListMode` nor store `commandType` and `operationContext` solely to power a local copy.

#### Scenario: Aggregation mode checked via AccountAssembly
- **WHEN** DecisionProcessor needs to determine if the current operation is an aggregation run
- **THEN** it SHALL call `this.deps.accountAssembly.isAggregationAccountListMode()`
- **AND** `commandType` and `operationContext` SHALL NOT be constructor parameters on DecisionProcessor if their sole purpose was powering a local `isAggregationAccountListMode` copy

### Requirement: FusionService SHALL expose independent reset flag accessors

FusionService SHALL expose `isResetAccounts()` and `isResetForms()` methods that reflect the corresponding Developer Settings values loaded at construction time. The legacy `isReset()` method SHALL NOT be used.

#### Scenario: Flag accessors reflect config

- **GIVEN** FusionConfig with `resetAccounts: true` and `resetForms: false`
- **WHEN** FusionService is constructed
- **THEN** `isResetAccounts()` SHALL return `true`
- **AND** `isResetForms()` SHALL return `false`

### Requirement: FusionService SHALL auto-disable reset flags in source configuration

FusionService SHALL provide `disableResetAccounts()` and `disableResetForms()` methods that patch the fusion source connector attributes back to `false` after a reset flag is consumed. `disableResetAccounts()` SHALL patch both `/connectorAttributes/resetAccounts` and the legacy `/connectorAttributes/reset` path. `disableResetForms()` SHALL patch `/connectorAttributes/resetForms`.

#### Scenario: disableResetAccounts clears legacy key

- **WHEN** `disableResetAccounts()` is called on a persistent run
- **THEN** the connector SHALL patch `resetAccounts` to `false`
- **AND** the connector SHALL patch legacy `reset` to `false`

#### Scenario: disableResetForms clears forms flag only

- **WHEN** `disableResetForms()` is called on a persistent run
- **THEN** the connector SHALL patch `resetForms` to `false`
- **AND** the connector SHALL NOT modify `resetAccounts` or legacy `reset`

### Requirement: Correlated entitlement reflects missing-accounts outcome

When a Fusion account is built or rebuilt for output, the connector SHALL evaluate the internal missing-account reference set and SHALL grant the `correlated` action entitlement on the returned Fusion account if and only if no missing managed source accounts remain. When missing accounts remain, the `correlated` action entitlement SHALL NOT appear on the returned account. This is an outcome of the Fusion account build process, not an independently removed entitlement. On provisioning paths (`accountCreate`, `accountUpdate`), a Remove change for `correlate` or `correlated` action tokens SHALL fail the operation with message matching `Correlated entitlement cannot be removed: <value>`; the connector SHALL NOT honor entitlement revocation for derived correlated state.

#### Scenario: Correlated granted when no missing accounts remain

- **GIVEN** a Fusion account whose missing-account reference set is empty after build
- **WHEN** correlation status is updated for output
- **THEN** the returned Fusion account actions SHALL include the `correlated` action entitlement
- **AND** the `Uncorrelated` status entitlement SHALL NOT be present

#### Scenario: Correlated absent when missing accounts remain

- **GIVEN** a Fusion account whose missing-account reference set contains at least one managed account key after build
- **WHEN** correlation status is updated for output
- **THEN** the returned Fusion account actions SHALL NOT include the `correlated` action entitlement
- **AND** the `Uncorrelated` status entitlement SHALL be present

#### Scenario: Correlated Remove rejected on provisioning path

- **GIVEN** a Fusion account whose missing-account reference set is empty
- **WHEN** a Remove change for the `correlated` action entitlement is processed on a provisioning path
- **THEN** the operation SHALL fail with a message matching `Correlated entitlement cannot be removed: correlated`
- **AND** the connector SHALL NOT mutate correlation links or missing-account state

### Requirement: Correlate action assignment triggers direct PATCH for missing accounts on provisioning paths

When the platform assigns the `correlate` or `correlated` action entitlement (Add) on a provisioning path (`accountCreate` or `accountUpdate`), the connector SHALL attempt direct identity correlation (ISC PATCH) for missing managed source accounts on that Fusion account. On this path the connector SHALL NOT apply reverse-correlation attribute writes; reverse correlation remains an aggregation/link flow concern.

#### Scenario: Correlate Add attempts PATCH when missing accounts exist

- **GIVEN** a Fusion account with a non-empty missing-account reference set
- **AND** the Fusion account has a resolvable platform identity id
- **WHEN** the correlate action entitlement is assigned (Add) on a provisioning path
- **THEN** the connector SHALL invoke direct identity correlation for eligible missing managed account keys
- **AND** SHALL update missing-account and correlated action state on the returned Fusion account based on the outcome

#### Scenario: Correlate Add is a no-op when no missing accounts exist

- **GIVEN** a Fusion account whose missing-account reference set is empty
- **WHEN** the correlate action entitlement is assigned (Add) on a provisioning path
- **THEN** the connector SHALL NOT invoke direct identity correlation
- **AND** the returned Fusion account SHALL reflect the correlated entitlement outcome per the missing-accounts evaluation requirement

### Requirement: Reverse-correlation attributes are managed on every Fusion account build

For each configured managed source with `correlationMode: reverse` and a defined `correlationAttribute`, the connector SHALL manage reverse-correlation attribute values on affected Fusion accounts whenever those accounts are built or rebuilt for output (including account-list, account-read, account-update, and other operations returning an ISC Fusion account). Rebuild steps that remap or redefine attributes SHALL NOT permanently clobber reverse-correlation attribute values that were established for the Fusion account; values SHALL be preserved or recomputed according to the active correlation outcome before output.

#### Scenario: Reverse-correlation attribute present on output when correlation applies

- **GIVEN** a managed source configured with `correlationMode: reverse` and `correlationAttribute: revAttr`
- **AND** a Fusion account with a missing managed account from that source eligible for reverse correlation
- **WHEN** the Fusion account is built for output
- **THEN** the returned ISC account attributes SHALL include `revAttr` with the reverse-correlation value for that source when the build path sets it
- **AND** the attribute SHALL remain consistent with the Fusion account correlation outcome

#### Scenario: Account update rebuild preserves reverse-correlation snapshot

- **GIVEN** reverse-correlation sources are configured
- **AND** a Fusion account already has reverse-correlation attribute values
- **WHEN** the account-update operation rebuilds the Fusion account before processing action changes
- **THEN** the connector SHALL capture reverse-correlation attribute values before rebuild
- **AND** SHALL restore those values after action processing and before generating the ISC account output

### Requirement: Persisted account reference collections MUST use composite managed account keys

When reconstructing a Fusion account from persisted platform attributes, values in the `accounts` and `missing-accounts` collections that represent managed source accounts MUST be valid composite managed account keys (`sourceId::nativeIdentity`). Non-composite values SHALL NOT be retained in internal account reference sets and SHALL NOT be used as lookup keys in the work queue or managed account inventory.

#### Scenario: Non-composite account reference is dropped during reconstruction

- **GIVEN** a persisted Fusion account with `accounts: ["legacy-uuid-only", "src-a::user-1"]`
- **WHEN** the connector reconstructs the Fusion account via `FusionAccount.fromFusionAccount`
- **THEN** the internal account reference set SHALL contain only `src-a::user-1`
- **AND** `legacy-uuid-only` SHALL NOT appear in internal collections or subsequent lookups

#### Scenario: Non-composite missing-account reference is dropped during reconstruction

- **GIVEN** a persisted Fusion account with `missing-accounts: ["legacy-uuid-only"]`
- **WHEN** the connector reconstructs the Fusion account
- **THEN** the internal missing-account reference set SHALL be empty
- **AND** `legacy-uuid-only` SHALL NOT be used for correlation or managed account fetch

### Requirement: originAccount MUST follow origin-type key rules

When loading persisted `originAccount` metadata, the connector SHALL accept a plain identity ID only when the account origin is the Identities source. When the origin is a managed source, `originAccount` MUST be a valid composite managed account key. Non-composite managed-source origin values SHALL NOT be retained as origin account identifiers.

#### Scenario: Identity-origin account retains plain identity ID

- **GIVEN** a persisted Fusion account with `originSource: Identities` and `originAccount: "<identity-uuid>"`
- **WHEN** the connector loads origin metadata
- **THEN** `originAccount` SHALL be set to the identity UUID

#### Scenario: Managed-origin account requires composite originAccount

- **GIVEN** a persisted Fusion account with `originSource: "Workday"` and `originAccount: "src-a::user-1"`
- **WHEN** the connector loads origin metadata
- **THEN** `originAccount` SHALL be set to `src-a::user-1`

#### Scenario: Managed-origin account rejects raw originAccount

- **GIVEN** a persisted Fusion account with `originSource: "Workday"` and `originAccount: "legacy-uuid-only"`
- **WHEN** the connector loads origin metadata
- **THEN** `originAccount` SHALL NOT be set to the raw UUID
- **AND** the invalid value SHALL NOT be used as a managed account lookup key

### Requirement: Managed source Match scoring eligibility uses automatic merge and manual review toggles

During `initializeManagedAccountProcessing`, `FusionService.validateManagedSourceReviewers` SHALL evaluate each managed source for Match scoring eligibility. A source SHALL enter Match scoring when **`fusionEnableAutoMerge`** is true **or** when **`fusionEnableManualReview`** is true and the source has at least one reviewer in `run.reviewersBySourceId`. When neither condition holds, the source SHALL be added to `run.sourcesWithoutReviewers`. A single INFO log SHALL be emitted once per run — never once per source and never at ERROR level — listing every source added to `run.sourcesWithoutReviewers` and stating their accounts will be treated as non-matched. When automatic merge is enabled and a source has zero reviewers, the source SHALL NOT be added to `run.sourcesWithoutReviewers`, and a single WARN log SHALL be emitted once per run listing those sources and stating manual review is unavailable and borderline matches will register as non-match.

#### Scenario: Manual review enabled without reviewers and automatic merge disabled skips scoring

- **GIVEN** `fusionEnableAutoMerge` is false
- **AND** `fusionEnableManualReview` is true
- **AND** managed source `"Source A"` has zero reviewers in `run.reviewersBySourceId`
- **WHEN** `validateManagedSourceReviewers` runs during managed account initialization
- **THEN** `"Source A"` SHALL be present in `run.sourcesWithoutReviewers`
- **AND** a single INFO log SHALL mention that Match scoring is not configured and list `"Source A"`
- **AND** an ERROR log SHALL NOT mention that Match scoring is not configured

#### Scenario: Automatic merge enabled without reviewers allows scoring

- **GIVEN** `fusionEnableAutoMerge` is true
- **AND** managed source `"Source A"` has zero reviewers in `run.reviewersBySourceId`
- **WHEN** `validateManagedSourceReviewers` runs during managed account initialization
- **THEN** `"Source A"` SHALL NOT be present in `run.sourcesWithoutReviewers`
- **AND** a WARN log SHALL mention manual review is unavailable

#### Scenario: Manual review enabled with reviewers allows scoring

- **GIVEN** `fusionEnableManualReview` is true
- **AND** managed source `"Source A"` has at least one reviewer in `run.reviewersBySourceId`
- **WHEN** `validateManagedSourceReviewers` runs
- **THEN** `"Source A"` SHALL NOT be present in `run.sourcesWithoutReviewers`

#### Scenario: Both automatic merge and manual review disabled skips scoring

- **GIVEN** `fusionEnableAutoMerge` is false
- **AND** `fusionEnableManualReview` is false
- **WHEN** `validateManagedSourceReviewers` runs for managed source `"Source A"`
- **THEN** `"Source A"` SHALL be present in `run.sourcesWithoutReviewers`
- **AND** an INFO log SHALL mention that Match scoring is not configured
- **AND** an ERROR log SHALL NOT mention that Match scoring is not configured

#### Scenario: Multiple non-scorable sources log once for the run

- **GIVEN** managed sources `"Source A"` and `"Source B"` are both ineligible for Match scoring
- **WHEN** `validateManagedSourceReviewers` runs
- **THEN** exactly one INFO log SHALL mention that Match scoring is not configured
- **AND** that log SHALL list both `"Source A"` and `"Source B"`

### Requirement: Unique JIT on Output does not hold the unique registry lock during Velocity evaluation

`FusionService.forEachISCAccount` SHALL continue to call `refreshUniqueAttributes` immediately before `getISCAccount` for accounts with `needsRefresh` when unique refresh is enabled. Unique template evaluation SHALL follow `definition-service` (registry lock does not cover Velocity). This requirement does not allow calling `listISCAccounts` on the account-list output path, eager Unique generation during Process, or skipping in-memory counter advance during dry-run Output.

#### Scenario: JIT Unique generation still precedes serialize

- **GIVEN** a Fusion account that requires Unique attribute generation
- **WHEN** Output iterates that account via `forEachISCAccount` with unique refresh enabled
- **THEN** Unique attributes SHALL be generated immediately before serialization
- **AND** the serialized account SHALL then be removed from memory as today

#### Scenario: Dry-run Output still uses in-memory counters

- **GIVEN** account-list dry-run with Unique incremental counters
- **WHEN** Output refreshes Unique attributes
- **THEN** in-memory counters MAY advance to project unique values
- **AND** counter persistence to the ISC tenant SHALL NOT occur

### Requirement: processFusionAccount records Refresh sub-step metrics

When the bound operation run context phase is `Refresh`, `FusionService.processFusionAccount` SHALL record wall-clock durations into Refresh-phase aggregate buckets (`prelude`, `managedLayer`, `uniqueRegister`, `map`, `normalDefine`, `correlation`, and `finalize`) without emitting per-account METRIC or INFO lines for those sub-steps. When the phase is not `Refresh`, the same recipe SHALL run and Refresh-phase metrics SHALL NOT increment.

#### Scenario: Refresh phase records sub-step timings without per-account METRIC

- **GIVEN** `processFusionAccount` runs during account-list Refresh
- **WHEN** the extended account-assembly recipe completes for a Fusion account
- **THEN** Refresh-phase metrics SHALL include the sub-step durations for that account
- **AND** the connector SHALL NOT emit a METRIC line per Fusion account for those sub-steps

#### Scenario: Non-Refresh processFusionAccount does not increment Refresh metrics

- **GIVEN** `processFusionAccount` is invoked during Process phase or a single-account rebuild
- **WHEN** sub-step timing hooks execute
- **THEN** Refresh-phase metrics SHALL NOT increment

### Requirement: Previous and missing keys that are foreign-owned are dropped as gone

When `FusionLayers.addManagedAccountLayer` resolves leftover `previousAccountIds` and `missingAccountIds` after identity matching for this Fusion account, it SHALL treat each **foreign-owned managed account** as gone for this Fusion account. Current managed-account state determines ownership: the Fusion identity whose ISC `identityId` currently holds the managed account SHALL blend and claim it; a Fusion identity that only has the key as previous or missing SHALL drop the link. The connector SHALL remove the key from accounts, missing-accounts, previous keys, and `managedAccountInfo` using the same bookkeeping as prune-deleted, including history and refresh/orphan semantics. It SHALL NOT absorb that managed source account into this Fusion account. It SHALL NOT `claimAccount` for that key, so the owning Fusion identity can still identity-match it. A previous or missing key whose ISC `identityId` is unset, matches this Fusion account, or belongs to an identity that is not a loaded Fusion identity SHALL keep existing uncorrelated absorb and claim behavior. A Fusion listing in accounts, missing-accounts, or previous keys SHALL NOT override an unset or matching ISC `identityId`. Identity matching for this Fusion account’s own `identityId` SHALL remain unchanged.

#### Scenario: Queue hit owned by another Fusion identity is dropped without claim

- **GIVEN** a Fusion account whose `previousAccountIds` or `missingAccountIds` contains a managed account key
- **AND** the Fusion account has another managed account link
- **AND** that key is present on the work queue
- **AND** the managed source account’s `identityId` is a loaded Fusion identity other than this Fusion account
- **WHEN** `addManagedAccountLayer` runs
- **THEN** the key SHALL be removed from this Fusion account’s accounts, missing-accounts, and previous keys
- **AND** `needsRefresh` SHALL be true
- **AND** `queue.claimAccount` SHALL NOT be invoked for that key
- **AND** the managed source account SHALL remain on the work queue

#### Scenario: Already-claimed foreign-owned key is dropped despite inventory presence

- **GIVEN** a Fusion account whose `previousAccountIds` or `missingAccountIds` contains a managed account key
- **AND** that key is absent from the work queue
- **AND** `managedAccountInventory` still lists the key
- **AND** the inventory `identityId` is a loaded Fusion identity other than this Fusion account
- **WHEN** `addManagedAccountLayer` runs with prune-deleted enabled
- **THEN** the key SHALL be removed from this Fusion account
- **AND** the managed-origin Fusion account SHALL be marked orphan
- **AND** `needsRefresh` SHALL be false because no managed contributor remains to remap
- **AND** prune-deleted SHALL NOT keep the key solely because inventory still lists it

#### Scenario: Uncorrelated key with no other Fusion identity is still absorbed

- **GIVEN** a Fusion account whose `previousAccountIds` contains a managed account key present on the work queue
- **AND** the managed source account is not a foreign-owned managed account
- **WHEN** `addManagedAccountLayer` runs
- **THEN** the account SHALL be absorbed and claimed as in existing previous-run uncorrelated behavior

#### Scenario: This Fusion identity’s identity-matched keys are not dropped

- **GIVEN** a Fusion account whose identity id matches a managed source account on the work queue
- **AND** that key is also listed in `previousAccountIds`
- **WHEN** `addManagedAccountLayer` runs
- **THEN** identity matching SHALL absorb and claim that key for this Fusion account
- **AND** the previous/missing path SHALL NOT drop that key as foreign-owned

#### Scenario: Identity-matched holder keeps the key when another Fusion identity still lists it

- **GIVEN** a Fusion account whose identity id matches a managed source account on the work queue
- **AND** another loaded Fusion identity still lists that key in accounts or missing-accounts
- **WHEN** `addManagedAccountLayer` runs for the identity that currently holds the managed account
- **THEN** identity matching SHALL absorb and claim that key for the holding Fusion identity
- **AND** the previous/missing path SHALL NOT drop that key as foreign-owned

#### Scenario: Missing-only listing does not own an uncorrelated managed account

- **GIVEN** a Fusion account whose `previousAccountIds` contains a managed account key present on the work queue
- **AND** the managed source account has no ISC `identityId`
- **AND** another loaded Fusion identity lists that key only in missing-accounts
- **WHEN** `addManagedAccountLayer` runs
- **THEN** the account SHALL be absorbed and claimed as in existing previous-run uncorrelated behavior

#### Scenario: Uncorrelated key listed on another Fusion identity is still absorbed

- **GIVEN** a Fusion account whose `previousAccountIds` contains a managed account key present on the work queue
- **AND** the managed source account has no ISC `identityId`
- **AND** another loaded Fusion identity lists that key in persisted accounts
- **WHEN** `addManagedAccountLayer` runs
- **THEN** the account SHALL be absorbed and claimed as in existing previous-run uncorrelated behavior

### Requirement: FusionLayers rematerializes linked snapshots from claimed account retention

When `FusionLayers.addManagedAccountLayer` determines that live sources are required, it SHALL materialize source snapshots for every live linked managed account key that still has attribute bodies available this run: first from the work queue when present, otherwise from **claimed account retention** for keys claimed earlier in the same run. Rematerialization SHALL run before Map and Define for that Fusion account (including `assembleAccount` re-entry for authorized or automatic merges). Keys never loaded this run and absent from retention SHALL remain without a new snapshot. Retention-backed rematerialization SHALL NOT re-queue keys onto the Match work queue.

#### Scenario: Prior claim-only origin rematerializes when a new blend requires live sources

- **GIVEN** a Fusion account whose origin managed account key was claim-only absorbed earlier in the same run
- **AND** claimed account retention still holds that origin account’s attributes
- **AND** a different managed account key on the work queue is a new blend for that Fusion account
- **WHEN** `addManagedAccountLayer` runs because live sources are required
- **THEN** `attributeBag.sources` SHALL include a materialized snapshot for the new blend
- **AND** `attributeBag.sources` SHALL include a rematerialized snapshot for the previously claim-only origin key
- **AND** the origin key SHALL NOT reappear on the Match work queue

#### Scenario: Authorized merge onto a claim-only-preprocessed Fusion account rematerializes linked keys

- **GIVEN** a Fusion account already processed with claim-only absorb for its linked keys
- **AND** an authorized or automatic merge decision blends a new managed account onto that Fusion account via `assembleAccount`
- **WHEN** live sources become required for that layer invocation
- **THEN** previously claim-only linked keys present in claimed account retention SHALL be rematerialized onto `attributeBag.sources` before Map and Define

#### Scenario: Missing retention leaves only queue-backed snapshots

- **GIVEN** live sources are required
- **AND** a linked key is absent from both the work queue and claimed account retention
- **WHEN** `addManagedAccountLayer` runs
- **THEN** that key SHALL NOT receive a newly materialized snapshot from this path
- **AND** other linked keys that are available SHALL still materialize

### Requirement: FusionLayers claim-only absorb skips source snapshot materialization when live sources are not required

When `FusionLayers.addManagedAccountLayer` absorbs managed accounts from the work queue, it SHALL decide **once per Fusion account before any `claimAccount` in that layer invocation** whether **source snapshot materialization** is required. If live sources are not required, each linked key found on the queue SHALL use **claim-only absorb**: `claimAccount`, uncorrelated/status bookkeeping, and `managedAccountInfo` without copying managed account attributes onto `attributeBag.sources`. If live sources are required, the layer SHALL materialize source snapshots for **all live linked accounts** whose attribute bodies are available this run — from the work queue and, when a key was claimed earlier in the same run, from **claimed account retention** (not only keys still on the queue). `claimAccount` SHALL run for work-queue keys in both paths so Process cannot rematch those keys. The layer SHALL NOT expect already-claimed keys to still sit in `managedAccountsById`; rematerialization from claimed account retention is the supported recovery path.

Live sources are required when any of the following hold before claim: `needsRefresh` is already true; force attribute refresh is enabled; rebuild `refreshMapping`, `refreshDefinition`, or `resetDefinition` is requested; the Fusion account has at least one eligible Always recalculate Normal definition; any linked key is a new blend (`previousAccountIds` does not contain it); any previously correlated linked key on the queue has `modified` strictly newer than Fusion `modified` plus `fusionAccountRefreshThresholdInSeconds`; prune-deleted would remove a tracked key; a previous or missing key is a **foreign-owned managed account** that this Fusion account will drop.

#### Scenario: Stale previously correlated accounts are claim-only

- **GIVEN** a Fusion account restored via `fromFusionAccount` with `modified` set
- **AND** `previousAccountIds` contains a managed account key present on the work queue
- **AND** that managed account `modified` is not newer than Fusion `modified` plus the refresh threshold
- **AND** force attribute refresh is disabled
- **AND** rebuild attribute operations do not request mapping or definition refresh
- **AND** no eligible Always recalculate Normal definition applies to the Fusion account
- **AND** prune-deleted would not remove a tracked key
- **AND** no previous or missing key is a foreign-owned managed account
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be false
- **AND** `queue.claimAccount` SHALL be invoked for that key
- **AND** `attributeBag.sources` SHALL NOT contain a newly materialized snapshot copied from that managed account’s attributes
- **AND** claimed account retention SHALL hold that account’s attributes after claim

#### Scenario: New blend materializes snapshots for the Fusion account

- **GIVEN** a Fusion account whose `previousAccountIds` does not contain a managed account key that is on the work queue
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be true
- **AND** source snapshot materialization SHALL copy that account’s attributes onto `attributeBag.sources`
- **AND** `queue.claimAccount` SHALL be invoked for that key

#### Scenario: Over-threshold modified materializes all live linked accounts on the Fusion account

- **GIVEN** a Fusion account with two previously correlated managed accounts on the work queue
- **AND** only one of them has `modified` strictly after Fusion `modified` plus the refresh threshold
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be true
- **AND** source snapshot materialization SHALL include both live linked accounts found on the queue

#### Scenario: Prune-deleted requires materializing remaining live accounts

- **GIVEN** a Fusion account whose tracked keys include one key absent from `managedAccountInventory`
- **AND** another previously correlated key is present on the work queue with stale `modified`
- **WHEN** `addManagedAccountLayer` runs with prune-deleted enabled
- **THEN** `needsRefresh` SHALL be true
- **AND** the remaining live account SHALL receive source snapshot materialization
- **AND** the missing key SHALL be pruned as today

#### Scenario: Foreign-owned drop requires materializing remaining live accounts

- **GIVEN** a Fusion account whose tracked keys include one foreign-owned managed account key
- **AND** another previously correlated key is present on the work queue with stale `modified`
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be true
- **AND** the remaining live account SHALL receive source snapshot materialization
- **AND** the foreign-owned key SHALL be dropped without claim

#### Scenario: Force attribute refresh materializes before Map

- **GIVEN** a Fusion account that would otherwise qualify for claim-only absorb
- **AND** `forceAttributeRefresh` is enabled
- **WHEN** `addManagedAccountLayer` runs
- **THEN** source snapshot materialization SHALL run for live linked accounts on the queue
- **AND** those keys SHALL still be claimed

#### Scenario: Eligible Always recalculate materializes when timestamps are stale

- **GIVEN** a Fusion account that would otherwise qualify for claim-only absorb
- **AND** at least one Normal definition has Always recalculate and is eligible on that Fusion account
- **WHEN** `addManagedAccountLayer` runs
- **THEN** source snapshot materialization SHALL run so Velocity `$accounts` / `$sources` can read this run’s snapshots

#### Scenario: New blend rematerializes a previously claim-only sibling from retention

- **GIVEN** a Fusion account that claim-only absorbed linked key A earlier in the same run
- **AND** claimed account retention holds key A’s attributes
- **AND** key B is a new blend on the work queue for that Fusion account
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be true
- **AND** source snapshot materialization SHALL include key B from the work queue
- **AND** source snapshot materialization SHALL include key A from claimed account retention

### Requirement: Previous and missing managed account keys use targeted queue lookups

When `FusionLayers.addManagedAccountLayer` re-blends managed source accounts for persisted Fusion accounts, `processPreviousRunMatchedAccounts` SHALL resolve accounts by looking up each normalized key in `previousAccountIds` and `missingAccountIds` via `FusionRun.get(key)` (or equivalent O(1) queue lookup). It SHALL NOT iterate all entries in the managed-account work queue to find matching keys. Foreign-owned managed account keys SHALL be excluded from absorb and claim on this path.

#### Scenario: Large queue with few previous keys avoids full scan

- **GIVEN** a managed-account work queue containing thousands of entries
- **AND** a Fusion account whose `previousAccountIds` contains two keys present in the queue
- **AND** neither key is a foreign-owned managed account
- **WHEN** `addManagedAccountLayer` runs during Refresh
- **THEN** exactly those two accounts SHALL be absorbed and claimed
- **AND** the implementation SHALL NOT invoke a full-queue iteration over all queue entries for this path

#### Scenario: Missing key absent from queue is skipped

- **GIVEN** a Fusion account with `missingAccountIds` containing a key not present in the work queue
- **AND** that key is not a foreign-owned managed account
- **WHEN** previous/missing re-blend runs
- **THEN** processing SHALL continue without error
- **AND** no account SHALL be absorbed for that key

#### Scenario: Uncorrelated status updates preserved for matched keys

- **GIVEN** a managed source account in the queue matching a previous-run key on a Fusion account
- **AND** that account is not a foreign-owned managed account
- **WHEN** targeted lookup absorbs the account
- **THEN** uncorrelated status and missing-account collection updates SHALL match pre-change behavior for that key
- **AND** `queue.claimAccount` SHALL be invoked for the absorbed key

### Requirement: Managed-account timestamp refresh uses Fusion account modified

When `FusionLayers.setManagedAccount` absorbs a managed account that is already in `previousAccountIds`, it SHALL set `needsRefresh` from timestamps only when the managed account `modified` is strictly newer than the Fusion account `modified` plus `fusionAccountRefreshThresholdInSeconds`. It SHALL NOT treat a missing Fusion `modified` as epoch 0. A managed account whose key is not in `previousAccountIds` SHALL still set `needsRefresh` (new blend). Prune-deleted and identity-layer rules are unchanged.

#### Scenario: Previously correlated stale managed account does not force refresh

- **GIVEN** a Fusion account restored via `fromFusionAccount` with `modified` set
- **AND** `previousAccountIds` contains a managed account key that is present on the work queue
- **AND** that managed account `modified` is older than the Fusion account `modified`
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be false
- **AND** the managed account SHALL still be claimed from the work queue

#### Scenario: Managed account newer than Fusion modified beyond the threshold forces refresh

- **GIVEN** a Fusion account with `modified` set and a previously correlated managed account on the work queue
- **AND** the managed account `modified` is strictly after Fusion `modified` plus `fusionAccountRefreshThresholdInSeconds`
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be true

#### Scenario: Managed account newer than Fusion modified within the threshold does not force refresh

- **GIVEN** a Fusion account with `modified` set and a previously correlated managed account on the work queue
- **AND** the managed account `modified` is after Fusion `modified` but not after Fusion `modified` plus `fusionAccountRefreshThresholdInSeconds`
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be false

#### Scenario: New blend still forces refresh

- **GIVEN** a Fusion account whose `previousAccountIds` does not contain the managed account key
- **AND** that managed account is on the work queue (for example via identity index)
- **WHEN** `addManagedAccountLayer` runs
- **THEN** `needsRefresh` SHALL be true

#### Scenario: Missing Fusion modified does not use epoch as the refresh reference

- **GIVEN** a Fusion account with no `modified` value
- **AND** a previously correlated managed account on the work queue with a real ISO `modified`
- **WHEN** `addManagedAccountLayer` runs
- **THEN** the timestamp check SHALL NOT set `needsRefresh`
- **AND** `needsRefresh` SHALL remain false unless a new-blend or prune-deleted rule applies

### Requirement: Ownership reviewer selection sets the owner identity

When a reviewer selects an existing identity for an Ownership-eligible account, the connector SHALL set that account's owner identity to the selected identity. The connector SHALL NOT change the account's correlated identity. The connector SHALL NOT add the machine account as a contributing or missing account on a Fusion account. The source correlation mode SHALL NOT cause a correlation for that account.

#### Scenario: Reviewer selection writes the owner identity

- **GIVEN** a finished review decision that selects an existing identity
- **AND** the decision's account is an Ownership-eligible machine account with no established owner identity
- **WHEN** the connector applies the decision
- **THEN** the machine account's owner identity SHALL be the selected identity
- **AND** the machine account's correlated identity SHALL be unchanged
- **AND** the machine account SHALL NOT be a contributing account on a Fusion account

#### Scenario: Assignment-mode reviewer selection still correlates

- **GIVEN** a finished review decision that selects an existing identity
- **AND** the decision's account is from an Orphan source in Assignment mode
- **AND** that source's correlation mode correlates missing accounts
- **WHEN** the connector applies the decision
- **THEN** the connector SHALL correlate the account to the selected identity
- **AND** the connector SHALL NOT set an owner identity on that account

### Requirement: Ownership reviewer no-match drops the account

When a reviewer records no match for an Ownership-eligible account, the connector SHALL drop the account and SHALL NOT set an owner identity. When Disable non-matching accounts is enabled for that source, the connector SHALL queue a disable for the account. When that toggle is off, the connector SHALL NOT disable the account.

#### Scenario: Reviewer no-match does not set an owner identity

- **GIVEN** a finished review decision that records no match
- **AND** the decision's account is an Ownership-eligible machine account
- **AND** Disable non-matching accounts is off
- **WHEN** the connector applies the decision
- **THEN** the account SHALL NOT gain an owner identity
- **AND** the account SHALL NOT be disabled

#### Scenario: Reviewer no-match queues disable when configured

- **GIVEN** a finished review decision that records no match
- **AND** the decision's account is an Ownership-eligible machine account
- **AND** Disable non-matching accounts is on
- **WHEN** the connector applies the decision
- **THEN** a disable SHALL be queued for that account
- **AND** the account SHALL NOT gain an owner identity

### Requirement: Processing Control toggle for origin-absent main account handoff defaults off

The connector SHALL expose Processing Control toggle `promoteMainAccountWhenOriginMissing` with label "Promote first found managed account to main account when origin account is missing". Help text SHALL state both halves: while enabled, set `mainAccount` to the first live managed account when the origin is not a current contributor, and clear `mainAccount` when the origin is a current contributor again. The connector spec SHALL NOT set an initial value that turns the toggle on. When the key is absent, runtime configuration SHALL read the toggle as off.

#### Scenario: Absent key leaves the toggle off

- **GIVEN** Processing Control settings with no `promoteMainAccountWhenOriginMissing` key
- **WHEN** settings are read
- **THEN** the toggle SHALL be off

#### Scenario: Help text states promote and clear

- **GIVEN** the Processing Control section in the connector spec
- **WHEN** an operator reads the toggle help
- **THEN** the help SHALL state that an enabled toggle sets `mainAccount` to the first live managed account while the origin is not a current contributor
- **AND** the help SHALL state that an enabled toggle clears `mainAccount` when the origin is a current contributor again

### Requirement: processFusionAccount hands mainAccount to the first live managed account while the origin is absent

While `promoteMainAccountWhenOriginMissing` is on, `FusionService.processFusionAccount` SHALL, after the managed-account layer and origin-in-scope resolution and before Map, set `mainAccount` to the first live managed account when the origin is not a current contributor and at least one live managed account remains. The identity bag SHALL NOT be selected. `originAccount` SHALL stay unchanged. A changed value SHALL set `needsRefresh` and SHALL append one history line. An unchanged value SHALL NOT set `needsRefresh` for this rule. The rule SHALL NOT run on `AccountAssembly.assembleAccount`.

#### Scenario: Managed-origin account promotes the first live managed account

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin key is not in `accounts` after this run's blend and prune
- **AND** another managed account is still linked
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be that first live managed account
- **AND** `originAccount` SHALL be unchanged
- **AND** `needsRefresh` SHALL be true so Map follows `mainAccount` in that same run
- **AND** history SHALL include one line for the change

#### Scenario: First live managed account follows configured source order

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin is not a current contributor
- **AND** linked managed accounts on two configured sources
- **AND** `mainAccount` currently names the account on the later source
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL name the account on the earlier configured source

#### Scenario: First live managed account follows blend order within one source

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin is not a current contributor
- **AND** two linked managed accounts on the same source, in blend order
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL name the earlier account in that blend order

#### Scenario: Identity bag is not the first live managed account

- **GIVEN** the toggle is on
- **AND** an identity-origin Fusion account whose origin identity is resolved out of scope
- **AND** at least one managed account is still linked
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL name that first live managed account
- **AND** `mainAccount` SHALL NOT be the identity id
- **AND** the Fusion account SHALL NOT be marked orphan

#### Scenario: No live managed account clears mainAccount

- **GIVEN** the toggle is on
- **AND** a Fusion account whose origin is not a current contributor
- **AND** no managed account is still linked
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared
- **AND** `needsRefresh` SHALL be true

#### Scenario: Unchanged mainAccount does not force refresh

- **GIVEN** the toggle is on
- **AND** a Fusion account whose origin is not a current contributor
- **AND** `mainAccount` is already the first live managed account
- **AND** the account does not otherwise need refresh
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay that account
- **AND** this rule SHALL NOT set `needsRefresh`

### Requirement: processFusionAccount clears mainAccount when the origin is a current contributor

While `promoteMainAccountWhenOriginMissing` is on, `processFusionAccount` SHALL clear `mainAccount` before Map when the origin is a current contributor, including a value an operator stored. Clearing SHALL remove the value. A changed value SHALL set `needsRefresh` and SHALL append one history line.

#### Scenario: Managed-origin account clears a stored mainAccount while the origin key remains

- **GIVEN** the toggle is on
- **AND** a managed-origin Fusion account whose origin key is still in `accounts`
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared before Map
- **AND** `needsRefresh` SHALL be true

#### Scenario: Identity-origin account clears mainAccount when the origin identity is in scope

- **GIVEN** the toggle is on
- **AND** an identity-origin Fusion account whose origin identity is resolved in scope
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared

#### Scenario: Origin returns on a later run and clears mainAccount

- **GIVEN** the toggle is on
- **AND** a Fusion account whose `mainAccount` was set to a live managed account while the origin was not a current contributor
- **AND** on this run the origin is a current contributor again
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be cleared

### Requirement: Skipped refresh and an unresolved scope check do not count as origin-absent

`processFusionAccount` SHALL NOT treat a missing origin snapshot as the origin being absent when this run did not rebuild the contributor list. `processFusionAccount` SHALL NOT treat unresolved `originIdentityInScope` as the origin being absent. While the toggle is off, or the key is absent, `processFusionAccount` SHALL leave `mainAccount` unchanged.

#### Scenario: Toggle off leaves mainAccount unchanged when the origin key is gone

- **GIVEN** the toggle is off
- **AND** a managed-origin Fusion account whose origin key is not in `accounts`
- **AND** `mainAccount` is set
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be unchanged

#### Scenario: Absent key leaves mainAccount unchanged

- **GIVEN** Processing Control has no `promoteMainAccountWhenOriginMissing` key
- **AND** a Fusion account whose origin is not a current contributor
- **AND** `mainAccount` is unset
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay unset

#### Scenario: Skipped refresh does not promote from a missing origin snapshot

- **GIVEN** the toggle is on
- **AND** this run did not rebuild the contributor list
- **AND** the origin key is still in `accounts`
- **AND** the origin snapshot is not loaded
- **AND** `mainAccount` is unset
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay unset

#### Scenario: Unresolved identity scope does not change mainAccount

- **GIVEN** the toggle is on
- **AND** an identity-origin Fusion account whose `originIdentityInScope` is unresolved
- **AND** `mainAccount` is set
- **AND** a managed account is still linked
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL be unchanged

#### Scenario: Turning the toggle off leaves a previously promoted mainAccount in place

- **GIVEN** the toggle is off
- **AND** `mainAccount` already names a live managed account from an earlier run when the toggle was on
- **AND** the origin is a current contributor on this run
- **WHEN** `processFusionAccount` runs
- **THEN** `mainAccount` SHALL stay that live managed account

### Requirement: An explicit attribute map can replace mainAccount after the handoff

An explicit attribute map that writes `mainAccount` in the same Map SHALL replace the value this rule wrote. The value that persists SHALL be the map's value.

#### Scenario: Explicit map wins over the handoff in the same run

- **GIVEN** the toggle is on
- **AND** the origin is not a current contributor
- **AND** an explicit attribute map writes `mainAccount`
- **WHEN** `processFusionAccount` runs
- **THEN** the persisted `mainAccount` SHALL be the value the map wrote
- **AND** the handoff value SHALL have been applied before that Map


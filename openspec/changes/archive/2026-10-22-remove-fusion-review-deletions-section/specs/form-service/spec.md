## REMOVED Requirements

### Requirement: Successful Fusion review form definition deletes are retained once

**Reason**: Successful deletes are no longer retained. The aggregation report no longer lists deleted Fusion review form definitions.

**Migration**: None; callers stop reading `run.deletedFusionReviewForms`.

### Requirement: Failed deletes and cancelled instances are not retained as deletions

**Reason**: No delete outcome is retained for a report, so the rule no longer applies.

**Migration**: None; the retention store is removed.

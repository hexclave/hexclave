# HexclaveAdminApp feature flag transport

HexclaveAdminApp extends HexclaveServerApp and exposes the following internal control-plane operations:

- `testFeatureFlags(request)` -> exposure-free evaluation through `POST /api/v1/internal/feature-flags/test`
- `listFeatureFlagExperimentRuns(experimentId)`
- `createFeatureFlagExperimentRun(experimentId, immutableConfigSnapshot)`
- `startFeatureFlagExperimentRun(experimentId, runId)`
- `pauseFeatureFlagExperimentRun(experimentId, runId)`
- `resumeFeatureFlagExperimentRun(experimentId, runId)`
- `completeFeatureFlagExperimentRun(experimentId, runId)`
- `createFeatureFlagExperimentRevision(experimentId, runId, immutableConfigSnapshot)`
- `getFeatureFlagExperimentResults(experimentId, runId)`

Run operations use `/api/v1/internal/feature-flags/experiments/:experimentId/runs/:runId`; lifecycle transitions append `/start`, `/pause`, `/resume`, or `/complete`, revisions append `/revision` with `experiment_config`, and results append `/results`. Creating and listing runs omit `:runId`. All requests use admin authentication. IDs and query values must be URL encoded. The SDK transports immutable run/result payloads without reproducing backend lifecycle or statistics logic.

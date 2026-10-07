import { FEATURE_REQUEST_FLAG_TYPE, featureRequestFromFlagsJson, type QaFlag } from "../../spacetimedb/src/feature-request-flag";

export { FEATURE_REQUEST_FLAG_TYPE, featureRequestFromFlagsJson, type QaFlag };

export type FeatureRequestVerdict = {
  detected: boolean,
  summary: string,
  evidence: string,
};


export function isCompleteFeatureRequestVerdict(featureRequest: FeatureRequestVerdict): boolean {
  return featureRequest.summary.trim() !== "" && featureRequest.evidence.trim() !== "";
}

export function normalizeQaFlags(flags: readonly QaFlag[], featureRequest: FeatureRequestVerdict): QaFlag[] {
  const withoutPreviousVerdict = flags.filter(flag => flag.type !== FEATURE_REQUEST_FLAG_TYPE);
  if (!featureRequest.detected || !isCompleteFeatureRequestVerdict(featureRequest)) return withoutPreviousVerdict;

  return [...withoutPreviousVerdict, {
    type: FEATURE_REQUEST_FLAG_TYPE,
    // A capability request is product input, not an answer-quality failure.
    severity: "low",
    explanation: featureRequest.evidence.trim(),
    summary: featureRequest.summary.trim(),
  }];
}

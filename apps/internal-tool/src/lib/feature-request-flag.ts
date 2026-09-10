export const FEATURE_REQUEST_FLAG_TYPE = "unsupported_feature_request";

export type QaFlag = {
  type: string,
  severity: string,
  explanation: string,
  summary?: string,
};

export type FeatureRequestVerdict = {
  detected: boolean,
  summary: string,
  evidence: string,
};

export function normalizeQaFlags(flags: readonly QaFlag[], featureRequest: FeatureRequestVerdict): QaFlag[] {
  const withoutPreviousVerdict = flags.filter(flag => flag.type !== FEATURE_REQUEST_FLAG_TYPE);
  if (!featureRequest.detected) return withoutPreviousVerdict;

  const summary = featureRequest.summary.trim();
  const evidence = featureRequest.evidence.trim();
  if (summary === "" || evidence === "") {
    throw new Error("A detected feature request must include a summary and supporting evidence");
  }

  return [...withoutPreviousVerdict, {
    type: FEATURE_REQUEST_FLAG_TYPE,
    // A capability request is product input, not an answer-quality failure.
    severity: "low",
    explanation: evidence,
    summary,
  }];
}

export function featureRequestFromFlagsJson(flagsJson: string | undefined): QaFlag | null {
  if (flagsJson == null || flagsJson === "") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(flagsJson);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!Array.isArray(parsed)) return null;

  for (const candidate of parsed) {
    if (candidate == null || typeof candidate !== "object") continue;
    if (!("type" in candidate) || candidate.type !== FEATURE_REQUEST_FLAG_TYPE) continue;
    if (!("severity" in candidate) || typeof candidate.severity !== "string") continue;
    if (!("explanation" in candidate) || typeof candidate.explanation !== "string") continue;
    const summary = "summary" in candidate && typeof candidate.summary === "string"
      ? candidate.summary.trim()
      : "";
    return {
      type: FEATURE_REQUEST_FLAG_TYPE,
      severity: candidate.severity,
      explanation: candidate.explanation,
      summary: summary === "" ? undefined : summary,
    };
  }
  return null;
}

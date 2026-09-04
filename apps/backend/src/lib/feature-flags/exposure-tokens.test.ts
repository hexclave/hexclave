// `import type` keeps this a compile-time-only dependency: tenancies.tsx pulls
// in the Prisma client at runtime, which unit tests must not load.
import type { Tenancy } from "@/lib/tenancies";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { signJWT } from "@hexclave/shared/dist/utils/jwt";
import { describe, expect, it } from "vitest";
import { computeExposureSubjectHash, verifyFeatureFlagEvaluationToken, type FeatureFlagExposureTokenPayload } from "./exposure-tokens";

const EXPOSURE_TOKEN_ISSUER = "hexclave:feature-flags:evaluation";
const EXPOSURE_TOKEN_AUDIENCE = "hexclave:feature-flags:exposures";

// Test-only cast: constructing a real `Tenancy` requires the full rendered
// organization config and the project CRUD object (see tenancies.tsx), which
// is impractical without a database. verifyFeatureFlagEvaluationToken only
// reads `tenancy.project.id` and `tenancy.branchId`; if it ever started
// reading more fields, these tests would fail loudly with a TypeError on the
// missing field rather than silently passing.
function makeFakeTenancy(projectId: string, branchId: string): Tenancy {
  return { project: { id: projectId }, branchId } as unknown as Tenancy;
}

function makeValidPayload(): FeatureFlagExposureTokenPayload {
  return {
    kind: "feature_flag_evaluation",
    evaluation_id: "00000000-0000-4000-8000-000000000001",
    issued_at_millis: "1784342400000",
    project_id: "internal",
    branch_id: "main",
    run_id: "run-1",
    experiment_id: "experiment-1",
    flag_id: "flag-1",
    variant_id: "variant-a",
    rule_id: "experiment-run-1",
    reason: "matched_rule",
    config_revision_hash: "revision-hash-1",
    subject_type: "user",
    subject_id: "user-123",
    subject_hash: computeExposureSubjectHash({ projectId: "internal", subjectType: "user", subjectId: "user-123" }),
  };
}

async function signExposureToken(options?: { payload?: unknown, audience?: string, expirationTime?: string }): Promise<string> {
  return await signJWT({
    issuer: EXPOSURE_TOKEN_ISSUER,
    audience: options?.audience ?? EXPOSURE_TOKEN_AUDIENCE,
    expirationTime: options?.expirationTime ?? "5m",
    payload: options?.payload ?? makeValidPayload(),
  });
}

describe("computeExposureSubjectHash", () => {
  it("is deterministic for the same input", () => {
    const a = computeExposureSubjectHash({ projectId: "internal", subjectType: "user", subjectId: "user-123" });
    const b = computeExposureSubjectHash({ projectId: "internal", subjectType: "user", subjectId: "user-123" });
    expect(a).toBe(b);
  });

  it("differs across projectId, subjectType, and subjectId", () => {
    const base = computeExposureSubjectHash({ projectId: "internal", subjectType: "user", subjectId: "user-123" });
    expect(computeExposureSubjectHash({ projectId: "other-project", subjectType: "user", subjectId: "user-123" })).not.toBe(base);
    expect(computeExposureSubjectHash({ projectId: "internal", subjectType: "team", subjectId: "user-123" })).not.toBe(base);
    expect(computeExposureSubjectHash({ projectId: "internal", subjectType: "user", subjectId: "user-456" })).not.toBe(base);
  });

  it("returns 64-character lowercase hex", () => {
    const hash = computeExposureSubjectHash({ projectId: "internal", subjectType: "user", subjectId: "user-123" });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the known value for a fixed input", () => {
    // Pinned so an accidental change to the hash formula (which must stay in
    // sync with the SQL in experiment-results.ts) fails loudly.
    expect(computeExposureSubjectHash({ projectId: "internal", subjectType: "user", subjectId: "user-123" })).toMatchInlineSnapshot(`"091902c5819c58582f1a01240a2d98b2ad7e76fe1dd1fe354985f0a088712bf9"`);
  });
});

describe("verifyFeatureFlagEvaluationToken", () => {
  it("returns the payload of a validly signed token for the matching tenancy", async () => {
    const token = await signExposureToken();
    const payload = await verifyFeatureFlagEvaluationToken({ token, tenancy: makeFakeTenancy("internal", "main") });
    expect({
      kind: payload.kind,
      evaluation_id: payload.evaluation_id,
      issued_at_millis: payload.issued_at_millis,
      project_id: payload.project_id,
      branch_id: payload.branch_id,
      run_id: payload.run_id,
      experiment_id: payload.experiment_id,
      flag_id: payload.flag_id,
      variant_id: payload.variant_id,
      rule_id: payload.rule_id,
      reason: payload.reason,
      config_revision_hash: payload.config_revision_hash,
      subject_type: payload.subject_type,
      subject_id: payload.subject_id,
      subject_hash: payload.subject_hash,
    }).toMatchInlineSnapshot(`
      {
        "branch_id": "main",
        "config_revision_hash": "revision-hash-1",
        "evaluation_id": "00000000-0000-4000-8000-000000000001",
        "experiment_id": "experiment-1",
        "flag_id": "flag-1",
        "issued_at_millis": "1784342400000",
        "kind": "feature_flag_evaluation",
        "project_id": "internal",
        "reason": "matched_rule",
        "rule_id": "experiment-run-1",
        "run_id": "run-1",
        "subject_hash": "091902c5819c58582f1a01240a2d98b2ad7e76fe1dd1fe354985f0a088712bf9",
        "subject_id": "user-123",
        "subject_type": "user",
        "variant_id": "variant-a",
      }
    `);
  });

  it("rejects a token with a tampered signature with a 401", async () => {
    const token = await signExposureToken();
    // Flip the FIRST character of the signature segment: its six bits are all
    // significant, so the decoded signature is guaranteed to change. (The last
    // character's low bits are base64url padding — flipping those can decode
    // to the identical signature and make the test flaky.)
    const [header, payload, signature] = token.split(".");
    const tampered = `${header}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
    const promise = verifyFeatureFlagEvaluationToken({ token: tampered, tenancy: makeFakeTenancy("internal", "main") });
    await expect(promise).rejects.toBeInstanceOf(StatusError);
    await expect(promise).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a validly signed token minted for a different audience", async () => {
    const token = await signExposureToken({ audience: "hexclave:some-other-audience" });
    const promise = verifyFeatureFlagEvaluationToken({ token, tenancy: makeFakeTenancy("internal", "main") });
    await expect(promise).rejects.toBeInstanceOf(StatusError);
    await expect(promise).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects an expired token with a 401", async () => {
    // "0s" makes exp === iat, which jose treats as already expired at
    // verification time (exp <= now), so no waiting is needed.
    const token = await signExposureToken({ expirationTime: "0s" });
    const promise = verifyFeatureFlagEvaluationToken({ token, tenancy: makeFakeTenancy("internal", "main") });
    await expect(promise).rejects.toBeInstanceOf(StatusError);
    await expect(promise).rejects.toMatchObject({ statusCode: 401 });
  });

  it("rejects a valid token presented for a different project's tenancy with a 403", async () => {
    const token = await signExposureToken();
    const promise = verifyFeatureFlagEvaluationToken({ token, tenancy: makeFakeTenancy("other-project", "main") });
    await expect(promise).rejects.toBeInstanceOf(StatusError);
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a valid token presented for a different branch's tenancy with a 403", async () => {
    const token = await signExposureToken();
    const promise = verifyFeatureFlagEvaluationToken({ token, tenancy: makeFakeTenancy("internal", "other-branch") });
    await expect(promise).rejects.toBeInstanceOf(StatusError);
    await expect(promise).rejects.toMatchObject({ statusCode: 403 });
  });

  it("rejects a validly signed token whose payload does not match the schema with a 401", async () => {
    const token = await signExposureToken({
      payload: { kind: "feature_flag_evaluation", project_id: "internal" },
    });
    const promise = verifyFeatureFlagEvaluationToken({ token, tenancy: makeFakeTenancy("internal", "main") });
    await expect(promise).rejects.toBeInstanceOf(StatusError);
    await expect(promise).rejects.toMatchObject({ statusCode: 401 });
  });
});

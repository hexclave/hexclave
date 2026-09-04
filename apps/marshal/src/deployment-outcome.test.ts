import { describe, expect, it } from "vitest";
import { builderOutputIsTerminal, builderStartupScriptFailed, deploymentStateForApply } from "./services.js";
import type { ServiceState } from "./types.js";

// The image the spec named. Every outcome reports one — including a failure,
// where "which image" is most of the question.
const IMAGE = "us-central1-docker.pkg.dev/project/marshal/app@sha256:" + "a".repeat(64);

function state(overrides: Partial<ServiceState> = {}): ServiceState {
  return {
    key: "web",
    type: "serverless",
    status: "running",
    instances: 1,
    revision: "revision",
    target_revision: null,
    outputs: { hostname: "web.internal", internal_url: "http://web.internal:3000", url: "https://web-example.run.app" },
    domains: [],
    error: null,
    observed_at_millis: 0,
    ...overrides,
  };
}

describe("the deployment outcome of one service's apply", () => {
  it("records a converged apply as deployed, with its URL", () => {
    expect(deploymentStateForApply("web", IMAGE, { revision: "r1", imageRef: null, state: state() })).toEqual({
      service_key: "web",
      status: "deployed",
      revision: "r1",
      url: "https://web-example.run.app",
      image: IMAGE,
      error: null,
    });
    // A private service has no public URL, which is not a failure.
    expect(deploymentStateForApply("web", IMAGE, {
      revision: "r1",
      imageRef: null,
      state: state({ outputs: { hostname: "web.internal", internal_url: null, url: null } }),
    })).toMatchObject({ status: "deployed", url: null });
  });

  it("records a FAILED apply as failed rather than deployed", () => {
    // REGRESSION: only "blocked" used to be treated as a failure, so this was
    // recorded as "deployed" — and the deployment then reported "succeeded"
    // over a service that never rolled. The apply's error is caught inside
    // applyServiceSpec and stored, so it arrives here through the state and
    // never through the caller's own catch.
    const failed = deploymentStateForApply("web", IMAGE, {
      revision: "r1",
      imageRef: null,
      state: state({ status: "failed", error: "deploy failed: machine never started" }),
    });
    expect(failed).toMatchObject({ status: "failed", url: null, error: "deploy failed: machine never started" });
  });

  it("records a degraded apply that carries an error as failed", () => {
    // Partially rolled and still broken: some machines came up, the apply errored.
    expect(deploymentStateForApply("web", IMAGE, {
      revision: "r1",
      imageRef: null,
      state: state({ status: "degraded", error: "deploy failed: one machine would not start" }),
    })).toMatchObject({ status: "failed", error: "deploy failed: one machine would not start" });
  });

  it("still counts a degraded apply with NO error as deployed", () => {
    // "degraded" also arises from merely under-pinned machines during a scale-up,
    // which carries no error. Failing on the status alone would fail deploys for
    // a transient state that resolves itself.
    expect(deploymentStateForApply("web", IMAGE, { revision: "r1", imageRef: null, state: state({ status: "degraded" }) }))
      .toMatchObject({ status: "deployed", url: "https://web-example.run.app" });
  });

  it("reports the image runtime resolved, not the tag the spec named", () => {
    // Marshal does not resolve images, so a tag stays a tag in the spec and the
    // digest only exists in what the runtime reported back for the machine. Recording
    // the tag here would make the deployment history say nothing at all about
    // which bytes ran.
    const ran = "docker.io/library/postgres@sha256:" + "b".repeat(64);
    expect(deploymentStateForApply("db", "docker.io/library/postgres:16", { revision: "r1", imageRef: ran, state: state() }))
      .toMatchObject({ status: "deployed", image: ran });
    // Reported on a failure too, for the same reason every other field is.
    expect(deploymentStateForApply("db", "docker.io/library/postgres:16", {
      revision: "r1",
      imageRef: ran,
      state: state({ status: "failed", error: "deploy failed: machine never started" }),
    })).toMatchObject({ status: "failed", image: ran });
    // An apply that rolled no machine has no resolution to report, so the
    // reference as written is all there is to say.
    expect(deploymentStateForApply("db", "docker.io/library/postgres:16", { revision: "r1", imageRef: null, state: state() }))
      .toMatchObject({ image: "docker.io/library/postgres:16" });
  });

  it("records a blocked apply as failed, and names the reason when the state gives none", () => {
    expect(deploymentStateForApply("web", IMAGE, {
      revision: "r1",
      imageRef: null,
      state: state({ status: "blocked", error: "blocked on unresolved refs: api.url" }),
    })).toMatchObject({ status: "failed", error: "blocked on unresolved refs: api.url" });
    // The fallbacks differ per status so the deployment's own error says which
    // kind of failure it was, even when the state carried no message.
    expect(deploymentStateForApply("web", IMAGE, { revision: "r1", imageRef: null, state: state({ status: "blocked" }) }))
      .toMatchObject({ status: "failed", error: "a connection could not be resolved" });
    expect(deploymentStateForApply("web", IMAGE, { revision: "r1", imageRef: null, state: state({ status: "failed" }) }))
      .toMatchObject({ status: "failed", error: "web failed to deploy" });
  });
});

describe("builder terminal output", () => {
  it("recognizes every harness terminal outcome without treating startup as terminal", () => {
    expect(builderOutputIsTerminal("MARSHAL_BUILD_START\nMARSHAL_TARGET_START web")).toBe(false);
    expect(builderOutputIsTerminal("MARSHAL_BUILD_DONE")).toBe(true);
    expect(builderOutputIsTerminal("MARSHAL_BUILD_FAILED: compilation failed")).toBe(true);
    expect(builderOutputIsTerminal("MARSHAL_BUILD_TIMEOUT")).toBe(true);
  });

  it("treats a builder whose startup script died as terminal", () => {
    // Real serial output: the metadata script runner prefixes every line and kernel messages
    // splice into them, so the marker is never at the start of a line.
    const serial = [
      "[   19.153897] google_metadata_script_runner_adapt[783]: Found startup-script in metadata.",
      "[   22.114974] google_metadata_script_runner_adapt[783]: startup-script: Error response from daemon",
      `[   22.117450] google_metadata_script_runner_adapt[783]: Script "startup-script" failed with error: exit status 1`,
    ].join("\n");

    expect(builderStartupScriptFailed(serial)).toBe(true);
    // No harness marker is ever printed, which is exactly why this needs its own signal.
    expect(builderOutputIsTerminal(serial)).toBe(false);
  });

  it("does not call a healthy builder's startup script failed", () => {
    expect(builderStartupScriptFailed("MARSHAL_BUILD_START\nMARSHAL_TARGET_START web")).toBe(false);
    expect(builderStartupScriptFailed("")).toBe(false);
  });
});

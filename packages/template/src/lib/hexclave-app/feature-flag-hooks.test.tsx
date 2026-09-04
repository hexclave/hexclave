// @vitest-environment jsdom

import type { FeatureFlagEvaluateResponse } from "@hexclave/shared/dist/interface/crud/feature-flags";
import { act } from "react";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FeatureFlagController } from "./feature-flags";
import { useFeatureFlagDetailsFromController } from "./feature-flag-hooks";

const successfulResponse: FeatureFlagEvaluateResponse = {
  results: {
    checkout: {
      flag_key: "checkout",
      value: true,
      variant_key: "on",
      reason: "matched_rule",
      rule_id: "rule-1",
      config_version: "v1",
      experiment_id: null,
      experiment_run_id: null,
      exposure_token: null,
    },
  },
};

function FlagValue(props: { controller: FeatureFlagController<string> }) {
  const details = useFeatureFlagDetailsFromController(
    props.controller,
    { cacheKey: "user-1", value: "session-1" },
    "checkout",
    false,
    { exposure: "none" },
  );
  return <div data-testid="value">{String(details.value)}</div>;
}

class TestErrorBoundary extends React.Component<React.PropsWithChildren, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error == null ? this.props.children : <div data-testid="error">{this.state.error.message}</div>;
  }
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("useFeatureFlagDetailsFromController", () => {
  it("suspends while evaluation is pending and renders the result", async () => {
    let resolveEvaluation: ((response: FeatureFlagEvaluateResponse) => void) | undefined;
    const evaluation = new Promise<FeatureFlagEvaluateResponse>((resolve) => {
      resolveEvaluation = resolve;
    });
    const controller = new FeatureFlagController<string>({
      evaluate: async () => await evaluation,
      sendExposures: async () => {},
    });

    await act(async () => {
      root?.render(<React.Suspense fallback={<div data-testid="loading">loading</div>}><FlagValue controller={controller} /></React.Suspense>);
    });
    expect(container?.querySelector("[data-testid=loading]")?.textContent).toBe("loading");

    await act(async () => {
      if (resolveEvaluation == null) throw new Error("Evaluation resolver was not initialized.");
      resolveEvaluation(successfulResponse);
      await evaluation;
    });
    expect(container?.querySelector("[data-testid=value]")?.textContent).toBe("true");
  });

  it("surfaces evaluation failures to the nearest error boundary", async () => {
    const controller = new FeatureFlagController<string>({
      evaluate: async () => {
        throw new Error("evaluation unavailable");
      },
      sendExposures: async () => {},
    });

    await act(async () => {
      root?.render(
        <TestErrorBoundary>
          <React.Suspense fallback={<div>loading</div>}><FlagValue controller={controller} /></React.Suspense>
        </TestErrorBoundary>,
      );
      await Promise.resolve();
    });
    expect(container?.querySelector("[data-testid=error]")?.textContent).toBe("evaluation unavailable");
  });
});

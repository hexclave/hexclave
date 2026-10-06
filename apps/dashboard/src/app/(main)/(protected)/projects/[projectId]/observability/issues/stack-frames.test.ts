import { describe, expect, it } from "vitest";
import {
  collapsedFramesLabel,
  frameFunctionLabel,
  frameLocationLabel,
  groupStackFrames,
  orderStackFrames,
  type StackFrameView,
} from "./stack-frames";

function frame(overrides: Partial<StackFrameView> = {}): StackFrameView {
  return {
    filename: null,
    function: null,
    module: null,
    abs_path: null,
    lineno: null,
    colno: null,
    in_app: false,
    ...overrides,
  };
}

const app = (name: string) => frame({ in_app: true, module: `app/${name}.ts`, function: name });
const lib = (name: string) => frame({
  in_app: false,
  filename: `${name}.js`,
  abs_path: `/repo/node_modules/${name}/index.js`,
  function: name,
});

describe("orderStackFrames", () => {
  it("reverses the parser's oldest-first order for display", () => {
    const frames = [app("outer"), app("inner")];
    expect(orderStackFrames(frames, "innermost-first").map((f) => f.function)).toEqual(["inner", "outer"]);
    expect(orderStackFrames(frames, "outermost-first").map((f) => f.function)).toEqual(["outer", "inner"]);
  });

  it("does not mutate the input", () => {
    const frames = [app("a"), app("b")];
    orderStackFrames(frames, "innermost-first");
    expect(frames.map((f) => f.function)).toEqual(["a", "b"]);
  });
});

describe("groupStackFrames", () => {
  it("collapses a run of consecutive library frames", () => {
    const groups = groupStackFrames([app("submit"), lib("react"), lib("scheduler"), app("render")]);
    expect(groups.map((g) => g.kind)).toEqual(["frame", "collapsed", "frame"]);
    const collapsed = groups[1];
    if (collapsed.kind !== "collapsed") throw new Error("expected a collapsed group");
    expect(collapsed.frames).toHaveLength(2);
    expect(collapsed.startIndex).toBe(1);
    expect(collapsed.defaultExpanded).toBe(false);
  });

  it("does NOT collapse a run of length one", () => {
    const groups = groupStackFrames([app("submit"), lib("react"), app("render")]);
    expect(groups.map((g) => g.kind)).toEqual(["frame", "frame", "frame"]);
  });

  it("auto-expands when EVERY frame is library code, so the card is never empty", () => {
    const groups = groupStackFrames([lib("react"), lib("scheduler"), lib("next")]);
    expect(groups).toHaveLength(1);
    const only = groups[0];
    if (only.kind !== "collapsed") throw new Error("expected a collapsed group");
    expect(only.defaultExpanded).toBe(true);
    expect(only.frames).toHaveLength(3);
  });

  it("handles an empty stack", () => {
    expect(groupStackFrames([])).toEqual([]);
  });

  it("keeps every frame exactly once across all groups", () => {
    const frames = [app("a"), lib("x"), lib("y"), app("b"), lib("z"), lib("w"), lib("v")];
    const groups = groupStackFrames(frames);
    const flattened = groups.flatMap((group) => (group.kind === "frame" ? [group.frame] : [...group.frames]));
    expect(flattened).toEqual(frames);
  });
});

describe("collapsedFramesLabel", () => {
  it("names the shared origin when every frame agrees on one", () => {
    expect(collapsedFramesLabel([lib("react"), lib("scheduler")])).toBe("2 frames from node_modules");
  });

  it("falls back to a generic label for a mixed run", () => {
    const mixed = [
      lib("react"),
      frame({ abs_path: "https://cdn.test/a.js", filename: "a.js" }),
    ];
    expect(collapsedFramesLabel(mixed)).toBe("2 library frames");
  });
});

describe("frame labels", () => {
  it("never renders an empty function or location", () => {
    expect(frameFunctionLabel(frame())).toBe("<anonymous>");
    expect(frameLocationLabel(frame())).toBe("unknown location");
  });

  it("appends line and column when present", () => {
    expect(frameLocationLabel(frame({ module: "app/x.ts", lineno: 42 }))).toBe("app/x.ts:42");
    expect(frameLocationLabel(frame({ module: "app/x.ts", lineno: 42, colno: 11 }))).toBe("app/x.ts:42:11");
  });

  it("prefers module over filename, matching the grouping algorithm", () => {
    expect(frameLocationLabel(frame({ module: "app/x", filename: "x.js" }))).toBe("app/x");
  });
});

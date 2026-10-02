import type { IssueFrame } from "./issues-data";

export type StackFrameView = Pick<IssueFrame, "filename" | "function" | "module" | "abs_path" | "lineno" | "colno" | "in_app" | "debug_id"> & {
  context?: { line: string, pre: string[], post: string[], symbolicated: true } | null,
  symbolication?: { status: "symbolicated" | "unsymbolicated" | "not_attempted" } | null,
};


export type StackFrameOrder = "innermost-first" | "outermost-first";

export const DEFAULT_STACK_FRAME_ORDER: StackFrameOrder = "innermost-first";

export function orderStackFrames<Frame extends StackFrameView>(
  frames: readonly Frame[],
  order: StackFrameOrder,
): Frame[] {
  return order === "innermost-first" ? [...frames].reverse() : [...frames];
}

export type StackFrameGroup<Frame extends StackFrameView = StackFrameView> =
  | { kind: "frame", frame: Frame, index: number }
  | {
    kind: "collapsed",
    frames: readonly Frame[],
    startIndex: number,
    defaultExpanded: boolean,
  };

const MIN_COLLAPSIBLE_RUN = 2;

export function groupStackFrames<Frame extends StackFrameView>(frames: readonly Frame[]): StackFrameGroup<Frame>[] {
  const everyFrameIsLibrary = frames.length > 0 && frames.every((frame) => !frame.in_app);
  const groups: StackFrameGroup<Frame>[] = [];
  let index = 0;
  while (index < frames.length) {
    const frame = frames[index] ?? throwMissingFrame(index);
    if (frame.in_app) {
      groups.push({ kind: "frame", frame, index });
      index += 1;
      continue;
    }
    let runEnd = index;
    while (runEnd < frames.length && (frames[runEnd] ?? throwMissingFrame(runEnd)).in_app === false) {
      runEnd += 1;
    }
    const run = frames.slice(index, runEnd);
    if (run.length < MIN_COLLAPSIBLE_RUN) {
      groups.push({ kind: "frame", frame, index });
    } else {
      groups.push({
        kind: "collapsed",
        frames: run,
        startIndex: index,
        defaultExpanded: everyFrameIsLibrary,
      });
    }
    index = runEnd;
  }
  return groups;
}

function throwMissingFrame(index: number): never {
  throw new Error(`Stack frame ${index} is missing, which a bounded loop cannot produce`);
}

export function collapsedFramesLabel(frames: readonly StackFrameView[]): string {
  const count = frames.length;
  const origins = new Set(frames.map(frameOrigin).filter((origin): origin is string => origin != null));
  const noun = count === 1 ? "frame" : "frames";
  if (origins.size === 1) {
    const [origin] = [...origins];
    return `${count} ${noun} from ${origin}`;
  }
  return `${count} library ${noun}`;
}

function frameOrigin(frame: StackFrameView): string | null {
  const path = frame.abs_path ?? frame.filename;
  if (path == null || path === "") return null;
  if (path.includes("node_modules")) return "node_modules";
  if (path.startsWith("node:") || path.startsWith("internal/")) return "node internals";
  const originMatch = /^[a-z]+:\/\/([^/]+)/i.exec(path);
  return originMatch?.[1] ?? null;
}

export function frameFunctionLabel(frame: StackFrameView): string {
  const fn = frame.function?.trim();
  if (fn != null && fn !== "") return fn;
  return "<anonymous>";
}

export function frameLocationLabel(frame: StackFrameView): string {
  const path = frame.module ?? frame.filename ?? frame.abs_path;
  if (path == null || path === "") return "unknown location";
  if (frame.lineno == null) return path;
  return frame.colno == null ? `${path}:${frame.lineno}` : `${path}:${frame.lineno}:${frame.colno}`;
}

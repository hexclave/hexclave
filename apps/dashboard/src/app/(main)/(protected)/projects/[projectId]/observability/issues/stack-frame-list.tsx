"use client";

import { DesignAlert, DesignBadge, DesignDialog } from "@/components/design-components";
import { cn } from "@/lib/utils";
import { CaretRightIcon, CodeIcon } from "@phosphor-icons/react";
import { useState, type KeyboardEvent } from "react";
import {
  collapsedFramesLabel,
  frameFunctionLabel,
  frameLocationLabel,
  groupStackFrames,
  orderStackFrames,
  type StackFrameOrder,
  type StackFrameView,
} from "./stack-frames";


function FrameSourceContext({
  context,
  lineno,
}: {
  context: NonNullable<StackFrameView["context"]>,
  lineno: number | null,
}) {
  const firstLine = lineno == null ? null : lineno - context.pre.length;
  const rows: { key: string, text: string, current: boolean, line: number | null }[] = [
    ...context.pre.map((text, index) => ({
      key: `pre-${index}`,
      text,
      current: false,
      line: firstLine == null ? null : firstLine + index,
    })),
    {
      key: "current",
      text: context.line,
      current: true,
      line: lineno,
    },
    ...context.post.map((text, index) => ({
      key: `post-${index}`,
      text,
      current: false,
      line: firstLine == null || lineno == null ? null : lineno + 1 + index,
    })),
  ];
  return (
    <div className="mt-1.5 overflow-x-auto rounded-lg bg-foreground/[0.03] ring-1 ring-foreground/[0.06]">
      <pre className="min-w-full py-1.5 font-mono text-[11px] leading-[1.6]">
        {rows.map((row) => (
          <span
            key={row.key}
            className={row.current ? "flex bg-red-500/10 px-3 text-foreground" : "flex px-3 text-muted-foreground/70"}
          >
            {row.line != null && (
              <span className="mr-3 w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/40">
                {row.line}
              </span>
            )}
            <span className="min-w-0 whitespace-pre">{row.text}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

function StackFrameRow({ frame, onSelect }: { frame: StackFrameView, onSelect: (frame: StackFrameView) => void }) {
  const handleKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(frame);
  };

  return (
    <li
      role="button"
      tabIndex={0}
      aria-label={`View stack frame ${frameFunctionLabel(frame)}`}
      onClick={() => onSelect(frame)}
      onKeyDown={handleKeyDown}
      className="cursor-pointer px-3 py-2 transition-colors duration-150 hover:transition-none hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-xs font-medium text-foreground">{frameFunctionLabel(frame)}</span>
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground" title={frameLocationLabel(frame)}>
          {frameLocationLabel(frame)}
        </span>
        {frame.in_app && <DesignBadge label="App" color="blue" size="sm" />}
        {frame.symbolication?.status === "symbolicated" && (
          <DesignBadge label="Mapped" color="green" size="sm" />
        )}
      </div>
      {frame.context != null && <FrameSourceContext context={frame.context} lineno={frame.lineno} />}
    </li>
  );
}

function CollapsedFrameGroup({
  frames,
  defaultExpanded,
  onSelect,
}: {
  frames: readonly StackFrameView[],
  defaultExpanded: boolean,
  onSelect: (frame: StackFrameView) => void,
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] text-muted-foreground transition-colors duration-150 hover:transition-none hover:bg-foreground/[0.03] hover:text-foreground"
      >
        <CaretRightIcon className={cn("h-3 w-3 shrink-0", expanded && "rotate-90")} />
        {collapsedFramesLabel(frames)}
      </button>
      {expanded && (
        <ul className="divide-y divide-foreground/[0.05] border-t border-foreground/[0.05] bg-foreground/[0.015]">
          {frames.map((frame, index) => (
            <StackFrameRow key={`${frameLocationLabel(frame)}-${index}`} frame={frame} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function throwMissingCollapsedFrame(): never {
  throw new Error("A collapsed frame group can never be empty — groupStackFrames only emits runs of two or more frames");
}

function stackContentKey(frames: readonly StackFrameView[], rawStack: string | null): string {
  return JSON.stringify([
    rawStack,
    frames.map((frame) => [
      frame.filename,
      frame.function,
      frame.module,
      frame.abs_path,
      frame.lineno,
      frame.colno,
      frame.in_app,
      frame.debug_id,
      frame.context?.line,
      frame.context?.pre,
      frame.context?.post,
      frame.symbolication?.status,
    ]),
  ]);
}

export function StackFrameList({
  frames,
  rawStack,
  order,
}: {
  frames: readonly StackFrameView[],
  rawStack: string | null,
  order: StackFrameOrder,
}) {
  const currentStackKey = stackContentKey(frames, rawStack);
  const [selection, setSelection] = useState<{ frame: StackFrameView, stackKey: string } | null>(null);
  const selectedFrame = selection?.stackKey === currentStackKey ? selection.frame : null;
  const selectFrame = (frame: StackFrameView) => setSelection({ frame, stackKey: currentStackKey });

  if (frames.length === 0) {
    if (rawStack == null || rawStack.trim() === "") {
      return (
        <DesignAlert
          variant="info"
          title="No stack trace"
          description="This error arrived without a stack — typically a non-Error value thrown somewhere the runtime could not attach one."
        />
      );
    }
    return (
      <div className="space-y-3">
        <DesignAlert
          variant="info"
          title="Unparsed stack trace"
          description="This stack didn't match any known runtime format, so it is shown exactly as it arrived."
        />
        <pre className="overflow-x-auto rounded-xl bg-foreground/[0.03] p-3 font-mono text-[11px] leading-relaxed ring-1 ring-foreground/[0.06]">
          {rawStack}
        </pre>
      </div>
    );
  }

  const groups = groupStackFrames(orderStackFrames(frames, order));

  return (
    <>
      <ul className="divide-y divide-foreground/[0.06] overflow-hidden rounded-xl ring-1 ring-foreground/[0.08]">
        {groups.map((group) => (
          group.kind === "frame"
            ? <StackFrameRow key={`frame-${group.index}`} frame={group.frame} onSelect={selectFrame} />
            : (
              <CollapsedFrameGroup
                key={`collapsed-${group.startIndex}-${group.frames.length}-${group.defaultExpanded ? "expanded" : "collapsed"}-${frameLocationLabel(group.frames[0] ?? throwMissingCollapsedFrame())}-${frameLocationLabel(group.frames[group.frames.length - 1] ?? throwMissingCollapsedFrame())}`}
                frames={group.frames}
                defaultExpanded={group.defaultExpanded}
                onSelect={selectFrame}
              />
            )
        ))}
      </ul>

      <DesignDialog
        open={selectedFrame != null}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
        size="xl"
        icon={CodeIcon}
        title={selectedFrame == null ? "Stack frame" : frameFunctionLabel(selectedFrame)}
        description={selectedFrame == null ? undefined : frameLocationLabel(selectedFrame)}
      >
        {selectedFrame != null && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              {selectedFrame.in_app && <DesignBadge label="App" color="blue" size="sm" />}
              {selectedFrame.symbolication?.status === "symbolicated" && <DesignBadge label="Mapped" color="green" size="sm" />}
              {selectedFrame.symbolication?.status === "unsymbolicated" && <DesignBadge label="Unmapped" color="zinc" size="sm" />}
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Function</dt>
                <dd className="mt-1 break-words font-mono text-xs text-foreground">{frameFunctionLabel(selectedFrame)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Location</dt>
                <dd className="mt-1 break-words font-mono text-xs text-foreground">{frameLocationLabel(selectedFrame)}</dd>
              </div>
              {selectedFrame.debug_id != null && (
                <div className="min-w-0 sm:col-span-2">
                  <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Debug ID</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-foreground">{selectedFrame.debug_id}</dd>
                </div>
              )}
            </dl>
            {selectedFrame.context != null && (
              <div>
                <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Source context</div>
                <FrameSourceContext context={selectedFrame.context} lineno={selectedFrame.lineno} />
              </div>
            )}
          </div>
        )}
      </DesignDialog>
    </>
  );
}

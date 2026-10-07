"use client";

import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Typography,
} from "@/components/ui";
import { useFromNow } from "@/hooks/use-from-now";
import { formatDurationMs } from "@/lib/session-replay-format";
import type { AdminSessionReplayRender } from "@hexclave/next";
import { DownloadSimpleIcon, FilmStripIcon } from "@phosphor-icons/react";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { useCallback, useEffect, useState } from "react";
import { useServerApp } from "../use-admin-app";

const POLL_INTERVAL_MS = 2000;

export type RenderableTab = {
  sessionReplaySegmentId: string,
  label: string,
};

function isActive(render: AdminSessionReplayRender) {
  return render.status === "queued" || render.status === "rendering";
}

function progressPercent(render: AdminSessionReplayRender) {
  return Math.round((render.progress ?? 0) * 100);
}

/**
 * Toolbar button + dialog for rendering the selected replay to an MP4. The
 * button doubles as the status indicator while a render is running, so the
 * dialog can be closed without losing track of it.
 */
export function RenderVideoButton({
  sessionReplayId,
  tabs,
  activeSegmentId,
}: {
  sessionReplayId: string,
  tabs: RenderableTab[],
  activeSegmentId: string | null,
}) {
  const serverApp = useServerApp();
  const [open, setOpen] = useState(false);
  const [renders, setRenders] = useState<AdminSessionReplayRender[] | null>(null);

  const refresh = useCallback(async () => {
    const items = await serverApp.listSessionReplayRenders(sessionReplayId);
    setRenders(items);
  }, [serverApp, sessionReplayId]);

  useEffect(() => {
    setRenders(null);
    runAsynchronously(refresh, { noErrorLogging: true });
  }, [refresh]);

  // Polling the list is what moves in-flight renders along, so keep polling
  // while any is active, whether or not the dialog is open.
  const anyActive = renders?.some(isActive) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    const interval = setInterval(() => runAsynchronously(refresh, { noErrorLogging: true }), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [anyActive, refresh]);

  const activeRender = renders?.find(isActive) ?? null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => setOpen(true)}
        aria-label="Render replay to video"
        title="Render replay to video"
      >
        {activeRender ? (
          <>
            <Spinner size={12} />
            <span className="tabular-nums">
              {activeRender.status === "queued" ? "Queued" : `Rendering ${progressPercent(activeRender)}%`}
            </span>
          </>
        ) : (
          <>
            <FilmStripIcon className="h-4 w-4" />
            <span>Video</span>
          </>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Render replay to video</DialogTitle>
            <DialogDescription>
              Renders one tab of this replay to an MP4 in the background. You can close this dialog while it renders.
            </DialogDescription>
          </DialogHeader>
          <RenderForm
            sessionReplayId={sessionReplayId}
            tabs={tabs}
            activeSegmentId={activeSegmentId}
            disabled={activeRender != null}
            onStarted={(render) => setRenders((prev) => [render, ...(prev ?? [])])}
          />
          <div className="space-y-2 pt-2">
            <Typography className="text-sm font-medium">Renders</Typography>
            {renders == null ? (
              <Typography className="text-xs text-muted-foreground">Loading…</Typography>
            ) : renders.length === 0 ? (
              <Typography className="text-xs text-muted-foreground">No renders of this replay yet.</Typography>
            ) : (
              <div className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
                {renders.map((render, i) => (
                  <RenderRow key={render.id} render={render} tabs={tabs} showPreview={i === 0} />
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RenderForm({
  sessionReplayId,
  tabs,
  activeSegmentId,
  disabled,
  onStarted,
}: {
  sessionReplayId: string,
  tabs: RenderableTab[],
  activeSegmentId: string | null,
  disabled: boolean,
  onStarted: (render: AdminSessionReplayRender) => void,
}) {
  const serverApp = useServerApp();
  // Defaults to the tab being watched when the dialog opened (the dialog's
  // content remounts on every open); playback continues behind the dialog, so
  // following activeSegmentId afterwards would change the user's choice.
  const [segmentId, setSegmentId] = useState<string | null>(activeSegmentId);
  const [speed, setSpeed] = useState("1");
  const [fps, setFps] = useState("15");
  const [skipInactivity, setSkipInactivity] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    try {
      const render = await serverApp.renderSessionReplay(sessionReplayId, {
        sessionReplaySegmentId: segmentId ?? undefined,
        speed: Number(speed),
        fps: Number(fps),
        skipInactivity,
      });
      onStarted(render);
    } catch (e) {
      // Limits (one tab too large, too many renders at once) are expected; show them inline.
      setError(e instanceof Error ? e.message : "Could not start the render.");
    }
  };

  return (
    <div className="space-y-4 pt-2">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Tab">
          <Select value={segmentId ?? ""} onValueChange={setSegmentId} disabled={tabs.length <= 1}>
            <SelectTrigger className="h-8 text-xs" aria-label="Tab to render">
              <SelectValue placeholder="Most active" />
            </SelectTrigger>
            <SelectContent>
              {tabs.map((tab) => (
                <SelectItem key={tab.sessionReplaySegmentId} value={tab.sessionReplaySegmentId}>{tab.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Speed">
          <Select value={speed} onValueChange={setSpeed}>
            <SelectTrigger className="h-8 text-xs" aria-label="Playback speed">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["0.5", "1", "2", "4"].map((v) => <SelectItem key={v} value={v}>{v}x</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Frame rate">
          <Select value={fps} onValueChange={setFps}>
            <SelectTrigger className="h-8 text-xs" aria-label="Frame rate">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["10", "15", "24", "30"].map((v) => <SelectItem key={v} value={v}>{v} fps</SelectItem>)}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Typography className="text-sm font-medium">Skip inactivity</Typography>
          <Typography className="text-xs text-muted-foreground">Cut idle stretches longer than two seconds.</Typography>
        </div>
        <Switch checked={skipInactivity} onCheckedChange={setSkipInactivity} aria-label="Skip inactivity" />
      </div>
      {error && <Alert variant="destructive">{error}</Alert>}
      <div className="flex justify-end">
        <Button onClick={start} disabled={disabled}>
          {disabled ? "A render is in progress" : "Start render"}
        </Button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string, children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Typography className="text-xs text-muted-foreground">{label}</Typography>
      {children}
    </div>
  );
}

function RenderRow({ render, tabs, showPreview }: { render: AdminSessionReplayRender, tabs: RenderableTab[], showPreview: boolean }) {
  const createdFromNow = useFromNow(render.createdAt);
  const tabLabel = tabs.find((t) => t.sessionReplaySegmentId === render.sessionReplaySegmentId)?.label ?? "Tab";
  const summary = `${tabLabel} · ${render.options.speed}x · ${render.options.fps} fps${render.options.skipInactivity ? " · skip idle" : ""}`;

  return (
    <div className="space-y-2 rounded-md border border-border/60 p-3" data-testid="session-replay-render">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <Typography className="truncate text-xs font-medium">{summary}</Typography>
          <Typography className="text-xs text-muted-foreground">{createdFromNow}</Typography>
        </div>
        <RenderStatusBadge render={render} />
      </div>
      {isActive(render) && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={progressPercent(render)} aria-valuemin={0} aria-valuemax={100}>
          <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${progressPercent(render)}%` }} />
        </div>
      )}
      {render.status === "failed" && render.errorMessage && (
        <Typography className="text-xs text-destructive">{render.errorMessage}</Typography>
      )}
      {render.video && (
        <>
          {showPreview && (
            <video
              src={render.video.url}
              controls
              playsInline
              className="w-full rounded border border-border/60 bg-black"
              style={{ aspectRatio: `${render.video.width} / ${render.video.height}` }}
            />
          )}
          <div className="flex items-center justify-between gap-2">
            <Typography className="text-xs text-muted-foreground tabular-nums">
              {render.video.width}×{render.video.height} · {formatDurationMs(render.video.durationMs)} · {(render.video.byteLength / 1024 / 1024).toFixed(1)} MB
            </Typography>
            <Button asChild size="sm" variant="secondary" className="h-7 gap-1.5 text-xs">
              <a href={render.video.url} download>
                <DownloadSimpleIcon className="h-3.5 w-3.5" />
                Download MP4
              </a>
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function RenderStatusBadge({ render }: { render: AdminSessionReplayRender }) {
  switch (render.status) {
    case "queued": {
      return <Badge variant="secondary">Queued</Badge>;
    }
    case "rendering": {
      return <Badge variant="info" className="tabular-nums">Rendering {progressPercent(render)}%</Badge>;
    }
    case "succeeded": {
      return <Badge variant="success">Ready</Badge>;
    }
    case "failed": {
      return <Badge variant="destructive">Failed</Badge>;
    }
  }
}

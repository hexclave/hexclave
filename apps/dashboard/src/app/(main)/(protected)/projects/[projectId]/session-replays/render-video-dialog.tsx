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
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerApp } from "../use-admin-app";

const POLL_INTERVAL_MS = 2000;
const ALL_TABS = "__all_tabs__";

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
 * dialog can be closed without losing track of it. Mount it keyed by the
 * replay id, so switching replays starts from a clean slate.
 */
export function RenderVideoButton({
  sessionReplayId,
  tabs,
}: {
  sessionReplayId: string,
  tabs: RenderableTab[],
}) {
  const serverApp = useServerApp();
  const [open, setOpen] = useState(false);
  const [renders, setRenders] = useState<AdminSessionReplayRender[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest list request may update state: listing also advances
  // renders, so responses can arrive out of order, and an older one must not
  // move progress backwards or drop a render started meanwhile.
  const latestRequestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++latestRequestRef.current;
    try {
      const items = await serverApp.listSessionReplayRenders(sessionReplayId);
      if (requestId !== latestRequestRef.current) return;
      setRenders(items);
      setLoadError(null);
    } catch (e) {
      if (requestId !== latestRequestRef.current) return;
      setLoadError(e instanceof Error ? e.message : "Could not load renders.");
    }
  }, [serverApp, sessionReplayId]);

  useEffect(() => {
    runAsynchronously(refresh);
  }, [refresh]);

  // Fresh data (and fresh, unexpired video URLs) whenever the dialog opens.
  useEffect(() => {
    if (open) runAsynchronously(refresh);
  }, [open, refresh]);

  // Polling the list is what moves in-flight renders along, so keep polling
  // while any is active, whether or not the dialog is open. Each poll waits
  // for the previous one rather than overlapping it.
  const anyActive = renders?.some(isActive) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      await refresh();
      if (!cancelled) timer = setTimeout(() => runAsynchronously(poll), POLL_INTERVAL_MS);
    };
    timer = setTimeout(() => runAsynchronously(poll), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [anyActive, refresh]);

  // Video URLs are presigned and short-lived; refresh before the shown ones expire.
  const soonestExpiry = renders?.reduce<number | null>((min, r) => r.video == null ? min : Math.min(min ?? Infinity, r.video.urlExpiresAt.getTime()), null) ?? null;
  useEffect(() => {
    if (!open || soonestExpiry == null) return;
    const timer = setTimeout(() => runAsynchronously(refresh), Math.max(0, soonestExpiry - Date.now() - 60_000));
    return () => clearTimeout(timer);
  }, [open, soonestExpiry, refresh]);

  const activeRender = renders?.find(isActive) ?? null;
  const statusText = activeRender == null ? null : activeRender.status === "queued" ? "Queued" : `Rendering ${progressPercent(activeRender)}%`;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        onClick={() => setOpen(true)}
        aria-label={statusText == null ? "Render replay to video" : `Render replay to video: ${statusText}`}
        title="Render replay to video"
      >
        {statusText != null ? (
          <>
            <Spinner size={12} />
            <span className="tabular-nums">{statusText}</span>
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
              Renders this replay to an MP4 in the background, cutting between tabs like the player. You can close this dialog while it renders.
            </DialogDescription>
          </DialogHeader>
          <RenderForm
            sessionReplayId={sessionReplayId}
            tabs={tabs}
            disabled={activeRender != null}
            onStarted={(render) => {
              setRenders((prev) => [render, ...(prev ?? []).filter((r) => r.id !== render.id)]);
              // Supersedes any list request that was already in flight without it.
              runAsynchronously(refresh);
            }}
          />
          <div className="space-y-2 pt-2">
            <Typography className="text-sm font-medium">Renders</Typography>
            {loadError != null && (
              <Alert variant="destructive" className="flex items-center justify-between gap-2">
                <span className="text-xs">Couldn&apos;t load renders: {loadError}</span>
                <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={refresh}>Retry</Button>
              </Alert>
            )}
            {renders == null ? (
              loadError == null && <Typography className="text-xs text-muted-foreground">Loading…</Typography>
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
  disabled,
  onStarted,
}: {
  sessionReplayId: string,
  tabs: RenderableTab[],
  disabled: boolean,
  onStarted: (render: AdminSessionReplayRender) => void,
}) {
  const serverApp = useServerApp();
  // All tabs by default: the video then cuts between tabs exactly like this player.
  const [segmentId, setSegmentId] = useState<string>(ALL_TABS);
  const [speed, setSpeed] = useState("1");
  const [fps, setFps] = useState("15");
  const [skipInactivity, setSkipInactivity] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The button disables itself while the request runs, but only after a
  // re-render; this also stops a fast double click from starting two renders.
  const startingRef = useRef(false);

  const start = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setError(null);
    try {
      const render = await serverApp.renderSessionReplay(sessionReplayId, {
        sessionReplaySegmentId: segmentId === ALL_TABS ? undefined : segmentId,
        speed: Number(speed),
        fps: Number(fps),
        skipInactivity,
      });
      onStarted(render);
    } catch (e) {
      // Limits (one tab too large, too many renders at once) are expected; show them inline.
      setError(e instanceof Error ? e.message : "Could not start the render.");
    } finally {
      startingRef.current = false;
    }
  };

  return (
    <div className="space-y-4 pt-2">
      <div className="grid grid-cols-3 gap-3">
        <Field label="Tab">
          <Select value={segmentId} onValueChange={setSegmentId} disabled={tabs.length <= 1}>
            <SelectTrigger className="h-8 text-xs" aria-label="Tab to render">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_TABS}>All tabs</SelectItem>
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
  const tabLabel = render.sessionReplaySegmentId == null
    ? "All tabs"
    : tabs.find((t) => t.sessionReplaySegmentId === render.sessionReplaySegmentId)?.label ?? "Tab";
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
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Render progress" aria-valuenow={progressPercent(render)} aria-valuemin={0} aria-valuemax={100}>
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

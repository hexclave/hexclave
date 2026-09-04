
"use client";

import { DashboardSandboxHost, stampEsmVersion, type DashboardRuntimeError, type WidgetSelection } from "@/components/commands/create-dashboard/dashboard-sandbox-host";
import packageJson from "../../../../../../../../package.json";
import { useRouter, useRouterConfirm } from "@/components/router";
import { StreamingCodeViewer } from "@/components/streaming-code-viewer";
import { ActionDialog, Button, Typography, useToast } from "@/components/ui";
import { Input } from "@/components/ui/input";
import {
  AssistantChat,
  createDashboardChatAdapter,
  createHistoryAdapter,
  DashboardToolUI,
  type AssistantComposerApi,
} from "@/components/vibe-coding";
import { ToolCallContent } from "@/components/vibe-coding/chat-adapters";
import { useUpdateConfig } from "@/components/config-update";
import { useDashboardUser } from "@/lib/dashboard-user";
import { cn } from "@/lib/utils";
import {
  ChatCircleIcon,
  FloppyDiskIcon,
  PencilSimpleIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { ALL_APPS } from "@hexclave/shared/dist/apps/apps-config";
import { typedEntries } from "@hexclave/shared/dist/utils/objects";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import type { AppId } from "@/lib/apps-frontend";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { getPublicEnvVar } from "@/lib/env";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PageLayout } from "../../page-layout";
import { useAdminApp, useProjectId } from "../../use-admin-app";

function useDashboardId(): string {
  const pathname = usePathname();
  const parts = pathname.split("/");
  const dashboardsIdx = parts.indexOf("dashboards");
  return parts[dashboardsIdx + 1] ?? throwErr("Dashboard ID not found in path");
}

export default function PageClient() {
  const adminApp = useAdminApp();
  const project = adminApp.useProject();
  const projectId = useProjectId();
  const currentUser = useDashboardUser();
  const backendBaseUrl = getPublicEnvVar("NEXT_PUBLIC_STACK_API_URL") ?? throwErr("NEXT_PUBLIC_STACK_API_URL is not set");
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const router = useRouter();
  const dashboardId = useDashboardId();
  const [hasEverExisted, setHasEverExisted] = useState(false);

  const enabledAppIds = useMemo(() =>
    typedEntries(config.apps.installed)
      .filter(([appId, appConfig]) => appConfig?.enabled && appId in ALL_APPS)
      .map(([appId]) => appId as AppId),
    [config.apps.installed]
  );

  const dashboard = Object.hasOwn(config.customDashboards, dashboardId)
    ? config.customDashboards[dashboardId]
    : undefined;

  useEffect(() => {
    if (dashboard) {
      setHasEverExisted(true);
    }
  }, [dashboard]);

  useEffect(() => {
    if (hasEverExisted && !dashboard) {
      router.replace(`/projects/${projectId}/dashboards`);
    }
  }, [hasEverExisted, dashboard, router, projectId]);

  if (!dashboard) {
    return null;
  }

  return (
    <DashboardDetailContent
      dashboardId={dashboardId}
      displayName={dashboard.displayName}
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stored dashboards may lack tsxSource before defaults backfill
      tsxSource={dashboard.tsxSource ?? ""}
      projectId={projectId}
      adminApp={adminApp}
      updateConfig={updateConfig}
      router={router}
      currentUser={currentUser}
      backendBaseUrl={backendBaseUrl}
      enabledAppIds={enabledAppIds}
    />
  );
}

function DashboardDetailContent({
  dashboardId,
  displayName,
  tsxSource,
  projectId,
  adminApp,
  updateConfig,
  router,
  currentUser,
  backendBaseUrl,
  enabledAppIds,
}: {
  dashboardId: string,
  displayName: string,
  tsxSource: string,
  projectId: string,
  adminApp: ReturnType<typeof useAdminApp>,
  updateConfig: ReturnType<typeof useUpdateConfig>,
  router: ReturnType<typeof useRouter>,
  currentUser: ReturnType<typeof useDashboardUser>,
  backendBaseUrl: string,
  enabledAppIds: AppId[],
}) {
  const hasSource = tsxSource.length > 0;
  const [isChatOpen, setIsChatOpen] = useState(!hasSource);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [currentTsxSource, setCurrentTsxSource] = useState(tsxSource);
  const [savedTsxSource, setSavedTsxSource] = useState(tsxSource);
  const [isGenerating, setIsGenerating] = useState(false);
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [iframeReady, setIframeReady] = useState(hasSource);
  const [codePhase, setCodePhase] = useState<"typing" | "loading" | "done">("done");
  const codePhaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnsavedChanges = currentTsxSource !== savedTsxSource;
  const { setNeedConfirm } = useRouterConfirm();
  const { toast } = useToast();

  // Handle on the assistant-ui composer, set by AssistantChat once its runtime mounts.
  // Used to prefill the composer when the sandbox dashboard throws an error.
  const composerApiRef = useRef<AssistantComposerApi | null>(null);
  const handleComposerReady = useCallback((api: AssistantComposerApi) => {
    composerApiRef.current = api;
  }, []);

  // Coalesce duplicate error reports — React re-renders a crashed component several times,
  // and uncaught-error listeners can fire twice for the same exception. We only surface the
  // first unique error per 2-second window so the composer isn't stomped on repeatedly.
  const lastErrorRef = useRef<{ signature: string, at: number } | null>(null);
  const handleDashboardRuntimeError = useCallback(
    (err: DashboardRuntimeError) => {
      const signature = `${err.message}::${(err.stack ?? "").slice(0, 200)}`;
      const now = Date.now();
      if (lastErrorRef.current && lastErrorRef.current.signature === signature && now - lastErrorRef.current.at < 2000) {
        return;
      }
      lastErrorRef.current = { signature, at: now };

      // Build a compact fix-request prompt. We keep the stack to ~1200 chars so the
      // agent gets enough context to localize the bug without drowning in frame noise.
      const stackSlice = (err.stack ?? "").trim().slice(0, 1200);
      const componentStackSlice = (err.componentStack ?? "").trim().slice(0, 400);
      const prefill = [
        "The dashboard just crashed at runtime. Please diagnose and fix it.",
        "",
        "Error:",
        err.message,
        stackSlice ? `\nStack:\n${stackSlice}` : "",
        componentStackSlice ? `\nComponent stack:${componentStackSlice}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      // Open the chat panel if it's closed so the user sees the pre-filled composer.
      // The iframe panel doesn't unmount when chat toggles, so no reload cost.
      setIsChatOpen(true);
      composerApiRef.current?.setText(prefill);

      toast({
        variant: "destructive",
        title: "Dashboard crashed",
        description: "Error added to chat — hit send to fix it.",
      });
    },
    [toast],
  );

  const handleWidgetSelected = useCallback(
    (selection: WidgetSelection) => {
      const api = composerApiRef.current;
      if (!api) return;

      setIsChatOpen(true);

      const { heading, tagName, rect, textPreview } = selection.metadata;
      const name = heading ?? `${tagName} (${rect.width}×${rect.height})`;
      const domContext = [
        `[Widget: ${name}]`,
        textPreview ? `Content: ${textPreview.slice(0, 200)}` : "",
      ].filter(Boolean).join("\n");

      const currentText = api.getText();
      api.setText(domContext + "\n" + currentText);
    },
    [],
  );

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    setNeedConfirm(true);
    return () => setNeedConfirm(false);
  }, [setNeedConfirm, hasUnsavedChanges]);

  const [isEditingName, setIsEditingName] = useState(false);
  const [editedName, setEditedName] = useState(displayName);

  const artifact = useMemo(() => ({
    prompt: displayName,
    projectId,
    runtimeCodegen: {
      title: displayName,
      description: "",
      uiRuntimeSourceCode: currentTsxSource,
    },
  }), [displayName, projectId, currentTsxSource]);

  const handleBack = useCallback(() => {
    router.push(`/projects/${projectId}/dashboards`);
  }, [router, projectId]);

  const currentHasSource = currentTsxSource.length > 0;

  const handleEditToggle = useCallback(() => {
    setIsChatOpen(prev => !prev);
  }, []);

  const handleNavigate = useCallback((path: string) => {
    router.push(`/projects/${projectId}${path}`);
  }, [router, projectId]);

  const handleCodeUpdate = useCallback((toolCall: ToolCallContent) => {
    if (typeof toolCall.args.content === "string") {
      const stamped = stampEsmVersion(toolCall.args.content, packageJson.version);
      setPendingCode(stamped);
      setCurrentTsxSource(stamped);
      if (codePhaseTimerRef.current) clearTimeout(codePhaseTimerRef.current);
      setCodePhase("typing");
      codePhaseTimerRef.current = setTimeout(() => {
        setCodePhase("loading");
        codePhaseTimerRef.current = setTimeout(() => {
          setCodePhase("done");
        }, 1000);
      }, 3000);
    }
  }, []);

  const handleRunStart = useCallback(() => {
    setIsGenerating(true);
    setPendingCode(null);
    setIframeReady(false);
    setCodePhase("typing");
    if (codePhaseTimerRef.current) clearTimeout(codePhaseTimerRef.current);
  }, []);

  const handleRunEnd = useCallback(() => {
    setIsGenerating(false);
  }, []);

  const handleIframeReady = useCallback(() => {
    setIframeReady(true);
  }, []);

  const handleSaveDashboard = useCallback(async () => {
    await updateConfig({
      adminApp,
      configUpdate: {
        [`customDashboards.${dashboardId}.tsxSource`]: currentTsxSource,
      },
      pushable: false,
    });
    setSavedTsxSource(currentTsxSource);
  }, [updateConfig, adminApp, dashboardId, currentTsxSource]);

  const handleSaveName = async () => {
    const trimmed = editedName.trim();
    if (!trimmed || trimmed === displayName) {
      setEditedName(displayName);
      setIsEditingName(false);
      return;
    }
    await updateConfig({
      adminApp,
      configUpdate: {
        [`customDashboards.${dashboardId}.displayName`]: trimmed,
      },
      pushable: false,
    });
    setIsEditingName(false);
  };

  const handleDelete = async () => {
    await updateConfig({
      adminApp,
      configUpdate: {
        [`customDashboards.${dashboardId}`]: null,
      },
      pushable: false,
    });
    router.replace(`/projects/${projectId}/dashboards`);
  };

  const isCreating = !currentHasSource;
  const overlayActive = isCreating && (isGenerating || (pendingCode !== null && codePhase !== "done"));
  const canShowDashboard = !isCreating || (codePhase === "done" && iframeReady);

  const UPDATE_STATUS_MESSAGES = [
    "Reviewing your current dashboard...",
    "Understanding your changes...",
    "Analyzing existing components...",
    "Planning the update...",
    "Building on your layout...",
    "Applying modifications...",
    "Updating data sources...",
    "Adjusting the structure...",
    "Refining components...",
    "Wiring up interactions...",
    "Polishing the details...",
    "Almost there...",
  ];

  const dashboardPreview = (
    <>
      {overlayActive && (
        <div className={cn(
          "absolute inset-0 z-10 transition-opacity duration-700",
          canShowDashboard ? "opacity-0 pointer-events-none" : "opacity-100"
        )}>
          {codePhase === "loading" ? (
            <div className="flex h-full w-full items-center justify-center rounded-lg bg-zinc-50 dark:bg-zinc-950 ring-1 ring-zinc-200 dark:ring-white/[0.06]">
              <div className="flex flex-col items-center gap-3">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" />
                  <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" style={{ animationDelay: "150ms" }} />
                  <div className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse" style={{ animationDelay: "300ms" }} />
                </div>
                <span className="text-[11px] text-zinc-400 dark:text-zinc-400">Loading dashboard...</span>
              </div>
            </div>
          ) : (
            <StreamingCodeViewer
              code={pendingCode ?? ""}
              isStreaming={isGenerating || codePhase === "typing"}
            />
          )}
        </div>
      )}

      {currentHasSource ? (
        <div className={cn(
          "h-full w-full transition-opacity duration-700",
          canShowDashboard ? "opacity-100" : "opacity-0"
        )}>
          <DashboardSandboxHost
            artifact={artifact}
            onBack={handleBack}
            onEditToggle={handleEditToggle}
            onNavigate={handleNavigate}
            onReady={handleIframeReady}
            onRuntimeError={handleDashboardRuntimeError}
            onWidgetSelected={handleWidgetSelected}
            isChatOpen={isChatOpen}
          />
        </div>
      ) : !isGenerating ? (
        <div className="flex h-full items-center justify-center">
          <div className="text-center space-y-3">
            <div className="mx-auto h-12 w-12 rounded-2xl bg-foreground/[0.04] ring-1 ring-foreground/[0.06] flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 256 256" className="text-muted-foreground/60" fill="currentColor">
                <path d="M224,48H32A16,16,0,0,0,16,64V192a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V64A16,16,0,0,0,224,48ZM32,192V64H224V192ZM48,136a8,8,0,0,1,8-8H200a8,8,0,0,1,0,16H56A8,8,0,0,1,48,136Zm0-32a8,8,0,0,1,8-8h72a8,8,0,0,1,0,16H56A8,8,0,0,1,48,104Zm0,64a8,8,0,0,1,8-8H200a8,8,0,0,1,0,16H56A8,8,0,0,1,48,168Z"/>
              </svg>
            </div>
            <Typography className="font-semibold text-foreground">No dashboard yet</Typography>
            <Typography variant="secondary" className="text-sm max-w-[240px]">
              Describe what you&apos;d like to see in the chat to generate your dashboard.
            </Typography>
          </div>
        </div>
      ) : null}
    </>
  );

  return (
    <PageLayout fillWidth noPadding>
      {/* Both panels are always in the DOM so the iframe never unmounts/reloads.
          The chat panel animates its width; the dashboard panel adjusts via flex-1. */}
      <div data-full-bleed className="flex h-[calc(100vh-4.5rem)] dark:h-[calc(100vh-5.75rem)]">
        {/* Dashboard iframe panel */}
        <div
          className={cn(
            "relative flex-1 min-w-0 flex flex-col transition-all duration-300 ease-in-out",
            "pl-6 pr-5 py-6",
            !isChatOpen && "dark:p-0",
          )}
        >
          <div className={cn(
            "relative flex-1 overflow-hidden transition-all duration-300 ease-in-out",
            "dark:bg-transparent dark:rounded-none dark:shadow-none dark:ring-0",
          )}>
            {dashboardPreview}
          </div>

          {!isChatOpen && (
            <Button
              size="icon"
              variant="outline"
              className="absolute bottom-10 right-10 z-[60] h-10 w-10 rounded-full shadow-lg"
              onClick={handleEditToggle}
            >
              <ChatCircleIcon className="h-5 w-5" />
            </Button>
          )}
        </div>

        {/* Chat panel — slides in from the right. min-w on the inner card prevents content
            squishing during the width animation (overflow-hidden clips the excess). */}
        <div className={cn(
          "shrink-0 flex flex-col overflow-hidden transition-all duration-300 ease-in-out",
          isChatOpen ? "w-[480px] pr-6 pl-2 py-6" : "w-0",
        )}>
          <div className="w-full min-w-[448px] flex-1 overflow-hidden rounded-2xl shadow-xl ring-1 ring-foreground/[0.06] dark:bg-background/40 backdrop-blur-xl bg-slate-50/90">
            <div className="flex flex-col h-full">
              <ChatPanelHeader
                displayName={displayName}
                isEditingName={isEditingName}
                editedName={editedName}
                onStartEditName={() => {
                  setEditedName(displayName);
                  setIsEditingName(true);
                }}
                onEditedNameChange={setEditedName}
                onSaveName={handleSaveName}
                onCancelEditName={() => {
                  setEditedName(displayName);
                  setIsEditingName(false);
                }}
                onDelete={() => setDeleteDialogOpen(true)}
                onClose={() => setIsChatOpen(false)}
                hasUnsavedChanges={hasUnsavedChanges}
                onSaveDashboard={handleSaveDashboard}
              />
              <div className="flex-1 min-h-0">
                <AssistantChat
                  chatAdapter={createDashboardChatAdapter(backendBaseUrl, currentTsxSource, handleCodeUpdate, currentUser, enabledAppIds, projectId, handleRunStart, handleRunEnd)}
                  historyAdapter={createHistoryAdapter(adminApp, dashboardId)}
                  toolComponents={<DashboardToolUI setCurrentCode={(code) => setCurrentTsxSource(stampEsmVersion(code, packageJson.version))} currentCode={currentTsxSource} />}
                  useOffWhiteLightMode
                  composerPlaceholder={currentHasSource ? undefined : DASHBOARD_COMPOSER_PLACEHOLDER}
                  runningStatusMessages={!isCreating ? UPDATE_STATUS_MESSAGES : undefined}
                  composerAttachments
                  onComposerReady={handleComposerReady}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <ActionDialog
        open={deleteDialogOpen}
        onClose={() => setDeleteDialogOpen(false)}
        title="Delete Dashboard"
        okButton={{
          label: "Delete",
          onClick: handleDelete,
          props: { variant: "destructive" },
        }}
        cancelButton={{ label: "Cancel" }}
      >
        <Typography variant="secondary" className="text-sm">
          Are you sure you want to delete &quot;{displayName}&quot;? This action cannot be undone.
        </Typography>
      </ActionDialog>
    </PageLayout>
  );
}

const DASHBOARD_COMPOSER_PLACEHOLDER = {
  prefix: "Create a dashboard about ",
  suffixes: [
    "user signups and retention",
    "team activity across projects",
    "API latency and error rates",
    "email open rates and clicks",
    "authentication trends",
    "revenue and subscription growth",
  ],
} as const;

function ChatPanelHeader({
  displayName,
  isEditingName,
  editedName,
  onStartEditName,
  onEditedNameChange,
  onSaveName,
  onCancelEditName,
  onDelete,
  onClose,
  hasUnsavedChanges,
  onSaveDashboard,
}: {
  displayName: string,
  isEditingName: boolean,
  editedName: string,
  onStartEditName: () => void,
  onEditedNameChange: (name: string) => void,
  onSaveName: () => Promise<void>,
  onCancelEditName: () => void,
  onDelete: () => void,
  onClose?: () => void,
  hasUnsavedChanges: boolean,
  onSaveDashboard: () => Promise<void>,
}) {
  return (
    <div className="flex flex-col shrink-0">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border/30 dark:border-foreground/[0.06]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isEditingName ? (
            <Input
              value={editedName}
              onChange={(e) => onEditedNameChange(e.target.value)}
              className="h-7 text-sm flex-1"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  runAsynchronouslyWithAlert(onSaveName);
                }
                if (e.key === "Escape") {
                  onCancelEditName();
                }
              }}
              onBlur={() => runAsynchronouslyWithAlert(onSaveName)}
            />
          ) : (
            <button
              onClick={onStartEditName}
              className="flex items-center gap-1.5 group min-w-0"
            >
              <span className={cn(
                "text-sm font-semibold text-foreground truncate",
              )}>
                {displayName}
              </span>
              <PencilSimpleIcon className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity hover:transition-none shrink-0" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {hasUnsavedChanges && (
            <Button
              size="sm"
              className="h-7 gap-1.5 text-xs min-w-[60px]"
              onClick={onSaveDashboard}
            >
              <span className="flex items-center gap-1.5">
                <FloppyDiskIcon className="h-3.5 w-3.5" />
                Save
              </span>
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-red-500 hover:text-red-600 hover:bg-red-500/10"
            onClick={onDelete}
          >
            <TrashIcon className="h-3.5 w-3.5" />
          </Button>
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              <XIcon className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

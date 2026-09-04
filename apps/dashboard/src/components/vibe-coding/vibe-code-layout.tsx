import {
  ActionDialog,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ArrowCounterClockwise, ArrowRight, Bug, CaretDown, CaretUp, ChatsCircle, Code, DeviceMobile, DeviceTablet, FloppyDisk, Laptop, PencilSimple } from "@phosphor-icons/react";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import type { EditableMetadata } from "@hexclave/shared/dist/utils/jsx-editable-transpiler";
import { useEffect, useState } from "react";

export type ViewportMode = 'desktop' | 'tablet' | 'phone' | 'edit';

export type WysiwygDebugInfo = {
  transpiledTemplateCode?: string,
  transpiledThemeCode?: string,
  renderedHtml?: string,
  editableRegions?: Record<string, EditableMetadata>,
};

type VibeCodeEditorLayoutProps = {
  previewComponent: React.ReactNode,
  editorComponent: React.ReactNode,
  chatComponent: React.ReactNode,
  onSave?: () => void | Promise<void>,
  saveLabel?: string,
  onUndo?: () => void,
  isDirty?: boolean,
  viewport?: ViewportMode,
  onViewportChange?: (viewport: ViewportMode) => void,
  previewActions?: React.ReactNode,
  editorTitle?: string,
  headerAction?: React.ReactNode,
  defaultViewport?: ViewportMode,
  primaryAction?: {
    label: string,
    onClick: () => void | Promise<void>,
    disabled?: boolean,
  },
  /** Whether edit mode is enabled (shows pencil icon in viewport switcher) */
  editModeEnabled?: boolean,
  /** Extra buttons to render in the code toggle bar (next to the debug button) */
  codeToggleBarExtra?: React.ReactNode,
  /** Debug info for WYSIWYG editing (dev mode only) */
  wysiwygDebugInfo?: WysiwygDebugInfo,
  /** Use off-white light mode chrome (page-specific opt-in) */
  useOffWhiteLightChrome?: boolean,
}

export default function VibeCodeLayout({
  previewComponent,
  editorComponent,
  chatComponent,
  onSave,
  saveLabel = "Save",
  onUndo,
  isDirty,
  viewport,
  onViewportChange,
  previewActions,
  editorTitle = "Code",
  headerAction,
  defaultViewport = 'desktop',
  primaryAction,
  editModeEnabled = false,
  codeToggleBarExtra,
  wysiwygDebugInfo,
  useOffWhiteLightChrome = false,
}: VibeCodeEditorLayoutProps) {
  // Use localStorage for isEditorOpen state - initialize with false to avoid hydration mismatch
  const [isEditorOpen, setIsEditorOpen] = useState(false);

  // Read from localStorage after hydration to avoid SSR mismatch
  useEffect(() => {
    const stored = localStorage.getItem('vibe-code-editor-open');
    if (stored === 'true') {
      setIsEditorOpen(true);
    }
  }, []);
  const [isChatOpen, setIsChatOpen] = useState(false);
  // Default to 'edit' mode when editModeEnabled is true
  const [internalViewport, setInternalViewport] = useState<ViewportMode>(
    editModeEnabled ? 'edit' : defaultViewport
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isPrimaryLoading, setIsPrimaryLoading] = useState(false);
  const [showUndoConfirm, setShowUndoConfirm] = useState(false);
  const [showDebugDialog, setShowDebugDialog] = useState(false);

  // Save isEditorOpen to localStorage when it changes
  const handleSetIsEditorOpen = (open: boolean) => {
    setIsEditorOpen(open);
    localStorage.setItem('vibe-code-editor-open', String(open));
  };

  const currentViewport = viewport ?? internalViewport;
  const isEditMode = currentViewport === 'edit';

  const handleViewportClick = (newViewport: ViewportMode) => {
    if (onViewportChange) {
      onViewportChange(newViewport);
    } else {
      setInternalViewport(newViewport);
    }
  };

  const handleSave = () => {
    if (!onSave) return;
    setIsSaving(true);
    runAsynchronouslyWithAlert(async () => {
      await onSave();
      setIsSaving(false);
    }, {
      onError: () => {
        setIsSaving(false);
      },
    });
  };

  const lightModeChromeBackgroundClass = useOffWhiteLightChrome ? "bg-white/90" : "bg-white/80";
  const activeViewportButtonClass =
    "bg-white text-foreground shadow-sm ring-1 ring-black/[0.06] dark:bg-background dark:ring-foreground/[0.06]";
  const inactiveViewportButtonClass =
    "text-muted-foreground hover:text-foreground hover:bg-zinc-100 dark:hover:bg-background/50";

  return (
    <TooltipProvider delayDuration={300}>
      {/* Mobile Layout - visible on small screens, hidden on md+ */}
      {/* h-[calc(100dvh-3.5rem)] anchors to viewport (minus sticky header) so the
          editor doesn't depend on an unbroken h-full chain through the dashboard
          shell, which collapses because <main> doesn't stretch (items-start). */}
      <div className="flex flex-col h-[calc(100dvh-3.5rem)] w-full overflow-hidden md:hidden">
        {/* Mobile Header - Compact */}
        <div className="px-3 pt-3 pb-2 shrink-0">
          <div className="flex flex-col gap-2">
            {/* Primary Actions Row */}
            <div className={cn(
              "flex items-center gap-2 px-2 py-2 rounded-lg dark:bg-background/40 backdrop-blur-xl shadow-sm ring-1 ring-foreground/[0.06]",
              lightModeChromeBackgroundClass,
            )}>
              {/* Viewport Switcher - Compact */}
              <div className="flex items-center gap-0.5 rounded-md bg-foreground/[0.04] p-0.5">
                {/* Edit Mode - leftmost when enabled */}
                {editModeEnabled && (
                  <>
                    <button
                      onClick={() => handleViewportClick('edit')}
                      className={cn(
                        "p-1 rounded transition-all duration-150 hover:transition-none",
                        currentViewport === 'edit'
                          ? activeViewportButtonClass
                          : inactiveViewportButtonClass
                      )}
                      aria-label="Edit mode"
                    >
                      <PencilSimple size={14} weight={currentViewport === 'edit' ? 'fill' : 'regular'} />
                    </button>
                    <div className="w-px h-3 bg-foreground/10 mx-0.5" />
                  </>
                )}
                <button
                  onClick={() => handleViewportClick('desktop')}
                  className={cn(
                    "p-1 rounded transition-all duration-150 hover:transition-none",
                    currentViewport === 'desktop'
                      ? activeViewportButtonClass
                      : inactiveViewportButtonClass
                  )}
                  aria-label="Desktop view"
                >
                  <Laptop size={14} weight={currentViewport === 'desktop' ? 'fill' : 'regular'} />
                </button>
                <button
                  onClick={() => handleViewportClick('tablet')}
                  className={cn(
                    "p-1 rounded transition-all duration-150 hover:transition-none",
                    currentViewport === 'tablet'
                      ? activeViewportButtonClass
                      : inactiveViewportButtonClass
                  )}
                  aria-label="Tablet view"
                >
                  <DeviceTablet size={14} weight={currentViewport === 'tablet' ? 'fill' : 'regular'} />
                </button>
                <button
                  onClick={() => handleViewportClick('phone')}
                  className={cn(
                    "p-1 rounded transition-all duration-150 hover:transition-none",
                    currentViewport === 'phone'
                      ? activeViewportButtonClass
                      : inactiveViewportButtonClass
                  )}
                  aria-label="Phone view"
                >
                  <DeviceMobile size={14} weight={currentViewport === 'phone' ? 'fill' : 'regular'} />
                </button>
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Right Actions - Compact */}
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    handleSetIsEditorOpen(!isEditorOpen);
                    if (!isEditorOpen) setIsChatOpen(false);
                  }}
                  className={cn(
                    "h-7 gap-1 px-2 rounded-md transition-all duration-150 hover:transition-none",
                    isEditorOpen
                      ? "bg-foreground/[0.06] text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <Code size={14} weight={isEditorOpen ? 'fill' : 'regular'} />
                  <span className="text-[10px] font-medium">Code</span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setIsChatOpen(!isChatOpen);
                    if (!isChatOpen) handleSetIsEditorOpen(false);
                  }}
                  className={cn(
                    "h-7 gap-1 px-2 rounded-md transition-all duration-150 hover:transition-none",
                    isChatOpen
                      ? "bg-foreground/[0.06] text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  <ChatsCircle size={14} weight={isChatOpen ? 'fill' : 'regular'} />
                  <span className="text-[10px] font-medium">Chat</span>
                </Button>
                {onUndo && isDirty && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowUndoConfirm(true)}
                    className="h-7 gap-1 px-2 rounded-md text-muted-foreground"
                  >
                    <ArrowCounterClockwise size={14} />
                  </Button>
                )}
                {onSave && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleSave}
                    disabled={isSaving}
                    className="h-7 gap-1 px-2 rounded-md"
                  >
                    {isSaving ? (
                      <>
                        <Spinner size={14} />
                        <span className="text-[10px] font-medium">Saving...</span>
                      </>
                    ) : (
                      <>
                        <FloppyDisk size={14} />
                        <span className="text-[10px] font-medium">{saveLabel}</span>
                      </>
                    )}
                  </Button>
                )}
                {primaryAction && (
                  <Button
                    size="sm"
                    onClick={() => {
                      setIsPrimaryLoading(true);
                      runAsynchronouslyWithAlert(async () => {
                        await primaryAction.onClick();
                        setIsPrimaryLoading(false);
                      }, {
                        onError: () => setIsPrimaryLoading(false),
                      });
                    }}
                    disabled={primaryAction.disabled || isPrimaryLoading}
                    className="h-7 gap-1 px-2 rounded-md"
                  >
                    {isPrimaryLoading ? (
                      <Spinner size={14} />
                    ) : (
                      <>
                        <span className="text-[10px] font-medium">{primaryAction.label}</span>
                        <ArrowRight size={14} />
                      </>
                    )}
                  </Button>
                )}
              </div>
            </div>

            {/* Header Action Row (Theme selector, etc) */}
            {headerAction && (
              <div className={cn(
                "px-2 py-1.5 rounded-lg dark:bg-background/40 backdrop-blur-xl shadow-sm ring-1 ring-foreground/[0.06]",
                lightModeChromeBackgroundClass,
              )}>
                <div className="scale-90 origin-left">
                  {headerAction}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Mobile Content Area - Stacked */}
        <div className="flex-1 overflow-hidden flex flex-col px-3 pb-3 gap-2">
          {/* Preview Panel - Always visible when neither editor nor chat is open */}
          {!isEditorOpen && !isChatOpen && (
            <div className={cn(
              "flex-1 overflow-hidden rounded-xl shadow-lg ring-1 ring-foreground/[0.06] dark:bg-background/40 backdrop-blur-xl",
              lightModeChromeBackgroundClass,
            )}>
              <div className="h-full bg-gradient-to-br from-muted/30 via-muted/20 to-muted/30 dark:from-foreground/[0.02] dark:via-foreground/[0.01] dark:to-foreground/[0.02]">
                <div className="h-full overflow-auto flex justify-center items-start p-2">
                  <div className="w-full h-full">
                    {previewComponent}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Code Editor - Shown when toggled */}
          {isEditorOpen && (
            <div className={cn(
              "flex-1 overflow-hidden rounded-xl shadow-lg ring-1 ring-foreground/[0.06] dark:bg-background/40 backdrop-blur-xl",
              lightModeChromeBackgroundClass,
            )}>
              <div className="h-full overflow-hidden">
                {editorComponent}
              </div>
            </div>
          )}

          {/* Chat Panel - Shown when toggled */}
          {isChatOpen && (
            <div className={cn(
              "flex-1 overflow-hidden rounded-xl shadow-lg ring-1 ring-foreground/[0.06] dark:bg-background/40 backdrop-blur-xl",
              lightModeChromeBackgroundClass,
            )}>
              {chatComponent}
            </div>
          )}
        </div>
      </div>

      {/* Desktop/Tablet Layout - hidden on small screens, visible on md+ */}
      {/* See note on the mobile wrapper above; the dark-mode header is taller
          (floating card with mt-3/mb-3 padding), matching sidebar-layout.tsx. */}
      <div className="hidden md:flex flex-col h-[calc(100vh-3.5rem)] dark:h-[calc(100vh-6rem)] w-full overflow-hidden">
        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Top Header / Toolbar - with consistent inset spacing */}
          <div className="px-6 pt-4 pb-3">
            <div className={cn(
              "flex items-center gap-3 px-4 py-2.5 rounded-xl dark:bg-background/40 backdrop-blur-xl shadow-sm ring-1 ring-foreground/[0.06]",
              lightModeChromeBackgroundClass,
            )}>
              {/* Viewport Switcher */}
              <div className="flex items-center gap-1 rounded-lg bg-foreground/[0.04] p-1">
                {/* Edit Mode - leftmost when enabled */}
                {editModeEnabled && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={() => handleViewportClick('edit')}
                          className={cn(
                            "p-1.5 rounded-md transition-all duration-150 hover:transition-none",
                            currentViewport === 'edit'
                              ? activeViewportButtonClass
                              : inactiveViewportButtonClass
                          )}
                        >
                          <PencilSimple size={16} weight={currentViewport === 'edit' ? 'fill' : 'regular'} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">Edit Mode</TooltipContent>
                    </Tooltip>
                    <div className="w-px h-4 bg-foreground/10 mx-0.5" />
                  </>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleViewportClick('desktop')}
                      className={cn(
                        "p-1.5 rounded-md transition-all duration-150 hover:transition-none",
                        currentViewport === 'desktop'
                          ? activeViewportButtonClass
                          : inactiveViewportButtonClass
                      )}
                    >
                      <Laptop size={16} weight={currentViewport === 'desktop' ? 'fill' : 'regular'} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Desktop</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleViewportClick('tablet')}
                      className={cn(
                        "p-1.5 rounded-md transition-all duration-150 hover:transition-none",
                        currentViewport === 'tablet'
                          ? activeViewportButtonClass
                          : inactiveViewportButtonClass
                      )}
                    >
                      <DeviceTablet size={16} weight={currentViewport === 'tablet' ? 'fill' : 'regular'} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Tablet</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleViewportClick('phone')}
                      className={cn(
                        "p-1.5 rounded-md transition-all duration-150 hover:transition-none",
                        currentViewport === 'phone'
                          ? activeViewportButtonClass
                          : inactiveViewportButtonClass
                      )}
                    >
                      <DeviceMobile size={16} weight={currentViewport === 'phone' ? 'fill' : 'regular'} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">Mobile</TooltipContent>
                </Tooltip>
              </div>

              {/* Theme Selector / Header Action */}
              {headerAction}

              {/* Spacer */}
              <div className="flex-1" />

              {/* Right Actions */}
              <div className="flex items-center gap-2">
                {previewActions}
                {onUndo && isDirty && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShowUndoConfirm(true)}
                        className="h-8 gap-1.5 px-3 rounded-lg text-muted-foreground hover:text-foreground"
                      >
                        <ArrowCounterClockwise size={16} />
                        <span className="text-xs font-medium">Discard changes</span>
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">Discard all unsaved changes</TooltipContent>
                  </Tooltip>
                )}
                {onSave && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleSave}
                    disabled={isSaving}
                    className="h-8 gap-1.5 px-3 rounded-lg"
                  >
                    {isSaving ? (
                      <>
                        <Spinner size={16} />
                        <span className="text-xs font-medium">Saving...</span>
                      </>
                    ) : (
                      <>
                        <FloppyDisk size={16} />
                        <span className="text-xs font-medium">{saveLabel}</span>
                      </>
                    )}
                  </Button>
                )}
                {primaryAction && (
                  <>
                    <div className="w-px h-5 bg-border/50 mx-1" />
                    <Button
                      size="sm"
                      onClick={() => {
                        setIsPrimaryLoading(true);
                        runAsynchronouslyWithAlert(async () => {
                          await primaryAction.onClick();
                          setIsPrimaryLoading(false);
                        }, {
                          onError: () => setIsPrimaryLoading(false),
                        });
                      }}
                      disabled={primaryAction.disabled || isPrimaryLoading}
                      className="h-8 gap-1.5 px-3 rounded-lg"
                    >
                      {isPrimaryLoading ? (
                        <>
                          <Spinner size={16} />
                          <span className="text-xs font-medium">{primaryAction.label}</span>
                        </>
                      ) : (
                        <>
                          <span className="text-xs font-medium">{primaryAction.label}</span>
                          <ArrowRight size={16} />
                        </>
                      )}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Undo Confirmation Dialog */}
          <ActionDialog
            open={showUndoConfirm}
            onOpenChange={setShowUndoConfirm}
            title="Discard changes?"
            description="Do you really want to discard all the changes you made since saving? This action cannot be undone."
            danger
            okButton={{
              label: "Discard changes",
              onClick: async () => {
                onUndo?.();
              },
            }}
            cancelButton
          />

          {/* WYSIWYG Debug Dialog */}
          {wysiwygDebugInfo && (
            <Dialog open={showDebugDialog} onOpenChange={setShowDebugDialog}>
              <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
                <DialogHeader>
                  <DialogTitle>WYSIWYG Debug Info</DialogTitle>
                </DialogHeader>
                <div className="flex-1 overflow-auto space-y-4">
                  {/* Editable Regions */}
                  <div>
                    <h3 className="font-semibold text-sm mb-2">Editable Regions ({Object.keys(wysiwygDebugInfo.editableRegions ?? {}).length})</h3>
                    <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto max-h-48">
                      {JSON.stringify(wysiwygDebugInfo.editableRegions, null, 2)}
                    </pre>
                  </div>

                  {/* Transpiled Template Code */}
                  {wysiwygDebugInfo.transpiledTemplateCode && (
                    <div>
                      <h3 className="font-semibold text-sm mb-2">Transpiled Template Code</h3>
                      <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto max-h-48 whitespace-pre-wrap">
                        {wysiwygDebugInfo.transpiledTemplateCode}
                      </pre>
                    </div>
                  )}

                  {/* Transpiled Theme Code */}
                  {wysiwygDebugInfo.transpiledThemeCode && (
                    <div>
                      <h3 className="font-semibold text-sm mb-2">Transpiled Theme Code</h3>
                      <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto max-h-48 whitespace-pre-wrap">
                        {wysiwygDebugInfo.transpiledThemeCode}
                      </pre>
                    </div>
                  )}

                  {/* Rendered HTML */}
                  {wysiwygDebugInfo.renderedHtml && (
                    <div>
                      <h3 className="font-semibold text-sm mb-2">Rendered HTML (with markers)</h3>
                      <pre className="bg-muted p-3 rounded-lg text-xs overflow-x-auto max-h-64 whitespace-pre-wrap">
                        {wysiwygDebugInfo.renderedHtml}
                      </pre>
                    </div>
                  )}
                </div>
              </DialogContent>
            </Dialog>
          )}

          {/* Main Content Area */}
          <ResizablePanelGroup direction="horizontal" className="flex-1 overflow-hidden">
            {/* Left Panel - Preview & Code */}
            <ResizablePanel defaultSize={67} minSize={33} className="relative">
              <div className="absolute inset-0 pl-6 pr-2 pb-6 flex flex-col gap-4">
                <ResizablePanelGroup
                  direction="vertical"
                  className={cn(
                    "flex-1 rounded-2xl overflow-hidden shadow-xl ring-1 ring-foreground/[0.06] dark:bg-background/40 backdrop-blur-xl",
                    lightModeChromeBackgroundClass,
                  )}
                >
                  {/* Preview Panel */}
                  <ResizablePanel defaultSize={isEditorOpen ? 50 : 100} minSize={20} className="relative">
                    <div className="absolute inset-0 bg-gradient-to-br from-muted/30 via-muted/20 to-muted/30 dark:from-foreground/[0.02] dark:via-foreground/[0.01] dark:to-foreground/[0.02]">
                      <div className="absolute inset-0 overflow-auto flex justify-center items-start p-2.5">
                        <div className={cn(
                          "w-full h-full transition-all duration-200 ease-out flex items-start justify-center",
                          currentViewport === 'phone' && "max-w-[420px]",
                          currentViewport === 'tablet' && "max-w-[860px]",
                          (currentViewport === 'desktop' || currentViewport === 'edit') && "max-w-full"
                        )}>
                          {previewComponent}
                        </div>
                      </div>
                    </div>
                  </ResizablePanel>

                  {/* Code Toggle Bar */}
                  <div className="h-10 flex items-center justify-center bg-muted/40 dark:bg-foreground/[0.03] border-y border-border/30 dark:border-foreground/[0.06] shrink-0">
                    <button
                      onClick={() => handleSetIsEditorOpen(!isEditorOpen)}
                      className="group flex-1 h-full flex items-center justify-center gap-2 hover:bg-muted/60 dark:hover:bg-foreground/[0.06] transition-colors duration-150 hover:transition-none cursor-pointer"
                    >
                      <Code size={14} className="text-muted-foreground group-hover:text-foreground transition-colors duration-150 group-hover:transition-none" />
                      <span className="text-xs font-medium text-muted-foreground group-hover:text-foreground transition-colors duration-150 group-hover:transition-none">
                        {isEditorOpen ? 'Hide Code' : 'View Code'}
                      </span>
                      {isEditorOpen ? (
                        <CaretDown size={12} className="text-muted-foreground group-hover:text-foreground transition-colors duration-150 group-hover:transition-none" />
                      ) : (
                        <CaretUp size={12} className="text-muted-foreground group-hover:text-foreground transition-colors duration-150 group-hover:transition-none" />
                      )}
                    </button>
                    {codeToggleBarExtra}
                    {/* Debug button - only in development */}
                    {process.env.NODE_ENV === 'development' && wysiwygDebugInfo && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            onClick={() => setShowDebugDialog(true)}
                            className="h-full px-3 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 dark:hover:bg-foreground/[0.06] transition-colors duration-150 hover:transition-none border-l border-border/30 dark:border-foreground/[0.06]"
                          >
                            <Bug size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">WYSIWYG Debug Info</TooltipContent>
                      </Tooltip>
                    )}
                  </div>

                  {/* Resize Handle - only shown when editor is open */}
                  {isEditorOpen && (
                    <ResizableHandle className="h-1 bg-transparent hover:bg-blue-500/30 transition-colors duration-150 hover:transition-none cursor-ns-resize" />
                  )}

                  {/* Code Editor Panel */}
                  {isEditorOpen && (
                    <ResizablePanel defaultSize={50} minSize={20} className="relative">
                      <div className="absolute inset-0 flex flex-col">
                        {/* Editor Content with integrated background */}
                        <div className="flex-1 overflow-hidden min-h-0 relative">
                          {editorComponent}
                        </div>
                      </div>
                    </ResizablePanel>
                  )}
                </ResizablePanelGroup>
              </div>
            </ResizablePanel>

            {/* Resize Handle */}
            <ResizableHandle
              className="w-px bg-border/10 dark:bg-foreground/[0.06] hover:bg-blue-500/30 hover:w-1 transition-all duration-150 hover:transition-none mb-6"
            />

            {/* Chat Panel */}
            <ResizablePanel
              defaultSize={35}
              minSize={20}
              maxSize={50}
              className="relative"
            >
              <div className="absolute inset-0 pl-2 pr-6 pb-6 flex flex-col">
                <div className={cn(
                  "flex-1 overflow-hidden rounded-2xl shadow-xl ring-1 ring-foreground/[0.06] dark:bg-background/40 backdrop-blur-xl",
                  lightModeChromeBackgroundClass,
                )}>
                  {chatComponent}
                </div>
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </div>
    </TooltipProvider>
  );
}

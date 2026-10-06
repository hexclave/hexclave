"use client";

import {
  BookmarkSimpleIcon,
  CheckIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import {
  DesignAlert,
  DesignButton,
  DesignDialog,
  DesignInput,
  DesignMenu,
} from "@/components/design-components";
import { Popover, PopoverContent, PopoverTrigger, Typography } from "@/components/ui";
import { getErrorMessage } from "../format";
import type { IssueFilters } from "./issue-filters";
import {
  createSavedIssueSearchView,
  deleteSavedIssueSearchView,
  fetchSavedIssueSearchViews,
  savedIssueSearchViewQueryIsCompatible,
  savedIssueSearchViewMutationForFilters,
  savedIssueSearchQueryToIssueFilters,
  savedIssueSearchViewVisibilityLabel,
  type SavedIssueSearchView,
} from "./issue-saved-views-data";
import { updateSavedIssueSearchView } from "./issue-saved-views-data";

type IssueSavedViewsProps = {
  adminApp: object,
  filters: IssueFilters,
  onApply: (filters: IssueFilters) => void,
};

type EditorState = {
  mode: "create" | "update",
  view: SavedIssueSearchView | null,
};

export function IssueSavedViews({ adminApp, filters, onApply }: IssueSavedViewsProps) {
  const [open, setOpen] = useState(false);
  const [views, setViews] = useState<SavedIssueSearchView[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [name, setName] = useState("");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<SavedIssueSearchView | null>(null);

  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    setLoading(true);
    setListError(null);
    runAsynchronously(async () => {
      try {
        const nextViews = await fetchSavedIssueSearchViews(adminApp);
        if (cancelled) return;
        setViews(nextViews);
        setLoaded(true);
      } catch (error) {
        if (!cancelled) setListError(getErrorMessage(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [adminApp, loaded, open, reloadToken]);

  function startCreate() {
    setOperationError(null);
    setName("");
    setOpen(false);
    setEditor({ mode: "create", view: null });
  }

  function startUpdate(view: SavedIssueSearchView) {
    setOperationError(null);
    setName(view.name);
    setOpen(false);
    setEditor({ mode: "update", view });
  }

  async function saveEditor() {
    const trimmedName = name.trim();
    if (trimmedName === "") {
      setOperationError("Give this view a name before saving it.");
      return;
    }

    setOperationError(null);
    try {
      const mutation = savedIssueSearchViewMutationForFilters(trimmedName, filters);
      const saved = editor?.mode === "update" && editor.view !== null
        ? await updateSavedIssueSearchView(adminApp, editor.view.id, mutation)
        : await createSavedIssueSearchView(adminApp, mutation);
      setViews((current) => {
        const existing = current.some((view) => view.id === saved.id);
        return existing ? current.map((view) => view.id === saved.id ? saved : view) : [saved, ...current];
      });
      setActiveViewId(saved.id);
      setEditor(null);
    } catch (error) {
      setOperationError(getErrorMessage(error));
    }
  }

  async function confirmDelete() {
    if (deleteCandidate === null) return;
    setOperationError(null);
    try {
      await deleteSavedIssueSearchView(adminApp, deleteCandidate.id);
      setViews((current) => current.filter((view) => view.id !== deleteCandidate.id));
      if (activeViewId === deleteCandidate.id) setActiveViewId(null);
      setDeleteCandidate(null);
    } catch (error) {
      setOperationError(getErrorMessage(error));
    }
  }

  function applyView(view: SavedIssueSearchView) {
    if (!savedIssueSearchViewQueryIsCompatible(view.query)) {
      setListError(`"${view.name}" uses filters this issue list cannot safely apply.`);
      return;
    }
    onApply(savedIssueSearchQueryToIssueFilters(view.query));
    setActiveViewId(view.id);
    setOpen(false);
  }

  function retryList() {
    setLoaded(false);
    setReloadToken((current) => current + 1);
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <DesignButton variant="secondary" size="sm" className="gap-1.5">
            <BookmarkSimpleIcon className="h-3.5 w-3.5" />
            Saved views
            {activeViewId !== null && <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-label="A saved view is active" />}
          </DesignButton>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(22rem,calc(100vw-2rem))] p-0">
          <div className="border-b border-foreground/[0.07] px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Typography className="text-sm font-semibold tracking-tight">Saved views</Typography>
                <Typography variant="secondary" className="mt-0.5 text-xs">
                  Keep a repeatable issue triage lens.
                </Typography>
              </div>
              <DesignButton variant="default" size="sm" className="h-7 shrink-0 gap-1 px-2.5" onClick={startCreate}>
                <PlusIcon className="h-3.5 w-3.5" />
                Save current
              </DesignButton>
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-2">
            {loading && <div className="px-2 py-5 text-center text-xs text-muted-foreground" aria-live="polite">Loading saved views…</div>}
            {listError !== null && !loading && (
              <DesignAlert
                variant="error"
                title="Saved views couldn’t load"
                description={listError}
              >
                <DesignButton variant="secondary" size="sm" className="mt-2" onClick={retryList}>Retry</DesignButton>
              </DesignAlert>
            )}
            {!loading && listError === null && views.length === 0 && (
              <div className="px-2 py-5 text-center">
                <BookmarkSimpleIcon className="mx-auto mb-2 h-5 w-5 text-muted-foreground/60" />
                <Typography className="text-xs font-medium">No project views yet</Typography>
                <Typography variant="secondary" className="mt-1 text-xs">Save the current filters to make the first one.</Typography>
              </div>
            )}
            {!loading && listError === null && views.length > 0 && (
              <div className="space-y-1">
                {views.map((view) => (
                  <div key={view.id} className="group flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-foreground/[0.04]">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => applyView(view)}
                    >
                      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/[0.08] text-primary">
                        {activeViewId === view.id ? <CheckIcon className="h-3.5 w-3.5" /> : <BookmarkSimpleIcon className="h-3.5 w-3.5" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{view.name}</span>
                        <span className="block text-[10px] text-muted-foreground">{savedIssueSearchViewVisibilityLabel(view.visibility)}</span>
                      </span>
                    </button>
                    <DesignMenu
                      trigger="icon"
                      triggerLabel={`Actions for ${view.name}`}
                      align="end"
                      contentClassName="min-w-[160px]"
                      withIcons
                      variant="actions"
                      items={[
                        { id: "edit", label: "Update with current filters", icon: <PencilSimpleIcon />, onClick: () => startUpdate(view) },
                        { id: "delete", label: "Delete view", itemVariant: "destructive", icon: <TrashIcon />, onClick: () => setDeleteCandidate(view) },
                      ]}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-foreground/[0.07] bg-foreground/[0.02] px-4 py-2.5">
            <Typography variant="secondary" className="text-[10px] leading-relaxed">
              Admin-key dashboard requests have no end-user identity, so private views are intentionally not listed or created here. Project views remain scoped to this project branch.
            </Typography>
          </div>
        </PopoverContent>
      </Popover>

      <DesignDialog
        open={editor !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setEditor(null);
            setOperationError(null);
          }
        }}
        size="sm"
        variant="plain"
        icon={editor?.mode === "update" ? PencilSimpleIcon : BookmarkSimpleIcon}
        title={editor?.mode === "update" ? "Update saved view" : "Save current filters"}
        description="This project view keeps the filter lens, not grid layout or cursor state."
        footer={(
          <div className="flex w-full justify-end gap-2">
            <DesignButton variant="secondary" onClick={() => setEditor(null)}>Cancel</DesignButton>
            <DesignButton variant="default" disabled={name.trim() === ""} onClick={saveEditor}>
              {editor?.mode === "update" ? "Update view" : "Save view"}
            </DesignButton>
          </div>
        )}
      >
        <div className="space-y-3">
          {operationError !== null && <DesignAlert variant="error" title="Couldn’t save view" description={operationError} />}
          <div className="space-y-1.5">
            <label htmlFor="issue-saved-view-name" className="text-xs font-medium">Name</label>
            <DesignInput
              id="issue-saved-view-name"
              value={name}
              maxLength={128}
              autoFocus
              placeholder="e.g. Production regressions"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="rounded-lg border border-primary/15 bg-primary/[0.05] px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">Project view.</span> Anyone with access to this project branch can use it. Private views require a real user session, which the dashboard admin-key request does not provide.
          </div>
        </div>
      </DesignDialog>

      <DesignDialog
        open={deleteCandidate !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            setDeleteCandidate(null);
            setOperationError(null);
          }
        }}
        size="sm"
        variant="plain"
        icon={TrashIcon}
        title="Delete saved view?"
        description={deleteCandidate == null ? undefined : `“${deleteCandidate.name}” will be removed from this project branch.`}
        footer={(
          <div className="flex w-full justify-end gap-2">
            <DesignButton variant="secondary" onClick={() => setDeleteCandidate(null)}>Cancel</DesignButton>
            <DesignButton variant="destructive" onClick={confirmDelete}>Delete view</DesignButton>
          </div>
        )}
      >
        {operationError !== null && <DesignAlert variant="error" title="Couldn’t delete view" description={operationError} />}
      </DesignDialog>
    </>
  );
}

"use client";

import { DesignAlert, DesignBadge, DesignButton, DesignInput } from "@/components/design-components";
import { cn, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { GROWTH_ACTION_STATUSES, GROWTH_CATEGORIES, type GrowthActionItem, type GrowthActionStatus, type GrowthCategory, type GrowthOverviewFinding } from "@/lib/growth/growth-types";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { CheckIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * The one thing that differs between the customer Growth workspace and the admin one: the admin
 * renders the exact same components, wrapped in this provider, and every field the Growth admin API
 * can change becomes editable in place. Nothing about the layout changes — the read-only rendering
 * of every value stays byte-for-byte what the customer sees, and edit affordances only appear on
 * hover/click — so there is a single implementation of the workspace UI rather than an admin copy of
 * it that drifts.
 */
export type GrowthWorkspaceItem =
  | { kind: "finding", value: GrowthOverviewFinding }
  | { kind: "action", value: GrowthActionItem };

/** Fields the workspace shows for a finding/note/action, in the shape the workspace renders them. */
export type GrowthWorkspaceItemPatch = {
  title?: string,
  /** A finding's `body` and an action's `description` occupy the same slot in the UI. */
  body?: string,
  category?: GrowthCategory,
  tags?: string[],
};

export type GrowthWorkspaceEditors = {
  saveCategoryScore: (category: GrowthCategory, score: number) => Promise<void>,
  saveItem: (item: GrowthWorkspaceItem, patch: GrowthWorkspaceItemPatch) => Promise<void>,
  saveActionStatus: (action: GrowthActionItem, status: GrowthActionStatus) => Promise<void>,
  createNote: (input: { category: GrowthCategory, title: string, body: string }) => Promise<void>,
  createSuggestion: (input: { category: GrowthCategory, title: string, body: string }) => Promise<void>,
};

/**
 * The mutations as the workspace sees them: the provider turns a rejected save into a reported failure,
 * so the caller gets `false` instead of a rejection. Fields that hold a draft the admin would have to retype
 * (the new-note row) key off that, rather than treating a reported failure as a successful save.
 */
type GrowthWorkspaceEditActions = {
  [Key in keyof GrowthWorkspaceEditors]: (...args: Parameters<GrowthWorkspaceEditors[Key]>) => Promise<boolean>
};

const GrowthWorkspaceEditContext = createContext<GrowthWorkspaceEditActions | null>(null);

/** Null on the customer workspace, which is exactly what makes every field below read-only there. */
export function useGrowthWorkspaceEditors(): GrowthWorkspaceEditActions | null {
  return useContext(GrowthWorkspaceEditContext);
}

function errorMessage(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Wraps the caller's mutations so a rejected save surfaces as an alert above the workspace instead
 * of an unhandled rejection: these are inline edits with no submit button of their own, so there is
 * no per-field place to put an error, and a toast would be too easy to miss on a page whose entire
 * purpose is editing customer data.
 */
export function GrowthWorkspaceEditProvider(props: { editors: GrowthWorkspaceEditors, children: ReactNode }) {
  const [error, setError] = useState<string | null>(null);
  const editors = props.editors;
  const guarded = useMemo<GrowthWorkspaceEditActions>(() => {
    const guard = <TArguments extends unknown[]>(label: string, mutation: (...args: TArguments) => Promise<void>) => async (...args: TArguments) => {
      setError(null);
      const result = await Result.fromThrowingAsync(async () => await mutation(...args));
      if (result.status === "error") {
        captureError(label, result.error);
        setError(errorMessage(result.error));
        return false;
      }
      return true;
    };
    return {
      saveCategoryScore: guard("growth-admin-category-score", editors.saveCategoryScore),
      saveItem: guard("growth-admin-item", editors.saveItem),
      saveActionStatus: guard("growth-admin-action-status", editors.saveActionStatus),
      createNote: guard("growth-admin-note", editors.createNote),
      createSuggestion: guard("growth-admin-suggestion", editors.createSuggestion),
    };
  }, [editors]);
  return (
    <GrowthWorkspaceEditContext.Provider value={guarded}>
      {error != null && <div className="mb-6"><DesignAlert variant="error">{error}</DesignAlert></div>}
      {props.children}
    </GrowthWorkspaceEditContext.Provider>
  );
}

const editableFieldClassName = "-mx-1 w-full rounded-md bg-transparent px-1 ring-1 ring-transparent transition-shadow hover:transition-none hover:ring-foreground/20 focus:outline-none focus:ring-foreground/40";

/**
 * Inline-editable text that inherits its typography from the element it is placed in, so the same
 * heading/paragraph markup renders the customer's text and the admin's editor. Saves on blur (and on
 * Enter for single-line fields); Escape restores the stored value.
 */
export function GrowthEditableText(props: {
  value: string,
  label: string,
  onSave: (value: string) => Promise<unknown>,
  multiline?: boolean,
}) {
  const editors = useGrowthWorkspaceEditors();
  if (editors == null) return <>{props.value}</>;
  return <GrowthEditableTextField {...props} />;
}

function GrowthEditableTextField(props: { value: string, label: string, onSave: (value: string) => Promise<unknown>, multiline?: boolean }) {
  const [draft, setDraft] = useState(props.value);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(props.value), [props.value]);

  const commit = async () => {
    if (draft === props.value || draft.trim().length === 0) {
      setDraft(props.value);
      return;
    }
    setSaving(true);
    try {
      await props.onSave(draft);
    } finally {
      setSaving(false);
    }
  };
  const className = cn(editableFieldClassName, saving && "opacity-60");
  const shared = {
    "aria-label": props.label,
    "value": draft,
    "disabled": saving,
    "className": className,
    "onChange": (event: { target: { value: string } }) => setDraft(event.target.value),
    "onBlur": () => runAsynchronously(commit()),
  };
  if (props.multiline === true) {
    return (
      <textarea
        {...shared}
        rows={Math.min(10, Math.max(2, draft.split("\n").length))}
        // The row grows with the text instead, so a drag handle would be the one visible difference
        // between the customer's paragraph and the admin's editor at rest.
        className={cn(className, "resize-none")}
        onKeyDown={(event) => {
          if (event.key === "Escape") setDraft(props.value);
        }}
      />
    );
  }
  return (
    <input
      {...shared}
      type="text"
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setDraft(props.value);
      }}
    />
  );
}

/**
 * A badge that opens a picker when the workspace is editable. The badge itself is the customer's
 * badge, unchanged, so the resting state of the row is identical on both surfaces.
 */
function GrowthBadgePicker(props: { badge: ReactNode, label: string, children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={props.label} className="rounded-full focus-visible:outline-none focus-visible:ring-2">
          {props.badge}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-2">
        {props.children(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  );
}

function PickerOption(props: { label: string, selected: boolean, onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className={cn(
        "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm capitalize transition-colors hover:transition-none hover:bg-foreground/[0.06]",
        props.selected && "font-medium",
      )}
    >
      {props.label}
      {props.selected && <CheckIcon className="size-3.5" />}
    </button>
  );
}

export function GrowthCategoryBadge(props: { category: GrowthCategory | null, label: string, onSave?: (category: GrowthCategory) => Promise<unknown> }) {
  const editors = useGrowthWorkspaceEditors();
  const badge = <DesignBadge label={props.label} color={props.category == null ? "orange" : "cyan"} size="sm" />;
  const onSave = props.onSave;
  if (editors == null || onSave === undefined) return badge;
  return (
    <GrowthBadgePicker badge={badge} label="Change stage">
      {(close) => GROWTH_CATEGORIES.map((category) => (
        <PickerOption
          key={category}
          label={category}
          selected={category === props.category}
          onSelect={() => {
            close();
            runAsynchronously(onSave(category));
          }}
        />
      ))}
    </GrowthBadgePicker>
  );
}

/**
 * Mirrors the transitions the Growth admin API accepts: a proposal can be activated or dismissed, an
 * active action can only be dismissed, and terminal states are final. Offering the rest would just
 * turn a known-invalid click into a server error.
 */
export function editableActionStatuses(current: GrowthActionStatus): GrowthActionStatus[] {
  if (current === "proposed") return GROWTH_ACTION_STATUSES.filter((status) => status !== "completed");
  if (current === "active") return ["active", "dismissed"];
  return [current];
}

/**
 * Action status, shown only on the editable workspace: the customer's row conveys status through the
 * action's own page, and there is nothing for them to change here.
 */
export function GrowthActionStatusPicker(props: { status: GrowthActionStatus, onSave: (status: GrowthActionStatus) => Promise<unknown> }) {
  const editors = useGrowthWorkspaceEditors();
  if (editors == null) return null;
  const statuses = editableActionStatuses(props.status);
  if (statuses.length === 1) return <DesignBadge label={props.status} color="purple" size="sm" />;
  return (
    <GrowthBadgePicker badge={<DesignBadge label={props.status} color="purple" size="sm" />} label="Change action status">
      {(close) => statuses.map((status) => (
        <PickerOption
          key={status}
          label={status}
          selected={status === props.status}
          onSelect={() => {
            close();
            runAsynchronously(props.onSave(status));
          }}
        />
      ))}
    </GrowthBadgePicker>
  );
}

export function GrowthTagBadges(props: { tags: string[], onSave?: (tags: string[]) => Promise<boolean> }) {
  const editors = useGrowthWorkspaceEditors();
  const onSave = props.onSave;
  const [adding, setAdding] = useState("");
  if (editors == null || onSave === undefined) {
    return <>{props.tags.map((tag) => <DesignBadge key={tag} label={tag} color="blue" size="sm" />)}</>;
  }
  return (
    <>
      {props.tags.map((tag) => (
        <GrowthBadgePicker key={tag} badge={<DesignBadge label={tag} color="blue" size="sm" />} label={`Edit tag ${tag}`}>
          {(close) => (
            <DesignButton
              size="sm"
              variant="outline"
              className="w-full"
              onClick={async () => {
                close();
                await onSave(props.tags.filter((existing) => existing !== tag));
              }}
            >
              <XIcon className="size-3.5" />
              Remove tag
            </DesignButton>
          )}
        </GrowthBadgePicker>
      ))}
      <GrowthBadgePicker
        badge={(
          <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-dashed border-foreground/25 px-2 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
            <PlusIcon className="size-3" />
            Tag
          </span>
        )}
        label="Add tag"
      >
        {(close) => (
          <div className="space-y-2">
            <DesignInput autoFocus placeholder="New tag" value={adding} onChange={(event) => setAdding(event.target.value)} />
            <DesignButton
              size="sm"
              className="w-full"
              disabled={adding.trim().length === 0}
              onClick={async () => {
                const tag = adding.trim();
                if (tag.length === 0 || props.tags.includes(tag)) {
                  setAdding("");
                  close();
                  return;
                }
                // The provider reports a rejected save as an alert above the workspace and resolves
                // false, so clearing the field unconditionally would leave the author with an error
                // and a tag they have to retype.
                const saved = await onSave([...props.tags, tag]);
                if (!saved) return;
                setAdding("");
                close();
              }}
            >
              Add tag
            </DesignButton>
          </div>
        )}
      </GrowthBadgePicker>
    </>
  );
}

/**
 * `min`/`max` on a number input are only enforced on form submission, which the score picker never
 * does, so the range the Growth API accepts (assertGrowthCategoryScore: a whole number from 0 to 100)
 * is checked here rather than letting a known-invalid score become a server error.
 */
export function isSubmittableCategoryScore(draft: string): boolean {
  // `Number("")` and `Number(" ")` are both 0, so the emptiness check has to come first or a blank
  // field would look like a valid score of zero.
  const score = Number(draft);
  return draft.trim() !== "" && Number.isInteger(score) && score >= 0 && score <= 100;
}

export function GrowthCategoryScoreBadge(props: { category: GrowthCategory, score: number | null }) {
  const editors = useGrowthWorkspaceEditors();
  const [draft, setDraft] = useState(props.score == null ? "" : String(props.score));
  useEffect(() => setDraft(props.score == null ? "" : String(props.score)), [props.score]);
  if (editors == null) {
    return props.score == null ? null : <DesignBadge label={`${props.score} / 100`} color="purple" size="md" />;
  }
  const score = Number(draft);
  return (
    <GrowthBadgePicker badge={<DesignBadge label={props.score == null ? "Not scored" : `${props.score} / 100`} color="purple" size="md" />} label="Change stage score">
      {(close) => (
        <div className="space-y-2">
          <DesignInput autoFocus type="number" min={0} max={100} step={1} value={draft} onChange={(event) => setDraft(event.target.value)} />
          <DesignButton
            size="sm"
            className="w-full"
            disabled={!isSubmittableCategoryScore(draft)}
            onClick={async () => {
              close();
              await editors.saveCategoryScore(props.category, score);
            }}
          >
            Save score
          </DesignButton>
        </div>
      )}
    </GrowthBadgePicker>
  );
}

type GrowthAddFindingVariant = "note" | "suggestion";

const ADD_FINDING_COPY = new Map<GrowthAddFindingVariant, { label: string, titlePlaceholder: string, bodyPlaceholder: string, button: string }>([
  ["note", { label: "New note", titlePlaceholder: "Note title", bodyPlaceholder: "What should the customer know?", button: "Add note" }],
  ["suggestion", { label: "New suggestion", titlePlaceholder: "Suggestion title", bodyPlaceholder: "What should the customer consider doing?", button: "Add suggestion" }],
]);

/** Creates a finding in the category the workspace is currently focused on. Admin surfaces only. */
function GrowthAddFindingRow(props: { category: GrowthCategory, variant: GrowthAddFindingVariant }) {
  const editors = useGrowthWorkspaceEditors();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  if (editors == null) return null;
  const copy = ADD_FINDING_COPY.get(props.variant) ?? throwErr(`Missing composer copy for Growth ${props.variant}.`);
  return (
    <div className="grid gap-3 border-b border-foreground/[0.08] px-1 py-5 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-start">
      <span className="text-xs text-muted-foreground">{copy.label}</span>
      <div className="min-w-0 space-y-2">
        <DesignInput placeholder={copy.titlePlaceholder} value={title} onChange={(event) => setTitle(event.target.value)} />
        <textarea
          className="min-h-20 w-full rounded-xl border bg-background p-3 text-sm"
          placeholder={copy.bodyPlaceholder}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </div>
      <DesignButton
        size="sm"
        variant="outline"
        disabled={title.trim().length === 0 || body.trim().length === 0}
        onClick={async () => {
          const create = props.variant === "note" ? editors.createNote : editors.createSuggestion;
          const saved = await create({ category: props.category, title: title.trim(), body: body.trim() });
          if (!saved) return;
          setTitle("");
          setBody("");
        }}
      >
        <PlusIcon className="size-3.5" />
        {copy.button}
      </DesignButton>
    </div>
  );
}

export function GrowthAddNoteRow(props: { category: GrowthCategory }) {
  return <GrowthAddFindingRow category={props.category} variant="note" />;
}

export function GrowthAddSuggestionRow(props: { category: GrowthCategory }) {
  return <GrowthAddFindingRow category={props.category} variant="suggestion" />;
}

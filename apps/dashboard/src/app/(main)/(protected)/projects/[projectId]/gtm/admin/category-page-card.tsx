"use client";

import { DesignAlert, DesignBadge, DesignButton } from "@/components/design-components";
import { CopyPromptButton } from "@/components/ui";
import {
  discardGrowthAdminCategoryPageDraft,
  listGrowthAdminCategoryPages,
  publishAllGrowthAdminCategoryPageDrafts,
  publishGrowthAdminCategoryPage,
  saveGrowthAdminCategoryPageDraft,
  unpublishGrowthAdminCategoryPage,
} from "@/lib/growth/growth-api";
import { buildGrowthCategoryPagePrompt } from "@/lib/growth/growth-page-prompt";
import { parseGrowthPageResponse } from "@/lib/growth/growth-page-response";
import { publishGrowthAdminReport } from "@/lib/growth/reports/growth-reports-admin-api";
import { GROWTH_CATEGORIES, type GrowthAdminCategoryPage, type GrowthCategory, type GrowthCategoryPageVersion, type GrowthOverview } from "@/lib/growth/growth-types";
import { captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { Result } from "@hexclave/shared/dist/utils/results";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { GrowthDocumentActionsProvider, GrowthDocumentRenderer } from "../components/growth-document";

/**
 * The staff side of stage pages: read the stage's material below, copy the prompt into a model, paste
 * the result back here, save, preview, publish.
 *
 * Everything the customer will see goes through the backend compiler on save, and the preview renders
 * the compiled draft with the customer's own renderer — so "what I previewed" and "what publishing
 * shows" cannot drift apart. This card is deliberately plain: it is an internal tool, and the page
 * being composed is the thing that needs to look designed.
 */

type PagesState =
  | { status: "loading" }
  | { status: "error", message: string }
  | { status: "loaded", pages: GrowthAdminCategoryPage[] };

const GrowthAdminCategoryPagesContext = createContext<{ state: PagesState, refresh: () => Promise<void> } | null>(null);

/**
 * Loads every stage's pages once for the selected project, rather than per stage: the card is
 * remounted whenever staff click a different corner of the hexagon, and refetching there would make
 * switching stages feel like navigation.
 */
export function GrowthAdminCategoryPagesProvider(props: { app: object, projectId: string, children: ReactNode }) {
  const { app, projectId } = props;
  const [state, setState] = useState<PagesState>({ status: "loading" });
  const refresh = useCallback(async () => {
    const result = await Result.fromThrowingAsync(async () => await listGrowthAdminCategoryPages(app, projectId));
    if (result.status === "error") {
      captureError("growth-admin-category-pages-load", result.error);
      setState({ status: "error", message: result.error instanceof Error ? result.error.message : String(result.error) });
      return;
    }
    setState({ status: "loaded", pages: result.data });
  }, [app, projectId]);
  useEffect(() => {
    setState({ status: "loading" });
    runAsynchronously(refresh());
  }, [refresh]);
  return <GrowthAdminCategoryPagesContext.Provider value={{ state, refresh }}>{props.children}</GrowthAdminCategoryPagesContext.Provider>;
}

export function GrowthAdminPublishAllCategoryPages(props: { app: object, projectId: string, pendingReportId: string | null, onPublishedChanged: () => Promise<void> }) {
  const context = useContext(GrowthAdminCategoryPagesContext)
    ?? throwErr("GrowthAdminPublishAllCategoryPages must be rendered inside GrowthAdminCategoryPagesProvider.");
  const [error, setError] = useState<string | null>(null);

  const drafts: { category: GrowthCategory, version: number }[] = [];
  let liveCount = 0;
  if (context.state.status === "loaded") {
    for (const category of GROWTH_CATEGORIES) {
      const page = context.state.pages.find((candidate) => candidate.category === category) ?? null;
      const draft = page?.draft ?? null;
      if (draft != null) drafts.push({ category, version: draft.version });
      if (page?.published != null) liveCount += 1;
    }
  }
  const draftsReady = drafts.length === GROWTH_CATEGORIES.length;
  const releaseOnly = liveCount === GROWTH_CATEGORIES.length && drafts.length === 0 && props.pendingReportId != null;
  const enabled = draftsReady || releaseOnly;
  const buttonLabel = releaseOnly
    ? "Release report to customer"
    : props.pendingReportId == null ? "Publish all stage pages" : "Publish all and release report";

  return (
    <div className="mt-6 flex flex-col items-end gap-2">
      {error != null && <DesignAlert variant="error">{error}</DesignAlert>}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <span className="text-xs text-muted-foreground">
          {liveCount} live · {drafts.length} {drafts.length === 1 ? "draft" : "drafts"}
          {props.pendingReportId != null && <> · report awaiting release</>}
        </span>
        <DesignButton
          size="sm"
          disabled={!enabled}
          onClick={async () => {
            setError(null);
            const result = await Result.fromThrowingAsync(async () => {
              if (releaseOnly) {
                const reportId = props.pendingReportId;
                if (reportId == null) throw new Error("The report awaiting release disappeared before it could be published.");
                await publishGrowthAdminReport(props.app, props.projectId, reportId);
              } else {
                await publishAllGrowthAdminCategoryPageDrafts(props.app, props.projectId, drafts, props.pendingReportId);
              }
              await Promise.all([context.refresh(), props.onPublishedChanged()]);
            });
            if (result.status === "error") {
              captureError("growth-admin-category-pages-publish-all", result.error);
              setError(result.error instanceof Error ? result.error.message : String(result.error));
            }
          }}
        >
          {buttonLabel}
        </DesignButton>
      </div>
    </div>
  );
}

const EMPTY_DATA_JSON = "[]";

/**
 * What the editor's text is based on: the stored version it was filled from, plus that text, so
 * unsaved edits can be told apart from a version the author has not seen.
 */
export type Seed = {
  key: string,
  mdx: string,
  dataJson: string,
  /** `updatedAtMillis` of the draft the text derives from, for the save's optimistic check. */
  draftUpdatedAtMillis: number | null,
};

/** Identifies the stored state of a stage: which versions occupy its slots, and how recent they are. */
export function seedKeyOf(
  category: GrowthCategory,
  draft: { id: string, updatedAtMillis: number } | null,
  published: { id: string, updatedAtMillis: number } | null,
): string {
  const slot = (version: { id: string, updatedAtMillis: number } | null, empty: string) =>
    version == null ? empty : `${version.id}:${version.updatedAtMillis}`;
  return `${category}:${slot(draft, "no-draft")}:${slot(published, "no-live")}`;
}

/**
 * Whether the editor holds text that is not in the stage's stored version yet. Typing while a save
 * is in flight is normal, and the refresh that follows it changes the seed key — so re-seeding on a
 * changed key alone would silently throw those keystrokes away.
 */
export function hasUnsavedEdits(seed: Seed | null, text: { mdx: string, dataJson: string }): boolean {
  return seed != null && (text.mdx !== seed.mdx || text.dataJson !== seed.dataJson);
}

/**
 * Whether the editor should be filled from the stage's stored version.
 *
 * Only when that version is one the editor is not based on, and neither of the two things that make
 * the loaded version untrustworthy is true: unsaved edits (which re-seeding would discard), and a
 * mutation of this stage still in flight (whose refresh has not landed, so what is loaded is the
 * stage as it was *before* the mutation — including before the save whose text the editor just
 * adopted).
 */
export function shouldSeedFromStored(args: {
  storedKey: string | null,
  seededKey: string | null,
  dirty: boolean,
  mutating: boolean,
}): boolean {
  return args.storedKey != null && args.storedKey !== args.seededKey && !args.dirty && !args.mutating;
}

/**
 * Whether to tell the author their edits are based on a version that is no longer the stored one —
 * true only for a stored version that really is someone else's, which is why an in-flight mutation
 * of this stage rules it out.
 */
export function isSupersededByStored(args: {
  storedKey: string | null,
  seededKey: string | null,
  dirty: boolean,
  mutating: boolean,
}): boolean {
  return args.storedKey != null && args.storedKey !== args.seededKey && args.dirty && !args.mutating;
}

/**
 * The draft version a save may replace, as the editor's text sees it — the backend rejects the save
 * if the stage's draft has moved on from it.
 *
 * Branching on the *presence* of the seed rather than on its timestamp matters: a seed whose
 * `draftUpdatedAtMillis` is null means "this text is based on a stage that had no draft", which is
 * exactly the case the backend must reject once a colleague has created one — falling through to
 * whatever draft the last refresh returned would silently overwrite them.
 */
export function expectedDraftUpdatedAtMillis(seed: Seed | null, draft: { updatedAtMillis: number } | null): number | null {
  return seed == null ? draft?.updatedAtMillis ?? null : seed.draftUpdatedAtMillis;
}

/** The draft the editor starts from: the stage's draft if there is one, else the live page's source. */
function initialSource(page: GrowthAdminCategoryPage | null): { mdx: string, dataJson: string } {
  const version = page?.draft ?? page?.published ?? null;
  if (version?.source == null) return { mdx: "", dataJson: EMPTY_DATA_JSON };
  return { mdx: version.source.sourceMdx, dataJson: JSON.stringify(version.source.data, null, 2) };
}

function StatusBadges(props: { page: GrowthAdminCategoryPage | null }) {
  const published = props.page?.published ?? null;
  const draft = props.page?.draft ?? null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {published == null
        ? <DesignBadge label="Not published" color="orange" size="sm" />
        : <DesignBadge label={`Live · v${published.version}`} color="green" size="sm" />}
      {draft != null && <DesignBadge label={`Draft · v${draft.version}`} color="cyan" size="sm" />}
    </div>
  );
}

/** Sources that changed after the version was written — the signal that a page needs a rewrite. */
function StaleSourceNotice(props: { version: GrowthCategoryPageVersion | null, label: string }) {
  const stale = props.version?.staleSourceIds ?? [];
  if (stale.length === 0) return null;
  return (
    <DesignAlert variant="warning">
      {stale.length} of the items the {props.label} was written from changed or were deleted since it was last saved. Re-copy the prompt and rewrite it before publishing.
    </DesignAlert>
  );
}

export function GrowthAdminCategoryPageCard(props: {
  app: object,
  projectId: string,
  category: GrowthCategory,
  overview: GrowthOverview,
  /** Re-reads the overview, so a stage page published here shows up in the workspace around it. */
  onPublishedChanged: () => Promise<void>,
}) {
  const context = useContext(GrowthAdminCategoryPagesContext)
    ?? throwErr("GrowthAdminCategoryPageCard must be rendered inside GrowthAdminCategoryPagesProvider.");
  const { app, projectId, category, overview } = props;

  const pages = context.state.status === "loaded" ? context.state.pages : [];
  const page = pages.find((candidate) => candidate.category === category) ?? null;

  const [mdx, setMdx] = useState("");
  const [dataJson, setDataJson] = useState(EMPTY_DATA_JSON);
  const [seeded, setSeeded] = useState<Seed | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True from the start of a save/publish/discard until the refresh that follows it has landed. In
  // that window the loaded pages still describe the stage as it was before the mutation, so they are
  // not evidence of anything and must not drive seeding: a save adopts its own text as the seed, and
  // re-seeding from the pre-save version here would undo it (and leave the next save carrying an
  // outdated timestamp, which the backend would then reject as a conflict that never happened).
  const [mutating, setMutating] = useState(false);

  // The editor is filled from the stage's stored version when that version is one it has not seen
  // yet — keyed by last-saved time as well as id, so content a colleague replaced does not linger.
  const seedKey = context.state.status === "loaded" ? seedKeyOf(category, page?.draft ?? null, page?.published ?? null) : null;
  const dirty = hasUnsavedEdits(seeded, { mdx, dataJson });
  const seedFrom = useCallback((key: string, page: GrowthAdminCategoryPage | null) => {
    const source = initialSource(page);
    setMdx(source.mdx);
    setDataJson(source.dataJson);
    setSeeded({ key, draftUpdatedAtMillis: page?.draft?.updatedAtMillis ?? null, ...source });
  }, []);
  const seededKey = seeded?.key ?? null;
  useEffect(() => {
    if (seedKey == null || !shouldSeedFromStored({ storedKey: seedKey, seededKey, dirty, mutating })) return;
    seedFrom(seedKey, page);
  }, [seedKey, seededKey, dirty, mutating, page, seedFrom]);

  // A stored version this editor is not based on: a colleague saved the stage, or the author reverted
  // their own edits to match an older seed.
  const supersededByStored = isSupersededByStored({ storedKey: seedKey, seededKey, dirty, mutating });

  const findings = overview.findings.filter((item) => item.category === category);
  const notes = overview.notes.filter((item) => item.category === category);
  const actions = overview.actions.filter((item) => item.category === category);
  const score = overview.categories.find((item) => item.category === category)?.score ?? null;
  const prompt = buildGrowthCategoryPagePrompt({ category, score, findings, notes, actions });

  const run = async (label: string, mutation: () => Promise<void>) => {
    setError(null);
    setMutating(true);
    const result = await Result.fromThrowingAsync(mutation);
    if (result.status === "error") {
      captureError(label, result.error);
      setError(result.error instanceof Error ? result.error.message : String(result.error));
      setMutating(false);
      return;
    }
    await context.refresh();
    setMutating(false);
  };

  // The version being previewed carries the actions its own buttons reference, so the preview
  // resolves them exactly like the customer's copy would — rather than against the overview's
  // capped, active-only lanes, which would report a valid reference as unavailable.
  const previewVersion = page?.draft ?? page?.published ?? null;
  const preview = previewVersion?.document ?? null;
  const previewActions = previewVersion?.actions ?? [];

  return (
    <section className="mt-6 rounded-2xl border border-dashed border-foreground/[0.16] bg-foreground/[0.02] p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold tracking-tight">Stage page</h4>
          <p className="mt-1 max-w-xl text-xs leading-5 text-muted-foreground">
            What the customer reads under this stage. While a page is live, the suggestion and note lanes below are staff-only.
          </p>
        </div>
        <StatusBadges page={page} />
      </header>

      {context.state.status === "loading" && <div className="mt-4 h-24 animate-pulse rounded-xl bg-foreground/[0.04]" aria-busy="true" />}
      {context.state.status === "error" && (
        <div className="mt-4">
          <DesignAlert variant="error">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span>Could not load this project&apos;s stage pages: {context.state.message}</span>
              <DesignButton size="sm" variant="outline" onClick={context.refresh}>Retry</DesignButton>
            </div>
          </DesignAlert>
        </div>
      )}

      {context.state.status === "loaded" && (
        <div className="mt-4 space-y-4">
          {error != null && <DesignAlert variant="error">{error}</DesignAlert>}
          <StaleSourceNotice version={page?.draft ?? null} label="draft" />
          {page?.draft == null && <StaleSourceNotice version={page?.published ?? null} label="live page" />}
          {supersededByStored && seedKey != null && (
            <DesignAlert variant="warning">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span>This stage&apos;s stored version changed after the editor was filled, so your unsaved edits below were kept rather than overwritten. Saving them will be rejected until you load the stored version.</span>
                <DesignButton size="sm" variant="outline" onClick={() => seedFrom(seedKey, page)}>Load stored version</DesignButton>
              </div>
            </DesignAlert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <CopyPromptButton content={prompt} size="sm" variant="outline">Copy stage prompt</CopyPromptButton>
            <span className="text-xs text-muted-foreground">
              {findings.length} findings · {notes.length} notes · {actions.length} actions
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Paste the complete model response into Page source. Its fenced MDX and JSON blocks will be separated automatically.
          </p>

          <label className="block text-xs font-medium">
            Page source (growth-mdx-v1)
            <textarea
              className="mt-1 min-h-64 w-full rounded-xl border bg-background p-3 font-mono text-xs"
              placeholder="## What we found&#10;&#10;<ActionButton action=&quot;…&quot; />"
              value={mdx}
              onChange={(event) => setMdx(event.target.value)}
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text");
                try {
                  const parsed = parseGrowthPageResponse(pasted);
                  if (parsed == null) return;
                  event.preventDefault();
                  setMdx(parsed.sourceMdx);
                  setDataJson(parsed.evidenceDataJson);
                  setError(null);
                } catch (parseError) {
                  event.preventDefault();
                  setError(parseError instanceof Error ? parseError.message : String(parseError));
                }
              }}
            />
          </label>
          <label className="block text-xs font-medium">
            Evidence data JSON
            <textarea
              className="mt-1 min-h-32 w-full rounded-xl border bg-background p-3 font-mono text-xs"
              value={dataJson}
              onChange={(event) => setDataJson(event.target.value)}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <DesignButton
              size="sm"
              disabled={mdx.trim().length === 0}
              onClick={async () => await run("growth-admin-category-page-save", async () => {
                // Older editor builds allowed the model's complete fenced response to be saved as
                // one Markdown code block. Normalize it on the next save as well as on paste, so an
                // affected draft can be repaired without asking its author to reconstruct the two
                // fields manually.
                const parsed = parseGrowthPageResponse(mdx);
                const savedMdx = parsed?.sourceMdx ?? mdx;
                const savedDataJson = parsed?.evidenceDataJson ?? dataJson;
                // The data field is hand-pasted JSON, so a bad paste and a rejected compile are the
                // same class of problem to the author and belong in the same alert.
                const data = JSON.parse(savedDataJson);
                if (!Array.isArray(data)) throw new Error("Evidence data must be a JSON array.");
                const saved = await saveGrowthAdminCategoryPageDraft(app, projectId, {
                  category,
                  sourceMdx: savedMdx,
                  data,
                  sourceFindingIds: [...findings, ...notes].map((item) => item.id),
                  sourceActionIds: actions.map((action) => action.id),
                  // The draft the editor's text is based on — not merely whatever the last refresh
                  // returned — so the backend rejects the save if someone else has saved the stage
                  // since, instead of overwriting their work.
                  expectedDraftUpdatedAtMillis: expectedDraftUpdatedAtMillis(seeded, page?.draft ?? null),
                });
                setMdx(savedMdx);
                setDataJson(savedDataJson);
                // This save wrote the editor's text, so anything typed while it was in flight is a
                // delta on top of the version now stored: adopt it as the seed, or the refresh that
                // follows would look like a colleague's edit and warn about a conflict that isn't one.
                // A draft save never touches the published slot, so that half of the key is unchanged.
                setSeeded({
                  key: seedKeyOf(category, saved, page?.published ?? null),
                  mdx: savedMdx,
                  dataJson: savedDataJson,
                  draftUpdatedAtMillis: saved.updatedAtMillis,
                });
              })}
            >
              Save draft
            </DesignButton>
            <DesignButton
              size="sm"
              variant="outline"
              disabled={page?.published == null}
              onClick={async () => await run("growth-admin-category-page-unpublish", async () => {
                await unpublishGrowthAdminCategoryPage(app, projectId, category);
                await props.onPublishedChanged();
              })}
            >
              Take page down
            </DesignButton>
            <DesignButton
              size="sm"
              variant="outline"
              disabled={page?.draft == null}
              onClick={async () => await run("growth-admin-category-page-discard", async () => {
                await discardGrowthAdminCategoryPageDraft(app, projectId, category);
              })}
            >
              Discard draft
            </DesignButton>
          </div>

          {(page?.archived.length ?? 0) > 0 && (
            <div className="rounded-xl border border-foreground/[0.08] p-3">
              <p className="text-xs font-medium">Earlier versions</p>
              <ul className="mt-2 space-y-1.5">
                {page?.archived.map((version) => (
                  <li key={version.id} className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>v{version.version} · last saved {new Date(version.updatedAtMillis).toISOString().slice(0, 10)}</span>
                    <DesignButton
                      size="sm"
                      variant="outline"
                      onClick={async () => await run("growth-admin-category-page-rollback", async () => {
                        await publishGrowthAdminCategoryPage(app, projectId, category, version.version);
                        await props.onPublishedChanged();
                      })}
                    >
                      Publish this version
                    </DesignButton>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="rounded-xl border border-foreground/[0.08] bg-background p-4">
            <p className="text-xs font-medium text-muted-foreground">
              {page?.draft != null ? "Preview of the saved draft" : page?.published != null ? "The live page" : "Preview"}
            </p>
            {preview == null
              ? <p className="mt-2 text-xs text-muted-foreground">Save a draft to preview it exactly as the customer will see it.</p>
              : (
                <div className="mt-3">
                  <GrowthDocumentActionsProvider actions={previewActions} demo={false} projectId={null} onChanged={props.onPublishedChanged}>
                    <GrowthDocumentRenderer document={preview} className="max-w-3xl" />
                  </GrowthDocumentActionsProvider>
                </div>
              )}
          </div>
        </div>
      )}
    </section>
  );
}

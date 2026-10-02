"use client";

import { DesignBadge, DesignCard } from "@/components/design-components";
import { GitBranchIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import type { IssueDetailResponse } from "./issues-data";

type IssueReleaseContext = IssueDetailResponse["release_context"];
type IssueRelease = NonNullable<IssueReleaseContext["first_release"]>;
type IssueReleaseCommit = IssueReleaseContext["release_commits"][number];

function isSafeExternalUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized.startsWith("https://") || normalized.startsWith("http://");
}

function ReleaseLink({ url, children }: { url: string | null, children: React.ReactNode }) {
  if (url == null || !isSafeExternalUrl(url)) return <span>{children}</span>;
  return <a href={url} target="_blank" rel="noreferrer" className="transition-colors duration-150 hover:transition-none hover:underline">{children}</a>;
}

function CommitRow({ commit, suspect }: { commit: IssueReleaseCommit, suspect?: string }) {
  return (
    <li className="min-w-0 rounded-xl bg-foreground/[0.03] px-3 py-2 ring-1 ring-foreground/[0.06]">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {suspect != null && <DesignBadge label={`Suspect · ${suspect}`} color="orange" size="sm" />}
        <ReleaseLink url={commit.url}>
          <span className="font-mono text-xs text-foreground">{commit.commit_sha.slice(0, 12)}</span>
        </ReleaseLink>
        <span className="text-[10px] text-muted-foreground">{commit.release_version}</span>
        {commit.repository !== "" && <span className="truncate text-[10px] text-muted-foreground/70">{commit.repository}</span>}
      </div>
      <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
        {commit.message ?? "Commit message unavailable"}
      </div>
      {commit.author_name != null && <div className="mt-1 truncate text-[10px] text-muted-foreground/70">{commit.author_name}</div>}
    </li>
  );
}

function ReleaseCard({ label, release }: { label: string, release: IssueRelease }) {
  return (
    <div className="min-w-0 rounded-xl bg-foreground/[0.03] p-3 ring-1 ring-foreground/[0.06]">
      <div className="flex flex-wrap items-center gap-2">
        <DesignBadge label={label} color="blue" size="sm" />
        <span className="min-w-0 truncate font-mono text-xs font-medium" title={release.version}>{release.version}</span>
        <DesignBadge label={release.status} color={release.status === "open" ? "green" : "zinc"} size="sm" />
      </div>
      <div className="mt-2 grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-2">
        <div><span className="text-muted-foreground/60">Added</span> {release.date_added}</div>
        <div><span className="text-muted-foreground/60">Released</span> {release.date_released ?? "Not released"}</div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <DesignBadge label={`${release.commits.length} commit${release.commits.length === 1 ? "" : "s"}`} color="zinc" size="sm" />
        <DesignBadge label={`${release.deployments.length} deployment${release.deployments.length === 1 ? "" : "s"}`} color="zinc" size="sm" />
      </div>
      {release.deployments.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {release.deployments.slice(0, 5).map((deployment) => (
            <li key={deployment.id} className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
              <RocketLaunchIcon className="h-3.5 w-3.5 shrink-0 text-cyan-500" />
              <span className="truncate">{deployment.environment}</span>
              {deployment.name != null && <span className="truncate text-muted-foreground/70">{deployment.name}</span>}
              <ReleaseLink url={deployment.url}><span className="shrink-0 text-muted-foreground/70 hover:text-foreground">View</span></ReleaseLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IssueReleaseContextSection({ context }: { context: IssueReleaseContext }) {
  const suspectCommits = context.suspect_commits;
  const hasContext = context.first_release != null
    || context.last_release != null
    || context.release_commits.length > 0
    || suspectCommits.length > 0;

  return (
    <DesignCard title="Releases & suspects" subtitle="Bounded release, deployment, and commit context" icon={GitBranchIcon}>
      {!hasContext ? (
        <p className="text-sm text-muted-foreground">
          No release context is retained for this issue in the current project and branch.
        </p>
      ) : (
        <div className="space-y-4">
          {(context.first_release != null || context.last_release != null) && (
            <div className="grid gap-3 lg:grid-cols-2">
              {context.first_release != null && <ReleaseCard label="First seen" release={context.first_release} />}
              {context.last_release != null && (
                <ReleaseCard
                  label={context.first_release?.id === context.last_release.id ? "Release" : "Last seen"}
                  release={context.last_release}
                />
              )}
            </div>
          )}
          {suspectCommits.length > 0 && (
            <div>
              <div className="mb-2 flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <GitBranchIcon className="h-3.5 w-3.5" />
                Suspect commits
              </div>
              <ol className="space-y-2">
                {suspectCommits.map((suspect) => (
                  <CommitRow
                    key={`${suspect.owner_id}:${suspect.commit.id}`}
                    commit={suspect.commit}
                    suspect={suspect.matched_by === "release_commit_id" ? "release commit" : "SHA"}
                  />
                ))}
              </ol>
            </div>
          )}
          {context.release_commits.length > 0 && (
            <div>
              <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Release commits</div>
              <ol className="space-y-2">
                {context.release_commits.slice(0, 10).map((commit) => (
                  <CommitRow key={commit.id} commit={commit} />
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </DesignCard>
  );
}

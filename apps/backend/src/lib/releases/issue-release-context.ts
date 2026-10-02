import { isPrismaJsonObject } from "@/lib/prisma-json";
import { IssueOwnerSource as PrismaIssueOwnerSource } from "@/generated/prisma/enums";
import type { Prisma } from "@/generated/prisma/client";
import type { Tenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";

const MAX_RELEASES = 2;
const MAX_RELEASE_COMMITS = 50;
const MAX_RELEASE_DEPLOYMENTS = 20;
const MAX_SUSPECT_OWNERS = 20;
const MAX_CONTEXT_BYTES = 65_536;
const MAX_CONTEXT_TOKEN_BYTES = 256;

export type ReleaseCommitProjection = {
  id: string,
  release_id: string,
  release_version: string,
  repository: string,
  commit_sha: string,
  position: number,
  message: string | null,
  author_name: string | null,
  committed_at: string | null,
  url: string | null,
};

export type ReleaseProjection = {
  id: string,
  version: string,
  status: "open" | "archived",
  date_added: string,
  date_started: string | null,
  date_released: string | null,
  deployments: ReleaseDeploymentProjection[],
  commits: ReleaseCommitProjection[],
};

export type ReleaseDeploymentProjection = {
  id: string,
  release_id: string,
  deployment_key: string,
  environment: string,
  name: string | null,
  url: string | null,
  started_at: string | null,
  finished_at: string,
};

export type IssueReleaseContext = {
  first_release: ReleaseProjection | null,
  last_release: ReleaseProjection | null,
  release_commits: ReleaseCommitProjection[],
  suspect_commits: {
    owner_id: string,
    matched_by: "release_commit_id" | "commit_sha",
    strategy: string | null,
    commit: ReleaseCommitProjection,
  }[],
};

export type IssueReleaseCommitRow = {
  id: string,
  releaseId: string,
  releaseVersion: string,
  repository: string,
  commitSha: string,
  position: number,
  message: string | null,
  authorName: string | null,
  committedAt: Date | null,
  url: string | null,
};

export type IssueSuspectOwner = {
  id: string,
  context: Prisma.JsonValue | null,
};

type SuspectCommitReference = {
  commitId: string | null,
  commitSha: string | null,
  repository: string | null,
  strategy: string | null,
};

function boundedToken(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_CONTEXT_TOKEN_BYTES
    ? value
    : null;
}

function parseSuspectCommitReference(owner: IssueSuspectOwner): SuspectCommitReference | null {
  if (!isPrismaJsonObject(owner.context)) return null;
  const serialized = JSON.stringify(owner.context);
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONTEXT_BYTES) return null;

  const commitId = boundedToken(owner.context.commit_id);
  const commitSha = boundedToken(owner.context.commit_sha);
  const repository = boundedToken(owner.context.repository);
  const strategy = boundedToken(owner.context.strategy);
  if (commitId === null && commitSha === null) return null;
  return { commitId, commitSha, repository, strategy };
}

function releaseStatus(status: string): "open" | "archived" {
  if (status === "OPEN") return "open";
  if (status === "ARCHIVED") return "archived";
  throw new Error(`Unknown persisted release status: ${status}`);
}

function projectCommit(row: IssueReleaseCommitRow): ReleaseCommitProjection {
  return {
    id: row.id,
    release_id: row.releaseId,
    release_version: row.releaseVersion,
    repository: row.repository,
    commit_sha: row.commitSha,
    position: row.position,
    message: row.message,
    author_name: row.authorName,
    committed_at: row.committedAt?.toISOString() ?? null,
    url: row.url,
  };
}

function projectRelease(row: {
  id: string,
  version: string,
  status: string,
  dateAdded: Date,
  dateStarted: Date | null,
  dateReleased: Date | null,
  deployments: readonly {
    id: string,
    releaseId: string,
    deploymentKey: string,
    environment: string,
    name: string | null,
    url: string | null,
    startedAt: Date | null,
    finishedAt: Date,
  }[],
  commits: readonly IssueReleaseCommitRow[],
}): ReleaseProjection {
  return {
    id: row.id,
    version: row.version,
    status: releaseStatus(row.status),
    date_added: row.dateAdded.toISOString(),
    date_started: row.dateStarted?.toISOString() ?? null,
    date_released: row.dateReleased?.toISOString() ?? null,
    deployments: row.deployments.map((deployment) => ({
      id: deployment.id,
      release_id: deployment.releaseId,
      deployment_key: deployment.deploymentKey,
      environment: deployment.environment,
      name: deployment.name,
      url: deployment.url,
      started_at: deployment.startedAt?.toISOString() ?? null,
      finished_at: deployment.finishedAt.toISOString(),
    })),
    commits: row.commits.map(projectCommit),
  };
}

function uniqueNonNull(values: readonly (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

export function joinSuspectCommits(options: {
  owners: readonly IssueSuspectOwner[],
  commits: readonly IssueReleaseCommitRow[],
}): IssueReleaseContext["suspect_commits"] {
  const byId = new Map(options.commits.map((commit) => [commit.id, commit]));
  const bySha = new Map<string, IssueReleaseCommitRow[]>();
  for (const commit of options.commits) {
    const matches = bySha.get(`${commit.repository}:${commit.commitSha}`) ?? [];
    matches.push(commit);
    bySha.set(`${commit.repository}:${commit.commitSha}`, matches);
  }
  const seen = new Set<string>();
  const joined: Array<{
    owner_id: string,
    matched_by: "release_commit_id" | "commit_sha",
    strategy: string | null,
    commit: ReleaseCommitProjection,
  }> = [];

  for (const owner of options.owners) {
    const reference = parseSuspectCommitReference(owner);
    if (reference === null) continue;
    const byCommitId = reference.commitId === null ? undefined : byId.get(reference.commitId);
    const shaMatches = reference.commitSha === null
      ? []
      : reference.repository === null
        ? options.commits.filter((commit) => commit.commitSha === reference.commitSha)
        : bySha.get(`${reference.repository}:${reference.commitSha}`) ?? [];
    const byCommitSha = shaMatches.length === 1 ? shaMatches[0] : undefined;
    const matched = byCommitId === undefined ? byCommitSha : byCommitId;
    if (matched === undefined || seen.has(`${owner.id}:${matched.id}`)) continue;
    seen.add(`${owner.id}:${matched.id}`);
    joined.push({
      owner_id: owner.id,
      matched_by: byCommitId === undefined ? "commit_sha" : "release_commit_id",
      strategy: reference.strategy,
      commit: projectCommit(matched),
    });
  }
  return joined;
}

export async function loadIssueReleaseContext(options: {
  tenancy: Tenancy,
  issueId: string,
  firstSeenRelease: string | null,
  lastSeenRelease: string | null,
}): Promise<IssueReleaseContext> {
  const prisma = await getPrismaClientForTenancy(options.tenancy);
  const replica = prisma.$replica();
  const versions = uniqueNonNull([options.firstSeenRelease, options.lastSeenRelease]).slice(0, MAX_RELEASES);
  const [releaseRows, owners] = await Promise.all([
    Promise.all(versions.map(async (version) => await replica.release.findFirst({
      where: {
        tenancyId: options.tenancy.id,
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        version,
      },
      select: {
        id: true,
        version: true,
        status: true,
        dateAdded: true,
        dateStarted: true,
        dateReleased: true,
        deployments: {
          where: {
            tenancyId: options.tenancy.id,
            projectId: options.tenancy.project.id,
            branchId: options.tenancy.branchId,
          },
          orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
          take: MAX_RELEASE_DEPLOYMENTS,
          select: {
            id: true,
            releaseId: true,
            deploymentKey: true,
            environment: true,
            name: true,
            url: true,
            startedAt: true,
            finishedAt: true,
          },
        },
        commits: {
          where: {
            tenancyId: options.tenancy.id,
            projectId: options.tenancy.project.id,
            branchId: options.tenancy.branchId,
          },
          orderBy: [{ position: "asc" }, { id: "asc" }],
          take: MAX_RELEASE_COMMITS,
          select: {
            id: true,
            releaseId: true,
            release: { select: { version: true } },
            repository: true,
            commitSha: true,
            position: true,
            message: true,
            authorName: true,
            committedAt: true,
            url: true,
          },
        },
      },
    }))),
    replica.issueOwner.findMany({
      where: {
        tenancyId: options.tenancy.id,
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        issueId: options.issueId,
        source: PrismaIssueOwnerSource.SUSPECT_COMMIT,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: MAX_SUSPECT_OWNERS,
      select: { id: true, context: true },
    }),
  ]);

  const scopedReleases = releaseRows.filter((release): release is NonNullable<typeof release> => release !== null);
  const releaseCommitsById = new Map<string, IssueReleaseCommitRow>();
  for (const release of scopedReleases) {
    for (const commit of release.commits) {
      releaseCommitsById.set(commit.id, {
        id: commit.id,
        releaseId: commit.releaseId,
        releaseVersion: commit.release.version,
        repository: commit.repository,
        commitSha: commit.commitSha,
        position: commit.position,
        message: commit.message,
        authorName: commit.authorName,
        committedAt: commit.committedAt,
        url: commit.url,
      });
    }
  }
  const releaseCommits: IssueReleaseCommitRow[] = [...releaseCommitsById.values()];
  const references = owners.flatMap((owner) => {
    const reference = parseSuspectCommitReference(owner);
    return reference === null ? [] : [reference];
  });
  const commitIds = uniqueNonNull(references.map((reference) => reference.commitId));
  const commitShas = uniqueNonNull(references.map((reference) => reference.commitSha));
  const suspectCommits = commitIds.length === 0 && commitShas.length === 0
    ? []
    : await replica.releaseCommit.findMany({
      where: {
        tenancyId: options.tenancy.id,
        projectId: options.tenancy.project.id,
        branchId: options.tenancy.branchId,
        OR: [
          ...(commitIds.length === 0 ? [] : [{ id: { in: commitIds } }]),
          ...(commitShas.length === 0 ? [] : [{ commitSha: { in: commitShas } }]),
        ],
        release: {
          projectId: options.tenancy.project.id,
          branchId: options.tenancy.branchId,
        },
      },
      orderBy: [{ committedAt: "desc" }, { position: "asc" }, { id: "asc" }],
      take: MAX_SUSPECT_OWNERS,
      select: {
        id: true,
        releaseId: true,
        release: { select: { version: true } },
        repository: true,
        commitSha: true,
        position: true,
        message: true,
        authorName: true,
        committedAt: true,
        url: true,
      },
    }).then((rows) => rows.map((commit) => ({
      id: commit.id,
      releaseId: commit.releaseId,
      releaseVersion: commit.release.version,
      repository: commit.repository,
      commitSha: commit.commitSha,
      position: commit.position,
      message: commit.message,
      authorName: commit.authorName,
      committedAt: commit.committedAt,
      url: commit.url,
    })));

  const allCommits = [...releaseCommits, ...suspectCommits.filter((candidate) => !releaseCommits.some((commit) => commit.id === candidate.id))];
  const firstReleaseRow = scopedReleases.find((release) => release.version === options.firstSeenRelease) ?? null;
  const lastReleaseRow = scopedReleases.find((release) => release.version === options.lastSeenRelease) ?? null;
  return {
    first_release: firstReleaseRow === null ? null : projectRelease({
      ...firstReleaseRow,
      commits: firstReleaseRow.commits.map((commit) => ({
        ...commit,
        releaseVersion: commit.release.version,
      })),
    }),
    last_release: lastReleaseRow === null ? null : projectRelease({
      ...lastReleaseRow,
      commits: lastReleaseRow.commits.map((commit) => ({
        ...commit,
        releaseVersion: commit.release.version,
      })),
    }),
    release_commits: releaseCommits.map(projectCommit),
    suspect_commits: joinSuspectCommits({
      owners,
      commits: allCommits,
    }),
  };
}

import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { parseArgs } from "node:util";
import type { FreePageReleaseResult } from "../src/databases/piledriver/implementations/breezy/core.js";

const mib = 1024 * 1024;

export const releaseFreePagesHelp = `Usage: pnpm release-free-pages:piledriver [--max-mib N] [--all] [--dry-run] [--url URL]

Gives the Breezylite (SQLite) database's free pages back to the operating system, so the database
file shrinks. It does not delete data and does not run GC.

Free pages are pages that GC has already emptied, and this can only release those. So run GC first
(pnpm gc:piledriver), usually a few times until it reports no more eligible work, then run this.
With no free pages it does nothing; --dry-run shows how many there are.

It runs inside the Bulldozer service, in small chunks with a pause between each, so requests keep
being served. Never run VACUUM or incremental_vacuum from a separate sqlite3 process instead: it takes
the database's write lock, and Bulldozer's writes fail until it finishes.

While it runs, the WAL file next to the database grows by up to about 64 MiB, so keep at least that
much disk free. On a large database under heavy write traffic, an occasional step can still pause
requests for up to a few seconds, so run big releases during quieter periods
(see scripts/gc-and-release-free-pages.md).

Options:
  --max-mib N   release at most N MiB per request (default 1024). Without --all, that's one request
  --all         keep sending --max-mib sized requests while each releases its full N MiB; stops after
                one finds fewer free pages than that, or makes no progress (the summary says which).
                Use both together, e.g. --max-mib 1024 --all, to release everything in bounded steps
  --dry-run     only report the free pages, and whether this file can release them
  --url URL     Bulldozer service URL (default: HEXCLAVE_BULLDOZER_SERVER_URL, or localhost:<port prefix>46)
  -h, --help    show this help

Needs HEXCLAVE_BULLDOZER_SERVER_SECRET.`;

export type ReleaseFreePagesCommand =
  | { kind: "help" }
  | { kind: "dry-run", url: string | undefined }
  | { kind: "release", maxBytes: number, all: boolean, url: string | undefined };

const isHttpUrl = (value: string) => {
  // URL.canParse instead of try/catch: "localhost:8146" parses too, with "localhost:" as its protocol.
  return URL.canParse(value) && ["http:", "https:"].includes(new URL(value).protocol);
};

export function parseReleaseFreePagesArgs(args: string[]): ReleaseFreePagesCommand {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      "max-mib": { type: "string" },
      "all": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "url": { type: "string" },
      "help": { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { kind: "help" };
  // A dry run releases nothing, so a limit or "keep going" would be silently ignored.
  if (values["dry-run"] && (values["max-mib"] !== undefined || values.all)) {
    throw new Error("--dry-run can't be combined with --max-mib or --all: a dry run only reports free pages");
  }
  if (values.url !== undefined && !isHttpUrl(values.url)) throw new Error("--url must be an http:// or https:// URL");
  if (values["dry-run"]) return { kind: "dry-run", url: values.url };
  const maxMiBArgument = values["max-mib"] ?? "1024";
  const maxMiB = Number(maxMiBArgument);
  if (!/^\d+$/.test(maxMiBArgument) || !Number.isSafeInteger(maxMiB * mib) || maxMiB <= 0) {
    throw new Error("--max-mib must be a positive whole number");
  }
  return { kind: "release", maxBytes: maxMiB * mib, all: values.all, url: values.url };
}

const formatMiB = (bytes: number) => `${(bytes / mib).toFixed(1)} MiB`;
const freePagesWithSize = (snapshot: FreePageReleaseResult["after"]) => `${snapshot.freePages} free pages (${formatMiB(snapshot.freePages * snapshot.pageSizeBytes)})`;
const mainFileBytes = (snapshot: FreePageReleaseResult["after"]) => snapshot.fileSizesInBytes["breezy.sqlite"] ?? 0;
const walFileBytes = (snapshot: FreePageReleaseResult["after"]) => snapshot.fileSizesInBytes["breezy.sqlite-wal"] ?? 0;

/** `--all` sends another request only after one that used its whole limit, so every round releases at least --max-mib. */
export function shouldRequestAgain(stoppedBecause: FreePageReleaseResult["stoppedBecause"]) {
  return stoppedBecause === "limit";
}

const nextStepByStopReason = new Map<Exclude<FreePageReleaseResult["stoppedBecause"], "dry-run">, (result: FreePageReleaseResult) => string>([
  ["limit", result => `${freePagesWithSize(result.after)} left: limit reached, run again to release more.`],
  ["no-free-pages", () => "No free pages left. If you expected some, run GC first (pnpm gc:piledriver)."],
  ["no-progress", result => `${freePagesWithSize(result.after)} left, but the last step made no progress; try again when writes are quieter.`],
]);

/** One line for the operator: what happened, and whether running it again would release more. */
export function formatReleaseFreePagesSummary(result: FreePageReleaseResult) {
  if (result.stoppedBecause === "dry-run") {
    const files = `breezy.sqlite is ${formatMiB(mainFileBytes(result.before))}, WAL ${formatMiB(walFileBytes(result.before))}.`;
    return result.before.canRelease
      ? `Dry run: ${freePagesWithSize(result.before)} could be released. ${files}`
      : `Dry run: ${freePagesWithSize(result.before)}, but this file was created without auto_vacuum=INCREMENTAL, so they can't be released incrementally; recreate the database directory to enable it. ${files}`;
  }
  const released = `Released ${formatMiB(result.released.bytes)} in ${result.chunks.count} chunks (slowest ${result.chunks.maxMs.toFixed(1)} ms).`;
  const files = `breezy.sqlite ${formatMiB(mainFileBytes(result.before))} -> ${formatMiB(mainFileBytes(result.after))}, WAL ${formatMiB(walFileBytes(result.after))}.`;
  const nextStep = nextStepByStopReason.get(result.stoppedBecause) ?? throwErr(`No summary for stop reason ${result.stoppedBecause}`);
  return `${released} ${files} ${nextStep(result)}`;
}

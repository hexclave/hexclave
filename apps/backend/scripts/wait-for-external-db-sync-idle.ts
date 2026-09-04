import { upstash } from "@/lib/upstash";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import postgres from "postgres";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const REQUIRED_CONSECUTIVE_IDLE_SAMPLES = 3;
const LOG_INTERVAL_MS = 10_000;
const EXTERNAL_DB_SYNC_PATH = "/api/latest/internal/external-db-sync/sync-engine";
const EXTERNAL_DB_SYNC_FLOW_CONTROL_KEY = "sentinel-sync-key";

const timeoutMs = Number.parseInt(
  getEnvVariable("HEXCLAVE_EXTERNAL_DB_SYNC_IDLE_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)),
  10,
);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  throw new Error(`HEXCLAVE_EXTERNAL_DB_SYNC_IDLE_TIMEOUT_MS must be a positive integer, received ${timeoutMs}.`);
}

const sql = postgres(getEnvVariable("STACK_DATABASE_CONNECTION_STRING"), { max: 1 });

type DatabaseActivity = {
  pending_tables: string[],
  outgoing_requests: number,
  sequencer_fingerprint: string,
};

type IdleSample = DatabaseActivity & {
  qstash_waiting: number,
  qstash_unfinished: number,
};

async function getDatabaseActivity(): Promise<DatabaseActivity> {
  const rows = await sql<DatabaseActivity[]>`
    SELECT
      ARRAY_REMOVE(ARRAY[
        CASE WHEN EXISTS (
          SELECT 1 FROM "ProjectUser"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'ProjectUser' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "ContactChannel"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'ContactChannel' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "Team"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'Team' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "TeamMember"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'TeamMember' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "TeamMemberDirectPermission"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'TeamMemberDirectPermission' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "VerificationCode"
          WHERE "type" = 'TEAM_INVITATION'
            AND ("shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL)
        ) THEN 'VerificationCode_TEAM_INVITATION' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "EmailOutbox"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'EmailOutbox' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "ProjectUserDirectPermission"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'ProjectUserDirectPermission' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "UserNotificationPreference"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'UserNotificationPreference' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "ProjectUserRefreshToken"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'ProjectUserRefreshToken' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "ProjectUserOAuthAccount"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'ProjectUserOAuthAccount' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM "DeletedRow"
          WHERE "shouldUpdateSequenceId" = TRUE OR "sequenceId" IS NULL
        ) THEN 'DeletedRow' END
      ], NULL)::text[] AS pending_tables,
      (
        SELECT COUNT(*)::integer
        FROM "OutgoingRequest"
        WHERE ("qstashOptions"->>'url') = '/api/latest/internal/external-db-sync/sync-engine'
      ) AS outgoing_requests,
      (
        SELECT json_build_object('last_value', last_value::text, 'is_called', is_called)::text
        FROM global_seq_id
      ) AS sequencer_fingerprint
  `;
  return rows[0];
}

type QstashMessageState = {
  state: string,
};

async function getQstashLifecycleActivity(): Promise<{ unfinished: number, failedMessageIds: string[] }> {
  const latestByMessageId = new Map<string, QstashMessageState>();
  let cursor: string | number | undefined;

  while (true) {
    const response = await upstash.logs({ cursor, filter: { count: 100 } });
    for (const log of response.logs) {
      if (!log.url.endsWith(EXTERNAL_DB_SYNC_PATH) || latestByMessageId.has(log.messageId)) continue;
      // QStash returns lifecycle events newest-first. Keeping the first event per message reduces
      // historical CREATED/ACTIVE events to the message's current state.
      latestByMessageId.set(log.messageId, { state: log.state });
    }

    if (response.cursor == null) break;
    if (response.cursor === cursor) {
      throw new Error(`QStash log pagination returned the same cursor twice: ${response.cursor}.`);
    }
    cursor = response.cursor;
  }

  const unfinishedStates = new Set(["CREATED", "ACTIVE", "RETRY", "ERROR"]);
  const failedStates = new Set(["FAILED", "CANCELED"]);
  const failedMessageIds: string[] = [];
  let unfinished = 0;

  for (const [messageId, message] of latestByMessageId) {
    if (unfinishedStates.has(message.state)) unfinished++;
    if (failedStates.has(message.state)) failedMessageIds.push(messageId);
  }

  return { unfinished, failedMessageIds };
}

async function getQstashWaitListSize(): Promise<number> {
  const baseUrl = getEnvVariable("STACK_QSTASH_URL");
  const response = await fetch(
    new URL(`/v2/flowControl/${encodeURIComponent(EXTERNAL_DB_SYNC_FLOW_CONTROL_KEY)}`, baseUrl),
    { headers: { Authorization: `Bearer ${getEnvVariable("STACK_QSTASH_TOKEN")}` } },
  );
  if (!response.ok) {
    throw new Error(`QStash flow-control status returned HTTP ${response.status}: ${await response.text()}`);
  }

  const body: unknown = await response.json();
  if (body == null || typeof body !== "object") {
    throw new Error(`QStash flow-control status returned a non-object: ${JSON.stringify(body)}`);
  }
  const waitListSize = body["waitListSize"];
  if (typeof waitListSize !== "number" || !Number.isSafeInteger(waitListSize) || waitListSize < 0) {
    throw new Error(`QStash flow-control status returned an invalid waitListSize: ${JSON.stringify(body)}`);
  }
  return waitListSize;
}

async function getIdleSample(): Promise<IdleSample> {
  const before = await getDatabaseActivity();
  const [lifecycle, waitListSize] = await Promise.all([
    getQstashLifecycleActivity(),
    getQstashWaitListSize(),
  ]);
  const after = await getDatabaseActivity();

  if (lifecycle.failedMessageIds.length > 0) {
    throw new Error(
      `External DB sync has terminally failed QStash messages: ${lifecycle.failedMessageIds.slice(0, 10).join(", ")}.`,
    );
  }

  // The second read closes the race where the sequencer queues work while QStash is being inspected.
  return {
    pending_tables: [...new Set([...before.pending_tables, ...after.pending_tables])],
    outgoing_requests: Math.max(before.outgoing_requests, after.outgoing_requests),
    sequencer_fingerprint: before.sequencer_fingerprint === after.sequencer_fingerprint
      ? after.sequencer_fingerprint
      : `${before.sequencer_fingerprint} -> ${after.sequencer_fingerprint}`,
    qstash_waiting: waitListSize,
    qstash_unfinished: lifecycle.unfinished,
  };
}

function isIdle(sample: IdleSample): boolean {
  return sample.pending_tables.length === 0
    && sample.outgoing_requests === 0
    && !sample.sequencer_fingerprint.includes(" -> ")
    && sample.qstash_waiting === 0
    && sample.qstash_unfinished === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForIdle(): Promise<void> {
  const startedAt = performance.now();
  let consecutiveIdleSamples = 0;
  let nextLogAt = 0;
  let latestSample: IdleSample | null = null;
  let previousIdleFingerprint: string | null = null;

  while (performance.now() - startedAt < timeoutMs) {
    latestSample = await getIdleSample();
    if (isIdle(latestSample)) {
      consecutiveIdleSamples = latestSample.sequencer_fingerprint === previousIdleFingerprint
        ? consecutiveIdleSamples + 1
        : 1;
      previousIdleFingerprint = latestSample.sequencer_fingerprint;
    } else {
      consecutiveIdleSamples = 0;
      previousIdleFingerprint = null;
    }

    const elapsedMs = performance.now() - startedAt;
    if (elapsedMs >= nextLogAt || consecutiveIdleSamples === REQUIRED_CONSECUTIVE_IDLE_SAMPLES) {
      console.log(JSON.stringify({
        event: "external-db-sync-idle-wait",
        elapsed_ms: Math.round(elapsedMs),
        consecutive_idle_samples: consecutiveIdleSamples,
        ...latestSample,
      }));
      nextLogAt = elapsedMs + LOG_INTERVAL_MS;
    }

    if (consecutiveIdleSamples >= REQUIRED_CONSECUTIVE_IDLE_SAMPLES) {
      // QStash marks a message delivered only after the sync-engine handler returns, so an empty
      // QStash plus empty database queues also means all accepted ClickHouse writes have completed.
      return;
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `External DB sync did not become idle within ${timeoutMs}ms. Last sample: ${JSON.stringify(latestSample)}`,
  );
}

try {
  await waitForIdle();
} finally {
  await sql.end();
}

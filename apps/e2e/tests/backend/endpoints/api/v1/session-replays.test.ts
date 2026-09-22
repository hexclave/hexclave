import { randomBytes, randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { PLAN_LIMITS } from "@hexclave/shared/dist/plans";
import { wait } from "@hexclave/shared/dist/utils/promises";
import { it } from "../../../../helpers";
import { Auth, Project, Team, backendContext, bumpEmailAddress, niceBackendFetch, withInternalProject } from "../../../backend-helpers";

/**
 * Response bodies come back as `any` from the fetch helper; this narrows a list
 * of them to something indexable so the tests can read fields without casts.
 */
function asObjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

async function uploadBatch(options: {
  browserSessionId: string,
  batchId: string,
  startedAtMs: number,
  sentAtMs: number,
  events: unknown[],
  sessionReplaySegmentId?: string,
}) {
  return await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: options.browserSessionId,
      session_replay_segment_id: options.sessionReplaySegmentId ?? randomUUID(),
      batch_id: options.batchId,
      started_at_ms: options.startedAtMs,
      sent_at_ms: options.sentAtMs,
      events: options.events,
    },
  });
}

it("requires a user token", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  backendContext.set({ userAuth: null });

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      started_at_ms: Date.now(),
      sent_at_ms: Date.now(),
      events: [{ timestamp: Date.now() }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "USER_AUTHENTICATION_REQUIRED",
        "error": "User authentication required for this endpoint.",
      },
      "headers": Headers {
        "x-stack-known-error": "USER_AUTHENTICATION_REQUIRED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("throws error when analytics is not enabled", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  // Analytics is disabled by default - do NOT call Project.updateConfig
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      started_at_ms: Date.now(),
      sent_at_ms: Date.now(),
      events: [{ timestamp: Date.now() }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "ANALYTICS_NOT_ENABLED",
        "error": "Analytics is not enabled for this project.",
      },
      "headers": Headers {
        "x-stack-known-error": "ANALYTICS_NOT_ENABLED",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("stores session replay batch metadata and dedupes by (session_replay_id, batch_id)", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const now = Date.now();
  const browserSessionId = randomUUID();
  const batchId = randomUUID();
  const sessionReplaySegmentId = randomUUID();

  const first = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: browserSessionId,
      session_replay_segment_id: sessionReplaySegmentId,
      batch_id: batchId,
      started_at_ms: now,
      sent_at_ms: now + 500,
      events: [
        { timestamp: now + 100, type: 2 },
        { timestamp: now + 200, type: 3 },
      ],
    },
  });

  expect(first).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "batch_id": "<stripped UUID>",
        "deduped": false,
        "s3_key": "session-replays/<stripped UUID>/main/<stripped UUID>/<stripped UUID>.json.gz",
        "session_replay_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(typeof first.body?.session_replay_id).toBe("string");

  const recordingId = first.body?.session_replay_id;

  const second = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: browserSessionId,
      session_replay_segment_id: sessionReplaySegmentId,
      batch_id: batchId,
      started_at_ms: now,
      sent_at_ms: now + 500,
      events: [{ timestamp: now + 150, type: 2 }],
    },
  });

  expect(second).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "batch_id": "<stripped UUID>",
        "deduped": true,
        "s3_key": "session-replays/<stripped UUID>/main/<stripped UUID>/<stripped UUID>.json.gz",
        "session_replay_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(second.body?.session_replay_id).toBe(recordingId);
});

it("accepts a gzipped binary body (compressed large-payload encoding)", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const now = Date.now();
  const payload = {
    browser_session_id: randomUUID(),
    session_replay_segment_id: randomUUID(),
    batch_id: randomUUID(),
    started_at_ms: now,
    sent_at_ms: now + 500,
    // Large full snapshot: exceeds the 1MB raw wire limit but gzips under it.
    events: [{ timestamp: now + 100, type: 2, data: { html: "x".repeat(2_000_000) } }],
  };
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload), "utf-8"));
  // Sanity: the raw payload exceeds the wire limit, the compressed one doesn't.
  expect(compressed.byteLength).toBeLessThan(1_000_000);

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    rawBody: compressed,
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "batch_id": "<stripped UUID>",
        "deduped": false,
        "s3_key": "session-replays/<stripped UUID>/main/<stripped UUID>/<stripped UUID>.json.gz",
        "session_replay_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a binary body that isn't valid gzip", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    rawBody: new Uint8Array([0, 1, 2, 3, 4, 5]),
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Invalid encoded session replay body",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a binary body larger than the compressed size cap", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  // Random bytes don't compress, so the byteLength check fires before gunzip.
  // 1.1 MB > the 1 MB MAX_BODY_BYTES cap.
  const oversized = new Uint8Array(randomBytes(Math.floor(1.1 * 1024 * 1024)));

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    rawBody: oversized,
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 413,
      "body": "Encoded session replay body too large (max 1000000 bytes)",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects a gzipped body that decompresses past the server size cap", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  // 9 MB of zeros gzips to ~9 KB but decompresses past the 8 MB server cap.
  const bomb = gzipSync(Buffer.alloc(9 * 1024 * 1024));

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    rawBody: bomb,
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Invalid encoded session replay body",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects empty events", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      started_at_ms: Date.now(),
      sent_at_ms: Date.now(),
      events: [],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "events must not be empty",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects too many events", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const tooManyEvents = Array.from({ length: 5001 }, (_, i) => ({ timestamp: 1_700_000_000_000 + i }));

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      started_at_ms: 1_700_000_000_000,
      sent_at_ms: 1_700_000_000_100,
      events: tooManyEvents,
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "Too many events (max 5000)",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("rejects invalid browser_session_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: "not-a-uuid",
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      started_at_ms: Date.now(),
      sent_at_ms: Date.now(),
      events: [{ timestamp: Date.now() }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/session-replays/batch:
              - Invalid browser_session_id
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/session-replays/batch:
            - Invalid browser_session_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects invalid batch_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: randomUUID(),
      batch_id: "not-a-uuid",
      started_at_ms: Date.now(),
      sent_at_ms: Date.now(),
      events: [{ timestamp: Date.now() }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/session-replays/batch:
              - Invalid batch_id
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/session-replays/batch:
            - Invalid batch_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects invalid session_replay_segment_id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: "not-a-uuid",
      batch_id: randomUUID(),
      started_at_ms: Date.now(),
      sent_at_ms: Date.now(),
      events: [{ timestamp: Date.now() }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/session-replays/batch:
              - Invalid session_replay_segment_id
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/session-replays/batch:
            - Invalid session_replay_segment_id
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("accepts events without timestamps (falls back to sent_at_ms)", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const browserSessionId = randomUUID();
  const batchId = randomUUID();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: browserSessionId,
      session_replay_segment_id: randomUUID(),
      batch_id: batchId,
      started_at_ms: 1_700_000_000_000,
      sent_at_ms: 1_700_000_000_500,
      events: [{ type: 2 }, { type: 3, timestamp: undefined }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "batch_id": "<stripped UUID>",
        "deduped": false,
        "s3_key": "session-replays/<stripped UUID>/main/<stripped UUID>/<stripped UUID>.json.gz",
        "session_replay_id": "<stripped UUID>",
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
  expect(typeof res.body?.session_replay_id).toBe("string");
});

it("rejects non-integer started_at_ms", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      started_at_ms: 123.4,
      sent_at_ms: Date.now(),
      events: [{ timestamp: Date.now() }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": {
        "code": "SCHEMA_ERROR",
        "details": {
          "message": deindent\`
            Request validation failed on POST /api/v1/session-replays/batch:
              - body.started_at_ms must be an integer
          \`,
        },
        "error": deindent\`
          Request validation failed on POST /api/v1/session-replays/batch:
            - body.started_at_ms must be an integer
        \`,
      },
      "headers": Headers {
        "x-stack-known-error": "SCHEMA_ERROR",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("rejects oversized payloads", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  // Backend limit is 1_000_000 bytes; a single large string is sufficient to exceed it.
  const hugeString = "a".repeat(1_100_000);

  const res = await niceBackendFetch("/api/v1/session-replays/batch", {
    method: "POST",
    accessType: "client",
    body: {
      browser_session_id: randomUUID(),
      session_replay_segment_id: randomUUID(),
      batch_id: randomUUID(),
      started_at_ms: Date.now(),
      sent_at_ms: Date.now(),
      events: [{ timestamp: Date.now(), data: hugeString }],
    },
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 413,
      "body": "Request body too large (max 1000000 bytes)",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("admin can list session replays, list chunks, and fetch events", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const browserSessionId = randomUUID();
  const batchId = randomUUID();
  const events = [
    { type: 1, timestamp: 1_700_000_000_100, data: { a: 1 } },
    { type: 2, timestamp: 1_700_000_000_200, data: { b: 2 } },
  ];

  const uploadRes = await uploadBatch({
    browserSessionId,
    batchId,
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_500,
    events,
  });
  expect(uploadRes.status).toBe(200);
  const recordingId = uploadRes.body?.session_replay_id;
  expect(typeof recordingId).toBe("string");

  const listRes = await niceBackendFetch("/api/v1/session-replays", {
    method: "GET",
    accessType: "admin",
  });
  expect(listRes.status).toBe(200);
  expect(listRes.body?.items?.length).toBeGreaterThanOrEqual(1);

  const chunksRes = await niceBackendFetch(`/api/v1/session-replays/${recordingId}/chunks`, {
    method: "GET",
    accessType: "admin",
  });
  expect(chunksRes.status).toBe(200);
  const chunkId = chunksRes.body?.items?.[0]?.id;
  expect(typeof chunkId).toBe("string");
  if (typeof chunkId !== "string") {
    throw new Error("Expected session replay chunks response to include an item id.");
  }

  const eventsRes = await niceBackendFetch(`/api/v1/session-replays/${recordingId}/chunks/${chunkId}/events`, {
    method: "GET",
    accessType: "admin",
  });
  expect(eventsRes.status).toBe(200);
  expect(eventsRes.body?.events?.length).toBe(events.length);
});

it("admin list session replays paginates without skipping items", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  // Use separate sign-ins to get different refresh tokens → different session replays.
  await Auth.fastSignUp();
  const uploadA = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_300,
    events: [{ type: 1, timestamp: 1_700_000_000_100 }],
  });
  expect(uploadA.status).toBe(200);
  const recordingA = uploadA.body?.session_replay_id;

  await Auth.fastSignUp();
  const uploadB = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_400,
    events: [{ type: 1, timestamp: 1_700_000_000_200 }],
  });
  expect(uploadB.status).toBe(200);
  const recordingB = uploadB.body?.session_replay_id;

  // Wait for ClickHouse to ingest both replays before paginating
  await listReplaysWithRetry(
    {},
    (res) => {
      const items = res.body?.items ?? [];
      const ids = items.map((i: any) => i.id);
      return res.status === 200 && ids.includes(recordingA) && ids.includes(recordingB);
    },
  );

  const first = await niceBackendFetch("/api/v1/session-replays?limit=1", {
    method: "GET",
    accessType: "admin",
  });
  expect(first.status).toBe(200);
  expect(first.body?.items?.length).toBe(1);
  const firstId = first.body?.items?.[0]?.id;
  expect([recordingA, recordingB]).toContain(firstId);

  const nextCursor = first.body?.pagination?.next_cursor;
  expect(typeof nextCursor).toBe("string");
  if (typeof nextCursor !== "string") {
    throw new Error("Expected next_cursor to be a string.");
  }

  const second = await niceBackendFetch(`/api/v1/session-replays?limit=1&cursor=${encodeURIComponent(nextCursor)}`, {
    method: "GET",
    accessType: "admin",
  });
  expect(second.status).toBe(200);
  expect(second.body?.items?.length).toBe(1);
  const secondId = second.body?.items?.[0]?.id;
  expect([recordingA, recordingB]).toContain(secondId);
  expect(secondId).not.toBe(firstId);
});

it("admin can fetch a single session replay by id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const upload = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_400,
    events: [
      { type: 2, timestamp: 1_700_000_000_100 },
      { type: 3, timestamp: 1_700_000_000_250 },
    ],
  });
  expect(upload.status).toBe(200);
  const recordingId = upload.body?.session_replay_id;
  expect(typeof recordingId).toBe("string");
  if (typeof recordingId !== "string") {
    throw new Error("Expected session replay id.");
  }

  const res = await niceBackendFetch(`/api/v1/session-replays/${recordingId}`, {
    method: "GET",
    accessType: "admin",
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 200,
      "body": {
        "chunk_count": 1,
        "event_count": 2,
        "id": "<stripped UUID>",
        "last_event_at_millis": 1700000000250,
        "project_user": {
          "display_name": null,
          "id": "<stripped UUID>",
          "primary_email": null,
        },
        "refresh_token_id": <stripped field 'refresh_token_id'>,
        "started_at_millis": 1700000000100,
      },
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("admin session replay endpoints expose the recording session's refresh token", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ "apps.installed.analytics.enabled": true });
  await Auth.fastSignUp();

  const upload = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_400,
    events: [{ type: 1, timestamp: 1_700_000_000_100 }],
  });
  expect(upload.status).toBe(200);
  const recordingId = upload.body?.session_replay_id;
  if (typeof recordingId !== "string") {
    throw new Error("Expected session replay id.");
  }

  // The session that uploaded the replay, straight from the sessions endpoint —
  // asserting against this is what proves the field isn't just some other UUID
  // (the replay's own id, say) that happens to survive snapshot anonymization.
  const sessions = await niceBackendFetch("/api/v1/auth/sessions?user_id=me", {
    method: "GET",
    accessType: "client",
  });
  expect(sessions.status).toBe(200);
  const currentSessionId = asObjects(sessions.body?.items).find(s => s.is_current_session === true)?.id;
  if (typeof currentSessionId !== "string") {
    throw new Error("Expected the signed-in session to be listed as the current session.");
  }

  const single = await niceBackendFetch(`/api/v1/session-replays/${encodeURIComponent(recordingId)}`, {
    method: "GET",
    accessType: "admin",
  });
  expect(single.status).toBe(200);
  expect(single.body?.refresh_token_id).toBe(currentSessionId);

  const list = await listReplaysWithRetry(
    {},
    (res) => res.status === 200 && asObjects(res.body?.items).some(i => i.id === recordingId),
  );
  const listed = asObjects(list.body?.items).find(i => i.id === recordingId);
  expect(listed?.refresh_token_id).toBe(currentSessionId);
});

it("admin get session replay returns 404 for nonexistent id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.fastSignUp();

  const fakeId = randomUUID();
  const res = await niceBackendFetch(`/api/v1/session-replays/${fakeId}`, {
    method: "GET",
    accessType: "admin",
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "ITEM_NOT_FOUND",
        "details": { "item_id": "<stripped UUID>" },
        "error": "Item with ID \\"<stripped UUID>\\" not found.",
      },
      "headers": Headers {
        "x-stack-known-error": "ITEM_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("client access cannot call single session replay endpoint, but server access can", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const upload = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_400,
    events: [{ type: 1, timestamp: 1_700_000_000_100 }],
  });
  expect(upload.status).toBe(200);
  const recordingId = upload.body?.session_replay_id;
  expect(typeof recordingId).toBe("string");

  const clientRes = await niceBackendFetch(`/api/v1/session-replays/${recordingId}`, {
    method: "GET",
    accessType: "client",
  });
  expect(clientRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "INSUFFICIENT_ACCESS_TYPE",
        "details": {
          "actual_access_type": "client",
          "allowed_access_types": [
            "server",
            "admin",
          ],
        },
        "error": "The x-hexclave-access-type header must be 'server' or 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
        <some fields may have been hidden>,
      },
    }
  `);

  // Server keys read session replays too: the SDK methods live on the server
  // app, so a secret server key is sufficient. Only client access is rejected.
  const serverRes = await niceBackendFetch(`/api/v1/session-replays/${recordingId}`, {
    method: "GET",
    accessType: "server",
  });
  expect(serverRes.status).toBe(200);
  expect(serverRes.body.id).toBe(recordingId);
});

it("admin list session replays rejects unknown cursor", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.fastSignUp();

  const cursor = randomUUID();
  const res = await niceBackendFetch(`/api/v1/session-replays?cursor=${encodeURIComponent(cursor)}`, {
    method: "GET",
    accessType: "admin",
  });

  expect(res).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "ITEM_NOT_FOUND",
        "details": { "item_id": "<stripped UUID>" },
        "error": "Item with ID \\"<stripped UUID>\\" not found.",
      },
      "headers": Headers {
        "x-stack-known-error": "ITEM_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("admin list chunks paginates and rejects a cursor from another session", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const now = Date.now();

  // session1: two batches under first refresh token
  await Auth.fastSignUp();
  const upload1a = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 1, timestamp: now + 10 }],
  });
  expect(upload1a.status).toBe(200);
  const recording1 = upload1a.body?.session_replay_id;

  await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 600,
    events: [{ type: 1, timestamp: now + 20 }],
  });

  // session2: one batch under a different refresh token
  await Auth.fastSignUp();
  const upload2 = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 700,
    events: [{ type: 1, timestamp: now + 30 }],
  });
  expect(upload2.status).toBe(200);
  const recording2 = upload2.body?.session_replay_id;

  // Wait for ClickHouse to ingest both sessions' chunks before paginating
  let first: any;
  for (let attempt = 0; attempt < 30; attempt++) {
    first = await niceBackendFetch(`/api/v1/session-replays/${recording1}/chunks?limit=1`, {
      method: "GET",
      accessType: "admin",
    });
    if (first.status === 200 && (first.body?.items?.length ?? 0) >= 1 && first.body?.pagination?.next_cursor) break;
    await wait(500);
  }
  expect(first.status).toBe(200);
  expect(first.body?.items?.length).toBe(1);

  const nextCursor = first.body?.pagination?.next_cursor;
  expect(typeof nextCursor).toBe("string");
  if (typeof nextCursor !== "string") {
    throw new Error("Expected next_cursor to be a string.");
  }

  const second = await niceBackendFetch(`/api/v1/session-replays/${recording1}/chunks?limit=1&cursor=${encodeURIComponent(nextCursor)}`, {
    method: "GET",
    accessType: "admin",
  });
  expect(second.status).toBe(200);
  expect(second.body?.items?.length).toBe(1);
  expect(second.body?.items?.[0]?.id).not.toBe(first.body?.items?.[0]?.id);

  // Cursor from another session should be rejected.
  const otherChunks = await niceBackendFetch(`/api/v1/session-replays/${recording2}/chunks?limit=1`, {
    method: "GET",
    accessType: "admin",
  });
  expect(otherChunks.status).toBe(200);
  const otherCursor = otherChunks.body?.items?.[0]?.id;
  expect(typeof otherCursor).toBe("string");
  if (typeof otherCursor !== "string") {
    throw new Error("Expected otherCursor to be a string.");
  }

  const bad = await niceBackendFetch(`/api/v1/session-replays/${recording1}/chunks?cursor=${encodeURIComponent(otherCursor)}`, {
    method: "GET",
    accessType: "admin",
  });
  expect(bad).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "ITEM_NOT_FOUND",
        "details": { "item_id": "<stripped UUID>" },
        "error": "Item with ID \\"<stripped UUID>\\" not found.",
      },
      "headers": Headers {
        "x-stack-known-error": "ITEM_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("admin events endpoint does not allow fetching a chunk via the wrong session id", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  // session1: upload under first refresh token
  await Auth.fastSignUp();
  const batchId = randomUUID();
  const upload1 = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId,
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_500,
    events: [{ type: 1, timestamp: 1_700_000_000_010 }],
  });
  expect(upload1.status).toBe(200);
  const recording1 = upload1.body?.session_replay_id;

  // session2: upload under a different refresh token
  await Auth.fastSignUp();
  const upload2 = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_600,
    events: [{ type: 1, timestamp: 1_700_000_000_020 }],
  });
  expect(upload2.status).toBe(200);
  const recording2 = upload2.body?.session_replay_id;

  const chunks = await niceBackendFetch(`/api/v1/session-replays/${recording1}/chunks`, {
    method: "GET",
    accessType: "admin",
  });
  expect(chunks.status).toBe(200);
  const chunkId = chunks.body?.items?.[0]?.id;
  expect(typeof chunkId).toBe("string");
  if (typeof chunkId !== "string") {
    throw new Error("Expected chunk id.");
  }

  const wrong = await niceBackendFetch(`/api/v1/session-replays/${recording2}/chunks/${chunkId}/events`, {
    method: "GET",
    accessType: "admin",
  });
  expect(wrong).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 404,
      "body": {
        "code": "ITEM_NOT_FOUND",
        "details": { "item_id": "<stripped UUID>" },
        "error": "Item with ID \\"<stripped UUID>\\" not found.",
      },
      "headers": Headers {
        "x-stack-known-error": "ITEM_NOT_FOUND",
        <some fields may have been hidden>,
      },
    }
  `);
});

it("client access cannot call internal session replays endpoints, but server access can", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.fastSignUp();

  const clientRes = await niceBackendFetch("/api/v1/session-replays", {
    method: "GET",
    accessType: "client",
  });
  expect(clientRes).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 401,
      "body": {
        "code": "INSUFFICIENT_ACCESS_TYPE",
        "details": {
          "actual_access_type": "client",
          "allowed_access_types": [
            "server",
            "admin",
          ],
        },
        "error": "The x-hexclave-access-type header must be 'server' or 'admin', but was 'client'. (The legacy x-stack-access-type header is also accepted.)",
      },
      "headers": Headers {
        "x-stack-known-error": "INSUFFICIENT_ACCESS_TYPE",
        <some fields may have been hidden>,
      },
    }
  `);

  const serverRes = await niceBackendFetch("/api/v1/session-replays", {
    method: "GET",
    accessType: "server",
  });
  expect(serverRes.status).toBe(200);
  expect(Array.isArray(serverRes.body.items)).toBe(true);
});

it("groups batches from same refresh token into one session replay", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  await Auth.fastSignUp();

  const now = Date.now();

  // Two batches with different browser_session_ids but same refresh token
  const upload1 = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 300,
    events: [{ type: 1, timestamp: now + 100 }],
  });
  expect(upload1.status).toBe(200);

  const upload2 = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 400,
    events: [{ type: 1, timestamp: now + 200 }],
  });
  expect(upload2.status).toBe(200);

  // Same refresh token within idle timeout → same session replay
  expect(upload1.body?.session_replay_id).toBe(upload2.body?.session_replay_id);
});

async function uploadEventBatch(options: {
  sessionReplaySegmentId: string,
  batchId: string,
  sentAtMs: number,
  events: { event_type: string, event_at_ms: number, data: unknown }[],
}) {
  return await niceBackendFetch("/api/v1/analytics/events/batch", {
    method: "POST",
    accessType: "client",
    body: {
      session_replay_segment_id: options.sessionReplaySegmentId,
      batch_id: options.batchId,
      sent_at_ms: options.sentAtMs,
      events: options.events,
    },
  });
}

async function listReplays(queryParams: Record<string, string> = {}) {
  const params = new URLSearchParams(queryParams);
  const qs = params.toString();
  return await niceBackendFetch(`/api/v1/session-replays${qs ? `?${qs}` : ""}`, {
    method: "GET",
    accessType: "admin",
  });
}

async function listReplaysWithRetry(
  queryParams: Record<string, string>,
  predicate: (res: Awaited<ReturnType<typeof listReplays>>) => boolean,
  options: { attempts?: number, delayMs?: number } = {},
) {
  const attempts = options.attempts ?? 30;
  const delayMs = options.delayMs ?? 500;
  let res = await listReplays(queryParams);
  for (let i = 0; i < attempts; i++) {
    if (predicate(res)) return res;
    await wait(delayMs);
    res = await listReplays(queryParams);
  }
  return res;
}

it("admin list session replays filters by user_ids", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  // User A
  const userA = await Auth.fastSignUp();
  const uploadA = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_500,
    events: [{ type: 1, timestamp: 1_700_000_000_100 }],
  });
  expect(uploadA.status).toBe(200);

  // User B
  const userB = await Auth.fastSignUp();
  const uploadB = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_600,
    events: [{ type: 1, timestamp: 1_700_000_000_200 }],
  });
  expect(uploadB.status).toBe(200);

  // Wait for ClickHouse to ingest both replays before asserting filters
  const resBoth = await listReplaysWithRetry(
    { user_ids: `${userA.userId},${userB.userId}` },
    (res) => res.status === 200 && res.body?.items?.length === 2,
  );
  expect(resBoth.status).toBe(200);
  expect(resBoth.body?.items?.length).toBe(2);

  // Filter by user A only (ClickHouse already confirmed ingested above)
  const resA = await listReplaysWithRetry(
    { user_ids: userA.userId },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(resA.status).toBe(200);
  expect(resA.body?.items?.length).toBe(1);
  expect(resA.body?.items?.[0]?.project_user?.id).toBe(userA.userId);

  // Filter by user B only
  const resB = await listReplaysWithRetry(
    { user_ids: userB.userId },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(resB.status).toBe(200);
  expect(resB.body?.items?.length).toBe(1);
  expect(resB.body?.items?.[0]?.project_user?.id).toBe(userB.userId);

  // Filter by nonexistent user
  const resNone = await listReplays({ user_ids: randomUUID() });
  expect(resNone.status).toBe(200);
  expect(resNone.body?.items?.length).toBe(0);
});

it("admin list session replays filters by team_ids", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  // User A — member of a team
  const userA = await Auth.fastSignUp();
  const uploadA = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_500,
    events: [{ type: 1, timestamp: 1_700_000_000_100 }],
  });
  expect(uploadA.status).toBe(200);

  const { teamId } = await Team.create({ accessType: "server", creatorUserId: userA.userId });

  // User B — not in any team
  await bumpEmailAddress();
  await Auth.fastSignUp();
  const uploadB = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_600,
    events: [{ type: 1, timestamp: 1_700_000_000_200 }],
  });
  expect(uploadB.status).toBe(200);

  // Filter by team → only user A's replay (wait for ClickHouse to ingest)
  const resTeam = await listReplaysWithRetry(
    { team_ids: teamId },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(resTeam.status).toBe(200);
  expect(resTeam.body?.items?.length).toBe(1);
  expect(resTeam.body?.items?.[0]?.project_user?.id).toBe(userA.userId);

  // Nonexistent team → empty
  const resNone = await listReplays({ team_ids: randomUUID() });
  expect(resNone.status).toBe(200);
  expect(resNone.body?.items?.length).toBe(0);
});

it("admin list session replays filters by duration range", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const baseTime = 1_700_000_000_000;

  // Short replay: 5 seconds (first event → last event = 5000ms)
  await Auth.fastSignUp();
  const uploadShort = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: baseTime,
    sentAtMs: baseTime + 5500,
    events: [
      { type: 1, timestamp: baseTime },
      { type: 1, timestamp: baseTime + 5000 },
    ],
  });
  expect(uploadShort.status).toBe(200);
  const shortId = uploadShort.body?.session_replay_id;

  // Long replay: 30 seconds (first event → last event = 30000ms)
  await bumpEmailAddress();
  await Auth.fastSignUp();
  const uploadLong = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: baseTime,
    sentAtMs: baseTime + 30500,
    events: [
      { type: 1, timestamp: baseTime },
      { type: 1, timestamp: baseTime + 30000 },
    ],
  });
  expect(uploadLong.status).toBe(200);
  const longId = uploadLong.body?.session_replay_id;

  // Wait for ClickHouse to ingest both replays before asserting filters
  const resBoth = await listReplaysWithRetry(
    { duration_ms_min: "0", duration_ms_max: "50000" },
    (res) => res.status === 200 && res.body?.items?.length === 2,
  );
  expect(resBoth.status).toBe(200);
  expect(resBoth.body?.items?.length).toBe(2);

  // duration_ms_min=10000 → only long replay
  const resMin = await listReplaysWithRetry(
    { duration_ms_min: "10000" },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(resMin.status).toBe(200);
  expect(resMin.body?.items?.length).toBe(1);
  expect(resMin.body?.items?.[0]?.id).toBe(longId);

  // duration_ms_max=10000 → only short replay
  const resMax = await listReplaysWithRetry(
    { duration_ms_max: "10000" },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(resMax.status).toBe(200);
  expect(resMax.body?.items?.length).toBe(1);
  expect(resMax.body?.items?.[0]?.id).toBe(shortId);

  // duration range that includes neither: 10000–20000
  const resNeither = await listReplays({ duration_ms_min: "10000", duration_ms_max: "20000" });
  expect(resNeither.status).toBe(200);
  expect(resNeither.body?.items?.length).toBe(0);
});

it("admin list session replays filters by last_event_at time range", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const earlyTime = 1_700_000_000_000;
  const lateTime = 1_700_000_100_000; // 100 seconds later

  // Early replay
  await Auth.fastSignUp();
  const uploadEarly = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: earlyTime,
    sentAtMs: earlyTime + 500,
    events: [{ type: 1, timestamp: earlyTime + 100 }],
  });
  expect(uploadEarly.status).toBe(200);
  const earlyId = uploadEarly.body?.session_replay_id;

  // Late replay
  await bumpEmailAddress();
  await Auth.fastSignUp();
  const uploadLate = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: lateTime,
    sentAtMs: lateTime + 500,
    events: [{ type: 1, timestamp: lateTime + 100 }],
  });
  expect(uploadLate.status).toBe(200);
  const lateId = uploadLate.body?.session_replay_id;

  // Wait for ClickHouse to ingest both replays before asserting filters
  const midpoint = earlyTime + 50_000;
  const resBoth = await listReplaysWithRetry(
    { last_event_at_from_millis: String(earlyTime), last_event_at_to_millis: String(lateTime + 200) },
    (res) => res.status === 200 && res.body?.items?.length === 2,
  );
  expect(resBoth.status).toBe(200);
  expect(resBoth.body?.items?.length).toBe(2);

  // Filter from midpoint → only late replay
  const resFrom = await listReplaysWithRetry(
    { last_event_at_from_millis: String(midpoint) },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(resFrom.status).toBe(200);
  expect(resFrom.body?.items?.length).toBe(1);
  expect(resFrom.body?.items?.[0]?.id).toBe(lateId);

  // Filter to midpoint → only early replay
  const resTo = await listReplaysWithRetry(
    { last_event_at_to_millis: String(midpoint) },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(resTo.status).toBe(200);
  expect(resTo.body?.items?.length).toBe(1);
  expect(resTo.body?.items?.[0]?.id).toBe(earlyId);
});

it("admin list session replays filters by click_count_min", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const now = Date.now();

  // Replay A: user with 3 clicks
  await Auth.fastSignUp();
  const segmentIdA = randomUUID();
  const uploadA = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    sessionReplaySegmentId: segmentIdA,
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 1, timestamp: now + 100 }],
  });
  expect(uploadA.status).toBe(200);
  const replayIdA = uploadA.body?.session_replay_id;

  const clickData = {
    tag_name: "button",
    text: "Click",
    href: null,
    selector: "button",
    x: 10,
    y: 20,
    page_x: 10,
    page_y: 20,
    viewport_width: 1920,
    viewport_height: 1080,
  };

  const eventBatchA = await uploadEventBatch({
    sessionReplaySegmentId: segmentIdA,
    batchId: randomUUID(),
    sentAtMs: now + 600,
    events: [
      { event_type: "$click", event_at_ms: now + 100, data: clickData },
      { event_type: "$click", event_at_ms: now + 200, data: clickData },
      { event_type: "$click", event_at_ms: now + 300, data: clickData },
    ],
  });
  expect(eventBatchA.status).toBe(200);

  // Replay B: user with 1 click
  await Auth.fastSignUp();
  const segmentIdB = randomUUID();
  const uploadB = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    sessionReplaySegmentId: segmentIdB,
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 1, timestamp: now + 100 }],
  });
  expect(uploadB.status).toBe(200);
  const replayIdB = uploadB.body?.session_replay_id;

  const eventBatchB = await uploadEventBatch({
    sessionReplaySegmentId: segmentIdB,
    batchId: randomUUID(),
    sentAtMs: now + 600,
    events: [
      { event_type: "$click", event_at_ms: now + 100, data: clickData },
    ],
  });
  expect(eventBatchB.status).toBe(200);

  // Wait for ClickHouse to ingest click events and replays
  const resClickMin = await listReplaysWithRetry(
    { click_count_min: "2" },
    (res) => res.status === 200 && res.body?.items?.length === 1 && res.body?.items?.[0]?.id === replayIdA,
  );
  expect(resClickMin.status).toBe(200);
  expect(resClickMin.body?.items?.length).toBe(1);
  expect(resClickMin.body?.items?.[0]?.id).toBe(replayIdA);

  // click_count_min=0 should return both (no-op filter)
  const resAll = await listReplaysWithRetry(
    { click_count_min: "0" },
    (res) => res.status === 200 && (res.body?.items?.length ?? 0) >= 2,
  );
  expect(resAll.status).toBe(200);
  expect(resAll.body?.items?.length).toBeGreaterThanOrEqual(2);
});

it("admin list session replays filters by country_codes", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const now = Date.now();

  // Replay A: session seen from Germany — the $token-refresh event logged at
  // sign-up carries the ip info set on backendContext
  backendContext.set({ ipData: { country: "DE", ipAddress: "127.0.0.1", city: "Berlin", region: "BE", latitude: 52.52, longitude: 13.405, tzIdentifier: "Europe/Berlin" } });
  await Auth.fastSignUp();
  const uploadA = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 1, timestamp: now + 100 }],
  });
  expect(uploadA.status).toBe(200);
  const replayIdA = uploadA.body?.session_replay_id;

  // Replay B: session seen from France
  await bumpEmailAddress();
  backendContext.set({ ipData: { country: "FR", ipAddress: "127.0.0.1", city: "Paris", region: "IDF", latitude: 48.8566, longitude: 2.3522, tzIdentifier: "Europe/Paris" } });
  await Auth.fastSignUp();
  const uploadB = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 600,
    events: [{ type: 1, timestamp: now + 200 }],
  });
  expect(uploadB.status).toBe(200);
  const replayIdB = uploadB.body?.session_replay_id;

  // Reset so the geo headers don't leak into anything else in this context
  backendContext.set({ ipData: undefined });

  // Wait for ClickHouse to ingest the $token-refresh events
  const resDe = await listReplaysWithRetry(
    { country_codes: "DE" },
    (res) => res.status === 200 && res.body?.items?.length === 1 && res.body?.items?.[0]?.id === replayIdA,
  );
  expect(resDe.status).toBe(200);
  expect(resDe.body?.items?.length).toBe(1);
  expect(resDe.body?.items?.[0]?.id).toBe(replayIdA);

  // Country codes are case-insensitive
  const resDeLower = await listReplaysWithRetry(
    { country_codes: "de" },
    (res) => res.status === 200 && res.body?.items?.length === 1 && res.body?.items?.[0]?.id === replayIdA,
  );
  expect(resDeLower.status).toBe(200);
  expect(resDeLower.body?.items?.[0]?.id).toBe(replayIdA);

  // Multiple codes match either replay
  const resBoth = await listReplaysWithRetry(
    { country_codes: "DE,FR" },
    (res) => res.status === 200 && res.body?.items?.length === 2,
  );
  expect(resBoth.status).toBe(200);
  const bothIds = asObjects(resBoth.body?.items).map((i) => i.id);
  expect(bothIds).toContain(replayIdA);
  expect(bothIds).toContain(replayIdB);

  // A country neither session was seen from → empty page
  const resNone = await listReplays({ country_codes: "AQ" });
  expect(resNone.status).toBe(200);
  expect(resNone.body?.items).toEqual([]);
  expect(resNone.body?.pagination?.next_cursor).toBeNull();
});

it("admin list session replays rejects invalid country_codes", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.fastSignUp();

  const resThreeLetters = await listReplays({ country_codes: "DEU" });
  expect(resThreeLetters).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "country_codes must contain valid ISO 3166-1 alpha-2 country codes",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const resOneLetter = await listReplays({ country_codes: "D" });
  expect(resOneLetter).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "country_codes must contain valid ISO 3166-1 alpha-2 country codes",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("admin list session replays rejects invalid UUID values in user_ids and team_ids", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.fastSignUp();

  const invalidUserIds = await listReplays({ user_ids: "not-a-uuid" });
  expect(invalidUserIds).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "user_ids must contain valid UUID values",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  const invalidTeamIds = await listReplays({ team_ids: "not-a-uuid" });
  expect(invalidTeamIds).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "team_ids must contain valid UUID values",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

it("admin list session replays paginates correctly when last_event_at timestamps are identical", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const baseTime = 1_700_000_000_000;

  await Auth.fastSignUp();
  const uploadA = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: baseTime,
    sentAtMs: baseTime + 500,
    events: [{ type: 1, timestamp: baseTime + 100 }],
  });
  expect(uploadA.status).toBe(200);
  const replayIdA = uploadA.body?.session_replay_id;

  await bumpEmailAddress();
  await Auth.fastSignUp();
  const uploadB = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: baseTime,
    sentAtMs: baseTime + 500,
    events: [{ type: 1, timestamp: baseTime + 100 }],
  });
  expect(uploadB.status).toBe(200);
  const replayIdB = uploadB.body?.session_replay_id;

  // Wait for ClickHouse to ingest both replays before paginating
  await listReplaysWithRetry(
    {},
    (res) => {
      const items = res.body?.items ?? [];
      const ids = items.map((i: any) => i.id);
      return res.status === 200 && ids.includes(replayIdA) && ids.includes(replayIdB);
    },
  );

  const first = await listReplays({ limit: "1" });
  expect(first.status).toBe(200);
  expect(first.body?.items?.length).toBe(1);
  const firstId = first.body?.items?.[0]?.id;
  expect([replayIdA, replayIdB]).toContain(firstId);

  const nextCursor = first.body?.pagination?.next_cursor;
  expect(typeof nextCursor).toBe("string");
  if (typeof nextCursor !== "string") {
    throw new Error("Expected next_cursor to be a string.");
  }

  const second = await listReplays({ limit: "1", cursor: nextCursor });
  expect(second.status).toBe(200);
  expect(second.body?.items?.length).toBe(1);
  const secondId = second.body?.items?.[0]?.id;
  expect([replayIdA, replayIdB]).toContain(secondId);
  expect(secondId).not.toBe(firstId);
});

it("admin list session replays combines filters with AND semantics", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const userA = await Auth.fastSignUp();
  const uploadA = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_500,
    events: [{ type: 1, timestamp: 1_700_000_000_100 }],
  });
  expect(uploadA.status).toBe(200);
  const { teamId } = await Team.create({ accessType: "server", creatorUserId: userA.userId });

  await bumpEmailAddress();
  const userB = await Auth.fastSignUp();
  const uploadB = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: 1_700_000_000_000,
    sentAtMs: 1_700_000_000_600,
    events: [{ type: 1, timestamp: 1_700_000_000_200 }],
  });
  expect(uploadB.status).toBe(200);

  // Wait for ClickHouse to ingest both replays before asserting combined filters
  const matchingIntersection = await listReplaysWithRetry(
    { user_ids: userA.userId, team_ids: teamId },
    (res) => res.status === 200 && res.body?.items?.length === 1,
  );
  expect(matchingIntersection.status).toBe(200);
  expect(matchingIntersection.body?.items?.length).toBe(1);
  expect(matchingIntersection.body?.items?.[0]?.project_user?.id).toBe(userA.userId);

  const nonMatchingIntersection = await listReplays({ user_ids: userB.userId, team_ids: teamId });
  expect(nonMatchingIntersection.status).toBe(200);
  expect(nonMatchingIntersection.body?.items?.length).toBe(0);
});

it("admin list session replays returns empty page with null next_cursor when click_count_min has no matches", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });

  const now = Date.now();
  await Auth.fastSignUp();
  const segmentId = randomUUID();

  const upload = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    sessionReplaySegmentId: segmentId,
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 1, timestamp: now + 100 }],
  });
  expect(upload.status).toBe(200);

  const eventBatch = await uploadEventBatch({
    sessionReplaySegmentId: segmentId,
    batchId: randomUUID(),
    sentAtMs: now + 600,
    events: [{
      event_type: "$click",
      event_at_ms: now + 120,
      data: {
        tag_name: "button",
        text: "Click",
        href: null,
        selector: "button",
        x: 10,
        y: 20,
        page_x: 10,
        page_y: 20,
        viewport_width: 1920,
        viewport_height: 1080,
      },
    }],
  });
  expect(eventBatch.status).toBe(200);

  // Wait until click data is visible, then assert a no-match threshold.
  let clickVisible = false;
  for (let i = 0; i < 15; i++) {
    const res = await listReplays({ click_count_min: "1" });
    expect(res.status).toBe(200);
    if ((res.body?.items?.length ?? 0) >= 1) {
      clickVisible = true;
      break;
    }
    await wait(500);
  }
  expect(clickVisible).toBe(true);

  const noMatch = await listReplays({ click_count_min: "9999" });
  expect(noMatch.status).toBe(200);
  expect(noMatch.body?.items).toEqual([]);
  expect(noMatch.body?.pagination?.next_cursor).toBeNull();
});

it("admin list session replays rejects invalid filter parameters", async ({ expect }) => {
  await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Auth.fastSignUp();

  // Non-integer duration_ms_min
  const res1 = await listReplays({ duration_ms_min: "abc" });
  expect(res1).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "duration_ms_min must be a non-negative integer",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Negative duration_ms_min
  const res2 = await listReplays({ duration_ms_min: "-1" });
  expect(res2).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "duration_ms_min must be a non-negative integer",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Non-integer duration_ms_max
  const res3 = await listReplays({ duration_ms_max: "12.5" });
  expect(res3).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "duration_ms_max must be a non-negative integer",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Inverted duration range (min > max)
  const res4 = await listReplays({ duration_ms_min: "5000", duration_ms_max: "1000" });
  expect(res4).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "duration_ms_min must be less than or equal to duration_ms_max",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // NaN timestamp
  const res5 = await listReplays({ last_event_at_from_millis: "not-a-number" });
  expect(res5).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "last_event_at_from_millis must be a non-negative timestamp in milliseconds",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Inverted time range (from > to)
  const res6 = await listReplays({ last_event_at_from_millis: "2000", last_event_at_to_millis: "1000" });
  expect(res6).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "last_event_at_from_millis must be less than or equal to last_event_at_to_millis",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Non-integer click_count_min
  const res7 = await listReplays({ click_count_min: "1.5" });
  expect(res7).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "click_count_min must be a non-negative integer",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);

  // Negative click_count_min
  const res8 = await listReplays({ click_count_min: "-3" });
  expect(res8).toMatchInlineSnapshot(`
    NiceResponse {
      "status": 400,
      "body": "click_count_min must be a non-negative integer",
      "headers": Headers { <some fields may have been hidden> },
    }
  `);
});

// ============================================================================
// Session replay limit enforcement tests
// ============================================================================

async function getSessionReplayItemQuantity(ownerTeamId: string) {
  return await withInternalProject(async () => {
    const response = await niceBackendFetch(`/api/v1/payments/items/team/${ownerTeamId}/session_replays`, {
      accessType: "server",
    });
    if (response.status !== 200) {
      throw new Error(`Failed to get session_replays item: ${JSON.stringify(response.body)}`);
    }
    return response.body.quantity as number;
  });
}

async function setSessionReplayItemQuantity(ownerTeamId: string, quantity: number) {
  const currentQuantity = await getSessionReplayItemQuantity(ownerTeamId);
  const delta = quantity - currentQuantity;

  await withInternalProject(async () => {
    const response = await niceBackendFetch(`/api/v1/payments/items/team/${ownerTeamId}/session_replays/update-quantity?allow_negative=true`, {
      method: "POST",
      accessType: "server",
      body: { delta },
    });
    if (response.status !== 200) {
      throw new Error(`Failed to set session_replays quantity: ${JSON.stringify(response.body)}`);
    }
  });
}

it("free plan starts with correct session replay allocation", async ({ expect }) => {
  const { createProjectResponse } = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  const ownerTeamId = createProjectResponse.body.owner_team_id;

  const quantity = await getSessionReplayItemQuantity(ownerTeamId);
  expect(quantity).toBe(PLAN_LIMITS.free.sessionReplays);
});

it("rejects new session replay when quota is exhausted", async ({ expect }) => {
  const { createProjectResponse } = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  const ownerTeamId = createProjectResponse.body.owner_team_id;

  await Auth.fastSignUp();
  await setSessionReplayItemQuantity(ownerTeamId, 0);

  const now = Date.now();
  const res = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 2, timestamp: now + 100 }],
  });

  expect(res.status).toBe(400);
  expect(res.body.code).toBe("ITEM_QUANTITY_INSUFFICIENT_AMOUNT");
});

it("accepts new session replay and debits quota by 1", async ({ expect }) => {
  const { createProjectResponse } = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  const ownerTeamId = createProjectResponse.body.owner_team_id;

  await Auth.fastSignUp();

  const quantityBefore = await getSessionReplayItemQuantity(ownerTeamId);

  const now = Date.now();
  const res = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 2, timestamp: now + 100 }],
  });

  expect(res.status).toBe(200);
  expect(res.body.deduped).toBe(false);

  const quantityAfter = await getSessionReplayItemQuantity(ownerTeamId);
  expect(quantityAfter).toBe(quantityBefore - 1);
});

it("does not debit quota when appending chunks to an existing session replay, even after quota is exhausted", async ({ expect }) => {
  const { createProjectResponse } = await Project.createAndSwitch({ config: { magic_link_enabled: true } });
  await Project.updateConfig({ apps: { installed: { analytics: { enabled: true } } } });
  const ownerTeamId = createProjectResponse.body.owner_team_id;

  await Auth.fastSignUp();

  const now = Date.now();
  const firstBatch = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 500,
    events: [{ type: 2, timestamp: now + 100 }],
  });
  expect(firstBatch.status).toBe(200);
  expect(firstBatch.body.deduped).toBe(false);

  const quantityAfterFirst = await getSessionReplayItemQuantity(ownerTeamId);

  const secondBatch = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 1000,
    events: [{ type: 3, timestamp: now + 500 }],
  });
  expect(secondBatch.status).toBe(200);
  expect(secondBatch.body.session_replay_id).toBe(firstBatch.body.session_replay_id);

  const quantityAfterSecond = await getSessionReplayItemQuantity(ownerTeamId);
  expect(quantityAfterSecond).toBe(quantityAfterFirst);

  // Exhaust quota — existing replays should still be able to append
  await setSessionReplayItemQuantity(ownerTeamId, 0);

  const thirdBatch = await uploadBatch({
    browserSessionId: randomUUID(),
    batchId: randomUUID(),
    startedAtMs: now,
    sentAtMs: now + 1500,
    events: [{ type: 3, timestamp: now + 1000 }],
  });
  expect(thirdBatch.status).toBe(200);
  expect(thirdBatch.body.session_replay_id).toBe(firstBatch.body.session_replay_id);

  const quantityAfterThird = await getSessionReplayItemQuantity(ownerTeamId);
  expect(quantityAfterThird).toBe(0);
});

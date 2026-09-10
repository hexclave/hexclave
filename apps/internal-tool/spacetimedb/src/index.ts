import { schema, t, table, SenderError, Range } from 'spacetimedb/server';
import { ScheduleAt, Timestamp, type Identity } from 'spacetimedb';
import {
  clampPageLimit,
  pageByCreatedAt,
  toPage,
  validatePageLimit,
  type OlderRowProbe,
  type PageCursor,
  type PageableRow,
  type SliceScanner,
} from './paging';

// Injected at publish time by scripts/spacetime-auth-config.mjs (non-secret).
// SpacetimeDB validates the JWT signature via OIDC discovery on the token's
// issuer; these constants pin WHICH issuers/audience this module trusts, so a
// valid token from any other OIDC provider cannot be replayed here. The
// trusted issuer is the internal tool itself — it serves the discovery
// document + JWKS and mints tokens only for signed-in Stack Auth users of the
// tool's project (see ../../src/lib/server/spacetimedb-token.ts).
const ALLOWED_ISSUERS: readonly string[] = ['__SPACETIMEDB_ALLOWED_ISSUERS__'];
const EXPECTED_AUDIENCE = '__SPACETIMEDB_EXPECTED_AUDIENCE__';

// Fallback session lifetime when a JWT carries no `exp` claim. Stack Auth
// access tokens always carry one (~10min), so this is defensive only.
const FALLBACK_SESSION_TTL_MICROS = 15n * 60n * 1000n * 1000n;
const SESSION_GC_INTERVAL_MICROS = 60n * 1000n * 1000n;

type SenderAuthLike = Readonly<{
  isInternal: boolean,
  jwt: Readonly<{
    issuer: string,
    audience: readonly string[],
    subject: string,
    fullPayload: { readonly [key: string]: unknown },
  }> | null,
}>;

// Holding a token from the trusted issuer IS the authorization: the internal
// tool only mints tokens for signed-in members of its Stack Auth project, and
// that project's sign-up rules restrict membership to the team. Any member
// may read and write everything here.
function isProjectMember(senderAuth: SenderAuthLike): boolean {
  if (senderAuth.isInternal) {
    // Scheduled reducers / module-internal calls are already trusted.
    return true;
  }
  const jwt = senderAuth.jwt;
  if (jwt == null) return false;
  if (!ALLOWED_ISSUERS.includes(jwt.issuer)) return false;
  if (!jwt.audience.includes(EXPECTED_AUDIENCE)) return false;
  return true;
}

function requireProjectMember(senderAuth: SenderAuthLike): void {
  if (!isProjectMember(senderAuth)) {
    throw new SenderError('Unauthorized: a member token of the trusted Stack Auth project is required');
  }
}

// Attribution for human actions (review/edit/create) is derived from the
// caller's validated token, never from a reducer argument: the internal tool
// mints tokens with a server-attested `name` claim only after verifying the
// Stack Auth session, so a member cannot forge who an action is credited to by
// passing a different string. Falls back to the stable subject (Stack Auth
// user id), then a sentinel for service/internal callers.
function actorName(senderAuth: SenderAuthLike): string {
  const jwt = senderAuth.jwt;
  if (jwt != null) {
    const name = jwt.fullPayload['name'];
    if (typeof name === 'string' && name !== '') return name;
    if (jwt.subject !== '') return jwt.subject;
  }
  return 'unknown';
}

function isExpiredSession(now: Timestamp, row: { expiresAt: Timestamp }): boolean {
  return row.expiresAt.microsSinceUnixEpoch <= now.microsSinceUnixEpoch;
}

function removeExpiredSessions(ctx: {
  timestamp: Timestamp,
  db: {
    sessions: {
      iter: () => Iterable<{ identity: Identity, expiresAt: Timestamp }>,
      identity: { delete: (identity: Identity) => void },
    },
  },
}): void {
  const expiredIdentities = new Array<Identity>();
  for (const row of ctx.db.sessions.iter()) {
    if (isExpiredSession(ctx.timestamp, row)) {
      expiredIdentities.push(row.identity);
    }
  }
  for (const identity of expiredIdentities) {
    ctx.db.sessions.identity.delete(identity);
  }
}

// Presence of a (non-expired) session row IS the authorization. This can't
// check `expiresAt` itself because view callbacks have no timestamp; instead,
// expired rows are actively deleted — on every connect/`touch_session` via
// `removeExpiredSessions`, and at most SESSION_GC_INTERVAL_MICROS later by the
// scheduled `session_gc` reducer — which re-evaluates the dependent views.
function hasMemberSession(ctx: {
  sender: Identity,
  db: {
    sessions: {
      identity: { find: (identity: Identity) => { identity: Identity } | null },
    },
  },
}): boolean {
  return ctx.db.sessions.identity.find(ctx.sender) != null;
}
const MAX_LIVE_LOG_ROWS = 200;

function newestById<Row extends { id: bigint }>(rows: Iterable<Row>): Row[] {
  const all = Array.from(rows);
  all.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)); // desc
  if (all.length > MAX_LIVE_LOG_ROWS) all.length = MAX_LIVE_LOG_ROWS;
  return all;
}

const mcpCallLog = table(
  {
    name: 'mcp_call_log',
    public: false,
    indexes: [{ accessor: 'shardCreatedAt', algorithm: 'btree', columns: ['shard', 'createdAt', 'id'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    shard: t.u8().index('btree'),
    correlationId: t.string().unique(),
    conversationId: t.string().optional(),
    createdAt: t.timestamp(),
    toolName: t.string(),
    reason: t.string(),
    userPrompt: t.string(),
    question: t.string(),
    response: t.string(),
    stepCount: t.u32(),
    innerToolCallsJson: t.string(),
    durationMs: t.u64(),
    modelId: t.string(),
    errorMessage: t.string().optional(),
    qaReviewedAt: t.timestamp().optional(),
    qaNeedsHumanReview: t.bool().optional(),
    qaAnswerCorrect: t.bool().optional(),
    qaAnswerRelevant: t.bool().optional(),
    qaFlagsJson: t.string().optional(),
    qaImprovementSuggestions: t.string().optional(),
    qaOverallScore: t.u32().optional(),
    qaReviewModelId: t.string().optional(),
    qaConversationJson: t.string().optional(),
    qaErrorMessage: t.string().optional(),
    humanReviewedAt: t.timestamp().optional(),
    humanReviewedBy: t.string().optional(),
    humanCorrectedQuestion: t.string().optional(),
    humanCorrectedAnswer: t.string().optional(),
    publishedToQa: t.bool().index('btree'),
    publishedAt: t.timestamp().optional(),
    // When the pending QA review was requested: insert time initially,
    // re-stamped by clear_mcp_qa_review on retry. Trailing + default-annotated
    // because that's the only column shape SpacetimeDB can auto-migrate (no
    // prod data wipe). Not optional: the SDK drops falsy default annotations
    // (`if (meta.defaultValue)` in table.ts), so an option column can't
    // default to none — readers treat the epoch-0 sentinel (pre-migration
    // rows) as unknown via max(createdAt, qaReviewRequestedAt).
    qaReviewRequestedAt: t.timestamp().default(Timestamp.UNIX_EPOCH),
  }
);

const aiQueryLog = table(
  {
    name: 'ai_query_log',
    public: false,
    indexes: [{ accessor: 'shardCreatedAt', algorithm: 'btree', columns: ['shard', 'createdAt', 'id'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    shard: t.u8().index('btree'),
    correlationId: t.string().unique(),
    createdAt: t.timestamp(),
    mode: t.string(),
    systemPromptId: t.string(),
    quality: t.string(),
    speed: t.string(),
    modelId: t.string(),
    isAuthenticated: t.bool(),
    projectId: t.string().optional(),
    userId: t.string().optional(),
    requestedToolsJson: t.string(),
    messagesJson: t.string(),
    stepsJson: t.string(),
    finalText: t.string(),
    inputTokens: t.u32().optional(),
    outputTokens: t.u32().optional(),
    cachedInputTokens: t.u32().optional(),
    cacheCreationTokens: t.u32().optional(),
    costUsd: t.f64().optional(),
    cacheDiscountUsd: t.f64().optional(),
    openrouterGenerationId: t.string().optional(),
    stepCount: t.u32(),
    durationMs: t.u64(),
    errorMessage: t.string().optional(),
    conversationId: t.string().optional(),
  }
);

const feedbackLog = table(
  {
    name: 'feedback_log',
    public: false,
    indexes: [{ accessor: 'shardCreatedAt', algorithm: 'btree', columns: ['shard', 'createdAt', 'id'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    shard: t.u8().index('btree'),
    correlationId: t.string().unique(),
    createdAt: t.timestamp(),
    conversationId: t.string().optional(),
    category: t.string(),
    message: t.string(),
    transport: t.string(),
    requestIp: t.string().optional(),
    requestIpSource: t.string().optional(),
    userAgent: t.string().optional(),
    requestHost: t.string().optional(),
    mcpProtocolVersion: t.string().optional(),
  }
);

// just because nobody reconnects.
const sessions = table(
  { name: 'sessions', public: false },
  {
    identity: t.identity().primaryKey(),
    stackUserId: t.string(),
    connectedAt: t.timestamp(),
    expiresAt: t.timestamp(),
  }
);


const sessionGcSchedule = table(
  { name: 'session_gc_schedule', public: false, scheduled: (): any => session_gc },
  {
    id: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
  }
);

const qaEntries = table(
  { name: 'qa_entries', public: false },
  {
    id: t.u64().primaryKey().autoInc(),
    shard: t.u8().index('btree'),
    sourceMcpCorrelationId: t.string().optional(),
    requestId: t.string().optional(),
    question: t.string(),
    answer: t.string(),
    createdBy: t.string(),
    createdAt: t.timestamp(),
    lastEditedBy: t.string(),
    lastEditedAt: t.timestamp(),
    published: t.bool().index('btree'),
    firstPublishedAt: t.timestamp().optional(),
    lastPublishedAt: t.timestamp().optional(),
  }
);

const spacetimedb = schema({ mcpCallLog, aiQueryLog, sessions, sessionGcSchedule, qaEntries, feedbackLog });
export default spacetimedb;

type SessionRow = typeof sessions.rowType.type;
type SessionGcScheduleRow = typeof sessionGcSchedule.rowType.type;

type SessionGcScheduleCtx = {
  db: {
    sessionGcSchedule: {
      iter: () => Iterable<SessionGcScheduleRow>,
      insert: (row: SessionGcScheduleRow) => void,
    },
  },
};

function ensureSessionGcScheduled(ctx: SessionGcScheduleCtx): void {
  for (const _row of ctx.db.sessionGcSchedule.iter()) return;
  ctx.db.sessionGcSchedule.insert({
    id: 0n,
    scheduledAt: ScheduleAt.interval(SESSION_GC_INTERVAL_MICROS),
  });
}

type SessionCtx = SessionGcScheduleCtx & {
  sender: Identity,
  timestamp: Timestamp,
  senderAuth: SenderAuthLike,
  db: {
    sessions: {
      iter: () => Iterable<SessionRow>,
      identity: {
        find: (identity: Identity) => SessionRow | null,
        update: (row: SessionRow) => void,
        delete: (identity: Identity) => void,
      },
      insert: (row: SessionRow) => void,
    },
  },
};

function upsertSessionFromJwt(ctx: SessionCtx): void {
  ensureSessionGcScheduled(ctx);
  removeExpiredSessions(ctx);
  const jwt = ctx.senderAuth.jwt;
  if (jwt == null) return;
  if (!ALLOWED_ISSUERS.includes(jwt.issuer)) return;
  if (!jwt.audience.includes(EXPECTED_AUDIENCE)) return;
  const exp = jwt.fullPayload['exp'];
  const expiresAt = typeof exp === 'number'
    ? new Timestamp(BigInt(Math.floor(exp)) * 1_000_000n)
    : new Timestamp(ctx.timestamp.microsSinceUnixEpoch + FALLBACK_SESSION_TTL_MICROS);
  const row = {
    identity: ctx.sender,
    stackUserId: jwt.subject,
    connectedAt: ctx.timestamp,
    expiresAt,
  };
  if (ctx.db.sessions.identity.find(ctx.sender) != null) {
    ctx.db.sessions.identity.update(row);
  } else {
    ctx.db.sessions.insert(row);
  }
}

export const onConnect = spacetimedb.clientConnected((ctx) => {
  upsertSessionFromJwt(ctx);
});

export const touch_session = spacetimedb.reducer({}, (ctx, _args) => {
  upsertSessionFromJwt(ctx);
});

export const session_gc = spacetimedb.reducer(
  { row: sessionGcSchedule.rowType },
  (ctx, _args) => {
    removeExpiredSessions(ctx);
  }
);

export const myVisibleMcpCallLog = spacetimedb.view(
  { name: 'my_visible_mcp_call_log', public: true },
  t.array(mcpCallLog.rowType),
  (ctx) => {
    if (!hasMemberSession(ctx)) return [];
    return newestById(ctx.db.mcpCallLog.shard.filter(0));
  }
);
export const myVisibleAiQueryLog = spacetimedb.view(
  { name: 'my_visible_ai_query_log', public: true },
  t.array(aiQueryLog.rowType),
  (ctx) => {
    if (!hasMemberSession(ctx)) return [];
    return newestById(ctx.db.aiQueryLog.shard.filter(0));
  }
);
export const myVisibleQaEntries = spacetimedb.view(
  { name: 'my_visible_qa_entries', public: true },
  t.array(qaEntries.rowType),
  (ctx) => {
    if (!hasMemberSession(ctx)) return [];
    return Array.from(ctx.db.qaEntries.shard.filter(0));
  }
);
export const myVisibleFeedbackLog = spacetimedb.view(
  { name: 'my_visible_feedback_log', public: true },
  t.array(feedbackLog.rowType),
  (ctx) => {
    if (!hasMemberSession(ctx)) return [];
    return newestById(ctx.db.feedbackLog.shard.filter(0));
  }
);

const publishedQaRow = t.object('PublishedQaRow', {
  id: t.u64(),
  question: t.string(),
  answer: t.string(),
  publishedAt: t.timestamp().optional(),
});

export const publishedQa = spacetimedb.anonymousView(
  { name: 'published_qa', public: true },
  t.array(publishedQaRow),
  (ctx) => {
    const out: Array<{
      id: bigint,
      question: string,
      answer: string,
      publishedAt: Timestamp | undefined,
    }> = [];
    for (const row of ctx.db.qaEntries.published.filter(true)) {
      out.push({
        id: row.id,
        question: row.question,
        answer: row.answer,
        publishedAt: row.lastPublishedAt,
      });
    }
    return out;
  },
);

const LIVE_SHARD = 0;

function sliceScannerFor<Row extends PageableRow>(
  index: { filter: (range: readonly [number, Range<Timestamp>]) => Iterable<Row> },
): SliceScanner<Row> {
  return (loMicrosInclusive, hiMicros, hiInclusive) => index.filter([
    LIVE_SHARD,
    new Range(
      { tag: 'included', value: new Timestamp(loMicrosInclusive) },
      { tag: hiInclusive ? 'included' : 'excluded', value: new Timestamp(hiMicros) },
    ),
  ]);
}

// Stops at the first row rather than materializing the range, so "is there
// anything older at all?" costs an index seek instead of a scan.
function olderRowProbeFor<Row extends PageableRow>(
  index: { filter: (range: readonly [number, Range<Timestamp>]) => Iterable<Row> },
): OlderRowProbe {
  return (hiMicros) => {
    const older = index.filter([
      LIVE_SHARD,
      new Range({ tag: 'unbounded' }, { tag: 'excluded', value: new Timestamp(hiMicros) }),
    ]);
    for (const _row of older) return true;
    return false;
  };
}

function requireMemberSession(ctx: {
  sender: Identity,
  db: { sessions: { identity: { find: (identity: Identity) => { identity: Identity } | null } } },
}): void {
  if (!hasMemberSession(ctx)) {
    throw new SenderError('Unauthorized: no active session for this identity. Call touch_session first.');
  }
}

type PageArgs = { beforeCreatedAtMicros: bigint | undefined, beforeId: bigint | undefined, limit: number };

function cursorOf(now: Timestamp, args: PageArgs): PageCursor {
  // No cursor means "newest page": everything ever written is at or before now.
  return {
    beforeCreatedAtMicros: args.beforeCreatedAtMicros ?? now.microsSinceUnixEpoch,
    beforeId: args.beforeId,
  };
}

function requireValidLimit(limit: number): number {
  const invalid = validatePageLimit(limit);
  if (invalid != null) throw new SenderError(invalid);
  return clampPageLimit(limit);
}

const pageParams = {
  beforeCreatedAtMicros: t.u64().optional(),
  beforeId: t.u64().optional(),
  limit: t.u32(),
};

const mcpCallLogPage = t.object('McpCallLogPage', {
  rows: t.array(mcpCallLog.rowType),
  nextBeforeCreatedAtMicros: t.u64().optional(),
  nextBeforeId: t.u64().optional(),
});

const aiQueryLogPage = t.object('AiQueryLogPage', {
  rows: t.array(aiQueryLog.rowType),
  nextBeforeCreatedAtMicros: t.u64().optional(),
  nextBeforeId: t.u64().optional(),
});

const feedbackLogPage = t.object('FeedbackLogPage', {
  rows: t.array(feedbackLog.rowType),
  nextBeforeCreatedAtMicros: t.u64().optional(),
  nextBeforeId: t.u64().optional(),
});

export const page_mcp_call_log = spacetimedb.procedure(
  pageParams,
  mcpCallLogPage,
  (ctx, args) => ctx.withTx((tx) => {
    requireMemberSession({ sender: ctx.sender, db: tx.db });
    const limit = requireValidLimit(args.limit);
    return toPage(pageByCreatedAt(sliceScannerFor(tx.db.mcpCallLog.shardCreatedAt), olderRowProbeFor(tx.db.mcpCallLog.shardCreatedAt), cursorOf(ctx.timestamp, args), limit), limit);
  }),
);

export const page_ai_query_log = spacetimedb.procedure(
  pageParams,
  aiQueryLogPage,
  (ctx, args) => ctx.withTx((tx) => {
    requireMemberSession({ sender: ctx.sender, db: tx.db });
    const limit = requireValidLimit(args.limit);
    return toPage(pageByCreatedAt(sliceScannerFor(tx.db.aiQueryLog.shardCreatedAt), olderRowProbeFor(tx.db.aiQueryLog.shardCreatedAt), cursorOf(ctx.timestamp, args), limit), limit);
  }),
);

export const page_feedback_log = spacetimedb.procedure(
  pageParams,
  feedbackLogPage,
  (ctx, args) => ctx.withTx((tx) => {
    requireMemberSession({ sender: ctx.sender, db: tx.db });
    const limit = requireValidLimit(args.limit);
    return toPage(pageByCreatedAt(sliceScannerFor(tx.db.feedbackLog.shardCreatedAt), olderRowProbeFor(tx.db.feedbackLog.shardCreatedAt), cursorOf(ctx.timestamp, args), limit), limit);
  }),
);

export const log_mcp_call = spacetimedb.reducer(
  {
    correlationId: t.string(),
    conversationId: t.string().optional(),
    toolName: t.string(),
    reason: t.string(),
    userPrompt: t.string(),
    question: t.string(),
    response: t.string(),
    stepCount: t.u32(),
    innerToolCallsJson: t.string(),
    durationMs: t.u64(),
    modelId: t.string(),
    errorMessage: t.string().optional(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    ctx.db.mcpCallLog.insert({
      id: 0n,
      shard: 0,
      correlationId: args.correlationId,
      conversationId: args.conversationId,
      createdAt: ctx.timestamp,
      toolName: args.toolName,
      reason: args.reason,
      userPrompt: args.userPrompt,
      question: args.question,
      response: args.response,
      stepCount: args.stepCount,
      innerToolCallsJson: args.innerToolCallsJson,
      durationMs: args.durationMs,
      modelId: args.modelId,
      errorMessage: args.errorMessage,
      publishedToQa: false,
      qaReviewRequestedAt: ctx.timestamp,
    } as Parameters<typeof ctx.db.mcpCallLog.insert>[0]);
  }
);

export const log_feedback = spacetimedb.reducer(
  {
    correlationId: t.string(),
    conversationId: t.string().optional(),
    category: t.string(),
    message: t.string(),
    transport: t.string(),
    requestIp: t.string().optional(),
    requestIpSource: t.string().optional(),
    userAgent: t.string().optional(),
    requestHost: t.string().optional(),
    mcpProtocolVersion: t.string().optional(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    ctx.db.feedbackLog.insert({
      id: 0n,
      shard: 0,
      correlationId: args.correlationId,
      createdAt: ctx.timestamp,
      conversationId: args.conversationId,
      category: args.category,
      message: args.message,
      transport: args.transport,
      requestIp: args.requestIp,
      requestIpSource: args.requestIpSource,
      userAgent: args.userAgent,
      requestHost: args.requestHost,
      mcpProtocolVersion: args.mcpProtocolVersion,
    } as Parameters<typeof ctx.db.feedbackLog.insert>[0]);
  }
);

export const update_mcp_qa_review = spacetimedb.reducer(
  {
    correlationId: t.string(),
    qaNeedsHumanReview: t.bool(),
    qaAnswerCorrect: t.bool(),
    qaAnswerRelevant: t.bool(),
    qaFlagsJson: t.string(),
    qaImprovementSuggestions: t.string(),
    qaOverallScore: t.u32(),
    qaReviewModelId: t.string(),
    qaConversationJson: t.string().optional(),
    qaErrorMessage: t.string().optional(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.mcpCallLog.correlationId.find(args.correlationId);
    if (row == null) {
      throw new SenderError('Call log not found for correlationId: ' + args.correlationId);
    }
    ctx.db.mcpCallLog.id.update({
      ...row,
      qaReviewedAt: ctx.timestamp,
      qaNeedsHumanReview: args.qaNeedsHumanReview,
      qaAnswerCorrect: args.qaAnswerCorrect,
      qaAnswerRelevant: args.qaAnswerRelevant,
      qaFlagsJson: args.qaFlagsJson,
      qaImprovementSuggestions: args.qaImprovementSuggestions,
      qaOverallScore: args.qaOverallScore,
      qaReviewModelId: args.qaReviewModelId,
      qaConversationJson: args.qaConversationJson,
      qaErrorMessage: args.qaErrorMessage,
    });
  }
);

export const clear_mcp_qa_review = spacetimedb.reducer(
  {
    correlationId: t.string(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.mcpCallLog.correlationId.find(args.correlationId);
    if (row == null) {
      throw new SenderError('Call log not found for correlationId: ' + args.correlationId);
    }
    ctx.db.mcpCallLog.id.update({
      ...row,
      qaReviewedAt: undefined,
      qaReviewRequestedAt: ctx.timestamp,
      qaNeedsHumanReview: undefined,
      qaAnswerCorrect: undefined,
      qaAnswerRelevant: undefined,
      qaFlagsJson: undefined,
      qaImprovementSuggestions: undefined,
      qaOverallScore: undefined,
      qaReviewModelId: undefined,
      qaConversationJson: undefined,
      qaErrorMessage: undefined,
    });
  }
);

export const set_human_reviewed = spacetimedb.reducer(
  {
    correlationId: t.string(),
    reviewed: t.bool(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.mcpCallLog.correlationId.find(args.correlationId);
    if (row == null) {
      throw new SenderError('Call log not found for correlationId: ' + args.correlationId);
    }
    ctx.db.mcpCallLog.id.update({
      ...row,
      humanReviewedAt: args.reviewed ? ctx.timestamp : undefined,
      humanReviewedBy: args.reviewed ? actorName(ctx.senderAuth) : undefined,
    });
  }
);

export const upsert_qa_from_call_and_mark_reviewed = spacetimedb.reducer(
  {
    correlationId: t.string(),
    question: t.string(),
    answer: t.string(),
    publish: t.bool(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const reviewer = actorName(ctx.senderAuth);
    const callLogRow = upsertQaEntryFromCall(ctx, {
      correlationId: args.correlationId,
      question: args.question,
      answer: args.answer,
      publish: args.publish,
      editedBy: reviewer,
    });

    ctx.db.mcpCallLog.id.update({
      ...callLogRow,
      humanReviewedAt: ctx.timestamp,
      humanReviewedBy: reviewer,
    });
  }
);

type McpCallLogRow = typeof mcpCallLog.rowType.type;
type QaEntriesRow = typeof qaEntries.rowType.type;

function upsertQaEntryFromCall(ctx: {
  timestamp: Timestamp,
  db: {
    mcpCallLog: {
      correlationId: { find: (correlationId: string) => McpCallLogRow | null },
    },
    qaEntries: {
      shard: { filter: (shard: number) => Iterable<QaEntriesRow> },
      id: {
        update: (row: QaEntriesRow) => void,
      },
      insert: (row: QaEntriesRow) => void,
    },
  },
}, args: {
  correlationId: string,
  question: string,
  answer: string,
  publish: boolean,
  editedBy: string,
}): McpCallLogRow {
  const callLogRow = ctx.db.mcpCallLog.correlationId.find(args.correlationId);
  if (callLogRow == null) {
    throw new SenderError('Call log not found for correlationId: ' + args.correlationId);
  }

  let existing = null;
  for (const row of ctx.db.qaEntries.shard.filter(0)) {
    if (row.sourceMcpCorrelationId === args.correlationId) {
      existing = row;
      break;
    }
  }
  if (existing != null) {
    ctx.db.qaEntries.id.update({
      ...existing,
      question: args.question,
      answer: args.answer,
      lastEditedBy: args.editedBy,
      lastEditedAt: ctx.timestamp,
      published: args.publish,
      firstPublishedAt: args.publish ? (existing.firstPublishedAt ?? ctx.timestamp) : existing.firstPublishedAt,
      lastPublishedAt: args.publish ? ctx.timestamp : existing.lastPublishedAt,
    });
    return callLogRow;
  }

  ctx.db.qaEntries.insert({
    id: 0n,
    shard: 0,
    sourceMcpCorrelationId: args.correlationId,
    requestId: undefined,
    question: args.question,
    answer: args.answer,
    createdBy: args.editedBy,
    createdAt: ctx.timestamp,
    lastEditedBy: args.editedBy,
    lastEditedAt: ctx.timestamp,
    published: args.publish,
    firstPublishedAt: args.publish ? ctx.timestamp : undefined,
    lastPublishedAt: args.publish ? ctx.timestamp : undefined,
  });
  return callLogRow;
}

export const add_manual_qa = spacetimedb.reducer(
  {
    question: t.string(),
    answer: t.string(),
    publish: t.bool(),
    requestId: t.string(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    if (args.requestId !== '') {
      for (const existing of ctx.db.qaEntries.iter()) {
        if (existing.requestId === args.requestId) return;
      }
    }
    const createdBy = actorName(ctx.senderAuth);
    ctx.db.qaEntries.insert({
      id: 0n,
      shard: 0,
      sourceMcpCorrelationId: undefined,
      requestId: args.requestId,
      question: args.question,
      answer: args.answer,
      createdBy,
      createdAt: ctx.timestamp,
      lastEditedBy: createdBy,
      lastEditedAt: ctx.timestamp,
      published: args.publish,
      firstPublishedAt: args.publish ? ctx.timestamp : undefined,
      lastPublishedAt: args.publish ? ctx.timestamp : undefined,
    } as Parameters<typeof ctx.db.qaEntries.insert>[0]);
  }
);

export const delete_qa_entry = spacetimedb.reducer(
  {
    qaId: t.u64(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.qaEntries.id.find(args.qaId);
    if (row == null) {
      throw new SenderError('QA entry not found for qaId: ' + args.qaId.toString());
    }
    ctx.db.qaEntries.id.delete(row.id);
  }
);

export const update_qa_entry_with_publish = spacetimedb.reducer(
  {
    qaId: t.u64(),
    question: t.string(),
    answer: t.string(),
    publish: t.bool(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.qaEntries.id.find(args.qaId);
    if (row == null) {
      throw new SenderError('QA entry not found for qaId: ' + args.qaId.toString());
    }
    ctx.db.qaEntries.id.update({
      ...row,
      question: args.question,
      answer: args.answer,
      lastEditedBy: actorName(ctx.senderAuth),
      lastEditedAt: ctx.timestamp,
      published: args.publish,
      firstPublishedAt: args.publish ? (row.firstPublishedAt ?? ctx.timestamp) : row.firstPublishedAt,
      lastPublishedAt: args.publish ? ctx.timestamp : row.lastPublishedAt,
    });
  }
);

export const log_ai_query = spacetimedb.reducer(
  {
    correlationId: t.string(),
    mode: t.string(),
    systemPromptId: t.string(),
    quality: t.string(),
    speed: t.string(),
    modelId: t.string(),
    isAuthenticated: t.bool(),
    projectId: t.string().optional(),
    userId: t.string().optional(),
    requestedToolsJson: t.string(),
    messagesJson: t.string(),
    stepsJson: t.string(),
    finalText: t.string(),
    inputTokens: t.u32().optional(),
    outputTokens: t.u32().optional(),
    cachedInputTokens: t.u32().optional(),
    cacheCreationTokens: t.u32().optional(),
    costUsd: t.f64().optional(),
    cacheDiscountUsd: t.f64().optional(),
    openrouterGenerationId: t.string().optional(),
    stepCount: t.u32(),
    durationMs: t.u64(),
    errorMessage: t.string().optional(),
    conversationId: t.string().optional(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    ctx.db.aiQueryLog.insert({
      id: 0n,
      shard: 0,
      correlationId: args.correlationId,
      createdAt: ctx.timestamp,
      mode: args.mode,
      systemPromptId: args.systemPromptId,
      quality: args.quality,
      speed: args.speed,
      modelId: args.modelId,
      isAuthenticated: args.isAuthenticated,
      projectId: args.projectId,
      userId: args.userId,
      requestedToolsJson: args.requestedToolsJson,
      messagesJson: args.messagesJson,
      stepsJson: args.stepsJson,
      finalText: args.finalText,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cachedInputTokens: args.cachedInputTokens,
      cacheCreationTokens: args.cacheCreationTokens,
      costUsd: args.costUsd,
      cacheDiscountUsd: args.cacheDiscountUsd,
      openrouterGenerationId: args.openrouterGenerationId,
      stepCount: args.stepCount,
      durationMs: args.durationMs,
      errorMessage: args.errorMessage,
      conversationId: args.conversationId,
    } as Parameters<typeof ctx.db.aiQueryLog.insert>[0]);
  }
);

export const update_ai_query_usage = spacetimedb.reducer(
  {
    correlationId: t.string(),
    inputTokens: t.u32().optional(),
    outputTokens: t.u32().optional(),
    cachedInputTokens: t.u32().optional(),
    costUsd: t.f64().optional(),
    cacheDiscountUsd: t.f64().optional(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.aiQueryLog.correlationId.find(args.correlationId);
    if (row == null) {
      throw new SenderError('AI query log not found for correlationId: ' + args.correlationId);
    }
    ctx.db.aiQueryLog.id.update({
      ...row,
      inputTokens: args.inputTokens ?? row.inputTokens,
      outputTokens: args.outputTokens ?? row.outputTokens,
      cachedInputTokens: args.cachedInputTokens ?? row.cachedInputTokens,
      costUsd: args.costUsd ?? row.costUsd,
      cacheDiscountUsd: args.cacheDiscountUsd ?? row.cacheDiscountUsd,
    });
  }
);

export const delete_feedback = spacetimedb.reducer(
  {
    correlationId: t.string(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.feedbackLog.correlationId.find(args.correlationId);
    if (row == null) {
      throw new SenderError('Feedback not found for correlationId: ' + args.correlationId);
    }
    ctx.db.feedbackLog.id.delete(row.id);
  }
);

export const delete_mcp_call_log = spacetimedb.reducer(
  {
    correlationId: t.string(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.mcpCallLog.correlationId.find(args.correlationId);
    if (row == null) {
      throw new SenderError('Call log not found for correlationId: ' + args.correlationId);
    }
    ctx.db.mcpCallLog.id.delete(row.id);
  }
);

export const delete_ai_query_log = spacetimedb.reducer(
  {
    correlationId: t.string(),
  },
  (ctx, args) => {
    requireProjectMember(ctx.senderAuth);
    const row = ctx.db.aiQueryLog.correlationId.find(args.correlationId);
    if (row == null) {
      throw new SenderError('Log entry not found for correlationId: ' + args.correlationId);
    }
    ctx.db.aiQueryLog.id.delete(row.id);
  }
);

export const init = spacetimedb.init(ctx => {
  ensureSessionGcScheduled(ctx);
});

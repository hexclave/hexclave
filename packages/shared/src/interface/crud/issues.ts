import { yupNumber, yupObject, yupString } from "../../schema-fields";
import { IssueStatusSchema, IssueSubstatusSchema } from "../admin-issues";
import { WebhookEvent } from "../webhooks";


/**
 * `short_id` and `times_seen` are strings, not numbers, and that is not a style choice.
 *
 * Both are Postgres `BigInt`. `apps/backend/src/route-handlers/smart-response.tsx` runs `JSON.stringify` over
 * the response body, and `JSON.stringify` THROWS on a BigInt rather than coercing it — so a numeric field here
 * would take down the request that tried to emit the webhook. They cross the wire as decimal strings, and a
 * consumer that needs arithmetic should use `BigInt(...)` rather than `Number(...)`: `times_seen` on a busy
 * project can exceed `Number.MAX_SAFE_INTEGER`.
 *
 * The `*_at_millis` fields are safe as numbers — epoch millis stay well inside the safe integer range.
 *
 * This is a builder rather than one shared schema constant because of the `status`/`substatus` EXAMPLES: the
 * payload shape is identical across the five `issue.*` events, but the emitter
 * (`apps/backend/src/lib/issues/issue-webhooks.ts`) sends event-determined values — `issue.created` always
 * carries substatus `new`, `issue.regressed` carries `regressed`, and the human-action events carry `ongoing`
 * with the status matching the action. One shared example ("regressed" everywhere) made the generated docs
 * show impossible payloads for four of the five events.
 */
function buildWebhookIssueSchema(examples: {
  status: "unresolved" | "resolved" | "ignored",
  substatus: "new" | "ongoing" | "regressed",
}) {
  return yupObject({
    id: yupString().uuid().defined().meta({ openapiField: { description: 'The unique identifier of the issue', exampleValue: '3241a285-8329-4d69-8f3d-316e08cf140c' } }),
    short_id: yupString().defined().meta({ openapiField: { description: 'Per-project monotonic counter identifying the issue, as a decimal string (it is a 64-bit integer and does not fit a JSON number safely)', exampleValue: '42' } }),

    type: yupString().defined().meta({ openapiField: { description: 'The error type, eg. the constructor name of the thrown error', exampleValue: 'TypeError' } }),
    value: yupString().defined().meta({ openapiField: { description: 'The error message', exampleValue: "Cannot read properties of undefined (reading 'id')" } }),
    culprit: yupString().defined().meta({ openapiField: { description: 'The code location the issue was attributed to', exampleValue: 'app/dashboard/page.tsx in DashboardPage' } }),
    level: yupString().defined().meta({ openapiField: { description: 'The severity the occurrence was reported with', exampleValue: 'error' } }),

    status: IssueStatusSchema.meta({ openapiField: { description: 'The lifecycle status of the issue', exampleValue: examples.status } }),
    substatus: IssueSubstatusSchema.meta({ openapiField: { description: 'A finer-grained view of an unresolved issue, derived from its timestamps', exampleValue: examples.substatus } }),

    first_seen_at_millis: yupNumber().defined().meta({ openapiField: { description: 'When the issue was first seen, in milliseconds since epoch', exampleValue: 1630000000000 } }),
    last_seen_at_millis: yupNumber().defined().meta({ openapiField: { description: 'When the issue was most recently seen, in milliseconds since epoch', exampleValue: 1630000000000 } }),
    times_seen: yupString().defined().meta({ openapiField: { description: 'Lifetime occurrence count, as a decimal string (it is a 64-bit integer and does not fit a JSON number safely)', exampleValue: '1337' } }),

    service_name: yupString().nullable().defined().meta({ openapiField: { description: 'The service that reported the issue, if configured', exampleValue: 'web' } }),
    environment: yupString().nullable().defined().meta({ openapiField: { description: 'The environment the issue was reported from, if configured', exampleValue: 'production' } }),
    release: yupString().nullable().defined().meta({ openapiField: { description: 'The release the issue was reported from, if configured', exampleValue: '1.4.2' } }),

    url: yupString().defined().meta({ openapiField: { description: 'Deep link to the issue in the Hexclave dashboard', exampleValue: 'https://app.hexclave.com/projects/3241a285-8329-4d69-8f3d-316e08cf140c/observability/issues/8f3d316e-08cf-4d69-8329-140c3241a285' } }),
  }).defined();
}

/**
 * The canonical payload shape shared by every `issue.*` event. Kept exported (with neutral examples) so
 * consumers can derive the payload type from one place; the per-event declarations below only differ in their
 * documentation examples.
 */
export const webhookIssueSchema = buildWebhookIssueSchema({ status: "unresolved", substatus: "ongoing" });

export const issueCreatedWebhookEvent = {
  type: "issue.created",
  schema: buildWebhookIssueSchema({ status: "unresolved", substatus: "new" }),
  metadata: {
    summary: "Issue Created",
    description: "This event is triggered the first time an error is grouped into a new issue. It does not fire again for subsequent occurrences of the same issue.",
    tags: ["Observability"],
  },
} satisfies WebhookEvent<typeof webhookIssueSchema>;

export const issueRegressedWebhookEvent = {
  type: "issue.regressed",
  schema: buildWebhookIssueSchema({ status: "unresolved", substatus: "regressed" }),
  metadata: {
    summary: "Issue Regressed",
    description: "This event is triggered when an issue that had been resolved occurs again.",
    tags: ["Observability"],
  },
} satisfies WebhookEvent<typeof webhookIssueSchema>;

export const issueResolvedWebhookEvent = {
  type: "issue.resolved",
  schema: buildWebhookIssueSchema({ status: "resolved", substatus: "ongoing" }),
  metadata: {
    summary: "Issue Resolved",
    description: "This event is triggered when an issue is marked as resolved.",
    tags: ["Observability"],
  },
} satisfies WebhookEvent<typeof webhookIssueSchema>;

export const issueIgnoredWebhookEvent = {
  type: "issue.ignored",
  schema: buildWebhookIssueSchema({ status: "ignored", substatus: "ongoing" }),
  metadata: {
    summary: "Issue Ignored",
    description: "This event is triggered when an issue is marked as ignored.",
    tags: ["Observability"],
  },
} satisfies WebhookEvent<typeof webhookIssueSchema>;

export const issueMergedWebhookEvent = {
  type: "issue.merged",
  schema: buildWebhookIssueSchema({ status: "unresolved", substatus: "ongoing" }),
  metadata: {
    summary: "Issue Merged",
    description: "This event is triggered when issues are merged together. The payload describes the surviving primary issue; the issues merged into it no longer resolve on their own.",
    tags: ["Observability"],
  },
} satisfies WebhookEvent<typeof webhookIssueSchema>;

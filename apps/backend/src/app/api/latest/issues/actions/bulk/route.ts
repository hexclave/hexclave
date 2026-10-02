import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { yupArray, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import {
  applyBulkIssueStatus,
  assertBulkIssueIdentifiers,
  BULK_ISSUE_ACTIONS,
  BULK_ISSUE_STATUSES,
  isValidBulkIssueIdentifier,
  MAX_BULK_ISSUE_IDS,
  MAX_BULK_ISSUE_ID_LENGTH,
  parseBulkIssueStatus,
} from "./bulk-status";
import { IssueActionAuthSchema, MAX_ACTION_TIMESTAMP_MILLIS, assertIssueActionsEnabled } from "../../[issue_id]/actions/_shared";

const BulkIssueIdentifierSchema = yupString()
  .nonEmpty()
  .max(MAX_BULK_ISSUE_ID_LENGTH)
  .defined()
  .test("uuid-or-short-id", "issue_ids must contain only UUIDs or numeric short ids", (value) => isValidBulkIssueIdentifier(value));

export const BulkIssueStatusBodySchema = yupObject({
  status: yupString().oneOf([...BULK_ISSUE_STATUSES]).defined(),
  issue_ids: yupArray(BulkIssueIdentifierSchema)
    .min(1)
    .max(MAX_BULK_ISSUE_IDS)
    .defined()
    .test(
      "unique-issue-ids",
      "issue_ids must not contain duplicates",
      (value) => !Array.isArray(value) || new Set(value).size === value.length,
    ),
}).defined();

const BulkIssueStatusResultSchema = yupObject({
  input_issue_id: yupString().defined(),
  action: yupString().oneOf([...BULK_ISSUE_ACTIONS]).defined(),
  issue_id: yupString().uuid().nullable().defined(),
  redirected: yupBoolean().defined(),
  redirected_from_issue_id: yupString().uuid().nullable().defined(),
  changed: yupBoolean().defined(),
  changed_at_millis: yupNumber().integer().min(0).max(MAX_ACTION_TIMESTAMP_MILLIS).nullable().defined(),
  status: yupString().oneOf([...BULK_ISSUE_STATUSES]).nullable().defined(),
  transition_kind: yupString().oneOf([
    "status_changed",
    "status_unchanged",
    "regressed",
    "reopened",
    "occurrence_unchanged",
  ]).nullable().defined(),
  ignored_until_millis: yupNumber().integer().min(0).max(MAX_ACTION_TIMESTAMP_MILLIS).nullable().defined(),
  regressed_at_millis: yupNumber().integer().min(0).max(MAX_ACTION_TIMESTAMP_MILLIS).nullable().defined(),
  error: yupString().oneOf(["not_found"]).nullable().defined(),
}).defined();

export const BulkIssueStatusResponseSchema = yupObject({
  status: yupString().oneOf([...BULK_ISSUE_STATUSES]).defined(),
  results: yupArray(BulkIssueStatusResultSchema).defined(),
}).defined();

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Bulk change issue status",
    description: "Resolves, ignores, or reopens a bounded explicit list of issues in the authenticated project branch.",
    tags: ["Issues"],
  },
  request: yupObject({
    auth: IssueActionAuthSchema,
    body: BulkIssueStatusBodySchema,
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: BulkIssueStatusResponseSchema,
  }),
  async handler({ auth, body }) {
    assertIssueActionsEnabled(auth.tenancy);
    assertBulkIssueIdentifiers(body.issue_ids);
    const status = parseBulkIssueStatus(body.status);
    const results = await applyBulkIssueStatus({
      tenancy: auth.tenancy,
      issueIds: body.issue_ids,
      status,
    });
    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        status,
        results,
      },
    } as const;
  },
});

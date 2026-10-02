import type { Prisma } from "@/generated/prisma/client";
import { resolveIssueIdentity } from "@/lib/issues/issue-identity";
import { IssueProductInputError, listIssueActivity, type IssueActivityRecord } from "@/lib/issues/issue-product";
import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { IssueActivityRecordSchema, type IssueActivityRecord as IssueActivityRecordJson } from "@hexclave/shared/dist/interface/admin-issues";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupArray, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError, StatusError } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";

const AuthSchema = yupObject({ type: serverOrHigherAuthTypeSchema.defined(), tenancy: adaptSchema.defined() }).defined();
const ParamsSchema = yupObject({ issue_id: yupString().defined() }).defined();
const ResponseSchema = yupObject({ items: yupArray(IssueActivityRecordSchema).defined() }).defined();

function serializeActivityRecord(activity: IssueActivityRecord): IssueActivityRecordJson {
  return {
    id: activity.id,
    actor_user_id: activity.actorUserId,
    type: activity.type,
    idempotency_key: activity.idempotencyKey,
    data: toSharedJson(activity.data, "activity data"),
    occurred_at: activity.occurredAt.toISOString(),
    created_at: activity.createdAt.toISOString(),
  };
}

// Prisma's JsonObject values are optional (`undefined` can hide inside), so a stored
// activity payload is not statically a shared Json value; the runtime check closes that gap.
function toSharedJson(value: Prisma.JsonValue, fieldName: string): Json {
  if (!isJsonSerializable(value)) {
    throw new HexclaveAssertionError(`Issue ${fieldName} contains a non-JSON value`, { value });
  }
  return value;
}

export const GET = createSmartRouteHandler({
  metadata: { summary: "List issue activity", description: "Returns a bounded, branch-scoped issue activity stream.", tags: ["Issues"] },
  request: yupObject({ auth: AuthSchema, params: ParamsSchema }).defined(),
  response: yupObject({ statusCode: yupNumber().oneOf([200]).defined(), bodyType: yupString().oneOf(["json"]).defined(), body: ResponseSchema }).defined(),
  async handler({ auth, params }) {
    assertObservabilityEnabled(auth.tenancy);
    const identity = await resolveIssueIdentity(auth.tenancy, params.issue_id);
    if (identity === null) throw new StatusError(StatusError.NotFound, "Issue not found");
    try {
      const items = await listIssueActivity({ tenancy: auth.tenancy, issueId: identity.issueId });
      return { statusCode: 200, bodyType: "json", body: { items: items.map(serializeActivityRecord) } } as const;
    } catch (error) {
      if (error instanceof IssueProductInputError) throw new StatusError(StatusError.NotFound, "Issue not found");
      throw error;
    }
  },
});

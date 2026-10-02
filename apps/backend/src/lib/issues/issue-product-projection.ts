import type { IssueProductMetadata } from "@hexclave/shared/dist/interface/admin-issues";
import { isJsonSerializable, type Json } from "@hexclave/shared/dist/utils/json";
import type { IssueProductSnapshot } from "./issue-product";

function toSharedJson(value: unknown, fieldName: string): Json {
  if (!isJsonSerializable(value)) {
    throw new Error(`Issue product ${fieldName} contains a non-JSON value`);
  }
  return value;
}

export function serializeIssueProductSnapshot(snapshot: IssueProductSnapshot): IssueProductMetadata {
  return {
    priority: snapshot.priority,
    assignee_user_id: snapshot.assigneeUserId,
    team_id: snapshot.teamId,
    owners: snapshot.owners.map((owner) => ({
      id: owner.id,
      type: owner.type,
      user_id: owner.userId,
      team_id: owner.teamId,
      source: owner.source,
      context: toSharedJson(owner.context, "owner context"),
      created_at: owner.createdAt.toISOString(),
      updated_at: owner.updatedAt.toISOString(),
    })),
    activities: snapshot.activities.map((activity) => ({
      id: activity.id,
      actor_user_id: activity.actorUserId,
      type: activity.type,
      idempotency_key: activity.idempotencyKey,
      data: toSharedJson(activity.data, "activity data"),
      occurred_at: activity.occurredAt.toISOString(),
      created_at: activity.createdAt.toISOString(),
    })),
    comments: snapshot.comments.map((comment) => ({
      id: comment.id,
      author_user_id: comment.authorUserId,
      body: comment.body,
      idempotency_key: comment.idempotencyKey,
      created_at: comment.createdAt.toISOString(),
      updated_at: comment.updatedAt.toISOString(),
    })),
    subscriptions: snapshot.subscriptions.map((subscription) => ({
      type: subscription.type,
      id: subscription.id,
      is_active: subscription.isActive,
      reason: subscription.reason,
      created_at: subscription.createdAt.toISOString(),
      updated_at: subscription.updatedAt.toISOString(),
    })),
    bookmarked_user_ids: [...snapshot.bookmarkedUserIds],
  };
}

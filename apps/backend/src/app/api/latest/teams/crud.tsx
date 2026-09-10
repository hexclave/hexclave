import { buildCreatedFieldsAuditMetadata, buildUpdatedFieldsAuditMetadata, recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { recordExternalDbSyncDeletion, recordExternalDbSyncTeamInvitationDeletionsForTeam, recordExternalDbSyncTeamMemberDeletionsForTeam, recordExternalDbSyncTeamPermissionDeletionsForTeam, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { createFreePlanSubscriptionRow } from "@/lib/payments/ensure-free-plan";
import { ensureTeamExists, ensureTeamMembershipExists, ensureUserExists, ensureUserTeamPermissionExists } from "@/lib/request-checks";
import { sendTeamCreatedWebhook, sendTeamDeletedWebhook, sendTeamUpdatedWebhook } from "@/lib/webhooks";
import { enqueueWorkflowEvent } from "@/lib/workflows/events";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { uploadAndGetUrl } from "@/s3";
import { runAsynchronouslyAndWaitUntil } from "@/utils/background-tasks";
import { Prisma, PurchaseCreationSource } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import { teamsCrud } from "@hexclave/shared/dist/interface/crud/teams";
import { captureError } from "@hexclave/shared/dist/utils/errors";
import { userIdOrMeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { validateBase64Image } from "@hexclave/shared/dist/utils/base64";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import { addUserToTeam } from "../team-memberships/crud";


export function teamPrismaToCrud(prisma: Prisma.TeamGetPayload<{}>) {
  return {
    id: prisma.teamId,
    display_name: prisma.displayName,
    profile_image_url: prisma.profileImageUrl,
    created_at_millis: prisma.createdAt.getTime(),
    client_metadata: prisma.clientMetadata,
    client_read_only_metadata: prisma.clientReadOnlyMetadata,
    server_metadata: prisma.serverMetadata,
  };
}

export const teamsCrudHandlers = createLazyProxy(() => createCrudHandlers(teamsCrud, {
  querySchema: yupObject({
    user_id: userIdOrMeSchema.optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: 'Filter for the teams that the user is a member of. Can be either `me` or an ID. Must be `me` in the client API', exampleValue: 'me' } }),
    /** @deprecated use creator_user_id in the body instead */
    add_current_user: yupString().oneOf(["true", "false"]).optional().meta({ openapiField: { onlyShowInOperations: ['Create'], hidden: true } }),
    order_by: yupString().oneOf(["created_at"]).optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: 'Field to order results by. Currently only `created_at` is supported.', exampleValue: 'created_at' } }),
    desc: yupString().oneOf(["true", "false"]).optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: 'Whether to order results in descending order. Defaults to false (ascending).', exampleValue: 'false' } }),
    limit: yupNumber().integer().min(1).max(200).optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: 'The maximum number of items to return (capped at 200).' } }),
    cursor: yupString().uuid().optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: 'The cursor to start the result set from. Requires `limit` to also be set.' } }),
    query: yupString().optional().meta({ openapiField: { onlyShowInOperations: ['List'], description: "A search query to filter the results by. Free-text search applied to the team's id (exact-match) and display name." } }),
  }),
  paramsSchema: yupObject({
    team_id: yupString().uuid().defined(),
  }),
  onCreate: async ({ query, auth, data }) => {
    let addUserId = data.creator_user_id;

    if (data.creator_user_id && query.add_current_user) {
      throw new StatusError(StatusError.BadRequest, "Cannot use both creator_user_id and add_current_user. add_current_user is deprecated, please only use creator_user_id in the body.");
    }

    if (auth.type === 'client') {
      if (!auth.user) {
        throw new KnownErrors.UserAuthenticationRequired;
      }

      if (!auth.tenancy.config.teams.allowClientTeamCreation) {
        throw new StatusError(StatusError.Forbidden, 'Client team creation is disabled for this project');
      }

      if (data.profile_image_url && !validateBase64Image(data.profile_image_url)) {
        throw new StatusError(400, "Invalid profile image URL");
      }

      if (!data.creator_user_id) {
        addUserId = auth.user.id;
      } else if (data.creator_user_id !== auth.user.id) {
        throw new StatusError(StatusError.Forbidden, "You cannot create a team as a user that is not yourself. Make sure you set the creator_user_id to 'me'.");
      }
    }

    if (query.add_current_user === 'true') {
      if (!auth.user) {
        throw new StatusError(StatusError.Unauthorized, "You must be logged in to create a team with the current user as a member.");
      }
      addUserId = auth.user.id;
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const { db, freePlanSubscription } = await retryTransaction(prisma, async (tx) => {
      const db = await tx.team.create({
        data: withExternalDbSyncUpdate({
          displayName: data.display_name,
          mirroredProjectId: auth.project.id,
          mirroredBranchId: auth.branchId,
          tenancyId: auth.tenancy.id,
          clientMetadata: data.client_metadata === null ? Prisma.JsonNull : data.client_metadata,
          clientReadOnlyMetadata: data.client_read_only_metadata === null ? Prisma.JsonNull : data.client_read_only_metadata,
          serverMetadata: data.server_metadata === null ? Prisma.JsonNull : data.server_metadata,
          profileImageUrl: await uploadAndGetUrl(data.profile_image_url, "team-profile-images"),
        }),
      });

      if (addUserId) {
        await ensureUserExists(tx, { tenancyId: auth.tenancy.id, userId: addUserId });
        await addUserToTeam(tx, {
          tenancy: auth.tenancy,
          teamId: db.teamId,
          userId: addUserId,
          type: 'creator',
        });
      }

      // Grant the free plan to every new internal-project team in the same
      // transaction as the team create, so either both commit or neither
      // does. Bulldozer write runs after the tx (it issues its own
      // BEGIN/COMMIT and can't nest); if that fails, the sub still exists
      // in Prisma and will be reconciled on the next sync/webhook.
      //
      // Silently skip if the `free` product isn't configured (or isn't a
      // team-typed product in a product line) — we don't want to block
      // team creation for callers in non-internal projects or in test
      // setups where the payments config may not be fully hydrated.
      const freePlanProduct = getOrUndefined(auth.tenancy.config.payments.products, "free");
      const shouldGrantFreePlan = auth.project.id === "internal"
        && freePlanProduct != null
        && freePlanProduct.customerType === "team"
        && freePlanProduct.productLineId != null;
      const freePlanSubscription = shouldGrantFreePlan
        ? await createFreePlanSubscriptionRow({
          prisma: tx,
          internalTenancy: auth.tenancy,
          billingTeamId: db.teamId,
          creationSource: PurchaseCreationSource.API_GRANT,
        })
        : null;

      // Workflow platform events ride the entity transaction (transactional
      // outbox); the Svix webhook below stays fire-and-forget post-commit.
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team.created", payload: teamPrismaToCrud(db) });

      return { db, freePlanSubscription };
    });

    if (freePlanSubscription != null) {
      try {
        await bulldozerWriteSubscription(freePlanSubscription);
      } catch (error) {
        // let's not block team creation for this
        captureError("teams:create:free-plan-bulldozer-write", error);
      }
    }

    const result = teamPrismaToCrud(db);

    // Dashboard/admin + server-key only — client self-service team creation is not audited.
    // Personal teams created via programmatic adminCreate are skipped by shouldRecordAdminAudit.
    if (shouldRecordAdminAudit(auth)) {
      // Prefer the persisted CRUD snapshot over the request body so we never store
      // raw base64 profile images from create payloads (result has the uploaded URL).
      const metadata = buildCreatedFieldsAuditMetadata({
        source: "teams.create",
        fields: {
          team_id: result.id,
          display_name: result.display_name,
          profile_image_url: result.profile_image_url,
          client_metadata: result.client_metadata,
          client_read_only_metadata: result.client_read_only_metadata,
          server_metadata: result.server_metadata,
          ...(addUserId != null ? { creator_user_id: addUserId } : {}),
        },
      }) ?? {
          source: "teams.create",
          team_id: result.id,
        };
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "team.created",
        metadata,
      });
    }

    runAsynchronouslyAndWaitUntil(sendTeamCreatedWebhook({
      projectId: auth.project.id,
      data: result,
    }));

    return result;
  },
  onRead: async ({ params, auth }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    if (auth.type === 'client') {
      await ensureTeamMembershipExists(prisma, {
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
        userId: auth.user?.id ?? throwErr(new KnownErrors.UserAuthenticationRequired),
      });
    }

    const db = await prisma.team.findUnique({
      where: {
        tenancyId_teamId: {
          tenancyId: auth.tenancy.id,
          teamId: params.team_id,
        },
      },
    });

    if (!db) {
      throw new KnownErrors.TeamNotFound(params.team_id);
    }

    return teamPrismaToCrud(db);
  },
  onUpdate: async ({ params, auth, data }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const { beforeTeam, afterTeam } = await retryTransaction(prisma, async (tx) => {
      if (auth.type === 'client' && data.profile_image_url && !validateBase64Image(data.profile_image_url)) {
        throw new StatusError(400, "Invalid profile image URL");
      }

      if (auth.type === 'client') {
        await ensureUserTeamPermissionExists(tx, {
          tenancy: auth.tenancy,
          teamId: params.team_id,
          userId: auth.user?.id ?? throwErr(new KnownErrors.UserAuthenticationRequired),
          permissionId: "$update_team",
          errorType: 'required',
          recursive: true,
        });
      }

      await ensureTeamExists(tx, { tenancyId: auth.tenancy.id, teamId: params.team_id });

      const oldTeam = await tx.team.findUnique({
        where: {
          tenancyId_teamId: {
            tenancyId: auth.tenancy.id,
            teamId: params.team_id,
          },
        },
      });
      if (!oldTeam) {
        throw new KnownErrors.TeamNotFound(params.team_id);
      }

      const updated = await tx.team.update({
        where: {
          tenancyId_teamId: {
            tenancyId: auth.tenancy.id,
            teamId: params.team_id,
          },
        },
        data: withExternalDbSyncUpdate({
          displayName: data.display_name,
          clientMetadata: data.client_metadata === null ? Prisma.JsonNull : data.client_metadata,
          clientReadOnlyMetadata: data.client_read_only_metadata === null ? Prisma.JsonNull : data.client_read_only_metadata,
          serverMetadata: data.server_metadata === null ? Prisma.JsonNull : data.server_metadata,
          profileImageUrl: await uploadAndGetUrl(data.profile_image_url, "team-profile-images"),
        }),
      });
      const beforeTeam = teamPrismaToCrud(oldTeam);
      const afterTeam = teamPrismaToCrud(updated);
      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team.updated", payload: afterTeam });
      return { beforeTeam, afterTeam };
    });

    // Renames, profile image, and client / client-read-only / server metadata share
    // one team.updated event with field-level before/after (same shape as user.updated).
    if (shouldRecordAdminAudit(auth)) {
      const patchForAudit: Record<string, unknown> = { ...data };
      const metadata = buildUpdatedFieldsAuditMetadata({
        source: "teams.update",
        patch: patchForAudit,
        beforeRoot: beforeTeam,
        afterRoot: afterTeam,
      });
      if (metadata != null) {
        await recordAuditEvent({
          tenancy: auth.tenancy,
          auth,
          action: "team.updated",
          metadata: {
            ...metadata,
            team_id: params.team_id,
          },
        });
      }
    }

    runAsynchronouslyAndWaitUntil(sendTeamUpdatedWebhook({
      projectId: auth.project.id,
      data: afterTeam,
    }));

    return afterTeam;
  },
  onDelete: async ({ params, auth }) => {
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const deletedTeam = await retryTransaction(prisma, async (tx) => {
      if (auth.type === 'client') {
        await ensureUserTeamPermissionExists(tx, {
          tenancy: auth.tenancy,
          teamId: params.team_id,
          userId: auth.user?.id ?? throwErr(new KnownErrors.UserAuthenticationRequired),
          permissionId: "$delete_team",
          errorType: 'required',
          recursive: true,
        });
      }
      await ensureTeamExists(tx, { tenancyId: auth.tenancy.id, teamId: params.team_id });

      const existing = await tx.team.findUnique({
        where: {
          tenancyId_teamId: {
            tenancyId: auth.tenancy.id,
            teamId: params.team_id,
          },
        },
      });
      if (!existing) {
        throw new KnownErrors.TeamNotFound(params.team_id);
      }

      await recordExternalDbSyncTeamPermissionDeletionsForTeam(tx, {
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
      });

      await recordExternalDbSyncTeamInvitationDeletionsForTeam(tx, {
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
      });

      await recordExternalDbSyncTeamMemberDeletionsForTeam(tx, {
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
      });

      await recordExternalDbSyncDeletion(tx, {
        tableName: "Team",
        tenancyId: auth.tenancy.id,
        teamId: params.team_id,
      });

      await tx.team.delete({
        where: {
          tenancyId_teamId: {
            tenancyId: auth.tenancy.id,
            teamId: params.team_id,
          },
        },
      });

      await enqueueWorkflowEvent(tx, { tenancy: auth.tenancy, type: "team.deleted", payload: { id: params.team_id } });
      return teamPrismaToCrud(existing);
    });

    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "team.deleted",
        metadata: {
          source: "teams.delete",
          team_id: params.team_id,
          display_name: deletedTeam.display_name,
        },
      });
    }

    runAsynchronouslyAndWaitUntil(sendTeamDeletedWebhook({
      projectId: auth.project.id,
      data: {
        id: params.team_id,
      },
    }));
  },
  onList: async ({ query, auth }) => {
    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());

      if (query.user_id !== currentUserId) {
        throw new StatusError(StatusError.Forbidden, 'Client can only list teams for their own user. user_id must be either "me" or the ID of the current user');
      }
    }

    if (query.cursor && !query.limit) {
      throw new StatusError(StatusError.BadRequest, "`cursor` requires `limit` to also be set.");
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const sortDirection = query.desc === 'true' ? 'desc' : 'asc';

    let queryFilter: Prisma.TeamWhereInput | undefined;
    if (query.query) {
      queryFilter = {
        OR: [
          ...isUuid(query.query) ? [{ teamId: { equals: query.query } }] : [],
          {
            displayName: {
              contains: query.query,
              mode: 'insensitive' as const,
            },
          },
        ],
      };
    }

    const db = await prisma.team.findMany({
      where: {
        tenancyId: auth.tenancy.id,
        ...query.user_id ? {
          teamMembers: {
            some: {
              projectUserId: query.user_id,
            },
          },
        } : {},
        ...queryFilter ?? {},
      },
      orderBy: [
        { createdAt: sortDirection },
        { teamId: sortDirection },
      ],
      take: query.limit ? query.limit + 1 : undefined,
      ...query.cursor ? {
        skip: 1,
        cursor: {
          tenancyId_teamId: {
            tenancyId: auth.tenancy.id,
            teamId: query.cursor,
          },
        },
      } : {},
    });

    if (query.limit) {
      const items = db.slice(0, query.limit).map(teamPrismaToCrud);
      const hasMore = db.length > query.limit;
      return {
        items,
        is_paginated: true,
        pagination: {
          next_cursor: hasMore && items.length > 0 ? items[items.length - 1].id : null,
        },
      };
    }

    return {
      items: db.map(teamPrismaToCrud),
      is_paginated: false,
    };
  }
}));

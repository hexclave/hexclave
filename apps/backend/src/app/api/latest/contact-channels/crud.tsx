import { BooleanTrue, Prisma } from "@/generated/prisma/client";
import { recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { demoteAllContactChannelsToNonPrimary, setContactChannelAsPrimaryById } from "@/lib/contact-channel";
import { normalizeEmail } from "@/lib/emails";
import { markProjectUserForExternalDbSync, recordExternalDbSyncDeletion, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { ensureContactChannelDoesNotExists, ensureContactChannelExists } from "@/lib/request-checks";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { KnownErrors } from "@hexclave/shared";
import { contactChannelsCrud } from "@hexclave/shared/dist/interface/crud/contact-channels";
import { userIdOrMeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";
import { typedToLowercase, typedToUppercase } from "@hexclave/shared/dist/utils/strings";

export const contactChannelToCrud = (channel: Prisma.ContactChannelGetPayload<{}>) => {
  return {
    user_id: channel.projectUserId,
    id: channel.id,
    type: typedToLowercase(channel.type),
    value: channel.value,
    is_primary: !!channel.isPrimary,
    is_verified: channel.isVerified,
    used_for_auth: !!channel.usedForAuth,
  } as const;
};

export const contactChannelsCrudHandlers = createLazyProxy(() => createCrudHandlers(contactChannelsCrud, {
  querySchema: yupObject({
    user_id: userIdOrMeSchema.optional(),
    contact_channel_id: yupString().uuid().optional(),
  }),
  paramsSchema: yupObject({
    user_id: userIdOrMeSchema.defined().meta({ openapiField: { description: "the user that the contact channel belongs to", exampleValue: 'me', onlyShowInOperations: ["Read", "Update", "Delete"] } }),
    contact_channel_id: yupString().uuid().defined().meta({ openapiField: { description: "the target contact channel", exampleValue: 'b3d396b8-c574-4c80-97b3-50031675ceb2', onlyShowInOperations: ["Read", "Update", "Delete"] } }),
  }),
  onRead: async ({ params, auth }) => {
    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== params.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only read contact channels for their own user.');
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const contactChannel = await prisma.contactChannel.findUnique({
      where: {
        tenancyId_projectUserId_id: {
          tenancyId: auth.tenancy.id,
          projectUserId: params.user_id,
          id: params.contact_channel_id || throwErr("Missing contact channel id"),
        },
      },
    });

    if (!contactChannel) {
      throw new StatusError(StatusError.NotFound, 'Contact channel not found.');
    }

    return contactChannelToCrud(contactChannel);
  },
  onCreate: async ({ auth, data }) => {
    let value = data.value;
    switch (data.type) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      case 'email': {
        value = normalizeEmail(value);
        break;
      }
    }

    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== data.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only create contact channels for their own user.');
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const contactChannel = await retryTransaction(prisma, async (tx) => {
      await ensureContactChannelDoesNotExists(tx, {
        tenancyId: auth.tenancy.id,
        userId: data.user_id,
        type: data.type,
        value: value,
      });

      // if usedForAuth is set to true, make sure no other account uses this channel for auth
      if (data.used_for_auth) {
        const existingWithSameChannel = await tx.contactChannel.findUnique({
          where: {
            tenancyId_type_value_usedForAuth: {
              tenancyId: auth.tenancy.id,
              type: crudContactChannelTypeToPrisma(data.type),
              value: value,
              usedForAuth: 'TRUE',
            },
          },
        });
        if (existingWithSameChannel) {
          throw new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse(data.type, value);
        }
      }

      const createdContactChannel = await tx.contactChannel.create({
        data: {
          tenancyId: auth.tenancy.id,
          projectUserId: data.user_id,
          type: typedToUppercase(data.type),
          value: value,
          isVerified: data.is_verified ?? false,
          usedForAuth: data.used_for_auth ? 'TRUE' : null,
        },
      });

      let previousPrimaryDemoted = false;
      if (data.is_primary) {
        const otherPrimary = await tx.contactChannel.findFirst({
          where: {
            tenancyId: auth.tenancy.id,
            projectUserId: data.user_id,
            type: crudContactChannelTypeToPrisma(data.type),
            isPrimary: BooleanTrue.TRUE,
            id: { not: createdContactChannel.id },
          },
          select: { id: true },
        });
        previousPrimaryDemoted = otherPrimary != null;
        await setContactChannelAsPrimaryById(tx, {
          tenancyId: auth.tenancy.id,
          projectUserId: data.user_id,
          contactChannelId: createdContactChannel.id,
          type: crudContactChannelTypeToPrisma(data.type),
        });
      }

      await markProjectUserForExternalDbSync(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: data.user_id,
      });

      const created = await tx.contactChannel.findUnique({
        where: {
          tenancyId_projectUserId_id: {
            tenancyId: auth.tenancy.id,
            projectUserId: data.user_id,
            id: createdContactChannel.id,
          },
        },
      }) || throwErr("Failed to create contact channel");
      return {
        channel: created,
        previousPrimaryDemoted,
      };
    });

    const crud = contactChannelToCrud(contactChannel.channel);
    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "contact_channel.created",
        targetUserId: crud.user_id,
        metadata: {
          source: "contact_channels.create",
          contact_channel_id: crud.id,
          type: crud.type,
          is_primary: crud.is_primary,
          is_verified: crud.is_verified,
          used_for_auth: crud.used_for_auth,
          ...(contactChannel.previousPrimaryDemoted ? { previous_primary_demoted: true } : {}),
        },
      });
    }
    return crud;
  },
  onUpdate: async ({ params, auth, data }) => {
    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== params.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only update contact channels for their own user.');
      }
    }


    let value = data.value;
    switch (data.type) {
      case 'email': {
        value = value ? normalizeEmail(value) : undefined;
        break;
      }
      case undefined: {
        break;
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const updatedContactChannel = await retryTransaction(prisma, async (tx) => {
      const existingContactChannel = await ensureContactChannelExists(tx, {
        tenancyId: auth.tenancy.id,
        userId: params.user_id,
        contactChannelId: params.contact_channel_id || throwErr("Missing contact channel id"),
      });

      // if usedForAuth is set to true, make sure no other account uses this channel for auth
      if (data.used_for_auth) {
        const existingWithSameChannel = await tx.contactChannel.findUnique({
          where: {
            tenancyId_type_value_usedForAuth: {
              tenancyId: auth.tenancy.id,
              type: data.type !== undefined ? crudContactChannelTypeToPrisma(data.type) : existingContactChannel.type,
              value: value !== undefined ? value : existingContactChannel.value,
              usedForAuth: 'TRUE',
            },
          },
        });
        if (existingWithSameChannel && existingWithSameChannel.id !== existingContactChannel.id) {
          throw new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse(data.type ?? prismaContactChannelTypeToCrud(existingContactChannel.type));
        }
      }

      let previousPrimaryDemoted = false;
      if (data.is_primary) {
        const otherPrimary = await tx.contactChannel.findFirst({
          where: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
            type: data.type !== undefined ? crudContactChannelTypeToPrisma(data.type) : existingContactChannel.type,
            isPrimary: BooleanTrue.TRUE,
            id: { not: existingContactChannel.id },
          },
          select: { id: true },
        });
        previousPrimaryDemoted = otherPrimary != null;
        await demoteAllContactChannelsToNonPrimary(tx, {
          tenancyId: auth.tenancy.id,
          projectUserId: params.user_id,
          type: data.type !== undefined ? crudContactChannelTypeToPrisma(data.type) : existingContactChannel.type,
        });
      }

      const updated = await tx.contactChannel.update({
        where: {
          tenancyId_projectUserId_id: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
            id: params.contact_channel_id || throwErr("Missing contact channel id"),
          },
        },
        data: withExternalDbSyncUpdate({
          value: value,
          isVerified: data.is_verified ?? (value ? false : undefined), // if value is updated and is_verified is not provided, set to false
          usedForAuth: data.used_for_auth !== undefined ? (data.used_for_auth ? 'TRUE' : null) : undefined,
          isPrimary: data.is_primary !== undefined ? (data.is_primary ? 'TRUE' : null) : undefined,
        }),
      });

      await markProjectUserForExternalDbSync(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });

      return { channel: updated, previousPrimaryDemoted };
    });

    const crud = contactChannelToCrud(updatedContactChannel.channel);
    if (shouldRecordAdminAudit(auth)) {
      const changedPaths = [
        ...Object.keys(data),
        ...(data.value !== undefined && data.is_verified === undefined ? ["is_verified"] : []),
      ];
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "contact_channel.updated",
        targetUserId: crud.user_id,
        metadata: {
          source: "contact_channels.update",
          contact_channel_id: crud.id,
          type: crud.type,
          changed_paths: changedPaths,
          is_primary: crud.is_primary,
          is_verified: crud.is_verified,
          used_for_auth: crud.used_for_auth,
          ...(updatedContactChannel.previousPrimaryDemoted ? { previous_primary_demoted: true } : {}),
        },
      });
    }
    return crud;
  },
  onDelete: async ({ params, auth }) => {
    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== params.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only delete contact channels for their own user.');
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    await retryTransaction(prisma, async (tx) => {
      await ensureContactChannelExists(tx, {
        tenancyId: auth.tenancy.id,
        userId: params.user_id,
        contactChannelId: params.contact_channel_id || throwErr("Missing contact channel id"),
      });

      await recordExternalDbSyncDeletion(tx, {
        tableName: "ContactChannel",
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
        contactChannelId: params.contact_channel_id || throwErr("Missing contact channel id"),
      });

      await tx.contactChannel.delete({
        where: {
          tenancyId_projectUserId_id: {
            tenancyId: auth.tenancy.id,
            projectUserId: params.user_id,
            id: params.contact_channel_id || throwErr("Missing contact channel id"),
          },
        },
      });

      await markProjectUserForExternalDbSync(tx, {
        tenancyId: auth.tenancy.id,
        projectUserId: params.user_id,
      });
    });

    if (shouldRecordAdminAudit(auth)) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "contact_channel.deleted",
        targetUserId: params.user_id,
        metadata: {
          source: "contact_channels.delete",
          contact_channel_id: params.contact_channel_id,
        },
      });
    }
  },
  onList: async ({ query, auth }) => {
    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== query.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only list contact channels for their own user.');
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const contactChannels = await prisma.contactChannel.findMany({
      where: {
        tenancyId: auth.tenancy.id,
        projectUserId: query.user_id,
        id: query.contact_channel_id,
      },
    });

    return {
      items: contactChannels.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(contactChannelToCrud),
      is_paginated: false,
    };
  }
}));


function crudContactChannelTypeToPrisma(type: "email") {
  return typedToUppercase(type);
}

function prismaContactChannelTypeToCrud(type: "EMAIL") {
  return typedToLowercase(type);
}

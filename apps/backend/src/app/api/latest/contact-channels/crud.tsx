import { ContactChannelType, Prisma } from "@/generated/prisma/client";
import { demoteAllContactChannelsToNonPrimary, setContactChannelAsPrimaryById } from "@/lib/contact-channel";
import { normalizeEmail } from "@/lib/emails";
import { markProjectUserForExternalDbSync, recordExternalDbSyncDeletion, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { ensureContactChannelDoesNotExists, ensureContactChannelExists } from "@/lib/request-checks";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { KnownErrors } from "@hexclave/shared";
import { contactChannelsCrud } from "@hexclave/shared/dist/interface/crud/contact-channels";
import { emailSchema, phoneNumberRegex, userIdOrMeSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
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
    const value = normalizeContactChannelValue(data.type, data.value);

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

      if (data.is_primary) {
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

      return await tx.contactChannel.findUnique({
        where: {
          tenancyId_projectUserId_id: {
            tenancyId: auth.tenancy.id,
            projectUserId: data.user_id,
            id: createdContactChannel.id,
          },
        },
      }) || throwErr("Failed to create contact channel");
    });

    return contactChannelToCrud(contactChannel);
  },
  onUpdate: async ({ params, auth, data }) => {
    if (auth.type === 'client') {
      const currentUserId = auth.user?.id || throwErr(new KnownErrors.CannotGetOwnUserWithoutUser());
      if (currentUserId !== params.user_id) {
        throw new StatusError(StatusError.Forbidden, 'Client can only update contact channels for their own user.');
      }
    }


    const prisma = await getPrismaClientForTenancy(auth.tenancy);

    const updatedContactChannel = await retryTransaction(prisma, async (tx) => {
      const existingContactChannel = await ensureContactChannelExists(tx, {
        tenancyId: auth.tenancy.id,
        userId: params.user_id,
        contactChannelId: params.contact_channel_id || throwErr("Missing contact channel id"),
      });

      // `type` is accepted in the update schema for backwards compatibility, but it was never actually written (back
      // when "email" was the only type, that made no difference). Now that there are multiple types, silently ignoring
      // it would let a phone-formatted value be stored on an email channel, so we reject actual type changes instead.
      const existingType = prismaContactChannelTypeToCrud(existingContactChannel.type);
      if (data.type !== undefined && data.type !== existingType) {
        throw new StatusError(StatusError.BadRequest, "The type of a contact channel cannot be changed. Delete it and create a new contact channel instead.");
      }
      // The request schema can only validate the value against the type if both are in the request body, so we
      // validate (and normalize) against the existing type here, eg. when only the value of a phone channel changes.
      // An empty value for an email channel is a no-op rather than an error, for backwards compatibility: before phone
      // channels existed, requests that included `type: "email"` treated `value: ""` as "unchanged".
      const value = data.value === undefined || (existingType === "email" && data.value === "")
        ? undefined
        : normalizeContactChannelValue(existingType, data.value);

      // if usedForAuth is set to true, make sure no other account uses this channel for auth
      if (data.used_for_auth) {
        const existingWithSameChannel = await tx.contactChannel.findUnique({
          where: {
            tenancyId_type_value_usedForAuth: {
              tenancyId: auth.tenancy.id,
              type: existingContactChannel.type,
              value: value !== undefined ? value : existingContactChannel.value,
              usedForAuth: 'TRUE',
            },
          },
        });
        if (existingWithSameChannel && existingWithSameChannel.id !== existingContactChannel.id) {
          throw new KnownErrors.ContactChannelAlreadyUsedForAuthBySomeoneElse(existingType);
        }
      }

      if (data.is_primary) {
        await demoteAllContactChannelsToNonPrimary(tx, {
          tenancyId: auth.tenancy.id,
          projectUserId: params.user_id,
          type: existingContactChannel.type,
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

      return updated;
    });

    return contactChannelToCrud(updatedContactChannel);
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


function crudContactChannelTypeToPrisma(type: "email" | "phone") {
  return typedToUppercase(type);
}

function prismaContactChannelTypeToCrud(type: ContactChannelType) {
  return typedToLowercase(type);
}

function normalizeContactChannelValue(type: "email" | "phone", value: string): string {
  switch (type) {
    case 'email': {
      // The request schema only validates the email format if `type` is in the same request body, which it doesn't
      // have to be for updates. `normalizeEmail` throws an assertion error (= 500) for malformed emails, so we
      // validate here first.
      if (value === "" || !emailSchema.isValidSync(value)) {
        throw new StatusError(StatusError.BadRequest, "Email must be a valid email address");
      }
      return normalizeEmail(value);
    }
    case 'phone': {
      // Phone numbers are stored in E.164 format, which is already canonical; we only need to reject other formats
      // (the request schema can't do this when the type isn't part of the same request, see onUpdate)
      if (!phoneNumberRegex.test(value)) {
        throw new StatusError(StatusError.BadRequest, "Phone number must be in E.164 format, eg. +15555550100");
      }
      return value;
    }
  }
}

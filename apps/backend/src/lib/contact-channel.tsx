import { BooleanTrue, ContactChannelType } from "@/generated/prisma/client";
import { markProjectUserForExternalDbSync, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { normalizeEmail } from "./emails";
import { PrismaTransaction } from "./types";

const fullContactChannelInclude = {
  projectUser: {
    include: {
      authMethods: {
        include: {
          otpAuthMethod: true,
          passwordAuthMethod: true,
        }
      }
    }
  }
};

/**
 * Demotes all contact channels of a given type for a user to non-primary.
 */
export async function demoteAllContactChannelsToNonPrimary(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    projectUserId: string,
    type: ContactChannelType,
  }
) {
  await tx.contactChannel.updateMany({
    where: {
      tenancyId: options.tenancyId,
      projectUserId: options.projectUserId,
      type: options.type,
      isPrimary: BooleanTrue.TRUE,
    },
    data: withExternalDbSyncUpdate({
      isPrimary: null,
    }),
  });
  await markProjectUserForExternalDbSync(tx, {
    tenancyId: options.tenancyId,
    projectUserId: options.projectUserId,
  });
}

/**
 * Sets a contact channel as primary, demoting all other contact channels of the same type.
 * The contact channel is identified by its ID.
 */
export async function setContactChannelAsPrimaryById(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    projectUserId: string,
    contactChannelId: string,
    type: ContactChannelType,
    /** Additional fields to update on the contact channel */
    additionalUpdates?: {
      usedForAuth?: typeof BooleanTrue.TRUE | null,
      isVerified?: boolean,
    },
  }
) {
  // First, validate that the target contact channel exists and has the correct type
  const targetChannel = await tx.contactChannel.findUnique({
    where: {
      tenancyId_projectUserId_id: {
        tenancyId: options.tenancyId,
        projectUserId: options.projectUserId,
        id: options.contactChannelId,
      },
    },
  });

  if (!targetChannel) {
    throw new HexclaveAssertionError(
      `Contact channel not found with id ${options.contactChannelId} for user ${options.projectUserId} in tenancy ${options.tenancyId}`,
      { options }
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  if (targetChannel.type !== options.type) {
    throw new HexclaveAssertionError(
      `Contact channel type mismatch: expected ${options.type}, got ${targetChannel.type}`,
      { options, actualType: targetChannel.type }
    );
  }

  // Demote all other contact channels of this type
  await demoteAllContactChannelsToNonPrimary(tx, {
    tenancyId: options.tenancyId,
    projectUserId: options.projectUserId,
    type: options.type,
  });

  // Promote the target contact channel to primary
  await tx.contactChannel.update({
    where: {
      tenancyId_projectUserId_id: {
        tenancyId: options.tenancyId,
        projectUserId: options.projectUserId,
        id: options.contactChannelId,
      },
    },
    data: withExternalDbSyncUpdate({
      isPrimary: BooleanTrue.TRUE,
      ...options.additionalUpdates,
    }),
  });
  await markProjectUserForExternalDbSync(tx, {
    tenancyId: options.tenancyId,
    projectUserId: options.projectUserId,
  });
}

/**
 * Sets a contact channel as primary by its value, demoting all other contact channels of the same type.
 */
export async function setContactChannelAsPrimaryByValue(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    projectUserId: string,
    type: ContactChannelType,
    value: string,
    /** Additional fields to update on the contact channel */
    additionalUpdates?: {
      usedForAuth?: typeof BooleanTrue.TRUE | null,
      isVerified?: boolean,
    },
  }
) {
  // Demote all other contact channels of this type
  await demoteAllContactChannelsToNonPrimary(tx, {
    tenancyId: options.tenancyId,
    projectUserId: options.projectUserId,
    type: options.type,
  });

  // Promote the target contact channel to primary
  await tx.contactChannel.update({
    where: {
      tenancyId_projectUserId_type_value: {
        tenancyId: options.tenancyId,
        projectUserId: options.projectUserId,
        type: options.type,
        value: options.value,
      },
    },
    data: withExternalDbSyncUpdate({
      isPrimary: BooleanTrue.TRUE,
      ...options.additionalUpdates,
    }),
  });
  await markProjectUserForExternalDbSync(tx, {
    tenancyId: options.tenancyId,
    projectUserId: options.projectUserId,
  });
}

export async function getAuthContactChannel(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    type: ContactChannelType,
    value: string,
  }
) {
  return await tx.contactChannel.findUnique({
    where: {
      tenancyId_type_value_usedForAuth: {
        tenancyId: options.tenancyId,
        type: options.type,
        value: options.value,
        usedForAuth: "TRUE",
      }
    },
    include: fullContactChannelInclude,
  });
}

/**
 * Looks up an auth contact channel by email, trying both unnormalized and normalized versions.
 * This handles the migration period where some emails in the DB are unnormalized.
 *
 * The lookup order is:
 * 1. Try the email as-is (unnormalized)
 * 2. If not found, try the normalized version
 *
 * @param tx - Prisma transaction
 * @param options - Lookup options including tenancyId, type, and email value
 * @returns The contact channel if found, null otherwise
 */
export async function getAuthContactChannelWithEmailNormalization(
  tx: PrismaTransaction,
  options: {
    tenancyId: string,
    type: ContactChannelType,
    value: string,
  }
) {
  // First try to find with the unnormalized email (for legacy data)
  const unnormalizedResult = await getAuthContactChannel(tx, options);
  if (unnormalizedResult) {
    return unnormalizedResult;
  }

  // Phone numbers are always stored in canonical E.164 form, so there is no legacy unnormalized data to fall back to
  if (options.type !== "EMAIL") {
    return null;
  }

  // If not found, try with normalized email
  const normalizedEmail = normalizeEmail(options.value);
  // Only try normalized if it's different from the original
  if (normalizedEmail !== options.value) {
    const normalizedResult = await getAuthContactChannel(tx, {
      ...options,
      value: normalizedEmail,
    });
    if (normalizedResult) {
      return normalizedResult;
    }
  }

  return null;
}

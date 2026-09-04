import { withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { getSoleTenancyFromProjectBranch } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { VerificationCodeType } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { isJsonSerializable, type JsonObject } from "@hexclave/shared/dist/utils/json";

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && isJsonSerializable(value);
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  if (!code || code.length !== 45)
    return new Response('Invalid code', { status: 400 });

  const codeLower = code.toLowerCase();
  const verificationCode = await globalPrismaClient.verificationCode.findFirst({
    where: {
      code: codeLower,
      type: VerificationCodeType.ONE_TIME_PASSWORD,
    },
  });

  if (!verificationCode) throw new KnownErrors.VerificationCodeNotFound();
  if (verificationCode.expiresAt < new Date()) throw new KnownErrors.VerificationCodeExpired();
  if (verificationCode.usedAt) {
    return new Response('<p>You have already unsubscribed from this notification group</p>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  }
  if (!isJsonObject(verificationCode.data) || typeof verificationCode.data.user_id !== "string" || typeof verificationCode.data.notification_category_id !== "string") {
    throw new HexclaveAssertionError("Unsubscribe verification code has malformed data");
  }
  const { user_id, notification_category_id } = verificationCode.data;

  await globalPrismaClient.verificationCode.update({
    where: {
      projectId_branchId_code: {
        projectId: verificationCode.projectId,
        branchId: verificationCode.branchId,
        code: codeLower,
      },
    },
    data: { usedAt: new Date() },
  });

  const tenancy = await getSoleTenancyFromProjectBranch(verificationCode.projectId, verificationCode.branchId);

  const prisma = await getPrismaClientForTenancy(tenancy);

  await prisma.userNotificationPreference.upsert({
    where: {
      tenancyId_projectUserId_notificationCategoryId: {
        tenancyId: tenancy.id,
        projectUserId: user_id,
        notificationCategoryId: notification_category_id,
      },
    },
    update: withExternalDbSyncUpdate({
      enabled: false,
    }),
    create: withExternalDbSyncUpdate({
      tenancyId: tenancy.id,
      projectUserId: user_id,
      notificationCategoryId: notification_category_id,
      enabled: false,
    }),
  });

  return new Response('<p>Successfully unsubscribed from notification group</p>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}

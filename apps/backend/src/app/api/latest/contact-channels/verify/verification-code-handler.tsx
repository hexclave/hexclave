import { sendEmailFromDefaultTemplate } from "@/lib/emails";
import { markProjectUserForExternalDbSync, withExternalDbSyncUpdate } from "@/lib/external-db-sync";
import { getSoleTenancyFromProjectBranch } from "@/lib/tenancies";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createVerificationCodeHandler } from "@/route-handlers/verification-code-handler";
import { VerificationCodeType } from "@/generated/prisma/client";
import { KnownErrors } from "@hexclave/shared";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { emailSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import { comparePassword } from "@hexclave/shared/dist/utils/hashes";

export const contactChannelVerificationCodeHandler = createVerificationCodeHandler({
  metadata: {
    post: {
      summary: "Verify an email",
      description: "Verify an email address of a user",
      tags: ["Contact Channels"],
    },
    check: {
      summary: "Check email verification code",
      description: "Check if an email verification code is valid without using it",
      tags: ["Contact Channels"],
    },
  },
  type: VerificationCodeType.CONTACT_CHANNEL_VERIFICATION,
  data: yupObject({
    user_id: yupString().defined(),
  }).defined(),
  method: yupObject({
    email: emailSchema.defined(),
  }),
  requestBody: yupObject({
    // Anyone can sign up with someone else's e-mail and a password of their choice, then hope that the
    // real owner clicks the verification link we send them. To stop that, clients can ask us to require
    // the account's password before verifying. This is opt-in so older clients keep working.
    require_password_if_set: yupBoolean().optional(),
    password: yupString().optional(),
  }),
  async validate(tenancy, method, data, body, user) {
    if (!body.require_password_if_set && body.password === undefined) {
      return;
    }
    // Someone signed in as this account already proved they own it
    if (user?.id === data.user_id) {
      return;
    }

    const prisma = await getPrismaClientForTenancy(tenancy);
    const passwordAuthMethod = await prisma.passwordAuthMethod.findFirst({
      where: {
        tenancyId: tenancy.id,
        projectUserId: data.user_id,
      },
    });
    if (!passwordAuthMethod) {
      return;
    }

    if (body.password === undefined) {
      throw new KnownErrors.EmailVerificationRequiresPassword();
    }
    if (!await comparePassword(body.password, passwordAuthMethod.passwordHash)) {
      throw new KnownErrors.PasswordConfirmationMismatch();
    }
  },
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["success"]).defined(),
  }),
  async send(codeObj, createOptions, sendOptions: { user: UsersCrud["Admin"]["Read"], shouldSkipDeliverabilityCheck: boolean }) {
    const tenancy = await getSoleTenancyFromProjectBranch(createOptions.project.id, createOptions.branchId);

    await sendEmailFromDefaultTemplate({
      tenancy,
      user: sendOptions.user,
      email: createOptions.method.email,
      templateType: "email_verification",
      extraVariables: {
        emailVerificationLink: codeObj.link.toString(),
      },
      shouldSkipDeliverabilityCheck: sendOptions.shouldSkipDeliverabilityCheck,
    });
  },
  async handler(tenancy, { email }, data) {
    const uniqueKeys = {
      tenancyId_projectUserId_type_value: {
        tenancyId: tenancy.id,
        projectUserId: data.user_id,
        type: "EMAIL",
        value: email,
      },
    } as const;

    const prisma = await getPrismaClientForTenancy(tenancy);

    const contactChannel = await prisma.contactChannel.findUnique({
      where: uniqueKeys,
    });

    // This happens if the email is sent but then before the user clicks the link, the contact channel is deleted.
    if (!contactChannel) {
      throw new StatusError(400, "Contact channel not found. Was your contact channel deleted?");
    }

    await prisma.contactChannel.update({
      where: uniqueKeys,
      data: withExternalDbSyncUpdate({
        isVerified: true,
      }),
    });

    await markProjectUserForExternalDbSync(prisma, {
      tenancyId: tenancy.id,
      projectUserId: data.user_id,
    });

    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});

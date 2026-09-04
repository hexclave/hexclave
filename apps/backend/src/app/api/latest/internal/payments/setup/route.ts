import { buildCreatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { getHexclaveStripe } from "@/lib/stripe";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      url: yupString().defined(),
    }).defined(),
  }),
  handler: async ({ auth }) => {
    const stripe = getHexclaveStripe();
    const dashboardBaseUrl = getEnvVariable("NEXT_PUBLIC_STACK_DASHBOARD_URL");

    const project = await globalPrismaClient.project.findUnique({
      where: { id: auth.project.id },
      select: { onboardingStatus: true, stripeAccountId: true },
    });

    let stripeAccountId = project?.stripeAccountId || null;
    const stripeAccountCreated = stripeAccountId == null;
    const returnToUrl = project?.onboardingStatus === "payments_setup"
      ? (() => {
        const onboardingUrl = new URL("/new-project", dashboardBaseUrl);
          onboardingUrl.searchParams.set("project_id", auth.project.id);
          return onboardingUrl.toString();
      })()
      : new URL(`/projects/${encodeURIComponent(auth.project.id)}/payments`, dashboardBaseUrl).toString();

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        controller: {
          stripe_dashboard: { type: "none" },
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        country: "US",
        metadata: {
          tenancyId: auth.tenancy.id,
        }
      });
      stripeAccountId = account.id;

      await globalPrismaClient.project.update({
        where: { id: auth.project.id },
        data: { stripeAccountId },
      });
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: returnToUrl,
      return_url: returnToUrl,
      type: "account_onboarding",
    });

    // Dashboard-only via recordAuditEvent. Never persist the Account Link URL.
    const metadata = buildCreatedFieldsAuditMetadata({
      source: "payments.setup",
      fields: {
        stripe_account_created: stripeAccountCreated,
      },
    }) ?? {
        source: "payments.setup",
        stripe_account_created: stripeAccountCreated,
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "payment.stripe.setup_started",
      metadata,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: { url: accountLink.url },
    };
  },
});

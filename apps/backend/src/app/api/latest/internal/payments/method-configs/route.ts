import { buildUpdatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { isPreviewModeEnabled } from "@/lib/preview-mode";
import { getHexclaveStripe } from "@/lib/stripe";
import { globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { getAllPaymentMethodIds, getAllPaymentMethodNames, getPaymentMethodName, isKnownPaymentMethod } from "@hexclave/shared/dist/payments/payment-methods";
import { adaptSchema, adminAuthTypeSchema, yupArray, yupBoolean, yupNumber, yupObject, yupRecord, yupString } from "@hexclave/shared/dist/schema-fields";
import { HexclaveAssertionError } from "@hexclave/shared/dist/utils/errors";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";

const METADATA_FIELDS = new Set([
  'id', 'object', 'active', 'application', 'is_default', 'livemode', 'name', 'parent'
]);

function paymentMethodAuditFields(config: object, methodIds: string[]): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const configRecord = config as Record<string, unknown>;
  for (const methodId of methodIds) {
    const method = configRecord[methodId];
    if (method == null || typeof method !== "object" || Array.isArray(method) || !("display_preference" in method)) {
      continue;
    }
    const preference = (method as { display_preference?: { preference?: string, value?: string, overridable?: boolean } }).display_preference;
    fields[`methods.${methodId}.preference`] = preference?.preference ?? null;
    fields[`methods.${methodId}.effective`] = preference?.value ?? null;
    fields[`methods.${methodId}.overridable`] = preference?.overridable ?? null;
  }
  return fields;
}

export const GET = createSmartRouteHandler({
  metadata: {
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      config_id: yupString().defined(),
      methods: yupArray(yupObject({
        id: yupString().defined(),
        name: yupString().oneOf(getAllPaymentMethodNames()).defined(),
        enabled: yupBoolean().defined(),
        available: yupBoolean().defined(),
        overridable: yupBoolean().defined(),
      })).defined(),
    }).defined(),
  }),
  handler: async ({ auth }) => {
    const project = await globalPrismaClient.project.findUnique({
      where: { id: auth.project.id },
      select: { stripeAccountId: true },
    });

    if (!project?.stripeAccountId) {
      throw new KnownErrors.StripeAccountInfoNotFound();
    }

    if (isPreviewModeEnabled()) {
      return {
        statusCode: 200,
        bodyType: "json",
        body: {
          config_id: "pmc_preview",
          methods: [
            { id: "card", name: getPaymentMethodName("card"), enabled: true, available: true, overridable: true },
            { id: "link", name: getPaymentMethodName("link"), enabled: true, available: true, overridable: true },
            { id: "us_bank_account", name: getPaymentMethodName("us_bank_account"), enabled: false, available: true, overridable: true },
          ],
        },
      };
    }

    const stripe = getHexclaveStripe();
    const configs = await stripe.paymentMethodConfigurations.list({}, {
      stripeAccount: project.stripeAccountId,
    });


    const platformConfig = configs.data.find(c => c.application || c.parent);
    const defaultConfig = platformConfig || configs.data.find(c => c.is_default);
    if (!defaultConfig) {
      throw new HexclaveAssertionError("No payment method configuration found for Stripe account", {
        stripeAccountId: project.stripeAccountId,
        configCount: configs.data.length,
      });
    }

    const methods = Object.entries(defaultConfig)
      .filter(([key]) => !METADATA_FIELDS.has(key))
      .filter(([, value]) => value && typeof value === 'object' && 'display_preference' in value)
      .filter(([id]) => isKnownPaymentMethod(id))
      .map(([id, config]) => ({
        id,
        name: getPaymentMethodName(id),
        // Use 'value' (what Stripe actually shows at checkout), not 'preference' (what user requested)
        // When overridable is true, updating 'preference' will change 'value'
        // When overridable is false, 'preference' is stored but 'value' stays as platform default
        enabled: (config as any).display_preference?.value === 'on',
        available: (config as any).available || false,
        // When overridable is true, toggles actually work. When false, they're ignored by Stripe.
        overridable: (config as any).display_preference?.overridable ?? false,
      }))
      .sort((a, b) => {
        if (a.available !== b.available) return b.available ? 1 : -1;
        return stringCompare(a.name, b.name);
      });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        config_id: defaultConfig.id,
        methods,
      },
    };
  },
});

export const PATCH = createSmartRouteHandler({
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
    body: yupObject({
      config_id: yupString().defined(),
      updates: yupRecord(
        yupString().oneOf(getAllPaymentMethodIds()).defined(),
        yupString().oneOf(['on', 'off']).defined()
      ).defined(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().defined(),
    }).defined(),
  }),
  handler: async ({ auth, body }) => {
    if (Object.keys(body.updates).length === 0 || isPreviewModeEnabled()) {
      return { statusCode: 200, bodyType: "json", body: { success: true } };
    }

    const project = await globalPrismaClient.project.findUnique({
      where: { id: auth.project.id },
      select: { stripeAccountId: true },
    });

    if (!project?.stripeAccountId) {
      throw new KnownErrors.StripeAccountInfoNotFound();
    }

    const stripeUpdates: Record<string, { display_preference: { preference: 'on' | 'off' } }> = {};

    for (const [methodId, preference] of Object.entries(body.updates)) {
      stripeUpdates[methodId] = {
        display_preference: { preference: preference as 'on' | 'off' },
      };
    }

    const stripe = getHexclaveStripe();
    const beforeConfig = await stripe.paymentMethodConfigurations.retrieve(
      body.config_id,
      {},
      { stripeAccount: project.stripeAccountId },
    );
    const afterConfig = await stripe.paymentMethodConfigurations.update(
      body.config_id,
      stripeUpdates,
      { stripeAccount: project.stripeAccountId }
    );

    // Stripe PMC toggles are not Hexclave config — dedicated Compliance event.
    // Record requested preference plus Stripe's effective display_preference.value
    // (they diverge when the method is not overridable).
    const methodIds = Object.keys(body.updates);
    const beforeRoot = paymentMethodAuditFields(beforeConfig, methodIds);
    const afterRoot = paymentMethodAuditFields(afterConfig, methodIds);
    for (const [methodId, preference] of Object.entries(body.updates)) {
      afterRoot[`methods.${methodId}.preference`] ??= preference;
    }
    const metadata = buildUpdatedFieldsAuditMetadata({
      source: "payments.method_configs.update",
      patch: afterRoot,
      beforeRoot,
      afterRoot,
    }) ?? {
        source: "payments.method_configs.update",
      };
    await recordAuditEvent({
      tenancy: auth.tenancy,
      auth,
      action: "payment.method_config.updated",
      metadata: {
        ...metadata,
        config_id: body.config_id,
      },
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        success: true,
      },
    };
  },
});

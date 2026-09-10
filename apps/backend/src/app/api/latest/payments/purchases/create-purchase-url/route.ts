import { CustomerType } from "@/generated/prisma/client";
import { buildCreatedFieldsAuditMetadata, recordAuditEvent, shouldRecordAdminAudit } from "@/lib/audit-log";
import { customerOwnsProduct, ensureClientCanAccessCustomer, ensureProductIdOrInlineProduct } from "@/lib/payments";
import { getOwnedProductsForCustomer } from "@/lib/payments/customer-data";
import { validateRedirectUrl } from "@/lib/redirect-urls";
import { getHexclaveStripe, getStripeForAccount } from "@/lib/stripe";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { adaptSchema, clientOrHigherAuthTypeSchema, inlineProductSchema, urlSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { getEnvVariable } from "@hexclave/shared/dist/utils/env";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { purchaseUrlVerificationCodeHandler } from "../verification-code-handler";

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: false,
    summary: "Create Purchase URL",
    description: "Creates a secure checkout URL for purchasing a product.",
    tags: ["Payments"],
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema.optional(),
    }).defined(),
    body: yupObject({
      customer_type: yupString().oneOf(["user", "team", "custom"]).defined().meta({
        openapiField: {
          description: "The type of customer making the purchase",
          exampleValue: "user"
        }
      }),
      customer_id: yupString().defined().meta({
        openapiField: {
          description: "The ID of the customer (user ID, team ID, or custom customer ID)",
          exampleValue: "user_1234567890abcdef"
        }
      }),
      product_id: yupString().optional().meta({
        openapiField: {
          description: "The ID of the product to purchase. Either this or product_inline should be given.",
          exampleValue: "prod_premium_monthly"
        }
      }),
      product_inline: inlineProductSchema.optional().meta({
        openapiField: {
          description: "Inline product definition. Either this or product_id should be given."
        }
      }),
      return_url: urlSchema.optional().meta({
        openapiField: {
          description: "URL to redirect to after purchase completion. Must be configured as a trusted domain in the project configuration.",
          exampleValue: "https://myapp.com/purchase-success"
        }
      }),
    }),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      url: yupString().defined().meta({
        openapiField: {
          description: "The secure checkout URL for completing the purchase"
        }
      }),
    }).defined(),
  }),
  handler: async (req, fullReq) => {
    const { tenancy } = req.auth;
    if (tenancy.config.payments.blockNewPurchases) {
      throw new KnownErrors.NewPurchasesBlocked();
    }

    if (req.auth.type === "client") {
      await ensureClientCanAccessCustomer({
        customerType: req.body.customer_type,
        customerId: req.body.customer_id,
        user: fullReq.auth?.user,
        tenancy,
        forbiddenMessage: "Clients can only create purchase URLs for their own user or teams they have admin access to.",
      });
    }

    const productConfig = await ensureProductIdOrInlineProduct(tenancy, req.auth.type, req.body.product_id, req.body.product_inline);
    const customerType = productConfig.customerType;
    if (req.body.customer_type !== customerType) {
      throw new KnownErrors.ProductCustomerTypeDoesNotMatch(req.body.product_id, req.body.customer_id, customerType, req.body.customer_type);
    }

    if (req.body.product_id && productConfig.stackable !== true) {
      const prisma = await getPrismaClientForTenancy(tenancy);
      const ownedProducts = await getOwnedProductsForCustomer({
        prisma,
        tenancyId: tenancy.id,
        customerType,
        customerId: req.body.customer_id,
      });
      if (customerOwnsProduct(ownedProducts, req.body.product_id)) {
        throw new KnownErrors.ProductAlreadyGranted(req.body.product_id, req.body.customer_id);
      }
    }

    const testMode = tenancy.config.payments.testMode === true;
    let stripeCustomerId: string | undefined;
    let stripeAccountId: string | undefined;
    let chargesEnabled: boolean | undefined;

    if (!testMode) {
      const stripe = await getStripeForAccount({ tenancy });
      const stripeCustomerSearch = await stripe.customers.search({
        query: `metadata['customerId']:'${req.body.customer_id}'`,
      });
      let stripeCustomer = stripeCustomerSearch.data.length ? stripeCustomerSearch.data[0] : undefined;
      if (!stripeCustomer) {
        stripeCustomer = await stripe.customers.create({
          metadata: {
            customerId: req.body.customer_id,
            customerType: customerType === "user" ? CustomerType.USER : CustomerType.TEAM,
          }
        });
      }

      const project = await globalPrismaClient.project.findUnique({
        where: { id: tenancy.project.id },
        select: { stripeAccountId: true },
      });
      stripeAccountId = project?.stripeAccountId ?? throwErr("Stripe account not configured");
      const stackStripe = getHexclaveStripe();
      const connectedAccount = await stackStripe.accounts.retrieve(stripeAccountId);
      stripeCustomerId = stripeCustomer.id;
      chargesEnabled = connectedAccount.charges_enabled;
    }

    const { code } = await purchaseUrlVerificationCodeHandler.createCode({
      tenancy,
      expiresInMs: 1000 * 60 * 60 * 24,
      data: {
        tenancyId: tenancy.id,
        customerId: req.body.customer_id,
        productId: req.body.product_id,
        product: productConfig,
        stripeCustomerId,
        stripeAccountId,
        chargesEnabled,
      },
      method: {},
      callbackUrl: undefined,
    });

    const fullCode = `${tenancy.id}_${code}`;
    const url = new URL(`/purchase/${fullCode}`, getEnvVariable("NEXT_PUBLIC_STACK_DASHBOARD_URL"));
    if (req.body.return_url) {
      if (!validateRedirectUrl(req.body.return_url, tenancy)) {
        throw new KnownErrors.RedirectUrlNotWhitelisted(req.body.return_url);
      }
      url.searchParams.set("return_url", req.body.return_url);
    }

    // Dashboard-only via recordAuditEvent (adminUser). Never persist URL/code.
    if (shouldRecordAdminAudit(req.auth)) {
      const metadata = buildCreatedFieldsAuditMetadata({
        source: "payments.create_purchase_url",
        fields: {
          customer_type: req.body.customer_type,
          customer_id: req.body.customer_id,
          ...(req.body.product_id != null ? { product_id: req.body.product_id } : {}),
          has_product_inline: req.body.product_inline != null,
        },
      }) ?? {
          source: "payments.create_purchase_url",
          customer_type: req.body.customer_type,
          customer_id: req.body.customer_id,
        };
      await recordAuditEvent({
        tenancy,
        auth: req.auth,
        action: "payment.checkout.created",
        targetUserId: req.body.customer_type === "user" ? req.body.customer_id : null,
        metadata,
      });
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        url: url.toString(),
      },
    };
  },
});

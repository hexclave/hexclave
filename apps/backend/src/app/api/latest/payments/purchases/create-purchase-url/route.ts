import { CustomerType } from "@/generated/prisma/client";
import { customerOwnsProduct, ensureClientCanAccessCustomer, ensureProductIdOrInlineProduct, ensureStripeCustomerForCustomer, stripeCustomerIdempotencyKey } from "@/lib/payments";
import { getOwnedProductsForCustomer } from "@/lib/payments/customer-data";
import { assertPromoCodesCapability, promoCodeProjectPolicy } from "@/lib/payments/promo-code-checkout";
import { validateRedirectUrl } from "@/lib/redirect-urls";
import { getHexclaveStripe, getStripeForAccount } from "@/lib/stripe";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared/dist/known-errors";
import { adaptSchema, clientOrHigherAuthTypeSchema, inlineProductSchema, urlSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
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
      allow_promo_codes: yupBoolean().optional().meta({
        openapiField: {
          description: "When true, the purchase page shows a promo-code field.",
          exampleValue: false,
        },
      }),
      allow_stacking_promo_codes: yupBoolean().optional().meta({
        openapiField: {
          description: "When true with allow_promo_codes, multiple promo codes may be applied.",
          exampleValue: false,
        },
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
    const promoPolicy = promoCodeProjectPolicy(tenancy.config.payments);
    const allowPromoCodes = req.body.allow_promo_codes === true;
    const allowStackingPromoCodes = allowPromoCodes && req.body.allow_stacking_promo_codes === true;
    assertPromoCodesCapability(promoPolicy, {
      wantsPromoCodes: allowPromoCodes,
      wantsStacking: allowStackingPromoCodes,
    });

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
      const prisma = await getPrismaClientForTenancy(tenancy);
      let stripeCustomer: Awaited<ReturnType<typeof ensureStripeCustomerForCustomer>>;
      if (customerType === "user" || customerType === "team") {
        stripeCustomer = await ensureStripeCustomerForCustomer({
          stripe,
          prisma,
          tenancyId: tenancy.id,
          customerType,
          customerId: req.body.customer_id,
        });
      } else {
        const stripeCustomerSearch = await stripe.customers.search({
          query: `metadata['customerId']:'${req.body.customer_id}'`,
        });
        stripeCustomer = stripeCustomerSearch.data[0] ?? await stripe.customers.create({
          metadata: {
            customerId: req.body.customer_id,
            customerType: CustomerType.CUSTOM,
          },
        }, {
          idempotencyKey: stripeCustomerIdempotencyKey(tenancy.id, "custom", req.body.customer_id),
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
        allowPromoCodes,
        allowStackingPromoCodes,
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

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        url: url.toString(),
      },
    };
  },
});

import { SubscriptionStatus } from "@/generated/prisma/client";
import { customerOwnsProduct, ensureCustomerExists, ensureProductIdOrInlineProduct, getCurrentBillingPeriod, isSubscriptionCancelable, isSubscriptionInEffect } from "@/lib/payments";
import { bulldozerWriteSubscription } from "@/lib/payments/bulldozer-dual-write";
import { getOwnedProductsForCustomer, getSubscriptionMapForCustomer } from "@/lib/payments/customer-data";
import { ensureFreePlanForBillingTeam } from "@/lib/payments/ensure-free-plan";
import { ensureUserTeamPermissionExists } from "@/lib/request-checks";
import { getStripeForAccount, getStripeSubscriptionPeriod, isStripeSubscriptionAlreadyTerminalError } from "@/lib/stripe";
import { getPrismaClientForTenancy } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, clientOrHigherAuthTypeSchema, yupBoolean, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: "Cancel a customer's subscription product",
    description: "Cancels at the end of the current billing period; the customer keeps the product until then. Without `subscription_id`, cancels every cancelable subscription the customer holds for this product — stackable products can have several; subscriptions already winding down are left as-is.",
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: clientOrHigherAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      customer_type: yupString().oneOf(["user", "team", "custom"]).defined(),
      customer_id: yupString().defined(),
      product_id: yupString().defined(),
    }).defined(),
    query: yupObject({
      subscription_id: yupString().optional().meta({ openapiField: { description: "Cancel only this subscription. Omit to cancel all of the customer's cancelable subscriptions for this product." } }),
    }).default(() => ({})).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      success: yupBoolean().oneOf([true]).defined(),
    }).defined(),
  }),
  handler: async ({ auth, params, query }, fullReq) => {
    if (auth.type === "client") {
      const currentUser = fullReq.auth?.user;
      if (!currentUser) {
        throw new KnownErrors.UserAuthenticationRequired();
      }
      if (params.customer_type === "user") {
        if (params.customer_id !== currentUser.id) {
          throw new StatusError(StatusError.Forbidden, "Clients can only cancel their own subscriptions.");
        }
      } else if (params.customer_type === "team") {
        const prisma = await getPrismaClientForTenancy(auth.tenancy);
        await ensureUserTeamPermissionExists(prisma, {
          tenancy: auth.tenancy,
          teamId: params.customer_id,
          userId: currentUser.id,
          permissionId: "team_admin",
          errorType: "required",
          recursive: true,
        });
      } else {
        throw new StatusError(StatusError.Forbidden, "Clients can only cancel user or team subscriptions they control.");
      }
    }

    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    await ensureCustomerExists({
      prisma,
      tenancyId: auth.tenancy.id,
      customerType: params.customer_type,
      customerId: params.customer_id,
    });

    // Fetch subscription map and owned products from Bulldozer
    const subMap = await getSubscriptionMapForCustomer({
      prisma,
      tenancyId: auth.tenancy.id,
      customerType: params.customer_type,
      customerId: params.customer_id,
    });
    const allSubs = Object.values(subMap);

    const nowMillis = Date.now();
    // Gives double-cancels and past_due-style states an honest error; no-op
    // when no in-effect sub matches.
    const throwIfUncancelableButInEffect = (candidates: typeof allSubs): void => {
      const inEffect = candidates.find(s => isSubscriptionInEffect(s, nowMillis));
      if (!inEffect) return;
      if (inEffect.status === "canceled" || inEffect.cancelAtPeriodEnd) {
        throw new StatusError(400, "This subscription is already canceled and ends at the end of the current billing period.");
      }
      throw new StatusError(400, "This subscription cannot be canceled in its current state.");
    };

    let subscriptions;
    if (query.subscription_id) {
      // Cancel by subscription DB ID (used for inline products that have no product_id)
      const matching = allSubs.filter(s => s.id === query.subscription_id);
      subscriptions = matching.filter(s => isSubscriptionCancelable(s));
      if (subscriptions.length === 0) {
        throwIfUncancelableButInEffect(matching);
        throw new StatusError(400, "No active subscription found with this ID for the given customer.");
      }
    } else {
      const product = await ensureProductIdOrInlineProduct(auth.tenancy, auth.type, params.product_id, undefined);
      if (params.customer_type !== product.customerType) {
        throw new KnownErrors.ProductCustomerTypeDoesNotMatch(
          params.product_id,
          params.customer_id,
          product.customerType,
          params.customer_type,
        );
      }

      // Check ownership via Bulldozer owned products (covers both subs and OTPs)
      const ownedProducts = await getOwnedProductsForCustomer({
        prisma,
        tenancyId: auth.tenancy.id,
        customerType: params.customer_type,
        customerId: params.customer_id,
      });
      if (!customerOwnsProduct(ownedProducts, params.product_id)) {
        throw new StatusError(400, "Customer does not have this product.");
      }

      // Find the cancelable subscriptions for this product
      const matching = allSubs.filter(s => s.productId === params.product_id);
      subscriptions = matching.filter(s => isSubscriptionCancelable(s));
      if (subscriptions.length === 0) {
        // Owned but nothing cancelable: winding down / uncancelable state,
        // or owned via OTP — don't claim the former is a one-time purchase.
        throwIfUncancelableButInEffect(matching);
        throw new StatusError(400, "This product is a one time purchase and cannot be canceled.");
      }
    }

    const hasStripeSubscription = subscriptions.some((subscription) => subscription.stripeSubscriptionId);
    const stripe = hasStripeSubscription ? await getStripeForAccount({ tenancy: auth.tenancy }) : undefined;
    // Without `subscription_id` this is every cancelable sub for the product.
    let canceledCount = 0;
    for (const subscription of subscriptions) {
      let updatedSub;
      if (subscription.stripeSubscriptionId) {
        const stripeClient = stripe ?? throwErr(500, "Stripe client missing for subscription cancellation.");
        // Cancel at period end, not `subscriptions.cancel()` (immediate) —
        // matches the confirm dialog and the local-sub branch below. The
        // eager local write (mirroring the refund route) shows the wind-down
        // before the webhook sync arrives.
        let updated;
        try {
          updated = await stripeClient.subscriptions.update(subscription.stripeSubscriptionId, { cancel_at_period_end: true });
        } catch (e) {
          if (!isStripeSubscriptionAlreadyTerminalError(e)) {
            throw e;
          }
          // The local row says cancelable but Stripe has already ended the sub
          // (missed webhook, or a cancel from the Stripe Dashboard). Stripe
          // rejects the update, which would otherwise surface as a 500. Report
          // the honest state rather than guessing the terminal one locally —
          // the webhook sync is what reconciles the row. In a batch cancel,
          // skip the stale row instead of aborting: throwing here would drop
          // the remaining cancelable subs and report failure for cancels that
          // already committed.
          continue;
        }
        // Stripe's response is the authority on the boundary — the bulldozer
        // snapshot can be a stale pre-renewal period end. Snapshot fallback
        // only covers item-less mocked responses.
        const stripePeriod = getStripeSubscriptionPeriod(updated, { tenancyId: auth.tenancy.id });
        const endedAt = stripePeriod?.end ?? new Date(subscription.currentPeriodEndMillis);
        updatedSub = await prisma.subscription.update({
          where: {
            tenancyId_id: {
              tenancyId: auth.tenancy.id,
              id: subscription.id,
            },
          },
          data: {
            cancelAtPeriodEnd: true,
            canceledAt: new Date(),
            endedAt,
            // Keep the displayed period in step with the entitlement boundary:
            // the products list surfaces `currentPeriodEnd` as `current_period_end`
            // ("Ends on"), so writing only `endedAt` leaves a stale local period
            // showing the wrong date after a missed renewal sync.
            ...(stripePeriod ? {
              currentPeriodStart: stripePeriod.start,
              currentPeriodEnd: stripePeriod.end,
            } : {}),
          },
        });
      } else {
        // Local subs never renew, so the stored period can be long past — see
        // `getCurrentBillingPeriod`. Write the rolled-forward period alongside
        // `endedAt` so the "Ends on" date the products list surfaces
        // (`current_period_end`) matches the entitlement boundary.
        const period = getCurrentBillingPeriod(subscription, nowMillis);
        updatedSub = await prisma.subscription.update({
          where: {
            tenancyId_id: {
              tenancyId: auth.tenancy.id,
              id: subscription.id,
            },
          },
          data: {
            status: SubscriptionStatus.canceled,
            cancelAtPeriodEnd: true,
            canceledAt: new Date(),
            endedAt: period.end,
            currentPeriodStart: period.start,
            currentPeriodEnd: period.end,
          },
        });
      }
      // dual write - prisma and bulldozer
      await bulldozerWriteSubscription(updatedSub);
      canceledCount++;
    }
    if (canceledCount === 0) {
      // Every candidate turned out already terminal at Stripe — nothing was
      // canceled, so a success response would be a lie.
      throw new StatusError(400, "This subscription is already canceled.");
    }

    // Regrant the free plan if a Hexclave billing team just lost their
    // only plans-line sub. Scoped to the internal tenancy — customer
    // projects' own sub cancellations are for their own products.
    if (auth.tenancy.project.id === "internal" && params.customer_type === "team") {
      await ensureFreePlanForBillingTeam(params.customer_id);
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        success: true,
      },
    };
  },
});

import { ensureCustomerExists } from "@/lib/payments";
import { bulldozerWriteItemQuantityChange } from "@/lib/payments/bulldozer-dual-write";
import { getItemQuantityForCustomer } from "@/lib/payments/customer-data";
import { getPrismaClientForTenancy, retryTransaction } from "@/prisma-client";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { KnownErrors } from "@hexclave/shared";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { getOrUndefined } from "@hexclave/shared/dist/utils/objects";
import { typedToUppercase } from "@hexclave/shared/dist/utils/strings";

export const POST = createSmartRouteHandler({
  metadata: {
    hidden: false,
    summary: "Update Item Quantity",
    description: "Updates the quantity of an item for a customer. Can increase or decrease quantities, with optional expiration and negative balance control.",
    tags: ["Payments"],
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema.defined(),
      project: adaptSchema.defined(),
      tenancy: adaptSchema.defined(),
    }).defined(),
    params: yupObject({
      customer_type: yupString().oneOf(["user", "team", "custom"]).defined().meta({
        openapiField: {
          description: "The type of customer",
          exampleValue: "user"
        }
      }),
      customer_id: yupString().defined().meta({
        openapiField: {
          description: "The ID of the customer",
          exampleValue: "user_1234567890abcdef"
        }
      }),
      item_id: yupString().defined().meta({
        openapiField: {
          description: "The ID of the item to update",
          exampleValue: "credits"
        }
      }),
    }).defined(),
    query: yupObject({
      allow_negative: yupString().oneOf(["true", "false"]).defined().meta({
        openapiField: {
          description: "Whether to allow the quantity to go negative",
          exampleValue: "false"
        }
      }),
    }).defined(),
    body: yupObject({
      // The quantity change is stored in an integer column (Postgres int4), so
      // bound the delta to its range; larger values used to fail as a 500 in Prisma.
      delta: yupNumber().integer().min(-2147483648).max(2147483647).defined().meta({
        openapiField: {
          description: "The amount to change the quantity by (positive to increase, negative to decrease)",
          exampleValue: 100
        }
      }),
      expires_at: yupString().optional().meta({
        openapiField: {
          description: "Optional expiration date for this quantity change (ISO 8601 format)",
          exampleValue: "2024-12-31T23:59:59Z"
        }
      }),
      description: yupString().optional().meta({
        openapiField: {
          description: "Optional description for this quantity change",
          exampleValue: "Monthly subscription renewal"
        }
      }),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({}).defined(),
  }),
  handler: async (req) => {
    const { tenancy } = req.auth;
    const paymentsConfig = tenancy.config.payments;
    const allowNegative = req.query.allow_negative === "true";
    const itemConfig = getOrUndefined(paymentsConfig.items, req.params.item_id);
    if (!itemConfig) {
      throw new KnownErrors.ItemNotFound(req.params.item_id);
    }

    if (req.params.customer_type !== itemConfig.customerType) {
      throw new KnownErrors.ItemCustomerTypeDoesNotMatch(req.params.item_id, req.params.customer_id, itemConfig.customerType, req.params.customer_type);
    }
    const prisma = await getPrismaClientForTenancy(tenancy);
    await ensureCustomerExists({
      prisma,
      tenancyId: tenancy.id,
      customerType: req.params.customer_type,
      customerId: req.params.customer_id,
    });

    // Read the current quantity from bulldozer-js BEFORE starting the Prisma
    // transaction. getItemQuantityForCustomer reads via HTTP from the
    // bulldozer-js server and does not use the Prisma client; keeping the
    // call inside the transaction would hold the transaction open for the
    // full HTTP round-trip, exhausting the interactive-transaction pool
    // under load and causing "Unable to start a transaction" cascades.
    const totalQuantity = await getItemQuantityForCustomer({
      prisma,
      tenancyId: tenancy.id,
      itemId: req.params.item_id,
      customerId: req.params.customer_id,
      customerType: req.params.customer_type,
    });
    if (!allowNegative && (totalQuantity + req.body.delta < 0)) {
      throw new KnownErrors.ItemQuantityInsufficientAmount(req.params.item_id, req.params.customer_id, req.body.delta);
    }

    const change = await retryTransaction(prisma, async (tx) => {
      const change = await tx.itemQuantityChange.create({
        data: {
          tenancyId: tenancy.id,
          customerId: req.params.customer_id,
          customerType: typedToUppercase(req.params.customer_type),
          itemId: req.params.item_id,
          quantity: req.body.delta,
          description: req.body.description,
          expiresAt: req.body.expires_at ? new Date(req.body.expires_at) : null,
        },
      });
      return change;
    });
    await bulldozerWriteItemQuantityChange(change);

    return {
      statusCode: 200,
      bodyType: "json",
      body: {},
    };
  },
});



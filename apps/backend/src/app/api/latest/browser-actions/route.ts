import { getApiUrlForRequest } from "@/lib/request-api-url";
import { recordAuditEvent } from "@/lib/audit-log";
import { createBrowserAction, DEFAULT_BROWSER_ACTION_TTL_MS, DEFAULT_IMPERSONATION_SESSION_TTL_MS, MAX_BROWSER_ACTION_TTL_MS } from "@/lib/browser-actions";
import { MAX_AUTH_SESSION_EXPIRATION_MS } from "@/lib/tokens";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, serverOrHigherAuthTypeSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";

export const POST = createSmartRouteHandler({
  metadata: {
    summary: "Create a browser action",
    description: "Creates a single-use link to one of the project's trusted origins that, when opened, makes the Hexclave SDK on that page perform an action in the browser: signing in as a given user (impersonation) or showing the clickmap overlay. Requires server or higher access.",
  },
  request: yupObject({
    auth: yupObject({
      type: serverOrHigherAuthTypeSchema,
      tenancy: adaptSchema.defined(),
      adminUser: adaptSchema,
    }).defined(),
    body: yupObject({
      type: yupString().oneOf(["impersonation", "clickmap-overlay"]).defined().meta({
        openapiField: {
          description: "The action the SDK performs after the link is opened. `impersonation` signs the browser in as `user_id`; `clickmap-overlay` mounts the clickmap overlay.",
          exampleValue: "impersonation",
        },
      }),
      origin: yupString().defined().meta({
        openapiField: {
          description: "The project's trusted origin where the link opens. The action can only be consumed by a request whose Origin header matches this value.",
          exampleValue: "https://app.example.com",
        },
      }),
      expires_in_millis: yupNumber().integer().min(1).max(MAX_BROWSER_ACTION_TTL_MS).default(DEFAULT_BROWSER_ACTION_TTL_MS).meta({
        openapiField: {
          description: "How long the single-use link remains redeemable, in milliseconds.",
          exampleValue: DEFAULT_BROWSER_ACTION_TTL_MS,
        },
      }),
      session_expires_in_millis: yupNumber().integer().min(1).max(MAX_AUTH_SESSION_EXPIRATION_MS).default(DEFAULT_IMPERSONATION_SESSION_TTL_MS).meta({
        openapiField: {
          description: "Lifetime of the impersonation session, measured from link creation. Ignored for `clickmap-overlay` actions.",
          exampleValue: DEFAULT_IMPERSONATION_SESSION_TTL_MS,
        },
      }),
      user_id: yupString().optional().meta({
        openapiField: {
          description: "ID of the user to impersonate. Required when `type` is `impersonation` and ignored for `clickmap-overlay`.",
          exampleValue: "user_123",
        },
      }),
      // Optional support-session note stored on the admin audit trail.
      reason: yupString().max(500).nullable().optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      id: yupString().defined().meta({
        openapiField: {
          description: "Opaque, single-use browser action ID.",
          exampleValue: "browser_action_code",
        },
      }),
      url: yupString().defined().meta({
        openapiField: {
          description: "URL at the requested trusted origin containing the browser action ID. Open it in the target browser to perform the action.",
          exampleValue: "https://app.example.com/?hexclave_action_id=browser_action_code",
        },
      }),
      expires_at_millis: yupNumber().defined().meta({
        openapiField: {
          description: "Unix timestamp in milliseconds after which the browser action can no longer be consumed.",
          exampleValue: 1_800_000_000_000,
        },
      }),
    }).defined(),
  }),
  handler: async ({ auth, body: { type, origin, expires_in_millis, session_expires_in_millis, user_id, reason } }, fullReq) => {
    const { tenancy } = auth;
    if (type === "impersonation" && user_id == null) {
      throw new StatusError(StatusError.BadRequest, "Invalid browser action");
    }
    const actionParams = type === "impersonation"
      ? { type, params: { userId: user_id ?? throwErr(new StatusError(StatusError.BadRequest, "Invalid browser action")) } }
      : { type, params: {} };
    const action = await createBrowserAction({
      tenancy,
      origin,
      expiresInMillis: expires_in_millis,
      sessionExpiresInMillis: session_expires_in_millis,
      apiUrl: getApiUrlForRequest(fullReq),
      ...actionParams,
    });

    if (type === "impersonation") {
      await recordAuditEvent({
        tenancy,
        auth,
        action: "impersonation.started",
        targetUserId: user_id ?? throwErr(new StatusError(StatusError.BadRequest, "Invalid browser action")),
        reason,
        metadata: {
          refresh_token_id: action.refreshTokenId ?? null,
          expires_at_millis: Date.now() + session_expires_in_millis,
          origin,
          source: "browser-actions",
        },
      });
    }

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        id: action.id,
        url: action.url,
        expires_at_millis: action.expiresAtMillis,
      },
    };
  },
});

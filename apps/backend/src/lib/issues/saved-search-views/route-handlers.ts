import { assertObservabilityEnabled } from "@/lib/issues/observability-gate";
import type { SmartRequest } from "@/route-handlers/smart-request";
import {
  createSmartRouteHandler,
  type SmartRouteHandlerOverloadMetadata,
} from "@/route-handlers/smart-route-handler";
import {
  adaptSchema,
  adminAuthTypeSchema,
  clientOrHigherAuthTypeSchema,
  serverOrHigherAuthTypeSchema,
  yupNumber,
  yupObject,
  yupString,
} from "@hexclave/shared/dist/schema-fields";
import { StatusError } from "@hexclave/shared/dist/utils/errors";
import {
  createSavedIssueSearchViewResponse,
  deleteSavedIssueSearchViewForActor,
  getSavedIssueSearchViewResponse,
  listSavedIssueSearchViewResponses,
  parseSavedIssueSearchViewListLimit,
  updateSavedIssueSearchViewResponse,
} from "./api";
import {
  SavedIssueSearchViewListResponseSchema,
  SavedIssueSearchViewMutationSchema,
  SavedIssueSearchViewResponseSchema,
} from "./contract";
import { createSavedIssueSearchViewMutationAuthorization } from "./persistence";

type SavedIssueSearchViewAuthTypeSchema =
  | typeof adminAuthTypeSchema
  | typeof clientOrHigherAuthTypeSchema
  | typeof serverOrHigherAuthTypeSchema;

export type SavedIssueSearchViewRouteHandlerOptions = {
  authTypeSchema: SavedIssueSearchViewAuthTypeSchema,
  mutationAuthTypeSchema: SavedIssueSearchViewAuthTypeSchema,
  metadata: {
    list: SmartRouteHandlerOverloadMetadata,
    create: SmartRouteHandlerOverloadMetadata,
    get: SmartRouteHandlerOverloadMetadata,
    update: SmartRouteHandlerOverloadMetadata,
    delete: SmartRouteHandlerOverloadMetadata,
  },
};

const SavedIssueSearchViewParamsSchema = yupObject({
  view_id: yupString().uuid().defined(),
}).defined();

function savedIssueSearchViewAuthSchema(typeSchema: SavedIssueSearchViewAuthTypeSchema) {
  return yupObject({
    type: typeSchema.defined(),
    tenancy: adaptSchema.defined(),
  }).defined();
}

export function savedIssueSearchViewActorUserId(fullReq: SmartRequest): string | null {
  return fullReq.auth?.user?.id ?? null;
}

function savedIssueSearchViewMutationAuthorization(fullReq: SmartRequest) {
  if (fullReq.auth === null) {
    throw new StatusError(StatusError.Forbidden, "saved issue search view mutation requires authenticated access");
  }
  return createSavedIssueSearchViewMutationAuthorization({
    authType: fullReq.auth.type,
    actorUserId: savedIssueSearchViewActorUserId(fullReq),
  });
}

export function createSavedIssueSearchViewListRoute(options: SavedIssueSearchViewRouteHandlerOptions) {
  return createSmartRouteHandler({
    metadata: options.metadata.list,
    request: yupObject({
      auth: savedIssueSearchViewAuthSchema(options.authTypeSchema),
      query: yupObject({
        limit: yupString().optional(),
      }).defined(),
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: SavedIssueSearchViewListResponseSchema,
    }),
    async handler({ auth, query }, fullReq) {
      assertObservabilityEnabled(auth.tenancy);
      return {
        statusCode: 200,
        bodyType: "json",
        body: await listSavedIssueSearchViewResponses({
          tenancy: auth.tenancy,
          actorUserId: savedIssueSearchViewActorUserId(fullReq),
          limit: parseSavedIssueSearchViewListLimit(query.limit),
        }),
      };
    },
  });
}

export function createSavedIssueSearchViewCreateRoute(options: SavedIssueSearchViewRouteHandlerOptions) {
  return createSmartRouteHandler({
    metadata: options.metadata.create,
    request: yupObject({
      auth: savedIssueSearchViewAuthSchema(options.authTypeSchema),
      body: SavedIssueSearchViewMutationSchema,
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([201]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: SavedIssueSearchViewResponseSchema,
    }),
    async handler({ auth, body }, fullReq) {
      assertObservabilityEnabled(auth.tenancy);
      return {
        statusCode: 201,
        bodyType: "json",
        body: await createSavedIssueSearchViewResponse({
          tenancy: auth.tenancy,
          actorUserId: savedIssueSearchViewActorUserId(fullReq),
          body,
        }),
      };
    },
  });
}

export function createSavedIssueSearchViewGetRoute(options: SavedIssueSearchViewRouteHandlerOptions) {
  return createSmartRouteHandler({
    metadata: options.metadata.get,
    request: yupObject({
      auth: savedIssueSearchViewAuthSchema(options.authTypeSchema),
      params: SavedIssueSearchViewParamsSchema,
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: SavedIssueSearchViewResponseSchema,
    }),
    async handler({ auth, params }, fullReq) {
      assertObservabilityEnabled(auth.tenancy);
      const view = await getSavedIssueSearchViewResponse({
        tenancy: auth.tenancy,
        actorUserId: savedIssueSearchViewActorUserId(fullReq),
        viewId: params.view_id,
      });
      if (view === null) throw new StatusError(StatusError.NotFound, "Saved issue search view not found");
      return {
        statusCode: 200,
        bodyType: "json",
        body: view,
      };
    },
  });
}

export function createSavedIssueSearchViewUpdateRoute(options: SavedIssueSearchViewRouteHandlerOptions) {
  return createSmartRouteHandler({
    metadata: options.metadata.update,
    request: yupObject({
      auth: savedIssueSearchViewAuthSchema(options.mutationAuthTypeSchema),
      params: SavedIssueSearchViewParamsSchema,
      body: SavedIssueSearchViewMutationSchema,
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([200]).defined(),
      bodyType: yupString().oneOf(["json"]).defined(),
      body: SavedIssueSearchViewResponseSchema,
    }),
    async handler({ auth, params, body }, fullReq) {
      assertObservabilityEnabled(auth.tenancy);
      return {
        statusCode: 200,
        bodyType: "json",
        body: await updateSavedIssueSearchViewResponse({
          tenancy: auth.tenancy,
          authorization: savedIssueSearchViewMutationAuthorization(fullReq),
          viewId: params.view_id,
          body,
        }),
      };
    },
  });
}

export function createSavedIssueSearchViewDeleteRoute(options: SavedIssueSearchViewRouteHandlerOptions) {
  return createSmartRouteHandler({
    metadata: options.metadata.delete,
    request: yupObject({
      auth: savedIssueSearchViewAuthSchema(options.mutationAuthTypeSchema),
      params: SavedIssueSearchViewParamsSchema,
    }),
    response: yupObject({
      statusCode: yupNumber().oneOf([204]).defined(),
      bodyType: yupString().oneOf(["empty"]).defined(),
    }),
    async handler({ auth, params }, fullReq) {
      assertObservabilityEnabled(auth.tenancy);
      await deleteSavedIssueSearchViewForActor({
        tenancy: auth.tenancy,
        authorization: savedIssueSearchViewMutationAuthorization(fullReq),
        viewId: params.view_id,
      });
      return {
        statusCode: 204,
        bodyType: "empty",
      };
    },
  });
}

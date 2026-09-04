import "../polyfills";

import { Tenancy, getSoleTenancyFromProjectBranch, } from "@/lib/tenancies";
import { CrudSchema, CrudTypeOf, CrudlOperation } from "@hexclave/shared/dist/crud";
import { ProjectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { yupArray, yupBoolean, yupMixed, yupNumber, yupObject, yupString, yupValidate } from "@hexclave/shared/dist/schema-fields";
import { typedIncludes } from "@hexclave/shared/dist/utils/arrays";
import { HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { FilterUndefined } from "@hexclave/shared/dist/utils/objects";
import { deindent, typedToLowercase } from "@hexclave/shared/dist/utils/strings";
import { traceSpan } from "@hexclave/shared/dist/utils/telemetry";
import * as yup from "yup";
import { SmartRequestAuth } from "./smart-request";
import { SmartRouteHandler, createSmartRouteHandler, routeHandlerTypeHelper } from "./smart-route-handler";

type GetAdminKey<T extends CrudTypeOf<any>, K extends Capitalize<CrudlOperation>> = K extends keyof T["Admin"] ? T["Admin"][K] : void;

type CrudSingleRouteHandler<T extends CrudTypeOf<any>, K extends Capitalize<CrudlOperation>, Params extends {}, Query extends {}, Multi extends boolean = false> =
  K extends keyof T["Admin"]
    ? (options: {
      params: Params,
      data: (K extends "Read" ? void : GetAdminKey<T, K>),
      auth: SmartRequestAuth,
      query: Query,
    }) => Promise<
      K extends "Delete"
        ? void
        : (
          Multi extends true
            ? GetAdminKey<T, "List">
            : GetAdminKey<T, "Read">
        )
    >
    : void;

type CrudRouteHandlersUnfiltered<T extends CrudTypeOf<any>, Params extends {}, Query extends {}> = {
  onPrepare?: (options: { params: Params, auth: SmartRequestAuth, query: Query, type: 'create' | 'read' | 'list' | 'update' | 'delete' }) => Promise<void>,
  onCreate?: CrudSingleRouteHandler<T, "Create", Params, Query>,
  onRead?: CrudSingleRouteHandler<T, "Read", Params, Query>,
  onList?: keyof Params extends never ? void : CrudSingleRouteHandler<T, "Read", Partial<Params>, Query, true>,
  onUpdate?: CrudSingleRouteHandler<T, "Update", Params, Query>,
  onDelete?: CrudSingleRouteHandler<T, "Delete", Params, Query>,
};

type CrudRouteHandlers<T extends CrudTypeOf<any>, Params extends {}, Query extends {}> = FilterUndefined<CrudRouteHandlersUnfiltered<T, Params, Query>>;

export type ParamsSchema = yup.ObjectSchema<{}>;
export type QuerySchema = yup.ObjectSchema<{}>;

type CrudHandlersFromOptions<
  T extends CrudTypeOf<any>,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  O extends CrudRouteHandlers<CrudTypeOf<any>, ParamsSchema, QuerySchema>,
> = CrudHandlers<
  T,
  PS,
  QS,
  ("onCreate" extends keyof O ? "Create" : never)
  | ("onRead" extends keyof O ? "Read" : never)
  | ("onList" extends keyof O ? "List" : never)
  | ("onUpdate" extends keyof O ? "Update" : never)
  | ("onDelete" extends keyof O ? "Delete" : never)
>

type CrudHandlerDirectByAccess<
  A extends "Client" | "Server" | "Admin",
  T extends CrudTypeOf<any>,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  L extends "Create" | "Read" | "List" | "Update" | "Delete"
> = {
  [K in L as `${Uncapitalize<A>}${K}`]: (options:
    & {
      user?: UsersCrud["Admin"]["Read"],
      allowedErrorTypes?: (new (...args: any) => any)[],
    }
    & ({ project: Omit<ProjectsCrud["Admin"]["Read"], "config">, branchId: string } | { tenancy: Tenancy })
    & (({} extends yup.InferType<QS> ? {} : never) | { query: yup.InferType<QS> })
    & (L extends "Create" | "List" ? Partial<yup.InferType<PS>> : yup.InferType<PS>)
    & (K extends "Read" | "List" | "Delete" ? {} : (K extends keyof T[A] ? { data: T[A][K] } : "TYPE ERROR: something went wrong here"))
  ) => Promise<(K extends "List" ? ("List" extends keyof T[A] ? T[A]["List"] : void) : (K extends "Delete" ? void : ("Read" extends keyof T[A] ? T[A]["Read"] : void)))>
};

export type CrudHandlers<
  T extends CrudTypeOf<any>,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  L extends "Create" | "Read" | "List" | "Update" | "Delete",
> =
& {
  [K in `${Uncapitalize<L>}Handler`]: SmartRouteHandler
}
& CrudHandlerDirectByAccess<"Client", T, PS, QS, L>
& CrudHandlerDirectByAccess<"Server", T, PS, QS, L>
& CrudHandlerDirectByAccess<"Admin", T, PS, QS, L>;

export function createCrudHandlers<
  S extends CrudSchema,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  RH extends CrudRouteHandlers<CrudTypeOf<S>, yup.InferType<PS>, yup.InferType<QS>>,
>(
  crud: S,
  options: RH & {
    paramsSchema: PS,
    querySchema?: QS,
  },
): CrudHandlersFromOptions<CrudTypeOf<S>, PS, QS, RH> {
  const optionsAsPartial = options as Partial<CrudRouteHandlersUnfiltered<CrudTypeOf<S>, any, any>>;

  const operations = [
    ["GET", "Read"],
    ["GET", "List"],
    ["POST", "Create"],
    ["PATCH", "Update"],
    ["DELETE", "Delete"],
  ] as const;
  const accessTypes = ["client", "server", "admin"] as const;

  const paramsSchema = options.paramsSchema;

  return Object.fromEntries(
    operations.filter(([_, crudOperation]) => optionsAsPartial[`on${crudOperation}`] !== undefined)
      .flatMap(([httpMethod, crudOperation]) => {
        const getSchemas = (accessType: "admin" | "server" | "client") => {
          const input =
            typedIncludes(["Read", "List"] as const, crudOperation)
              ? yupMixed<any>().oneOf([undefined])
              : crud[accessType][`${typedToLowercase(crudOperation)}Schema`] ?? throwErr(`No input schema for ${crudOperation} with access type ${accessType}; this should never happen`);
          const read = crud[accessType].readSchema ?? yupMixed<any>().oneOf([undefined]);
          const output =
            crudOperation === "List"
              ? yupObject({
                items: yupArray(read).defined(),
                is_paginated: yupBoolean().defined().meta({ openapiField: { hidden: true } }),
                pagination: yupObject({
                  next_cursor: yupString().nullable().defined().meta({ openapiField: { description: "The cursor to fetch the next page of results. null if there is no next page.", exampleValue: 'b3d396b8-c574-4c80-97b3-50031675ceb2' } }),
                }).when('is_paginated', {
                  is: true,
                  then: (schema) => schema.defined(),
                  otherwise: (schema) => schema.optional(),
                }),
              }).defined()
              : crudOperation === "Delete"
                ? yupMixed<any>().oneOf([undefined])
                : read;
          return { input, output };
        };

        const availableAccessTypes = accessTypes.filter((accessType) => {
          const crudOperationWithoutList = crudOperation === "List" ? "Read" : crudOperation;
          return crud[accessType][`${typedToLowercase(crudOperationWithoutList)}Schema`] !== undefined;
        });

        const aat = new Map(availableAccessTypes.map((accessType) => {
          const adminSchemas = getSchemas("admin");
          const accessSchemas = getSchemas(accessType);
          return [
            accessType,
            {
              accessSchemas,
              adminSchemas,
              invoke: async (options: { params: yup.InferType<PS> | Partial<yup.InferType<PS>>, query: yup.InferType<QS>, data: any, auth: SmartRequestAuth }) => {
                const actualParamsSchema = typedIncludes(["List", "Create"], crudOperation) ? paramsSchema.partial() : paramsSchema;
                const paramsValidated = await validate(options.params, actualParamsSchema, options.auth.user ?? null, "Params validation");
                const adminData = await validate(options.data, adminSchemas.input, options.auth.user ?? null, "Input validation");

                await optionsAsPartial.onPrepare?.({
                  params: paramsValidated,
                  auth: options.auth,
                  query: options.query,
                  type: typedToLowercase(crudOperation)
                });
                const result = await optionsAsPartial[`on${crudOperation}`]?.({
                  params: paramsValidated,
                  data: adminData,
                  auth: options.auth,
                  query: options.query,
                });

                const resultAdminValidated = await validate(result, adminSchemas.output, options.auth.user ?? null, "Result admin validation");
                const resultAccessValidated = await validate(resultAdminValidated, accessSchemas.output, options.auth.user ?? null, `Result ${accessType} validation`);

                return resultAccessValidated;
              },
            },
          ];
        }));

        const routeHandler = createSmartRouteHandler(
          [...aat],
          ([accessType, { invoke, accessSchemas, adminSchemas }]) => {
            const frw = routeHandlerTypeHelper({
              request: yupObject({
                auth: yupObject({
                  type: yupString().oneOf([accessType]).defined(),
                }).defined(),
                url: yupString().defined(),
                method: yupString().oneOf([httpMethod]).defined(),
                body: accessSchemas.input,
                params: typedIncludes(["List", "Create"], crudOperation) ? paramsSchema.partial() : paramsSchema,
                query: (options.querySchema ?? yupObject({})) as QuerySchema,
              }),
              response: yupObject({
                statusCode: yupNumber().oneOf([crudOperation === "Create" ? 201 : 200]).defined(),
                headers: yupObject({}),
                bodyType: yupString().oneOf([crudOperation === "Delete" ? "success" : "json"]).defined(),
                body: accessSchemas.output,
              }),
              handler: async (req, fullReq) => {
                const data = req.body;

                const result = await invoke({
                  params: req.params as any,
                  query: req.query as any,
                  data,
                  auth: fullReq.auth ?? throwErr("Auth not found in CRUD handler; this should never happen! (all clients are at least client to access CRUD handler)"),
                });

                return {
                  statusCode: crudOperation === "Create" ? 201 : 200,
                  headers: {},
                  bodyType: crudOperation === "Delete" ? "success" : "json",
                  body: result,
                };
              },
            });

            const metadata = crud[accessType][`${typedToLowercase(crudOperation)}Docs`];
            return {
              ...frw,
              metadata: metadata ? (metadata.hidden ? metadata : { ...metadata, crudOperation }) : undefined,
            };
          }
        );
        return [
          [`${typedToLowercase(crudOperation)}Handler`, routeHandler],
          ...[...aat].map(([accessType, { invoke }]) => (
            [
              `${accessType}${crudOperation}`,
              async ({ user, project, branchId, tenancy, data, query, allowedErrorTypes, ...params }: yup.InferType<PS> & {
                query?: yup.InferType<QS>,
                user?: UsersCrud["Admin"]["Read"],
                project?: Omit<ProjectsCrud["Admin"]["Read"], "config">,
                branchId?: string,
                tenancy?: Tenancy,
                data: any,
                allowedErrorTypes?: (new (...args: any) => any)[],
              }) => {
                if (tenancy) {
                  if (project || branchId) {
                    throw new HexclaveAssertionError("Must specify either project and branchId or tenancy, not both");
                  }
                  project = tenancy.project;
                  branchId = tenancy.branchId;
                } else if (project) {
                  if (!branchId) {
                    throw new HexclaveAssertionError("Must specify branchId when specifying project");
                  }
                  tenancy = await getSoleTenancyFromProjectBranch(project.id, branchId);
                } else {
                  throw new HexclaveAssertionError("Must specify either project and branchId or tenancy");
                }

                try {
                  return await traceSpan("invoking CRUD handler programmatically", async () => {
                    return await invoke({
                      params,
                      query: query ?? {} as any,
                      data,
                      auth: {
                        user,
                        project: project,
                        branchId: branchId,
                        tenancy: tenancy,
                        type: accessType,
                        // Synthetic auth for internal callers — must not look like
                        // a dashboard/admin HTTP request for audit logging.
                        isProgrammaticInvocation: true,
                      },
                    });
                  });
                } catch (error) {
                  if (allowedErrorTypes?.some((a) => error instanceof a) || error instanceof HexclaveAssertionError) {
                    throw error;
                  }
                  throw new CrudHandlerInvocationError(error);
                }
              },
            ]
          )),
        ];
      })
  ) as any;
}

export class CrudHandlerInvocationError extends Error {
  constructor(public readonly cause: unknown) {
    super("Error while invoking CRUD handler programmatically. This is a wrapper error to prevent caught errors (eg. StatusError) from being caught by outer catch blocks. Check the `cause` property.\n\nOriginal error: " + cause, { cause });
  }
}

async function validate<T>(obj: unknown, schema: yup.ISchema<T>, currentUser: UsersCrud["Admin"]["Read"] | null, validationDescription: string): Promise<T> {
  try {
    return await yupValidate(schema, obj, {
      abortEarly: false,
      stripUnknown: true,
      currentUserId: currentUser?.id ?? null,
    });
  } catch (error) {
    if (error instanceof yup.ValidationError) {
      throw new HexclaveAssertionError(
        deindent`
          ${validationDescription} failed in CRUD handler.
          
          Errors:
            ${error.errors.join("\n")}
        `,
        { obj: obj, schema, cause: error },
      );
    }
    throw error;
  }
}

import "../polyfills";

import { Tenancy, getSoleTenancyFromProjectBranch } from "@/lib/tenancies";
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

type BatchInput<T> = T | T[];
type Batch<T> = T[];

type GetAdminKey<T extends CrudTypeOf<any>, K extends Capitalize<CrudlOperation>> = K extends keyof T["Admin"] ? T["Admin"][K] : void;

type CudOperation = "create" | "read" | "list" | "update" | "delete";

type CreateForwardData<T extends CrudTypeOf<any>> = Omit<GetAdminKey<T, "Create">, "id"> & { id: string };
type UpdateData<T extends CrudTypeOf<any>> = GetAdminKey<T, "Update">;
type OnUpdateData<T extends CrudTypeOf<any>> = Array<UpdateData<T> | CreateForwardData<T>>;

type CudRouteHandlersUnfiltered<T extends CrudTypeOf<any>, Params extends {}, Query extends {}> = {
  onCreate: (options: { params: Partial<Params>, data: GetAdminKey<T, "Create">, auth: SmartRequestAuth, query: Query }) => Promise<string>,
  onUpdate: (options: {
    params: Params | Partial<Params>,
    data: OnUpdateData<T>,
    auth: SmartRequestAuth,
    query: Query,
  }) => Promise<GetAdminKey<T, "List">>,
  onDelete: (options: { params: Params, data: Batch<GetAdminKey<T, "Delete">>, auth: SmartRequestAuth, query: Query }) => Promise<GetAdminKey<T, "List">>,
};

type CudRouteHandlers<T extends CrudTypeOf<any>, Params extends {}, Query extends {}> = FilterUndefined<CudRouteHandlersUnfiltered<T, Params, Query>>;

export type ParamsSchema = yup.ObjectSchema<{}>;
export type QuerySchema = yup.ObjectSchema<{}>;

type CudHandlerDirectByAccess<
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
    & (
      K extends "Read" | "List"
        ? {}
        : (
          K extends "Create"
            ? (K extends keyof T[A] ? { data: T[A][K] } : "TYPE ERROR: something went wrong here")
            : (
              K extends "Update"
                ? (K extends keyof T[A] ? { data: T[A][K][] } : "TYPE ERROR: something went wrong here")
                : (K extends keyof T[A] ? { data: BatchInput<T[A][K]> } : "TYPE ERROR: something went wrong here")
            )
        )
    )
  ) => Promise<
    K extends "Read"
      ? ("Read" extends keyof T[A] ? T[A]["Read"] : void)
      : ("List" extends keyof T[A] ? T[A]["List"] : void)
  >
};

export type CudHandlers<
  T extends CrudTypeOf<any>,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  L extends "Create" | "Read" | "List" | "Update" | "Delete",
> =
  & {
    [K in `${Uncapitalize<L>}Handler`]: SmartRouteHandler
  }
  & CudHandlerDirectByAccess<"Client", T, PS, QS, L>
  & CudHandlerDirectByAccess<"Server", T, PS, QS, L>
  & CudHandlerDirectByAccess<"Admin", T, PS, QS, L>;

export function createCudHandlers<
  S extends CrudSchema,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  RH extends CudRouteHandlers<CrudTypeOf<S>, yup.InferType<PS>, yup.InferType<QS>>,
>(
  crud: S,
  options: RH & {
    paramsSchema: PS,
    querySchema?: QS,
  },
): CudHandlers<CrudTypeOf<S>, PS, QS, "Create" | "Read" | "List" | "Update" | "Delete"> {
  const accessTypes = ["client", "server", "admin"] as const;
  const paramsSchema = options.paramsSchema;

  const operations = [
    ["GET", "Read"],
    ["GET", "List"],
    ["POST", "Create"],
    ["PATCH", "Update"],
    ["DELETE", "Delete"],
  ] as const;

  const getBatchSchema = <T,>(schema: yup.ISchema<T>): yup.ISchema<Batch<T>> => {
    return yup.lazy((value) => {
      const batchSchema = yupArray(schema).defined();
      if (Array.isArray(value)) {
        return batchSchema;
      }
      return batchSchema.transform((_, originalValue) => [originalValue]);
    }) as unknown as yup.ISchema<Batch<T>>;
  };

  const getListOutputSchema = (readSchema: yup.AnySchema) => {
    return yupObject({
      items: yupArray(readSchema).defined(),
      is_paginated: yupBoolean().defined().meta({ openapiField: { hidden: true } }),
      pagination: yupObject({
        next_cursor: yupString().nullable().defined().meta({ openapiField: { description: "The cursor to fetch the next page of results. null if there is no next page.", exampleValue: 'b3d396b8-c574-4c80-97b3-50031675ceb2' } }),
      }).when('is_paginated', {
        is: true,
        then: (schema) => schema.defined(),
        otherwise: (schema) => schema.optional(),
      }),
    }).defined();
  };

  const getSchemas = (accessType: "admin" | "server" | "client", operation: Capitalize<CudOperation>) => {
    const read = crud[accessType].readSchema ?? throwErr(`No read schema for access type ${accessType}; this should never happen`);

    const input =
      typedIncludes(["Read", "List"] as const, operation)
        ? yupMixed<any>().oneOf([undefined])
        : operation === "Create"
          ? (crud[accessType].createSchema ?? throwErr(`No create schema for access type ${accessType}; this should never happen`))
          : operation === "Update"
            ? getBatchSchema(crud[accessType].updateSchema ?? throwErr(`No update schema for access type ${accessType}; this should never happen`))
            : getBatchSchema(crud[accessType].deleteSchema ?? throwErr(`No delete schema for access type ${accessType}; this should never happen`));

    const output =
      operation === "Read"
        ? read
        : getListOutputSchema(read);

    const listOutput = getListOutputSchema(read);
    return { input, output, read, listOutput };
  };

  // SAFETY: Every generated entry is assembled from the operation/access maps
  // above, whose schemas and handlers are checked before construction.
  return Object.fromEntries(
    operations.flatMap(([httpMethod, operation]) => {
      const availableAccessTypes = accessTypes.filter((accessType) => {
        if (crud[accessType].readSchema === undefined) {
          return false;
        }
        if (operation === "Read" || operation === "List") {
          return true;
        }
        return crud[accessType][`${typedToLowercase(operation)}Schema`] !== undefined;
      });

      if (availableAccessTypes.length === 0) {
        throw new HexclaveAssertionError(`No access types available for operation ${operation} in CUD handler; check that the corresponding schemas are defined in the CrudSchema`);
      }

      // Build invoke helpers per access type to power both route handlers and direct calls.
      const accessTypeEntries = new Map(availableAccessTypes.map((accessType) => {
        const adminSchemas = getSchemas("admin", operation);
        const accessSchemas = getSchemas(accessType, operation);
        const invokeList = async (invokeOptions: { params: yup.InferType<PS> | Partial<yup.InferType<PS>>, query: yup.InferType<QS>, data: unknown, auth: SmartRequestAuth }) => {
          const expectsAllParams = typedIncludes(["Read", "Update", "Delete"] as const, operation);
          const actualParamsSchema = expectsAllParams ? paramsSchema : paramsSchema.partial();
          const paramsValidated = await validate(invokeOptions.params, actualParamsSchema, invokeOptions.auth.user ?? null, "Params validation");

          let result: unknown;
          if (operation === "Create") {
            const adminCreateData = await validate(invokeOptions.data, adminSchemas.input, invokeOptions.auth.user ?? null, "Input validation");
            const createdId = await validate(await options.onCreate({
              params: paramsValidated as any,
              data: adminCreateData as any,
              auth: invokeOptions.auth,
              query: invokeOptions.query,
            }), yupString().defined(), invokeOptions.auth.user ?? null, "Created id validation");

            result = await options.onUpdate({
              params: paramsValidated as any,
              data: [{ ...(adminCreateData as any), id: createdId }],
              auth: invokeOptions.auth,
              query: invokeOptions.query,
            });
          } else if (operation === "Delete") {
            const adminDeleteData = await validate(invokeOptions.data, adminSchemas.input, invokeOptions.auth.user ?? null, "Input validation");
            result = await options.onDelete({
              params: paramsValidated as any,
              data: adminDeleteData as any,
              auth: invokeOptions.auth,
              query: invokeOptions.query,
            });
          } else {
            const updateData = operation === "Update"
              ? await validate(invokeOptions.data, adminSchemas.input, invokeOptions.auth.user ?? null, "Input validation")
              : [];
            result = await options.onUpdate({
              params: paramsValidated as any,
              data: updateData as any,
              auth: invokeOptions.auth,
              query: invokeOptions.query,
            });
          }

          const resultAdminValidated = await validate(result, adminSchemas.listOutput, invokeOptions.auth.user ?? null, "Result admin validation");
          const resultAccessValidated = await validate(resultAdminValidated, accessSchemas.listOutput, invokeOptions.auth.user ?? null, `Result ${accessType} validation`);
          return resultAccessValidated;
        };

        const invokeRead = async (invokeOptions: { params: yup.InferType<PS>, query: yup.InferType<QS>, auth: SmartRequestAuth }) => {
          const listResult = await invokeList({
            params: invokeOptions.params,
            query: invokeOptions.query,
            data: [],
            auth: invokeOptions.auth,
          }) as any;

          if (listResult.is_paginated) {
            throw new HexclaveAssertionError("Read operation returned a paginated list; reads must return exactly one item");
          }
          if (listResult.items.length !== 1) {
            throw new HexclaveAssertionError(`Read operation returned ${listResult.items.length} items; reads must return exactly one item`);
          }
          return listResult.items[0];
        };

        return [
          accessType,
          {
            accessSchemas,
            adminSchemas,
            invokeList,
            invokeRead,
          },
        ] as const;
      }));

      const routeHandler = createSmartRouteHandler(
        [...accessTypeEntries],
        ([accessType, entry]) => {
          const { accessSchemas } = entry;
          const frw = routeHandlerTypeHelper({
            request: yupObject({
              auth: yupObject({
                type: yupString().oneOf([accessType]).defined(),
              }).defined(),
              url: yupString().defined(),
              method: yupString().oneOf([httpMethod]).defined(),
              body: accessSchemas.input,
              params: typedIncludes(["List", "Create"] as const, operation) ? paramsSchema.partial() : paramsSchema,
              query: (options.querySchema ?? yupObject({})) as QuerySchema,
            }),
            response: yupObject({
              statusCode: yupNumber().oneOf([operation === "Create" ? 201 : 200]).defined(),
              headers: yupObject({}),
              bodyType: yupString().oneOf(["json"]).defined(),
              body: accessSchemas.output,
            }),
            handler: async (req, fullReq) => {
              const auth = fullReq.auth ?? throwErr("Auth not found in CUD handler; this should never happen! (all clients are at least client to access CUD handler)");

              if (operation === "Read") {
                const result = await entry.invokeRead({
                  params: req.params as any,
                  query: req.query as any,
                  auth,
                });
                return {
                  statusCode: 200,
                  headers: {},
                  bodyType: "json",
                  body: result,
                };
              }

              const result = await entry.invokeList({
                params: req.params as any,
                query: req.query as any,
                data: req.body,
                auth,
              });

              return {
                statusCode: operation === "Create" ? 201 : 200,
                headers: {},
                bodyType: "json",
                body: result,
              };
            },
          });

          const metadata = crud[accessType][`${typedToLowercase(operation)}Docs`];
          return {
            ...frw,
            metadata: metadata ? (metadata.hidden ? metadata : { ...metadata, crudOperation: operation }) : undefined,
          };
        },
      );

      const resolveInvocationContext = async (
        { project, branchId, tenancy }: { project?: Omit<ProjectsCrud["Admin"]["Read"], "config">, branchId?: string, tenancy?: Tenancy },
      ) => {
        if (tenancy) {
          if (project || branchId) {
            throw new HexclaveAssertionError("Must specify either project and branchId or tenancy, not both");
          }
          return { project: tenancy.project, branchId: tenancy.branchId, tenancy };
        }
        if (project) {
          if (!branchId) {
            throw new HexclaveAssertionError("Must specify branchId when specifying project");
          }
          const resolvedTenancy = await getSoleTenancyFromProjectBranch(project.id, branchId);
          return { project, branchId, tenancy: resolvedTenancy };
        }
        throw new HexclaveAssertionError("Must specify either project and branchId or tenancy");
      };

      const makeDirectInvoke = (entry: (typeof accessTypeEntries) extends Map<unknown, infer V> ? V : never, accessType: "client" | "server" | "admin", directOperation: CudOperation) => {
        return async ({ user, project, branchId, tenancy, data, query, allowedErrorTypes, ...params }: any) => {
          const resolved = await resolveInvocationContext({ project, branchId, tenancy });

          try {
            return await traceSpan("invoking CUD handler programmatically", async () => {
              const auth: SmartRequestAuth = {
                user,
                project: resolved.project,
                branchId: resolved.branchId,
                tenancy: resolved.tenancy,
                type: accessType,
              };

              if (directOperation === "read") {
                return await entry.invokeRead({
                  params,
                  query: query ?? {} as any,
                  auth,
                });
              }

              return await entry.invokeList({
                params,
                query: query ?? {} as any,
                data: data as any,
                auth,
              });
            });
          } catch (error) {
            if (allowedErrorTypes?.some((a: any) => error instanceof a) || error instanceof HexclaveAssertionError) {
              throw error;
            }
            throw new CudHandlerInvocationError(error);
          }
        };
      };

      const directOperation = typedToLowercase(operation) as CudOperation;
      const directCalls = [...accessTypeEntries].map(([accessType, entry]) => {
        const directName = `${accessType}${operation}`;
        return [directName, makeDirectInvoke(entry, accessType, directOperation)] as const;
      });

      return [
        [`${typedToLowercase(operation)}Handler`, routeHandler],
        ...directCalls,
      ];
    }),
  ) as any;
}

export class CudHandlerInvocationError extends Error {
  constructor(public readonly cause: unknown) {
    super("Error while invoking CUD handler programmatically. This is a wrapper error to prevent caught errors (eg. StatusError) from being caught by outer catch blocks. Check the `cause` property.\n\nOriginal error: " + cause, { cause });
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
          ${validationDescription} failed in CUD handler.
          
          Errors:
            ${error.errors.join("\n")}
        `,
        { obj: obj, schema, cause: error },
      );
    }
    throw error;
  }
}

import.meta.vitest?.test("createCudHandlers", async ({ expect }) => {
  const { createCrud } = await import("@hexclave/shared/dist/crud");
  const { yupObject, yupString } = await import("@hexclave/shared/dist/schema-fields");

  const itemClientSchema = yupObject({
    id: yupString().defined(),
    public: yupString().defined(),
  }).defined();

  const itemAdminSchema = yupObject({
    id: yupString().defined(),
    public: yupString().defined(),
    secret: yupString().defined(),
  }).defined();

  const crud = createCrud({
    clientReadSchema: itemClientSchema,
    adminReadSchema: itemAdminSchema,
    clientCreateSchema: yupObject({ public: yupString().defined() }).defined(),
    clientUpdateSchema: yupObject({ public: yupString().optional() }).defined(),
    clientDeleteSchema: yupObject({ id: yupString().defined() }).defined(),
  });

  let createCalls = 0;
  let updateCalls = 0;
  let deleteCalls = 0;
  let lastCreatePublic: string | null = null;
  let lastUpdateDataKind: "empty" | "update" | "create-forward" | null = null;
  let lastDeleteBatchSize: number | null = null;

  const handlers = createCudHandlers(crud, {
    paramsSchema: yupObject({
      id: yupString().defined(),
    }).defined(),
    onCreate: async ({ data }) => {
      createCalls++;
      lastCreatePublic = data.public;
      return "1";
    },
    onUpdate: async ({ data, params }) => {
      updateCalls++;
      const paramId = params.id;
      if (data.length === 0) {
        lastUpdateDataKind = "empty";
        if (paramId) {
          return {
            items: [{ id: paramId, public: "p", secret: "s" }],
            is_paginated: false,
          };
        }
        return {
          items: [{ id: "1", public: "p1", secret: "s1" }, { id: "2", public: "p2", secret: "s2" }],
          is_paginated: false,
        };
      }

      if ("id" in data[0]!) {
        lastUpdateDataKind = "create-forward";
        const first = data[0];
        const created = first as { id: string, public: string };
        return {
          items: [{ id: created.id, public: created.public, secret: "s" }],
          is_paginated: false,
        };
      }

      lastUpdateDataKind = "update";
      if (paramId) {
        return {
          items: [{ id: paramId, public: data[0]?.public ?? "p", secret: "s" }],
          is_paginated: false,
        };
      }

      return {
        items: [{ id: "1", public: "p1", secret: "s1" }, { id: "2", public: "p2", secret: "s2" }],
        is_paginated: false,
      };
    },
    onDelete: async ({ data }) => {
      deleteCalls++;
      lastDeleteBatchSize = data.length;
      return {
        items: [],
        is_paginated: false,
      };
    },
  });

  const baseReq = {
    url: "http://localhost/api/latest/test",
    bodyBuffer: new ArrayBuffer(0),
    headers: {},
    query: {},
    clientVersion: undefined,
  };

  const makeAuth = (type: "client" | "admin") => ({
    type,
    project: { id: "p", display_name: "p" } as any,
    branchId: "main",
    tenancy: { id: "t", project: { id: "p", display_name: "p" }, branchId: "main", config: {} } as any,
  }) as any;

  {
    const res = await handlers.listHandler.invoke({
      ...baseReq,
      auth: makeAuth("client"),
      method: "GET",
      body: undefined,
      params: {},
    });

    expect(createCalls).toBe(0);
    expect(deleteCalls).toBe(0);
    expect(lastUpdateDataKind).toBe("empty");
    expect((res as any).body.items).toEqual([{ id: "1", public: "p1" }, { id: "2", public: "p2" }]);
  }

  {
    const res = await handlers.readHandler.invoke({
      ...baseReq,
      auth: makeAuth("client"),
      method: "GET",
      body: undefined,
      params: { id: "1" },
    } as any);

    expect(lastUpdateDataKind).toBe("empty");
    expect(res.body).toEqual({ id: "1", public: "p" });
  }

  {
    const res = await handlers.updateHandler.invoke({
      ...baseReq,
      auth: makeAuth("admin"),
      method: "PATCH",
      body: { public: "new" },
      params: { id: "1" },
    } as any);

    expect(lastUpdateDataKind).toBe("update");
    expect((res as any).body.items[0]).toEqual({ id: "1", public: "new", secret: "s" });
  }

  {
    const res = await handlers.createHandler.invoke({
      ...baseReq,
      auth: makeAuth("client"),
      method: "POST",
      body: { public: "c" },
      params: {},
    } as any);

    expect(createCalls).toBe(1);
    expect(lastUpdateDataKind).toBe("create-forward");
    expect(lastCreatePublic).toBe("c");
    expect((res as any).body.items[0]).toEqual({ id: "1", public: "c" });
  }

  {
    const res = await handlers.deleteHandler.invoke({
      ...baseReq,
      auth: makeAuth("client"),
      method: "DELETE",
      body: [{ id: "1" }, { id: "2" }],
      params: { id: "anything" },
    } as any);

    expect(lastDeleteBatchSize).toBe(2);
    expect((res as any).body.items).toEqual([]);
  }
});

import { Prisma } from "@/generated/prisma/client";
import { globalPrismaClient, retryTransaction } from "@/prisma-client";
import type * as PrismaRuntime from "@prisma/client/runtime/client";
import { CrudSchema, CrudTypeOf } from "@hexclave/shared/dist/crud";
import { typedAssign } from "@hexclave/shared/dist/utils/objects";
import * as yup from "yup";
import { CrudHandlers, ParamsSchema, QuerySchema, createCrudHandlers } from "./crud-handler";
import { SmartRequestAuth } from "./smart-request";

type GetResult<Payload extends PrismaRuntime.OperationPayload, Args, OperationName extends PrismaRuntime.Operation = 'findUniqueOrThrow', GlobalOmitOptions = {}> = PrismaRuntime.Types.Result.GetResult<Payload, Args, OperationName, GlobalOmitOptions>;

type ReplaceNever<T, R> = [T] extends [never] ? R : T;

type AllPrismaModelNames = Prisma.TypeMap["meta"]["modelProps"];
type ModelOperations<T extends AllPrismaModelNames> = Prisma.TypeMap["model"][Capitalize<T>]["operations"];
type WhereUnique<T extends AllPrismaModelNames> = Prisma.TypeMap["model"][Capitalize<T>]["operations"]["findUniqueOrThrow"]["args"]["where"];
type WhereMany<T extends AllPrismaModelNames> = Prisma.TypeMap["model"][Capitalize<T>]["operations"]["findMany"]["args"]["where"];
type Where<T extends AllPrismaModelNames> = { [K in keyof WhereMany<T> as (K extends keyof WhereUnique<T> ? K : never)]: WhereMany<T>[K] };
type Include<T extends AllPrismaModelNames> = (Prisma.TypeMap["model"][Capitalize<T>]["operations"]["findMany"]["args"] & { include?: unknown })["include"];
type BaseFields<T extends AllPrismaModelNames> = Where<T> & Partial<PCreate<T>>;
type PRead<T extends AllPrismaModelNames, W extends Where<T>, I extends Include<T>> = GetResult<Prisma.TypeMap["model"][Capitalize<T>]["payload"], { where: W, include: I }, "findUniqueOrThrow">;
type PUpdate<T extends AllPrismaModelNames> = ModelOperations<T> extends { update: { args: { data: infer D } } } ? D : never;
type PCreate<T extends AllPrismaModelNames> = ModelOperations<T> extends { create: { args: { data: infer D } } } ? D : never;
type PEitherWrite<T extends AllPrismaModelNames> = (PCreate<T> | PUpdate<T>) & Partial<ReplaceNever<PCreate<T> & PUpdate<T>, unknown>>;

type CRead<T extends CrudTypeOf<any>> = T extends { Admin: { Read: infer R } } ? R : never;
type CCreate<T extends CrudTypeOf<any>> = T extends { Admin: { Create: infer R } } ? R : never;
type CUpdate<T extends CrudTypeOf<any>> = T extends { Admin: { Update: infer R } } ? R : never;
type CEitherWrite<T extends CrudTypeOf<any>> = (CCreate<T> | CUpdate<T>) & Partial<ReplaceNever<CCreate<T> & CUpdate<T>, unknown>>;

type Context<AllParams extends boolean, PS extends ParamsSchema, QS extends QuerySchema> = {
  params: [AllParams] extends [true] ? yup.InferType<PS> : Partial<yup.InferType<PS>>,
  auth: SmartRequestAuth,
  query: yup.InferType<QS>,
};
type CrudToPrismaContext<AllParams extends boolean, PS extends ParamsSchema, QS extends QuerySchema> = Context<AllParams, PS, QS> & { type: 'update' | 'create' };
type OnPrepareContext<AllParams extends boolean, PS extends ParamsSchema, QS extends QuerySchema> = Context<AllParams, PS, QS> & { type: 'list' | 'read' | 'create' | 'update' | 'delete' };

type CrudHandlersFromCrudType<T extends CrudTypeOf<CrudSchema>, PS extends ParamsSchema, QS extends QuerySchema> = CrudHandlers<
  T,
  PS,
  QS,
  | ("Create" extends keyof T["Admin"] ? "Create" : never)
  | ("Read" extends keyof T["Admin"] ? "Read" : never)
  | ("Read" extends keyof T["Admin"] ? "List" : never)
  | ("Update" extends keyof T["Admin"] ? "Update" : never)
  | ("Delete" extends keyof T["Admin"] ? "Delete" : never)
>;

type ExtraDataFromCrudType<
  S extends CrudSchema,
  PrismaModelName extends AllPrismaModelNames,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  W extends Where<PrismaModelName>,
  I extends Include<PrismaModelName>,
  B extends BaseFields<PrismaModelName>,
> = {
  getInclude(params: yup.InferType<PS>, query: yup.InferType<QS>, context: Pick<Context<false, PS, QS>, "auth">): Promise<I>,
  transformPrismaToCrudObject(prismaOrNull: PRead<PrismaModelName, W & B, I> | null, params: yup.InferType<PS>, query: yup.InferType<QS>, context: Pick<Context<false, PS, QS>, "auth">): Promise<CRead<CrudTypeOf<S>>>,
};

/**
 * @deprecated Use `createCrudHandlers` instead.
 *
 * Only used for internal API keys, which will also soon migrate off of this.
 */
export function createPrismaCrudHandlers<
  S extends CrudSchema,
  PrismaModelName extends AllPrismaModelNames,
  PS extends ParamsSchema,
  QS extends QuerySchema,
  W extends Where<PrismaModelName>,
  I extends Include<PrismaModelName>,
  B extends BaseFields<PrismaModelName>,
>(
  crudSchema: S,
  prismaModelName: PrismaModelName,
  options: & {
      paramsSchema: PS,
      querySchema?: QS,
      onPrepare?: (context: OnPrepareContext<false, PS, QS>) => Promise<void>,
      baseFields: (context: Context<false, PS, QS>) => Promise<B>,
      where?: (context: Context<false, PS, QS>) => Promise<W>,
      whereUnique?: (context: Context<true, PS, QS>) => Promise<WhereUnique<PrismaModelName>>,
      orderBy?: (context: Context<false, PS, QS>) => Promise<Prisma.TypeMap["model"][Capitalize<PrismaModelName>]["operations"]["findMany"]["args"]["orderBy"]>,
      include: (context: Context<false, PS, QS>) => Promise<I>,
      crudToPrisma: (crud: CEitherWrite<CrudTypeOf<S>>, context: CrudToPrismaContext<false, PS, QS>) => Promise<PEitherWrite<PrismaModelName>>,
      prismaToCrud: (prisma: PRead<PrismaModelName, W & B, I>, context: Context<false, PS, QS>) => Promise<CRead<CrudTypeOf<S>>>,
      notFoundToCrud: (context: Context<false, PS, QS>) => Promise<CRead<CrudTypeOf<S>> | never>,
      onCreate?: (prisma: PRead<PrismaModelName, W & B, I>, context: Context<false, PS, QS>) => Promise<void>,
      onUpdate?: (
        prisma: PRead<PrismaModelName, W & B, I>,
        context: Context<true, PS, QS>,
        extras: { previous: PRead<PrismaModelName, W & B, I> },
      ) => Promise<void>,
    },
): CrudHandlersFromCrudType<CrudTypeOf<S>, PS, QS> & ExtraDataFromCrudType<S, PrismaModelName, PS, QS, W, I, B> {
  const wrapper = <AllParams extends boolean, T>(allParams: AllParams, func: (data: any, context: Context<AllParams, PS, QS>) => Promise<T>): (opts: Context<AllParams, PS, QS> & { data?: unknown }) => Promise<T> => {
    return async (req) => {
      const context: Context<AllParams, PS, QS> = {
        params: req.params,
        auth: req.auth,
        query: req.query,
      };
      return await func(req.data, context);
    };
  };

  const prismaOrNullToCrud = (prismaOrNull: PRead<PrismaModelName, W & B, I> | null, context: Context<false, PS, QS>) => {
    if (prismaOrNull === null) {
      return options.notFoundToCrud(context);
    } else {
      return options.prismaToCrud(prismaOrNull, context);
    }
  };
  const crudToPrisma = options.crudToPrisma;

  return typedAssign(createCrudHandlers<any, PS, QS, any>(crudSchema, {
    paramsSchema: options.paramsSchema,
    querySchema: options.querySchema,
    onPrepare: options.onPrepare,
    onRead: wrapper(true, async (data, context) => {
      const prisma = await (globalPrismaClient[prismaModelName].findUnique as any)({
        include: await options.include(context),
        where: {
          ...await options.baseFields(context),
          ...await options.where?.(context),
          ...await options.whereUnique?.(context),
        },
      });
      return await prismaOrNullToCrud(prisma, context);
    }),
    onList: wrapper(false, async (data, context) => {
      const prisma: any[] = await (globalPrismaClient[prismaModelName].findMany as any)({
        include: await options.include(context),
        where: {
          ...await options.baseFields(context),
          ...await options.where?.(context),
        },
        orderBy: await options.orderBy?.(context)
      });
      const items = await Promise.all(prisma.map((p) => prismaOrNullToCrud(p, context)));
      return {
        items,
        is_paginated: false,
      };
    }),
    onCreate: wrapper(false, async (data, context) => {
      const prismaModel = globalPrismaClient[prismaModelName];
      const createMethod = Reflect.get(prismaModel, "create");
      if (typeof createMethod !== "function") {
        throw new Error(`Prisma model ${prismaModelName} does not support create()`);
      }
      const prisma = await Reflect.apply(createMethod, prismaModel, [{
        include: await options.include(context),
        data: {
          ...await options.baseFields(context),
          ...await crudToPrisma(data, { ...context, type: 'create' }),
        },
      }]);
      // TODO pass the same transaction to onCreate as the one that creates the user row
      // we should probably do this with all functions and pass a transaction around in the context
      await options.onCreate?.(prisma, context);
      return await prismaOrNullToCrud(prisma, context);
    }),
    onUpdate: wrapper(true, async (data, context) => {
      const baseQuery: any = {
        include: await options.include(context),
        where: {
          ...await options.baseFields(context),
          ...await options.where?.(context),
          ...await options.whereUnique?.(context),
        },
      };
      // Snapshot and update must be the same row. A concurrent PATCH between
      // findUnique and update would make API-key (and similar) audit
      // before-values describe a state that was already overwritten.
      const { prismaRead, prisma } = await retryTransaction(globalPrismaClient, async (tx) => {
        const previous = await (tx[prismaModelName].findUnique as any)({
          ...baseQuery,
        });
        if (previous === null) {
          return { prismaRead: null, prisma: null };
        }
        const updated = await (tx[prismaModelName].update as any)({
          ...baseQuery,
          data: await crudToPrisma(data, { ...context, type: 'update' }),
        });
        return { prismaRead: previous, prisma: updated };
      });
      if (prismaRead === null || prisma === null) {
        return await prismaOrNullToCrud(null, context);
      }
      await options.onUpdate?.(prisma, context, { previous: prismaRead });
      return await prismaOrNullToCrud(prisma, context);
    }),
    onDelete: wrapper(true, async (data, context) => {
      const baseQuery: any = {
        include: await options.include(context),
        where: {
          ...await options.baseFields(context),
          ...await options.where?.(context),
          ...await options.whereUnique?.(context),
        },
      };
      const prismaRead = await (globalPrismaClient[prismaModelName].findUnique as any)({
        ...baseQuery,
      });
      if (prismaRead !== null) {
        await (globalPrismaClient[prismaModelName].delete as any)({
          ...baseQuery
        });
      }
    }),
  }), {
    getInclude(params, query, context) {
      return options.include({
        ...context,
        params,
        query,
      });
    },
    transformPrismaToCrudObject(prismaOrNull, params, query, context) {
      return prismaOrNullToCrud(prismaOrNull, {
        ...context,
        params,
        query,
      });
    },
  } satisfies ExtraDataFromCrudType<S, PrismaModelName, PS, QS, W, I, B>);
}

import { createPermissionDefinition, deletePermissionDefinition, listPermissionDefinitions, updatePermissionDefinition } from "@/lib/permissions";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { teamPermissionDefinitionsCrud } from '@hexclave/shared/dist/interface/crud/team-permissions';
import { permissionDefinitionIdSchema, yupObject } from "@hexclave/shared/dist/schema-fields";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";
import {
  permissionDefinitionResultToSnapshot,
  readPermissionDefinitionSnapshot,
  recordPermissionDefinitionAudit,
} from "../permission-definition-audit";
import { paginatePermissionDefinitions, permissionDefinitionsListQuerySchema } from "../permission-definitions-pagination";

export const teamPermissionDefinitionsCrudHandlers = createLazyProxy(() => createCrudHandlers(teamPermissionDefinitionsCrud, {
  paramsSchema: yupObject({
    permission_id: permissionDefinitionIdSchema.defined(),
  }),
  querySchema: permissionDefinitionsListQuerySchema,
  async onCreate({ auth, data }) {
    const result = await createPermissionDefinition(
      globalPrismaClient,
      {
        scope: "team",
        tenancy: auth.tenancy,
        data,
      }
    );
    await recordPermissionDefinitionAudit({
      auth,
      scope: "team",
      action: "permission_definition.created",
      source: "team_permission_definitions.create",
      after: permissionDefinitionResultToSnapshot(result, "team"),
    });
    return result;
  },
  async onUpdate({ auth, data, params }) {
    const before = readPermissionDefinitionSnapshot(auth.tenancy, params.permission_id, "team");
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await updatePermissionDefinition(
      globalPrismaClient,
      prisma,
      {
        oldId: params.permission_id,
        scope: "team",
        tenancy: auth.tenancy,
        data: {
          id: data.id,
          description: data.description,
          contained_permission_ids: data.contained_permission_ids,
        }
      }
    );
    await recordPermissionDefinitionAudit({
      auth,
      scope: "team",
      action: "permission_definition.updated",
      source: "team_permission_definitions.update",
      before,
      after: permissionDefinitionResultToSnapshot(result, "team"),
      patch: {
        id: data.id,
        description: data.description,
        contained_permission_ids: data.contained_permission_ids,
      },
    });
    return result;
  },
  async onDelete({ auth, params }) {
    const before = readPermissionDefinitionSnapshot(auth.tenancy, params.permission_id, "team");
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await deletePermissionDefinition(
      globalPrismaClient,
      prisma,
      {
        scope: "team",
        tenancy: auth.tenancy,
        permissionId: params.permission_id
      }
    );
    await recordPermissionDefinitionAudit({
      auth,
      scope: "team",
      action: "permission_definition.deleted",
      source: "team_permission_definitions.delete",
      before,
    });
    return result;
  },
  async onList({ auth, query }) {
    const all = await listPermissionDefinitions({
      scope: "team",
      tenancy: auth.tenancy,
    });
    return paginatePermissionDefinitions(all, query);
  },
}));

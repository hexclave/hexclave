import { createPermissionDefinition, deletePermissionDefinition, listPermissionDefinitions, updatePermissionDefinition } from "@/lib/permissions";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { projectPermissionDefinitionsCrud } from '@hexclave/shared/dist/interface/crud/project-permissions';
import { permissionDefinitionIdSchema, yupObject } from "@hexclave/shared/dist/schema-fields";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";
import {
  permissionDefinitionResultToSnapshot,
  readPermissionDefinitionSnapshot,
  recordPermissionDefinitionAudit,
} from "../permission-definition-audit";


export const projectPermissionDefinitionsCrudHandlers = createLazyProxy(() => createCrudHandlers(projectPermissionDefinitionsCrud, {
  paramsSchema: yupObject({
    permission_id: permissionDefinitionIdSchema.defined(),
  }),
  async onCreate({ auth, data }) {
    const result = await createPermissionDefinition(
      globalPrismaClient,
      {
        scope: "project",
        tenancy: auth.tenancy,
        data,
      }
    );
    await recordPermissionDefinitionAudit({
      auth,
      scope: "project",
      action: "permission_definition.created",
      source: "project_permission_definitions.create",
      after: permissionDefinitionResultToSnapshot(result, "project"),
    });
    return result;
  },
  async onUpdate({ auth, data, params }) {
    const before = readPermissionDefinitionSnapshot(auth.tenancy, params.permission_id, "project");
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await updatePermissionDefinition(
      globalPrismaClient,
      prisma,
      {
        oldId: params.permission_id,
        scope: "project",
        tenancy: auth.tenancy,
        data,
      }
    );
    await recordPermissionDefinitionAudit({
      auth,
      scope: "project",
      action: "permission_definition.updated",
      source: "project_permission_definitions.update",
      before,
      after: permissionDefinitionResultToSnapshot(result, "project"),
      patch: {
        id: data.id,
        description: data.description,
        contained_permission_ids: data.contained_permission_ids,
      },
    });
    return result;
  },
  async onDelete({ auth, params }) {
    const before = readPermissionDefinitionSnapshot(auth.tenancy, params.permission_id, "project");
    const prisma = await getPrismaClientForTenancy(auth.tenancy);
    const result = await deletePermissionDefinition(
      globalPrismaClient,
      prisma,
      {
        scope: "project",
        tenancy: auth.tenancy,
        permissionId: params.permission_id
      }
    );
    await recordPermissionDefinitionAudit({
      auth,
      scope: "project",
      action: "permission_definition.deleted",
      source: "project_permission_definitions.delete",
      before,
    });
    return result;
  },
  async onList({ auth }) {
    return {
      items: await listPermissionDefinitions({
        scope: "project",
        tenancy: auth.tenancy,
      }),
      is_paginated: false,
    };
  },
}));

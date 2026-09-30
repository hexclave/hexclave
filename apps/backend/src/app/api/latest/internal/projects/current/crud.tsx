import { getBranchConfigPushedError, getDevelopmentEnvironmentConfigWarnings, renderedOrganizationConfigToProjectCrud } from "@/lib/config";
import { dropDataSourceSlotsForProject } from "@/lib/data-sources";
import { createOrUpdateProjectWithLegacyConfig } from "@/lib/projects";
import { getTenancy } from "@/lib/tenancies";
import { getPrismaClientForTenancy, globalPrismaClient } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { projectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { yupObject } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

export const projectsCrudHandlers = createLazyProxy(() => createCrudHandlers(projectsCrud, {
  paramsSchema: yupObject({}),
  onUpdate: async ({ auth, data }) => {
    if (
      data.config?.email_theme &&
      !Object.keys(auth.tenancy.config.emails.themes).includes(data.config.email_theme)
    ) {
      throw new StatusError(400, "Invalid email theme");
    }
    const project = await createOrUpdateProjectWithLegacyConfig({
      type: "update",
      projectId: auth.project.id,
      branchId: auth.branchId,
      data: data,
    });
    const tenancy = await getTenancy(auth.tenancy.id) ?? throwErr("Tenancy not found after project update?"); // since we updated the project, we need to re-fetch the new tenancy config
    return {
      ...project,
      pushed_config_error: await getBranchConfigPushedError({
        projectId: auth.project.id,
        branchId: auth.tenancy.branchId,
      }),
      config_warnings: await getDevelopmentEnvironmentConfigWarnings({
        projectId: auth.project.id,
        branchId: auth.tenancy.branchId,
        organizationId: auth.tenancy.organization?.id ?? null,
      }),
      config: renderedOrganizationConfigToProjectCrud(tenancy.config),
    };
  },
  onRead: async ({ auth }) => {
    return {
      ...auth.project,
      pushed_config_error: await getBranchConfigPushedError({
        projectId: auth.project.id,
        branchId: auth.tenancy.branchId,
      }),
      config_warnings: await getDevelopmentEnvironmentConfigWarnings({
        projectId: auth.project.id,
        branchId: auth.tenancy.branchId,
        organizationId: auth.tenancy.organization?.id ?? null,
      }),
      config: renderedOrganizationConfigToProjectCrud(auth.tenancy.config),
    };
  },
  onDelete: async ({ auth }) => {
    // The delete cascades data sources away without their own cleanup, so their
    // replication slots have to be dropped first.
    await dropDataSourceSlotsForProject(auth.project.id);
    await globalPrismaClient.project.delete({
      where: {
        id: auth.project.id
      }
    });
  }
}));

import { buildProjectSettingsAuditMetadata, collectConfigPaths, recordAuditEvent } from "@/lib/audit-log";
import { getBranchConfigPushedError, getDevelopmentEnvironmentConfigWarnings, renderedOrganizationConfigToProjectCrud } from "@/lib/config";
import { createOrUpdateProjectWithLegacyConfig } from "@/lib/projects";
import { getTenancy } from "@/lib/tenancies";
import { globalPrismaClient } from "@/prisma-client";
import { createCrudHandlers } from "@/route-handlers/crud-handler";
import { projectsCrud } from "@hexclave/shared/dist/interface/crud/projects";
import { yupObject } from "@hexclave/shared/dist/schema-fields";
import { StatusError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { createLazyProxy } from "@hexclave/shared/dist/utils/proxies";

function collectProjectUpdateFields(data: Record<string, unknown>): string[] {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (key === "config" && value != null && typeof value === "object" && !Array.isArray(value)) {
      fields.push(...collectConfigPaths(value).map((path) => `config.${path}`));
    } else {
      fields.push(key);
    }
  }
  return fields;
}

export const projectsCrudHandlers = createLazyProxy(() => createCrudHandlers(projectsCrud, {
  paramsSchema: yupObject({}),
  onUpdate: async ({ auth, data }) => {
    if (
      data.config?.email_theme &&
      !Object.keys(auth.tenancy.config.emails.themes).includes(data.config.email_theme)
    ) {
      throw new StatusError(400, "Invalid email theme");
    }
    // Capture pre-update project for before values (auth.project is still the old snapshot).
    const beforeProject = {
      ...auth.project,
      config: renderedOrganizationConfigToProjectCrud(auth.tenancy.config),
    };
    const project = await createOrUpdateProjectWithLegacyConfig({
      type: "update",
      projectId: auth.project.id,
      branchId: auth.branchId,
      data: data,
    });
    const tenancy = await getTenancy(auth.tenancy.id) ?? throwErr("Tenancy not found after project update?"); // since we updated the project, we need to re-fetch the new tenancy config

    const afterProject = {
      ...project,
      config: renderedOrganizationConfigToProjectCrud(tenancy.config),
    };
    const settingsMetadata = buildProjectSettingsAuditMetadata({
      source: "projects.current.update",
      writeMode: "merge",
      changedPaths: collectProjectUpdateFields(data as Record<string, unknown>),
      beforeRoot: beforeProject,
      afterRoot: afterProject,
    });
    if (settingsMetadata != null) {
      await recordAuditEvent({
        tenancy: auth.tenancy,
        auth,
        action: "project_settings.updated",
        metadata: settingsMetadata,
      });
    }

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
    await globalPrismaClient.project.delete({
      where: {
        id: auth.project.id
      }
    });
  }
}));

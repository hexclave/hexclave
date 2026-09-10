import { PrismaClientTransaction } from "@/prisma-client";
import { KnownErrors } from "@hexclave/shared";
import { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import { ProjectPermissionsCrud } from "@hexclave/shared/dist/interface/crud/project-permissions";
import { TeamPermissionDefinitionsCrud, TeamPermissionsCrud } from "@hexclave/shared/dist/interface/crud/team-permissions";
import { groupBy } from "@hexclave/shared/dist/utils/arrays";
import { getOrUndefined, has, typedEntries, typedFromEntries } from "@hexclave/shared/dist/utils/objects";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { overrideEnvironmentConfigOverride } from "./config";
import { recordExternalDbSyncDeletion, withExternalDbSyncUpdate } from "./external-db-sync";
import { Tenancy } from "./tenancies";
import { PrismaTransaction } from "./types";

const teamSystemPermissionMap: Record<string, string> = {
  "$update_team": "Update the team information",
  "$delete_team": "Delete the team",
  "$read_members": "Read and list the other members of the team",
  "$remove_members": "Remove other members from the team",
  "$invite_members": "Invite other users to the team",
  "$manage_api_keys": "Create and manage API keys for the team",
};

function getDescription(permissionId: string, specifiedDescription?: string) {
  if (specifiedDescription) return specifiedDescription;
  if (permissionId in teamSystemPermissionMap) return teamSystemPermissionMap[permissionId];
  return undefined;
}

export async function listPermissions<S extends "team" | "project">(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    userId?: string,
    // Bound recursive resolution to a known page of users without changing full-tenancy callers.
    userIds?: string[],
    permissionId?: string,
    recursive: boolean,
    scope: S,
  } & (S extends "team" ? {
    scope: "team",
    teamId?: string,
  } : {
    scope: "project",
  })
): Promise<S extends "team" ? TeamPermissionsCrud["Admin"]["Read"][] : ProjectPermissionsCrud["Admin"]["Read"][]> {
  const permissionDefs = await listPermissionDefinitions({
    scope: options.scope,
    tenancy: options.tenancy,
  });
  const permissionsMap = new Map(permissionDefs.map(p => [p.id, p]));
  const results = options.scope === "team" ?
    await tx.teamMemberDirectPermission.findMany({
      where: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId ?? (options.userIds == null ? undefined : { in: options.userIds }),
        teamId: (options as any).teamId
      },
    }) :
    await tx.projectUserDirectPermission.findMany({
      where: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId ?? (options.userIds == null ? undefined : { in: options.userIds }),
      },
    });

  const finalResults: { id: string, team_id?: string, user_id: string }[] = [];
  const groupedBy = groupBy(results, (result) => JSON.stringify([result.projectUserId, ...(options.scope === "team" ? [(result as any).teamId] : [])]));
  for (const [compositeKey, groupedResults] of groupedBy) {
    const [userId, teamId] = JSON.parse(compositeKey) as [string, string | undefined];
    const idsToProcess = groupedResults.map(p => p.permissionId);

    const result = new Map<string, typeof permissionDefs[number]>();
    while (idsToProcess.length > 0) {
      const currentId = idsToProcess.pop()!;
      const current = permissionsMap.get(currentId);
      if (!current) {
        // can't find the permission definition in the config, so most likely it has been deleted from the config in the meantime
        // so we just skip it
        continue;
      }
      if (result.has(current.id)) continue;
      result.set(current.id, current);
      if (options.recursive) {
        idsToProcess.push(...current.contained_permission_ids);
      }
    }

    finalResults.push(...[...result.values()].map(p => ({
      id: p.id,
      team_id: teamId,
      user_id: userId,
    })));
  }

  return finalResults
    .sort((a, b) => (options.scope === 'team' ? stringCompare((a as any).team_id, (b as any).team_id) : 0) || stringCompare(a.user_id, b.user_id) || stringCompare(a.id, b.id))
    .filter(p => options.permissionId ? p.id === options.permissionId : true) as any;
}

export async function grantTeamPermission(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    teamId: string,
    userId: string,
    permissionId: string,
  }
) {
  // sanity check: make sure that the permission exists
  const permissionDefinition = getOrUndefined(options.tenancy.config.rbac.permissions, options.permissionId);
  if (permissionDefinition === undefined) {
    if (!has(teamSystemPermissionMap, options.permissionId)) {
      throw new KnownErrors.PermissionNotFound(options.permissionId);
    }
  } else if (permissionDefinition.scope !== "team") {
    throw new KnownErrors.PermissionScopeMismatch(options.permissionId, "team", permissionDefinition.scope ?? null);
  }

  await tx.teamMemberDirectPermission.upsert({
    where: {
      tenancyId_projectUserId_teamId_permissionId: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId,
        teamId: options.teamId,
        permissionId: options.permissionId,
      },
    },
    create: withExternalDbSyncUpdate({
      tenancyId: options.tenancy.id,
      projectUserId: options.userId,
      teamId: options.teamId,
      permissionId: options.permissionId,
    }),
    update: withExternalDbSyncUpdate({}),
  });

  return {
    id: options.permissionId,
    user_id: options.userId,
    team_id: options.teamId,
  };
}

export async function revokeTeamPermission(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    teamId: string,
    userId: string,
    permissionId: string,
  }
) {
  const permissionRecord = await tx.teamMemberDirectPermission.findUniqueOrThrow({
    where: {
      tenancyId_projectUserId_teamId_permissionId: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId,
        teamId: options.teamId,
        permissionId: options.permissionId,
      },
    },
    select: { id: true },
  });

  await recordExternalDbSyncDeletion(tx, {
    tableName: "TeamMemberDirectPermission",
    tenancyId: options.tenancy.id,
    permissionDbId: permissionRecord.id,
  });

  await tx.teamMemberDirectPermission.delete({
    where: {
      tenancyId_projectUserId_teamId_permissionId: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId,
        teamId: options.teamId,
        permissionId: options.permissionId,
      },
    },
  });
}

export function listPermissionDefinitionsFromConfig(
  options: {
    config: CompleteConfig,
    scope: "team" | "project",
  },
) {
  const permissions = typedEntries(options.config.rbac.permissions).filter(([_, p]) => p.scope === options.scope);

  return [
    ...permissions.map(([id, p]) => ({
      id,
      description: getDescription(id, p.description),
      contained_permission_ids: typedEntries(p.containedPermissionIds).map(([id]) => id).sort(stringCompare),
    })),
    ...(options.scope === "team" ? typedEntries(teamSystemPermissionMap).map(([id, description]) => ({
      id,
      description,
      contained_permission_ids: [],
    })) : []),
  ].sort((a, b) => stringCompare(a.id, b.id));
}

export async function listPermissionDefinitions(
  options: {
    scope: "team" | "project",
    tenancy: Tenancy,
  }
): Promise<(TeamPermissionDefinitionsCrud["Admin"]["Read"])[]> {
  return listPermissionDefinitionsFromConfig({
    config: options.tenancy.config,
    scope: options.scope,
  });
}

export async function createPermissionDefinition(
  globalTx: PrismaTransaction,
  options: {
    scope: "team" | "project",
    tenancy: Tenancy,
    data: {
      id: string,
      description?: string,
      contained_permission_ids?: string[],
    },
  }
) {
  const oldConfig = options.tenancy.config;

  const existingPermission = oldConfig.rbac.permissions[options.data.id] as CompleteConfig['rbac']['permissions'][string] | undefined;
  const allIds = Object.keys(oldConfig.rbac.permissions)
    .filter(id => oldConfig.rbac.permissions[id].scope === options.scope)
    .concat(Object.keys(options.scope === "team" ? teamSystemPermissionMap : {}));

  if (existingPermission) {
    throw new KnownErrors.PermissionIdAlreadyExists(options.data.id);
  }

  const containedPermissionIdThatWasNotFound = options.data.contained_permission_ids?.find(id => !allIds.includes(id));
  if (containedPermissionIdThatWasNotFound !== undefined) {
    throw new KnownErrors.ContainedPermissionNotFound(containedPermissionIdThatWasNotFound);
  }

  await overrideEnvironmentConfigOverride({
    branchId: options.tenancy.branchId,
    projectId: options.tenancy.project.id,
    environmentConfigOverrideOverride: {
      "rbac.permissions": {
        ...oldConfig.rbac.permissions,
        [options.data.id]: {
          description: getDescription(options.data.id, options.data.description),
          scope: options.scope,
          containedPermissionIds: typedFromEntries((options.data.contained_permission_ids ?? []).map(id => [id, true]))
        },
      },
    }
  });

  return {
    id: options.data.id,
    description: getDescription(options.data.id, options.data.description),
    contained_permission_ids: options.data.contained_permission_ids?.sort(stringCompare) || [],
  };
}

export async function updatePermissionDefinition(
  globalTx: PrismaTransaction,
  sourceOfTruthTx: PrismaTransaction,
  options: {
    scope: "team" | "project",
    tenancy: Tenancy,
    oldId: string,
    data: {
      id?: string,
      description?: string,
      contained_permission_ids?: string[],
    },
  }
) {
  const newId = options.data.id ?? options.oldId;
  const oldConfig = options.tenancy.config;

  const existingPermission = oldConfig.rbac.permissions[options.oldId] as CompleteConfig['rbac']['permissions'][string] | undefined;

  if (!existingPermission) {
    throw new KnownErrors.PermissionNotFound(options.oldId);
  }
  if (existingPermission.scope !== options.scope) {
    throw new KnownErrors.PermissionScopeMismatch(options.oldId, options.scope, existingPermission.scope ?? null);
  }

  // check if the target new id already exists
  if (newId !== options.oldId && oldConfig.rbac.permissions[newId] as any !== undefined) {
    throw new KnownErrors.PermissionIdAlreadyExists(newId);
  }

  const allIds = Object.keys(oldConfig.rbac.permissions)
    .filter(id => oldConfig.rbac.permissions[id].scope === options.scope)
    .concat(Object.keys(options.scope === "team" ? teamSystemPermissionMap : {}));
  const containedPermissionIdThatWasNotFound = options.data.contained_permission_ids?.find(id => !allIds.includes(id));
  if (containedPermissionIdThatWasNotFound !== undefined) {
    throw new KnownErrors.ContainedPermissionNotFound(containedPermissionIdThatWasNotFound);
  }

  await overrideEnvironmentConfigOverride({
    branchId: options.tenancy.branchId,
    projectId: options.tenancy.project.id,
    environmentConfigOverrideOverride: {
      "rbac.permissions": {
        ...typedFromEntries(
          typedEntries(oldConfig.rbac.permissions)
            .filter(([id]) => id !== options.oldId)
            .map(([id, p]) => [id, {
              ...p,
              containedPermissionIds: typedFromEntries(typedEntries(p.containedPermissionIds).map(([id]) => {
                if (id === options.oldId) {
                  return [newId, true];
                } else {
                  return [id, true];
                }
              }))
            }])
        ),
        [newId]: {
          description: getDescription(newId, options.data.description),
          scope: options.scope,
          containedPermissionIds: typedFromEntries((options.data.contained_permission_ids ?? []).map(id => [id, true]))
        }
      }
    }
  });

  // update permissions for all users/teams
  await sourceOfTruthTx.teamMemberDirectPermission.updateMany({
    where: {
      tenancyId: options.tenancy.id,
      permissionId: options.oldId,
    },
    data: withExternalDbSyncUpdate({
      permissionId: newId,
    }),
  });

  await sourceOfTruthTx.projectUserDirectPermission.updateMany({
    where: {
      tenancyId: options.tenancy.id,
      permissionId: options.oldId,
    },
    data: withExternalDbSyncUpdate({
      permissionId: newId,
    }),
  });

  return {
    id: newId,
    description: getDescription(newId, options.data.description),
    contained_permission_ids: options.data.contained_permission_ids?.sort(stringCompare) || [],
  };
}

export async function ensurePermissionDefinition(
  globalTx: PrismaClientTransaction,
  sourceOfTruthTx: PrismaClientTransaction,
  options: {
    scope: "team" | "project",
    tenancy: Tenancy,
    id: string,
    data: {
      description?: string,
      contained_permission_ids?: string[],
    },
  }
) {
  const existingPermission = getOrUndefined(options.tenancy.config.rbac.permissions, options.id);

  if (existingPermission) {
    return await updatePermissionDefinition(globalTx, sourceOfTruthTx, {
      scope: options.scope,
      tenancy: options.tenancy,
      oldId: options.id,
      data: {
        id: options.id,
        description: options.data.description,
        contained_permission_ids: options.data.contained_permission_ids,
      },
    });
  } else {
    return await createPermissionDefinition(globalTx, {
      scope: options.scope,
      tenancy: options.tenancy,
      data: {
        id: options.id,
        description: options.data.description,
        contained_permission_ids: options.data.contained_permission_ids,
      },
    });
  }
}

export async function deletePermissionDefinition(
  globalTx: PrismaTransaction,
  sourceOfTruthTx: PrismaTransaction,
  options: {
    scope: "team" | "project",
    tenancy: Tenancy,
    permissionId: string,
  }
) {
  const oldConfig = options.tenancy.config;

  const existingPermission = oldConfig.rbac.permissions[options.permissionId] as CompleteConfig['rbac']['permissions'][string] | undefined;

  if (!existingPermission || existingPermission.scope !== options.scope) {
    throw new KnownErrors.PermissionNotFound(options.permissionId);
  }

  // Remove the permission from the config and update other permissions' containedPermissionIds
  await overrideEnvironmentConfigOverride({
    branchId: options.tenancy.branchId,
    projectId: options.tenancy.project.id,
    environmentConfigOverrideOverride: {
      "rbac.permissions": typedFromEntries(
        typedEntries(oldConfig.rbac.permissions)
          .filter(([id]) => id !== options.permissionId)
          .map(([id, p]) => [id, {
            ...p,
            containedPermissionIds: typedFromEntries(
              typedEntries(p.containedPermissionIds)
                .filter(([containedId]) => containedId !== options.permissionId)
            )
          }])
      )
    }
  });

  // Remove all direct permissions for this permission ID
  if (options.scope === "team") {
    await sourceOfTruthTx.teamMemberDirectPermission.deleteMany({
      where: {
        tenancyId: options.tenancy.id,
        permissionId: options.permissionId,
      },
    });
  } else {
    const projectPermissions = await sourceOfTruthTx.projectUserDirectPermission.findMany({
      where: {
        tenancyId: options.tenancy.id,
        permissionId: options.permissionId,
      },
      select: { id: true },
    });
    for (const perm of projectPermissions) {
      await recordExternalDbSyncDeletion(sourceOfTruthTx, {
        tableName: "ProjectUserDirectPermission",
        tenancyId: options.tenancy.id,
        permissionDbId: perm.id,
      });
    }
    await sourceOfTruthTx.projectUserDirectPermission.deleteMany({
      where: {
        tenancyId: options.tenancy.id,
        permissionId: options.permissionId,
      },
    });
  }
}

export async function grantProjectPermission(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    userId: string,
    permissionId: string,
  }
) {
  // sanity check: make sure that the permission exists
  const permissionDefinition = getOrUndefined(options.tenancy.config.rbac.permissions, options.permissionId);
  if (permissionDefinition === undefined) {
    throw new KnownErrors.PermissionNotFound(options.permissionId);
  } else if (permissionDefinition.scope !== "project") {
    throw new KnownErrors.PermissionScopeMismatch(options.permissionId, "project", permissionDefinition.scope ?? null);
  }

  await tx.projectUserDirectPermission.upsert({
    where: {
      tenancyId_projectUserId_permissionId: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId,
        permissionId: options.permissionId,
      },
    },
    create: withExternalDbSyncUpdate({
      permissionId: options.permissionId,
      projectUserId: options.userId,
      tenancyId: options.tenancy.id,
    }),
    update: withExternalDbSyncUpdate({}),
  });

  return {
    id: options.permissionId,
    user_id: options.userId,
  };
}

export async function revokeProjectPermission(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    userId: string,
    permissionId: string,
  }
) {
  const permissionRecord = await tx.projectUserDirectPermission.findUniqueOrThrow({
    where: {
      tenancyId_projectUserId_permissionId: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId,
        permissionId: options.permissionId,
      },
    },
    select: { id: true },
  });

  await recordExternalDbSyncDeletion(tx, {
    tableName: "ProjectUserDirectPermission",
    tenancyId: options.tenancy.id,
    permissionDbId: permissionRecord.id,
  });

  await tx.projectUserDirectPermission.delete({
    where: {
      tenancyId_projectUserId_permissionId: {
        tenancyId: options.tenancy.id,
        projectUserId: options.userId,
        permissionId: options.permissionId,
      },
    },
  });
}

/**
 * Grants default project permissions to a user
 * This function should be called when a new user is created
 */
export async function grantDefaultProjectPermissions(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    userId: string,
  }
) {
  const config = options.tenancy.config;

  for (const permissionId of Object.keys(config.rbac.defaultPermissions.signUp)) {
    await grantProjectPermission(tx, {
      tenancy: options.tenancy,
      userId: options.userId,
      permissionId: permissionId,
    });
  }

  return {
    grantedPermissionIds: Object.keys(config.rbac.defaultPermissions.signUp),
  };
}

/**
 * Grants default team permissions to a user
 * This function should be called when a new user is created
 */
export async function grantDefaultTeamPermissions(
  tx: PrismaTransaction,
  options: {
    tenancy: Tenancy,
    userId: string,
    teamId: string,
    type: "creator" | "member",
  }
) {
  const config = options.tenancy.config;

  const defaultPermissions = config.rbac.defaultPermissions[options.type === "creator" ? "teamCreator" : "teamMember"];

  for (const permissionId of Object.keys(defaultPermissions)) {
    await grantTeamPermission(tx, {
      tenancy: options.tenancy,
      teamId: options.teamId,
      userId: options.userId,
      permissionId: permissionId,
    });
  }

  return {
    grantedPermissionIds: Object.keys(defaultPermissions),
  };
}

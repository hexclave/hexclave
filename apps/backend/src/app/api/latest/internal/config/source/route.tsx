import { buildUpdatedFieldsAuditMetadata, recordAuditEvent } from "@/lib/audit-log";
import { getBranchConfigOverrideSource, unlinkBranchConfigOverrideSource } from "@/lib/config";
import { createSmartRouteHandler } from "@/route-handlers/smart-route-handler";
import { adaptSchema, adminAuthTypeSchema, branchConfigSourceSchema, yupNumber, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";

/**
 * Flatten a config source into auditable primitive fields.
 * GitHub sources include repo identity; secrets never appear on this object.
 */
function configSourceAuditFields(source: {
  type: string,
  owner?: string,
  repo?: string,
  branch?: string,
  commit_hash?: string,
  config_file_path?: string,
  workflow_path?: string,
}): Record<string, unknown> {
  switch (source.type) {
    case "pushed-from-github": {
      return {
        type: source.type,
        owner: source.owner,
        repo: source.repo,
        branch: source.branch,
        commit_hash: source.commit_hash,
        config_file_path: source.config_file_path,
        ...(source.workflow_path != null ? { workflow_path: source.workflow_path } : {}),
      };
    }
    case "pushed-from-unknown": {
      return { type: source.type };
    }
    case "unlinked": {
      return { type: source.type };
    }
    default: {
      return { type: source.type };
    }
  }
}

export const GET = createSmartRouteHandler({
  metadata: {
    summary: 'Get pushed config source',
    description: 'Get the source metadata for the pushed config (where it was pushed from)',
    tags: ['Config'],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema,
      tenancy: adaptSchema,
      adminUser: adaptSchema.optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["json"]).defined(),
    body: yupObject({
      source: branchConfigSourceSchema.defined(),
    }).defined(),
  }),
  handler: async (req) => {
    const source = await getBranchConfigOverrideSource({
      projectId: req.auth.tenancy.project.id,
      branchId: req.auth.tenancy.branchId,
    });

    return {
      statusCode: 200,
      bodyType: "json",
      body: {
        source,
      },
    };
  },
});

export const DELETE = createSmartRouteHandler({
  metadata: {
    summary: 'Unlink pushed config source',
    description: 'Set the pushed config source to unlinked, allowing direct dashboard editing',
    tags: ['Config'],
    hidden: true,
  },
  request: yupObject({
    auth: yupObject({
      type: adminAuthTypeSchema,
      tenancy: adaptSchema,
      adminUser: adaptSchema.optional(),
    }).defined(),
  }),
  response: yupObject({
    statusCode: yupNumber().oneOf([200]).defined(),
    bodyType: yupString().oneOf(["success"]).defined(),
  }),
  handler: async (req) => {
    const { didUnlink, beforeSource } = await unlinkBranchConfigOverrideSource({
      projectId: req.auth.tenancy.project.id,
      branchId: req.auth.tenancy.branchId,
    });

    // Already-unlinked DELETE is a no-op for operators; skip a duplicate audit row.
    if (didUnlink) {
      const beforeFields = configSourceAuditFields(beforeSource);
      // Null out prior identity fields so details show owner/repo/branch as Removed,
      // not just `type: pushed-from-github → unlinked`.
      const afterFields: Record<string, unknown> = { type: "unlinked" };
      for (const key of Object.keys(beforeFields)) {
        if (key !== "type") {
          afterFields[key] = null;
        }
      }
      const metadata = buildUpdatedFieldsAuditMetadata({
        source: "config.source.delete",
        patch: afterFields,
        beforeRoot: beforeFields,
        afterRoot: afterFields,
      }) ?? {
          source: "config.source.delete",
          previous_source_type: beforeSource.type,
        };
      await recordAuditEvent({
        tenancy: req.auth.tenancy,
        auth: req.auth,
        action: "config_source.unlinked",
        metadata,
      });
    }

    return {
      statusCode: 200,
      bodyType: "success",
    };
  },
});

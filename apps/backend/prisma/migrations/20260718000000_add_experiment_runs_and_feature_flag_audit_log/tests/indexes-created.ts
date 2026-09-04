import type { Sql } from "postgres";
import { expect } from "vitest";

export const postMigration = async (sql: Sql) => {
  const indexes = await sql`
    SELECT
      index_relation.relname AS index_name,
      pg_get_indexdef(index_relation.oid) AS indexdef,
      index_metadata.indisvalid,
      index_metadata.indisready,
      index_metadata.indisunique
    FROM pg_index index_metadata
    JOIN pg_class index_relation ON index_relation.oid = index_metadata.indexrelid
    JOIN pg_class table_relation ON table_relation.oid = index_metadata.indrelid
    JOIN pg_namespace table_namespace ON table_namespace.oid = table_relation.relnamespace
    WHERE table_namespace.nspname = current_schema()
      AND table_relation.relname IN ('ExperimentRun', 'FeatureFlagExposureReceipt')
  `;
  const byName = new Map(indexes.map((row) => [row.index_name as string, row]));

  const activeKey = byName.get('ExperimentRun_active_run_key');
  expect(activeKey).toBeDefined();
  expect(activeKey).toMatchObject({ indisvalid: true, indisready: true, indisunique: true });
  expect(activeKey!.indexdef).toContain(`WHERE (state = ANY (ARRAY['RUNNING'::"ExperimentRunState", 'PAUSED'::"ExperimentRunState"]))`);
  expect(activeKey!.indexdef).toContain('("projectId", "branchId", "experimentId")');

  const activeFlagKey = byName.get('ExperimentRun_active_flag_key');
  expect(activeFlagKey).toBeDefined();
  expect(activeFlagKey).toMatchObject({ indisvalid: true, indisready: true, indisunique: true });
  expect(activeFlagKey!.indexdef).toContain(`WHERE (state = ANY (ARRAY['RUNNING'::"ExperimentRunState", 'PAUSED'::"ExperimentRunState"]))`);
  expect(activeFlagKey!.indexdef).toContain('("projectId", "branchId"');
  expect(activeFlagKey!.indexdef).toContain(`"configSnapshot" ->> 'flag_id'::text`);

  for (const name of [
    'ExperimentRun_project_experiment_createdAt_idx',
    'ExperimentRun_state_scheduledStartAt_idx',
    'ExperimentRun_state_scheduledEndAt_idx',
    'ExperimentRun_schedule_start_rotation_idx',
    'ExperimentRun_schedule_end_rotation_idx',
    'FeatureFlagExposureReceipt_project_event_key',
    'FeatureFlagExposureReceipt_project_evaluation_key',
    'FeatureFlagExposureReceipt_ingestionNonce_idx',
    'FeatureFlagExposureReceipt_processingStartedAt_idx',
    'FeatureFlagExposureReceipt_createdAt_idx',
    'FeatureFlagExposureReceipt_project_createdAt_idx',
  ]) {
    const index = byName.get(name);
    expect(index, `expected index ${name} to exist`).toBeDefined();
    expect(index).toMatchObject({ indisvalid: true, indisready: true });
  }
};

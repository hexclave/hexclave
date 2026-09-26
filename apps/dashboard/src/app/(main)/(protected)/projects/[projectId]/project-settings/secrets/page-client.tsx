"use client";

// The project's write-only secret store. Deployments are its only consumer
// today: `secret()` env vars in the deploy file's `services` export are filled
// from these at deploy time (the `prod` value, else `all`), and `hexclave dev`
// pulls the `dev` value, else `all`. Values can be set, overwritten, and
// deleted here, but never read back — the API doesn't return them, so this
// page only shows which (key, environment) cells have a value.
//
// One list row per stored (key, environment). "Add" writes either the `all`
// cell or a chosen subset of prod/preview/dev — the same value written to each
// selected cell as its own row, so each can later be edited or deleted alone.
//
// Deliberately ONE state per row. An earlier version also listed keys that the
// synced service definitions referenced but that had no value yet, badged
// "Missing" / "Using default" / "Set". That leaked config-file concepts into
// this page and made its answer to "is this secret set?" a three-way one. A
// missing secret is surfaced where it matters instead: the deployments panel
// badges it, and `hexclave deploy` fails naming every key that needs a value.

import { DesignAlert, DesignBadge, DesignButton, DesignCard, DesignEmptyState, DesignMenu, DesignPillToggle } from "@/components/design-components";
import { FormDialog } from "@/components/form-dialog";
import { CheckboxField, InputField } from "@/components/form-fields";
import { ActionDialog, Spinner, Typography } from "@/components/ui";
import type { DesignBadgeColor } from "@hexclave/dashboard-ui-components";
import { PROJECT_SECRET_ENVIRONMENTS, PROJECT_SECRET_KEY_REGEX, type ProjectSecretEnvironment } from "@hexclave/shared/dist/project-secrets";
import { yupString } from "@hexclave/shared/dist/schema-fields";
import { throwErr } from "@hexclave/shared/dist/utils/errors";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { KeyIcon } from "@phosphor-icons/react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as yup from "yup";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";

type SecretItem = {
  key: string,
  environment: ProjectSecretEnvironment,
  updatedAtMillis: number,
};

const SPECIFIC_ENVIRONMENTS = ["prod", "preview", "dev"] as const;

const ENVIRONMENT_LABELS = new Map<ProjectSecretEnvironment, string>([
  ["all", "All"],
  ["prod", "Production"],
  ["preview", "Preview"],
  ["dev", "Development"],
]);

const ENVIRONMENT_BADGE_COLORS = new Map<ProjectSecretEnvironment, DesignBadgeColor>([
  ["all", "orange"],
  ["prod", "green"],
  ["preview", "purple"],
  ["dev", "cyan"],
]);

function environmentLabel(environment: ProjectSecretEnvironment): string {
  return ENVIRONMENT_LABELS.get(environment) ?? throwErr(`No label for secret environment ${JSON.stringify(environment)}; ENVIRONMENT_LABELS must cover PROJECT_SECRET_ENVIRONMENTS`);
}

function environmentBadgeColor(environment: ProjectSecretEnvironment): DesignBadgeColor {
  return ENVIRONMENT_BADGE_COLORS.get(environment) ?? throwErr(`No badge color for secret environment ${JSON.stringify(environment)}; ENVIRONMENT_BADGE_COLORS must cover PROJECT_SECRET_ENVIRONMENTS`);
}

function secretCellId(key: string, environment: ProjectSecretEnvironment): string {
  return `${key}\0${environment}`;
}

function sortSecretItems(items: SecretItem[]): SecretItem[] {
  return [...items].sort((a, b) => {
    const byKey = stringCompare(a.key, b.key);
    if (byKey !== 0) return byKey;
    return PROJECT_SECRET_ENVIRONMENTS.indexOf(a.environment) - PROJECT_SECRET_ENVIRONMENTS.indexOf(b.environment);
  });
}

function formatUpdatedAt(millis: number): string {
  return new Date(millis).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// The concrete environments that resolve to a value for `key` now but would
// resolve to nothing once `deleted` is removed. Resolution is the exact
// environment, else `all` — the same rule the backend and CLI apply — so
// deleting `prod` while an `all` value exists loses nothing (prod falls back).
export function environmentsLosingValue(items: SecretItem[], deleted: { key: string, environment: ProjectSecretEnvironment }): ProjectSecretEnvironment[] {
  const before = new Set(items.filter((item) => item.key === deleted.key).map((item) => item.environment));
  const after = new Set(before);
  after.delete(deleted.environment);
  const resolves = (stored: Set<ProjectSecretEnvironment>, environment: ProjectSecretEnvironment) => stored.has(environment) || stored.has("all");
  return SPECIFIC_ENVIRONMENTS.filter((environment) => resolves(before, environment) && !resolves(after, environment));
}

type AddSecretFormValues = {
  key: string,
  value: string,
  scope: "all" | "specific",
  prod: boolean,
  preview: boolean,
  dev: boolean,
};

function selectedEnvironments(values: AddSecretFormValues): ProjectSecretEnvironment[] {
  if (values.scope === "all") return ["all"];
  return SPECIFIC_ENVIRONMENTS.filter((environment) => values[environment]);
}

export function createAddSecretFormSchema(occupied: ReadonlySet<string>) {
  return yup.object({
    key: yupString()
      .defined()
      .nonEmpty("Enter a secret key")
      .matches(PROJECT_SECRET_KEY_REGEX, "Secret keys must contain only letters, numbers, underscores, and hyphens"),
    value: yupString().defined().nonEmpty("Enter a value"),
    scope: yupString().oneOf(["all", "specific"]).defined(),
    prod: yup.boolean().defined(),
    preview: yup.boolean().defined(),
    dev: yup.boolean().defined(),
  }).test("at-least-one-environment", function (value) {
    if (selectedEnvironments(value).length > 0) return true;
    return this.createError({
      path: "prod",
      message: "Select at least one environment.",
    });
  }).test("unique-key-environment", function (value) {
    // Add must not silently overwrite: the value can't be read back, so an
    // accidental overwrite is unrecoverable. Overwriting goes through a row's
    // Edit, which names exactly one (key, environment) cell.
    const conflicts = selectedEnvironments(value).filter((environment) => occupied.has(secretCellId(value.key, environment)));
    if (conflicts.length === 0) return true;
    return this.createError({
      path: "key",
      message: `A secret named ${JSON.stringify(value.key)} already exists for ${conflicts.map(environmentLabel).join(", ")}. Use Edit on that row to replace it.`,
    });
  });
}

function AddSecretDialog(props: {
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
  trigger?: React.ReactNode,
  occupied: ReadonlySet<string>,
  onDone: () => Promise<void>,
}) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const formSchema = useMemo(() => createAddSecretFormSchema(props.occupied), [props.occupied]);

  return <FormDialog
    open={props.open}
    onOpenChange={props.onOpenChange}
    trigger={props.trigger}
    title="Add Secret"
    formSchema={formSchema}
    defaultValues={{
      key: "",
      value: "",
      scope: "all",
      prod: false,
      preview: false,
      dev: false,
    }}
    okButton={{ label: "Save" }}
    onSubmit={async (values) => {
      // One write per environment; there is no batch endpoint. If a later
      // write fails, the earlier ones are already stored, so the list is
      // refreshed either way — otherwise those rows stay invisible until the
      // next reload. A retry of the same form isn't blocked by them: the
      // uniqueness check reads `occupied` from the list as it was, and the
      // server upserts.
      try {
        for (const environment of selectedEnvironments(values)) {
          await project.setProjectSecret(values.key, values.value, environment);
        }
      } finally {
        await props.onDone();
      }
    }}
    render={(form) => {
      const scope = form.watch("scope");
      return (
        <>
          <DesignAlert
            variant="info"
            description="Secret values are write-only: once saved, they can be replaced or deleted, but never viewed again. A value for a specific environment takes precedence over the All value."
          />
          <InputField
            label="Key"
            name="key"
            control={form.control}
            placeholder="e.g. OPENAI_API_KEY"
          />
          <InputField
            label="Value"
            name="value"
            control={form.control}
            type="password"
            placeholder="Secret value"
            autoComplete="off"
          />
          <div className="space-y-2">
            <Typography variant="secondary" className="text-sm">Environments</Typography>
            <DesignPillToggle
              size="sm"
              options={[
                { id: "all", label: "All environments" },
                { id: "specific", label: "Specific" },
              ]}
              selected={scope}
              onSelect={(id) => {
                if (id !== "all" && id !== "specific") throw new Error(`Unknown secret scope option ${JSON.stringify(id)}`);
                form.setValue("scope", id, { shouldValidate: true });
              }}
            />
            {scope === "specific" && (
              <>
                {SPECIFIC_ENVIRONMENTS.map((environment) => (
                  <CheckboxField key={environment} label={environmentLabel(environment)} name={environment} control={form.control} />
                ))}
              </>
            )}
          </div>
        </>
      );
    }}
  />;
}

function EditSecretDialog(props: {
  item: SecretItem,
  open: boolean,
  onOpenChange: (open: boolean) => void,
  onDone: () => Promise<void>,
}) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();

  return <FormDialog
    open={props.open}
    onOpenChange={props.onOpenChange}
    title="Edit Secret"
    formSchema={yup.object({
      value: yupString().defined().nonEmpty("Enter a value"),
    })}
    defaultValues={{ value: "" }}
    okButton={{ label: "Save" }}
    onSubmit={async (values) => {
      await project.setProjectSecret(props.item.key, values.value, props.item.environment);
      await props.onDone();
    }}
    render={(form) => (
      <>
        <div className="space-y-1">
          <Typography variant="secondary" className="text-sm">Key</Typography>
          <div className="font-mono text-sm">{props.item.key}</div>
        </div>
        <div className="space-y-1">
          <Typography variant="secondary" className="text-sm">Environment</Typography>
          <DesignBadge
            label={environmentLabel(props.item.environment)}
            color={environmentBadgeColor(props.item.environment)}
            size="sm"
          />
        </div>
        <InputField
          label="Value"
          name="value"
          control={form.control}
          type="password"
          placeholder="Enter a new value — the current value cannot be shown"
          autoComplete="off"
        />
      </>
    )}
  />;
}

function DeleteSecretDialog(props: {
  item: SecretItem,
  items: SecretItem[],
  onOpenChange: (open: boolean) => void,
  onDone: () => Promise<void>,
}) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const losing = environmentsLosingValue(props.items, props.item);
  const environment = environmentLabel(props.item.environment);

  return (
    <ActionDialog
      open
      onOpenChange={props.onOpenChange}
      title="Delete Secret"
      danger
      okButton={{
        label: "Delete",
        onClick: async () => {
          await project.deleteProjectSecret(props.item.key, props.item.environment);
          await props.onDone();
        },
      }}
      cancelButton
    >
      <div className="space-y-2">
        <Typography>
          Delete the {environment} value of <span className="font-mono">{props.item.key}</span>? It can never be viewed or recovered.
        </Typography>
        {losing.length === 0 ? (
          props.item.environment !== "all" && (
            <Typography variant="secondary" className="text-sm">
              {environment} will fall back to the All value.
            </Typography>
          )
        ) : (
          <Typography variant="secondary" className="text-sm">
            {losing.map(environmentLabel).join(", ")} will have no value for this secret
            {losing.includes("prod") ? ", so deploys of services that use it will fail until it is set again." : "."}
          </Typography>
        )}
      </div>
    </ActionDialog>
  );
}

function SecretRow(props: {
  item: SecretItem,
  onEdit: () => void,
  onDelete: () => void,
}) {
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm">{props.item.key}</div>
        <Typography variant="secondary" className="text-xs">Updated {formatUpdatedAt(props.item.updatedAtMillis)}</Typography>
      </div>
      <DesignBadge
        label={environmentLabel(props.item.environment)}
        color={environmentBadgeColor(props.item.environment)}
        size="sm"
      />
      <DesignMenu
        variant="actions"
        trigger="icon"
        triggerLabel={`Actions for ${props.item.key} (${environmentLabel(props.item.environment)})`}
        align="end"
        items={[
          { id: "edit", label: "Edit", onClick: props.onEdit },
          { id: "delete", label: "Delete", itemVariant: "destructive", onClick: props.onDelete },
        ]}
      />
    </div>
  );
}

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const searchParams = useSearchParams();
  const addSecret = searchParams.get("addSecret") === "true";

  const [items, setItems] = useState<SecretItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isAddSecretDialogOpen, setIsAddSecretDialogOpen] = useState(addSecret);
  const [editItem, setEditItem] = useState<SecretItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<SecretItem | null>(null);
  // Refreshes race: every add / edit / delete triggers one, they can overlap,
  // and this page has no periodic poll to self-correct — so a superseded
  // response writing its stale snapshot last would make a just-added secret
  // vanish until the next user action. Only the NEWEST refresh may write state.
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const storedSecrets = await project.listProjectSecrets();
      if (sequence !== refreshSequenceRef.current) return;
      setItems(storedSecrets.map((secret) => ({
        key: secret.key,
        environment: secret.environment,
        updatedAtMillis: secret.updated_at_millis,
      })));
      setLoadError(null);
    } catch (error) {
      if (sequence !== refreshSequenceRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [project]);

  useEffect(() => {
    runAsynchronouslyWithAlert(refresh());
  }, [refresh]);

  const rows = useMemo(() => items == null ? null : sortSecretItems(items), [items]);

  const occupied = useMemo(() => new Set((items ?? []).map((item) => secretCellId(item.key, item.environment))), [items]);

  return (
    <PageLayout
      title="Secrets"
      description="Write-only values for secret() env vars in hexclave.deploy.ts."
      actions={
        // Gated on the list: the Add form's "already exists" check reads
        // `occupied`, which is empty until the first load lands — submitting
        // before then would silently overwrite existing values (the server
        // upserts). `?addSecret=true` waits for the load for the same reason.
        <AddSecretDialog
          open={isAddSecretDialogOpen && items != null}
          onOpenChange={setIsAddSecretDialogOpen}
          occupied={occupied}
          trigger={<DesignButton disabled={items == null}>Add Secret</DesignButton>}
          onDone={refresh}
        />
      }
    >
      <DesignCard title="Project Secrets" icon={KeyIcon}>
        {loadError != null && (
          // A retry here, not just the alert: Add stays disabled until a load
          // succeeds (see the gate on AddSecretDialog), so without it a failed
          // first load would leave a page reload as the only way forward.
          <div className="space-y-3">
            <DesignAlert variant="error" description={`Failed to load secrets: ${loadError}`} />
            <DesignButton variant="outline" size="sm" onClick={refresh}>Retry</DesignButton>
          </div>
        )}
        {rows == null && loadError == null && (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        )}
        {rows != null && rows.length === 0 && loadError == null && (
          <DesignEmptyState
            icon={KeyIcon}
            title="No secrets yet"
            description="Add a value for every secret() key in your deploy file."
          />
        )}
        {rows != null && rows.length > 0 && (
          <div className="divide-y divide-border/60">
            {rows.map((item) => (
              <SecretRow
                key={secretCellId(item.key, item.environment)}
                item={item}
                onEdit={() => setEditItem(item)}
                onDelete={() => setDeleteItem(item)}
              />
            ))}
          </div>
        )}
      </DesignCard>
      {editItem != null && (
        <EditSecretDialog
          key={`edit-${secretCellId(editItem.key, editItem.environment)}`}
          item={editItem}
          open
          onOpenChange={(open) => {
            if (!open) setEditItem(null);
          }}
          onDone={refresh}
        />
      )}
      {deleteItem != null && items != null && (
        <DeleteSecretDialog
          key={`delete-${secretCellId(deleteItem.key, deleteItem.environment)}`}
          item={deleteItem}
          items={items}
          onOpenChange={(open) => {
            if (!open) setDeleteItem(null);
          }}
          onDone={refresh}
        />
      )}
    </PageLayout>
  );
}

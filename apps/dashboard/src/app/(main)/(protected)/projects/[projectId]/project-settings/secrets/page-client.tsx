"use client";

// The project's write-only secret store. Deployments are its only consumer
// today: `secret()` env vars in the deploy file's `services` export are filled
// from these at deploy time. Values can be set, overwritten, and deleted here,
// but never read back — the API doesn't return them, so this page only shows
// which keys have a value.
//
// Deliberately ONE state per row. An earlier version also listed keys that the
// synced service definitions referenced but that had no value yet, badged
// "Missing" / "Using default" / "Set". That leaked two config-file concepts
// into the dashboard (which services reference a key, and whether the config
// gave it a `secret(key, default)` fallback) and made the page's answer to
// "is this secret set?" a three-way one. A missing secret is now surfaced
// where it actually matters — `hexclave deploy` fails and names every key that
// needs a value here.

import { DesignAlert } from "@/components/design-components";
import { FormDialog } from "@/components/form-dialog";
import { InputField } from "@/components/form-fields";
import { SettingCard } from "@/components/settings";
import { ActionCell, ActionDialog, Button, Spinner, Typography } from "@/components/ui";
import { PROJECT_SECRET_KEY_REGEX } from "@hexclave/shared/dist/project-secrets";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { yupString } from "@hexclave/shared/dist/schema-fields";
import { stringCompare } from "@hexclave/shared/dist/utils/strings";
import { useCallback, useEffect, useRef, useState } from "react";
import * as yup from "yup";
import { PageLayout } from "../../page-layout";
import { useAdminApp } from "../../use-admin-app";

type SecretRow = {
  key: string,
  updatedAtMillis: number,
};

function SetSecretDialog(props: {
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
  trigger?: React.ReactNode,
  // Set when overwriting an existing key; the key field is fixed then.
  fixedKey?: string,
  onDone: () => Promise<void>,
}) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();

  const formSchema = yup.object({
    key: yupString()
      .defined()
      .nonEmpty("Enter a secret key")
      .matches(PROJECT_SECRET_KEY_REGEX, "Secret keys must contain only letters, numbers, underscores, and hyphens"),
    value: yupString().defined().nonEmpty("Enter a value"),
  });

  const isOverwrite = props.fixedKey != null;
  return <FormDialog
    open={props.open}
    onOpenChange={props.onOpenChange}
    trigger={props.trigger}
    title={isOverwrite ? `Overwrite ${props.fixedKey}` : "Set secret"}
    formSchema={formSchema}
    defaultValues={{ key: props.fixedKey ?? "", value: "" }}
    okButton={{ label: isOverwrite ? "Overwrite" : "Set secret" }}
    onSubmit={async (values) => {
      await project.setProjectSecret(values.key, values.value);
      await props.onDone();
    }}
    render={(form) => (
      <>
        <DesignAlert variant="info" description="Secret values are write-only: once set, they can be overwritten or deleted, but never viewed again. They are read server-side at deploy time to fill secret() env vars." />
        <InputField
          label="Key"
          name="key"
          control={form.control}
          placeholder="e.g. OPENAI_API_KEY"
          disabled={isOverwrite}
        />
        <InputField
          label="Value"
          name="value"
          control={form.control}
          type="password"
          placeholder="Secret value"
          autoComplete="off"
        />
      </>
    )}
  />;
}

function SecretActionMenu({ secret, refresh }: {
  secret: SecretRow,
  refresh: () => Promise<void>,
}) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const [isSetOpen, setIsSetOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);

  return (
    <>
      <SetSecretDialog
        open={isSetOpen}
        onOpenChange={setIsSetOpen}
        fixedKey={secret.key}
        onDone={refresh}
      />
      <ActionDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        title="Delete secret"
        danger
        okButton={{
          label: "Delete",
          onClick: async () => {
            await project.deleteProjectSecret(secret.key);
            await refresh();
          },
        }}
        cancelButton
      >
        <Typography>
          Do you really want to delete the value of <b>{secret.key}</b>? Deploys of services whose config references
          it will fail until it is set again, and the value can never be viewed or recovered.
        </Typography>
      </ActionDialog>
      <ActionCell
        items={[
          { item: "Overwrite value", onClick: () => setIsSetOpen(true) },
          "-",
          { item: "Delete", onClick: () => setIsDeleteOpen(true), danger: true },
        ]}
      />
    </>
  );
}

function formatUpdatedAt(millis: number): string {
  return new Date(millis).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();

  const [rows, setRows] = useState<SecretRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Refreshes race: the "Set secret" button is usable while the slow
  // mount-time load is still in flight, and this page has no periodic poll to
  // self-correct — so a superseded response writing its stale snapshot last
  // would make a just-set secret vanish until the next user action. Only the
  // NEWEST refresh may write state.
  const refreshSequenceRef = useRef(0);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    try {
      const storedSecrets = await project.listProjectSecrets();
      if (sequence !== refreshSequenceRef.current) return;
      setRows(storedSecrets
        .map((secret) => ({ key: secret.key, updatedAtMillis: secret.updated_at_millis }))
        .sort((a, b) => stringCompare(a.key, b.key)));
      setLoadError(null);
    } catch (error) {
      if (sequence !== refreshSequenceRef.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [project]);

  useEffect(() => {
    runAsynchronouslyWithAlert(refresh());
  }, [refresh]);

  return (
    <PageLayout
      title="Secrets"
      description="Write-only values for the secret() env vars of your deployment services. Read at deploy time; never shown again after being set."
    >
      <SettingCard
        title="Project secrets"
        actions={
          <SetSecretDialog
            trigger={<Button>Set secret</Button>}
            onDone={refresh}
          />
        }
      >
        {loadError != null && <DesignAlert variant="error" description={`Failed to load secrets: ${loadError}`} />}
        {rows == null && loadError == null && (
          <div className="flex h-24 items-center justify-center">
            <Spinner />
          </div>
        )}
        {rows != null && rows.length === 0 && (
          <DesignAlert variant="info" description="No secrets set. Set a value for every secret() key used by the deploy export of your hexclave.deploy.ts — hexclave deploy fails and lists any that are still missing." />
        )}
        {rows != null && rows.length > 0 && (
          <div className="divide-y divide-border/60">
            {rows.map((row) => (
              <div key={row.key} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm text-foreground">{row.key}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    Last updated {formatUpdatedAt(row.updatedAtMillis)}
                  </div>
                </div>
                <SecretActionMenu secret={row} refresh={refresh} />
              </div>
            ))}
          </div>
        )}
      </SettingCard>
    </PageLayout>
  );
}

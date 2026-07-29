"use client";
import { InternalApiKeyTable } from "@/components/data-table/api-key-table";
import { DesignAlert, DesignButton, DesignCard } from "@/components/design-components";
import { EnvKeys } from "@/components/env-keys";
import { SmartFormDialog } from "@/components/form-dialog";
import { SelectField } from "@/components/form-fields";
import { InlineCode } from "@/components/inline-code";
import { SettingSwitch } from "@/components/settings";
import { ActionDialog, Typography } from "@/components/ui";
import { getPublicEnvVar } from "@/lib/env";
import { InternalApiKeyFirstView } from "@hexclave/next";
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import * as yup from "yup";
import { PageLayout } from "../page-layout";
import { useAdminApp } from "../use-admin-app";


export default function PageClient() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const params = useSearchParams();
  const create = params.get("create") === "true";
  const isRemoteDevelopmentEnvironment = getPublicEnvVar("NEXT_PUBLIC_STACK_IS_REMOTE_DEVELOPMENT_ENVIRONMENT") === "true";
  const showLocalConfigInstructions = isRemoteDevelopmentEnvironment && project.isDevelopmentEnvironment;

  if (showLocalConfigInstructions) {
    return (
      <PageLayout>
        <LocalConfigProjectKeysInstructions />
      </PageLayout>
    );
  }

  return <ProjectKeysManagement create={create} />;
}

function ProjectKeysManagement(props: { create: boolean }) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const requirePublishableClientKey = config.project.requirePublishableClientKey;
  const apiKeySets = hexclaveAdminApp.useInternalApiKeys();

  const [isNewApiKeyDialogOpen, setIsNewApiKeyDialogOpen] = useState(props.create);
  const [returnedApiKey, setReturnedApiKey] = useState<InternalApiKeyFirstView | null>(null);

  return (
    <PageLayout
      actions={
        <DesignButton onClick={() => setIsNewApiKeyDialogOpen(true)}>
          Create Project Keys
        </DesignButton>
      }
    >
      <InternalApiKeyTable
        apiKeys={apiKeySets}
        showPublishableClientKey={requirePublishableClientKey}
      />

      <SettingSwitch
        label="[Advanced] Require publishable client keys"
        hint="When enabled, client requests must include a publishable client key."
        checked={requirePublishableClientKey}
        onCheckedChange={async (checked) => {
          await project.update({
            requirePublishableClientKey: checked,
          });
        }}
      />

      <CreateDialog
        open={isNewApiKeyDialogOpen}
        onOpenChange={setIsNewApiKeyDialogOpen}
        onKeyCreated={setReturnedApiKey}
        requirePublishableClientKey={requirePublishableClientKey}
      />
      <ShowKeyDialog
        apiKey={returnedApiKey || undefined}
        onClose={() => setReturnedApiKey(null)}
      />

    </PageLayout>
  );
}

function LocalConfigProjectKeysInstructions() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const requirePublishableClientKey = config.project.requirePublishableClientKey;

  return (
    <>
      <DesignCard glassmorphic contentClassName="space-y-5">
        <DesignAlert
          variant="info"
          title="Project keys are managed by the Hexclave CLI for local configs"
          description="Local config projects do not create project keys from the dashboard. The CLI starts the dashboard, creates or links the local project, and injects the project ID and secret server key into your app process."
        />

        <div className="space-y-3">
          <Typography>
            Run your app through the CLI so Hexclave can keep <InlineCode>hexclave.config.ts</InlineCode> and your app environment in sync:
          </Typography>
          <div className="overflow-x-auto rounded-xl border border-border bg-foreground/[0.03] p-4 font-mono text-sm">
            npx @hexclave/cli dev --config-file &lt;path-to-hexclave.config.ts&gt; -- &lt;your-dev-command&gt;
          </div>
          <Typography>
            This will automatically provide the correct environment variables to the specified command.
          </Typography>
          <Typography>
            If you have the CLI installed globally, the same command starts with <InlineCode>hexclave dev</InlineCode>. Keep project settings in the config file; the CLI provides the runtime keys automatically.
          </Typography>
        </div>
      </DesignCard>

      <SettingSwitch
        label="[Advanced] Require publishable client keys"
        hint="When enabled, client requests must include a publishable client key."
        checked={requirePublishableClientKey}
        onCheckedChange={async (checked) => {
          await project.update({
            requirePublishableClientKey: checked,
          });
        }}
      />
    </>
  );
}

const neverInMs = 1000 * 60 * 60 * 24 * 365 * 200;
const expiresInOptions = {
  [1000 * 60 * 60 * 24 * 1]: "1 day",
  [1000 * 60 * 60 * 24 * 7]: "7 days",
  [1000 * 60 * 60 * 24 * 30]: "30 days",
  [1000 * 60 * 60 * 24 * 90]: "90 days",
  [1000 * 60 * 60 * 24 * 365]: "1 year",
  [neverInMs]: "Never",
} as const;

function CreateDialog(props: {
  open: boolean,
  onOpenChange: (open: boolean) => void,
  onKeyCreated?: (key: InternalApiKeyFirstView) => void,
  requirePublishableClientKey: boolean,
}) {
  const hexclaveAdminApp = useAdminApp();
  const params = useSearchParams();
  const defaultDescription = params.get("description");

  const formSchema = yup.object({
    description: yup.string().defined().label("Description").default(defaultDescription || ""),
    expiresIn: yup.string().default(neverInMs.toString()).label("Expires in").meta({
      stackFormFieldRender: (props) => (
        <SelectField {...props} options={Object.entries(expiresInOptions).map(([value, label]) => ({ value, label }))} />
      )
    }),
  });

  return <SmartFormDialog
    open={props.open}
    onOpenChange={props.onOpenChange}
    title="Create Project Keys"
    formSchema={formSchema}
    okButton={{ label: "Create" }}
    onSubmit={async (values) => {
      const expiresIn = parseInt(values.expiresIn);
      const newKey = await hexclaveAdminApp.createInternalApiKey({
        hasPublishableClientKey: props.requirePublishableClientKey,
        hasSecretServerKey: true,
        hasSuperSecretAdminKey: false,
        expiresAt: new Date(Date.now() + expiresIn),
        description: values.description,
      });
      props.onKeyCreated?.(newKey);
    }}
    cancelButton
  />;
}

function ShowKeyDialog(props: {
  apiKey?: InternalApiKeyFirstView,
  onClose?: () => void,
}) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  if (!props.apiKey) return null;


  return (
    <ActionDialog
      open={!!props.apiKey}
      title="Project Keys"
      okButton={{ label: "Close" }}
      onClose={props.onClose}
      preventClose
      confirmText="I understand that I will not be able to view these keys again."
    >
      <div className="flex flex-col gap-4">
        <DesignAlert
          variant="warning"
          description={<>
            Here are your project keys.{" "}
            <span className="font-bold text-foreground/90">
              Copy them to a safe place. You will not be able to view them again.
            </span>
          </>}
        />
        <EnvKeys
          projectId={project.id}
          publishableClientKey={props.apiKey.publishableClientKey}
          secretServerKey={props.apiKey.secretServerKey}
        />
      </div>
    </ActionDialog>
  );
}

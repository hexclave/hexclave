"use client";

import { InlineSaveDiscard } from "@/components/inline-save-discard";
import { ActionDialog, BrandIcons, BrowserFrame, FormControl, FormField, FormItem, FormLabel, FormMessage, InlineCode, Label, SimpleTooltip, Switch, Typography } from "@/components/ui";
import { FormDialog } from "@/components/form-dialog";
import { HostedAuthMethodPreview } from "@/components/hosted-auth-preview";
import { useUpdateConfig } from "@/components/config-update";
import { useDashboardInternalUser } from "@/lib/dashboard-user";
import {
  DesignAlert,
  DesignBadge,
  DesignButton,
  DesignCard,
  DesignCardTint,
  DesignInput,
} from "@hexclave/dashboard-ui-components";
import { DesignMenu, type DesignMenuActionItem } from "@/components/design-components/menu";
import { DesignSelectorDropdown } from "@/components/design-components/select";
import {
  AsteriskIcon,
  EnvelopeSimpleIcon,
  EyeIcon,
  GearSixIcon,
  GlobeIcon,
  KeyIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PlusCircleIcon,
  PowerIcon,
  SignInIcon,
  TrashIcon,
  UserCircleIcon,
  UserPlusIcon,
} from "@phosphor-icons/react";
import { AdminProject } from "@hexclave/next";
import type { CompleteConfig } from "@hexclave/shared/dist/config/schema";
import type { RestrictedReason } from "@hexclave/shared/dist/schema-fields";
import { urlSchema, yupObject, yupString } from "@hexclave/shared/dist/schema-fields";
import { runAsynchronouslyWithAlert } from "@hexclave/shared/dist/utils/promises";
import { captureError, HexclaveAssertionError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { allProviders } from "@hexclave/shared/dist/utils/oauth";
import { typedFromEntries, typedEntries } from "@hexclave/shared/dist/utils/objects";
import { resolvePlanId } from "@hexclave/shared/dist/plans";
import { generateUuid } from "@hexclave/shared/dist/utils/uuids";
import { ErrorBoundary } from "next/dist/client/components/error-boundary";
import { Suspense, useEffect, useId, useMemo, useState } from "react";
import { Link } from "@/components/link";
import { AppEnabledGuard } from "../app-enabled-guard";
import { PageLayout } from "../page-layout";
import { useAdminApp, useProjectId } from "../use-admin-app";
import { getNewProviderCallbackUrl, resolveProviderCallbackUrl } from "./oauth-callback-url";
import { ProviderIcon, ProviderSettingDialog, ProviderSettingSwitch, TurnOffProviderDialog } from "./providers";

export type AuthMethodsPageVariant = "full" | "branch" | "oauth";

type AdminOAuthProviderConfig = AdminProject['config']['oauthProviders'][number];

type OAuthAccountMergeStrategy = 'link_method' | 'raise_error' | 'allow_duplicates';

const SHARED_TOOLTIP = "Shared keys are automatically created by Stack, but show Stack's logo on the OAuth sign-in page.\n\nYou should replace these before you go into production.";

// ─── Confirmation dialogs ─────────────────────────────────────────────────

function ConfirmSignUpEnabledDialog(props: {
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
  onConfirm: () => Promise<void>,
}) {
  return (
    <ActionDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Enable sign-up"
      danger
      okButton={{
        label: "Enable Sign-up",
        onClick: props.onConfirm,
      }}
      cancelButton
    >
      <DesignAlert
        variant="warning"
        title="Anyone will be able to create an account"
        description="Enabling sign-up means new accounts can be created from your auth pages without admin approval. You can disable it again at any time."
      />
    </ActionDialog>
  );
}

function ConfirmSignUpDisabledDialog(props: {
  open?: boolean,
  onOpenChange?: (open: boolean) => void,
  onConfirm: () => Promise<void>,
}) {
  return (
    <ActionDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Disable sign-up"
      danger
      okButton={{
        label: "Disable Sign-up",
        onClick: props.onConfirm,
      }}
      cancelButton
    >
      <DesignAlert
        variant="warning"
        title="No new accounts can be created"
        description="Existing users can still sign in. Only project admins will be able to create new accounts going forward."
      />
    </ActionDialog>
  );
}

function adminProviderToConfigProvider(
  provider: AdminOAuthProviderConfig,
  existing: CompleteConfig['auth']['oauth']['providers'][string] | undefined,
): CompleteConfig['auth']['oauth']['providers'][string] {
  switch (provider.type) {
    case 'shared': {
      return {
        type: provider.id as any,
        isShared: true,
        clientId: undefined,
        clientSecret: undefined,
        // Shared providers always use Stack's shared OAuth app; customCallbackUrl
        // is forbidden by the schema for them.
        customCallbackUrl: undefined,
        facebookConfigId: undefined,
        microsoftTenantId: undefined,
        appleTeamId: undefined,
        appleKeyId: undefined,
        applePrivateKey: undefined,
        appleBundles: undefined,
        allowSignIn: true,
        allowConnectedAccounts: true,
      };
    }
    case 'standard': {
      return {
        type: provider.id as any,
        isShared: false,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        // Setting up a standard provider (brand-new, or converting shared ->
        // standard) means registering a fresh OAuth app, so it gets the
        // hexclave-branded callback URL. A provider that was already standard
        // keeps whatever it had — legacy ones without a customCallbackUrl keep
        // falling back to the stack-auth callback so edits never silently change
        // an already-registered redirect URL.
        customCallbackUrl: (existing && !existing.isShared) ? existing.customCallbackUrl : getNewProviderCallbackUrl(provider.id),
        facebookConfigId: provider.facebookConfigId,
        microsoftTenantId: provider.microsoftTenantId,
        appleTeamId: provider.appleTeamId,
        appleKeyId: provider.appleKeyId,
        applePrivateKey: provider.applePrivateKey,
        appleBundles: provider.appleBundleIds?.length
          ? typedFromEntries(provider.appleBundleIds.map((bundleId: string) => [generateUuid(), { bundleId }] as const))
          : undefined,
        allowSignIn: true,
        allowConnectedAccounts: true,
      };
    }
    case 'custom_oidc': {
      return {
        // `as any` — same pattern as standard providers above; the CompleteConfig
        // type field is the yup-inferred union which doesn't resolve cleanly
        // when @hexclave/shared dist types are unavailable at dashboard tsc time.
        type: "custom_oidc" as any,
        isShared: false,
        clientId: provider.clientId,
        clientSecret: provider.clientSecret,
        customCallbackUrl: (existing && !existing.isShared) ? existing.customCallbackUrl : getNewProviderCallbackUrl(provider.id),
        facebookConfigId: undefined,
        microsoftTenantId: undefined,
        appleTeamId: undefined,
        appleKeyId: undefined,
        applePrivateKey: undefined,
        appleBundles: undefined,
        issuerUrl: provider.issuerUrl,
        scope: provider.scope,
        displayName: provider.displayName,
        allowSignIn: true,
        allowConnectedAccounts: true,
      };
    }
    default: {
      throw new HexclaveAssertionError(`Unknown provider type: ${(provider as { type: unknown }).type}`);
    }
  }
}

// ─── Plan gating ─────────────────────────────────────────────────────────

function AddCustomOidcButton({ onClick }: { onClick: () => void }) {
  const project = useAdminApp().useProject();
  const user = useDashboardInternalUser();
  const teams = user.useTeams();
  const ownerTeam = useMemo(
    () => teams.find(t => t.id === project.ownerTeamId),
    [teams, project.ownerTeamId],
  );

  if (ownerTeam == null) {
    return <AddCustomOidcButtonDisabled onClick={onClick} isTeamPlanOrAbove={false} />;
  }

  // The plan check reads the internal project's owned products from bulldozer.
  // That gate must not break the auth-methods page if bulldozer is down: on a
  // read failure (or while it loads) we report it and fall back to the locked
  // (non-Team) state, which is the same safe default as having no owner team.
  return (
    <ErrorBoundary errorComponent={({ error }) => <AddCustomOidcButtonPlanReadFailed onClick={onClick} error={error} />}>
      <Suspense fallback={<AddCustomOidcButtonDisabled onClick={onClick} isTeamPlanOrAbove={false} />}>
        <AddCustomOidcButtonInner team={ownerTeam} onClick={onClick} />
      </Suspense>
    </ErrorBoundary>
  );
}

function AddCustomOidcButtonPlanReadFailed({ onClick, error }: { onClick: () => void, error: unknown }) {
  useEffect(() => {
    captureError("auth-methods:custom-oidc-plan-gate", error);
  }, [error]);
  return <AddCustomOidcButtonDisabled onClick={onClick} isTeamPlanOrAbove={false} />;
}

function AddCustomOidcButtonInner({
  team,
  onClick,
}: {
  team: { useProducts: () => Array<{ id: string | null, type?: string }> },
  onClick: () => void,
}) {
  const products = team.useProducts();
  const planId = resolvePlanId(products);
  const isTeamPlanOrAbove = planId === "team" || planId === "growth";

  return <AddCustomOidcButtonDisabled onClick={onClick} isTeamPlanOrAbove={isTeamPlanOrAbove} />;
}

function AddCustomOidcButtonDisabled({ onClick, isTeamPlanOrAbove }: { onClick: () => void, isTeamPlanOrAbove: boolean }) {
  return (
    <SimpleTooltip tooltip={!isTeamPlanOrAbove ? "Custom OIDC providers require a Team plan or above." : undefined}>
      <DesignButton
        onClick={onClick}
        variant="secondary"
        disabled={!isTeamPlanOrAbove}
      >
        <GlobeIcon size={16} className="mr-1.5" />
        Add Custom OIDC
        {!isTeamPlanOrAbove && <span className="ml-1.5"><DesignBadge label="Team+" color="blue" size="sm" /></span>}
      </DesignButton>
    </SimpleTooltip>
  );
}

// ─── Custom OIDC types and helpers ────────────────────────────────────────

type CustomOidcConfigEntry = {
  id: string,
  type: "custom_oidc",
  issuerUrl: string,
  clientId: string,
  clientSecret: string,
  scope?: string,
  displayName?: string,
  customCallbackUrl?: string,
};

function getCustomOidcProviders(config: CompleteConfig): CustomOidcConfigEntry[] {
  return typedEntries(config.auth.oauth.providers)
    .filter(([, p]) => p.type === "custom_oidc")
    .map(([id, p]) => ({
      id,
      type: "custom_oidc" as const,
      issuerUrl: p.issuerUrl ?? throwErr(`Custom OIDC provider "${id}" is missing issuerUrl`),
      clientId: p.clientId ?? throwErr(`Custom OIDC provider "${id}" is missing clientId`),
      clientSecret: p.clientSecret ?? throwErr(`Custom OIDC provider "${id}" is missing clientSecret`),
      scope: p.scope,
      displayName: p.displayName,
      customCallbackUrl: p.customCallbackUrl,
    }));
}

const customOidcFormSchema = yupObject({
  providerId: yupString().defined().nonEmpty().matches(
    /^[a-z0-9_-]+$/,
    "Provider ID must only contain lowercase letters, numbers, hyphens, and underscores"
  ).test(
    "not-reserved",
    "This ID is reserved for a standard provider. Choose a different name.",
    (v) => !allProviders.includes(v as any),
  ),
  displayName: yupString().defined().nonEmpty(),
  issuerUrl: urlSchema.defined().nonEmpty(),
  clientId: yupString().defined().nonEmpty(),
  clientSecret: yupString().defined().nonEmpty(),
  scope: yupString().optional(),
});

type CustomOidcFormValues = {
  providerId: string,
  displayName: string,
  issuerUrl: string,
  clientId: string,
  clientSecret: string,
  scope?: string,
};

function CustomOidcProviderDialog({
  open,
  onClose,
  existing,
}: {
  open: boolean,
  onClose: () => void,
  existing?: CustomOidcConfigEntry,
}) {
  const hexclaveAdminApp = useAdminApp();
  const config = hexclaveAdminApp.useProject().useConfig();
  const updateConfig = useUpdateConfig();

  const defaultValues: CustomOidcFormValues = {
    providerId: existing?.id ?? "",
    displayName: existing?.displayName ?? "",
    issuerUrl: existing?.issuerUrl ?? "",
    clientId: existing?.clientId ?? "",
    clientSecret: existing?.clientSecret ?? "",
    scope: existing?.scope ?? "",
  };

  const isEditing = !!existing;

  const onSubmit = async (values: CustomOidcFormValues) => {
    const providerId = isEditing ? existing.id : values.providerId;
    if (!isEditing && providerId in config.auth.oauth.providers) {
      throw new HexclaveAssertionError(`OAuth provider ID "${providerId}" already exists`);
    }
    // `as any` — same rationale as adminProviderToConfigProvider
    const configEntry: CompleteConfig['auth']['oauth']['providers'][string] = {
      type: "custom_oidc" as any,
      isShared: false,
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      customCallbackUrl: (isEditing && existing.customCallbackUrl) ? existing.customCallbackUrl : getNewProviderCallbackUrl(providerId),
      facebookConfigId: undefined,
      microsoftTenantId: undefined,
      appleTeamId: undefined,
      appleKeyId: undefined,
      applePrivateKey: undefined,
      appleBundles: undefined,
      issuerUrl: values.issuerUrl,
      scope: values.scope || undefined,
      displayName: values.displayName,
      allowSignIn: true,
      allowConnectedAccounts: true,
    };
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`auth.oauth.providers.${providerId}`]: configEntry,
      },
      pushable: false,
    });
  };

  const callbackUrl = isEditing
    ? resolveProviderCallbackUrl(existing.id, config.auth.oauth.providers[existing.id])
    : null;

  return (
    <FormDialog<CustomOidcFormValues>
      defaultValues={defaultValues}
      formSchema={customOidcFormSchema}
      onSubmit={onSubmit}
      open={open}
      onClose={onClose}
      title={isEditing ? `Edit ${existing.displayName || "Custom OIDC Provider"}` : "Add Custom OIDC Provider"}
      cancelButton
      okButton={{ label: isEditing ? "Save" : "Add Provider" }}
      render={(form) => (
        <div className="flex flex-col gap-4 w-full">
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl ring-1 ring-black/[0.08] dark:ring-white/[0.08] shadow-sm bg-foreground/[0.04]">
              <GlobeIcon size={18} className="text-foreground/70" />
            </div>
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold text-foreground">Custom OIDC Provider</span>
                <DesignBadge label="OIDC" color="blue" size="sm" />
              </div>
              <span className="text-[11px] text-muted-foreground">Connect any OIDC-compliant identity provider</span>
            </div>
          </div>

          {!isEditing && (
            <FormField
              control={form.control}
              name="providerId"
              render={({ field }) => (
                <FormItem className="space-y-1.5">
                  <FormLabel className="text-xs font-medium text-muted-foreground">Provider ID</FormLabel>
                  <FormControl>
                    <DesignInput {...field} value={field.value} placeholder="my-oidc-provider" size="sm" autoComplete="off" />
                  </FormControl>
                  <FormMessage />
                  <span className="text-[10px] text-muted-foreground">Unique identifier — lowercase letters, numbers, hyphens, underscores only.</span>
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="displayName"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="text-xs font-medium text-muted-foreground">Display Name</FormLabel>
                <FormControl>
                  <DesignInput {...field} value={field.value} placeholder="My Identity Provider" size="sm" autoComplete="off" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="issuerUrl"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="text-xs font-medium text-muted-foreground">Issuer URL</FormLabel>
                <FormControl>
                  <DesignInput {...field} value={field.value} placeholder="https://your-idp.example.com" size="sm" autoComplete="off" />
                </FormControl>
                <FormMessage />
                <span className="text-[10px] text-muted-foreground">Must support OIDC discovery (/.well-known/openid-configuration).</span>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="clientId"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="text-xs font-medium text-muted-foreground">Client ID</FormLabel>
                <FormControl>
                  <DesignInput {...field} value={field.value} placeholder="Client ID" size="sm" autoComplete="off" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="clientSecret"
            render={({ field }) => (
              <FormItem className="hexclave-sensitive space-y-1.5">
                <FormLabel className="text-xs font-medium text-muted-foreground">Client Secret</FormLabel>
                <FormControl>
                  <DesignInput {...field} value={field.value} type="password" placeholder="Client Secret" size="sm" autoComplete="off" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="scope"
            render={({ field }) => (
              <FormItem className="space-y-1.5">
                <FormLabel className="text-xs font-medium text-muted-foreground">Scopes (optional)</FormLabel>
                <FormControl>
                  <DesignInput {...field} value={field.value ?? ""} placeholder="openid email profile" size="sm" autoComplete="off" />
                </FormControl>
                <FormMessage />
                <span className="text-[10px] text-muted-foreground">Space-separated. Defaults to &quot;openid email profile&quot;.</span>
              </FormItem>
            )}
          />

          {callbackUrl && (
            <div className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wider text-muted-foreground">Redirect URL</span>
              <Typography type="footnote" className="break-all">
                <InlineCode>{callbackUrl}</InlineCode>
              </Typography>
            </div>
          )}
        </div>
      )}
    />
  );
}

function CustomOidcProviderInlineRow({ provider }: { provider: CustomOidcConfigEntry }) {
  const hexclaveAdminApp = useAdminApp();
  const updateConfig = useUpdateConfig();
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [turnOffDialogOpen, setTurnOffDialogOpen] = useState(false);

  const deleteProvider = async () => {
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`auth.oauth.providers.${provider.id}`]: null,
      },
      pushable: false,
    });
  };

  const items: DesignMenuActionItem[] = [
    {
      id: "configure",
      label: "Configure",
      icon: <GearSixIcon size={14} />,
      onClick: () => setEditDialogOpen(true),
    },
    {
      id: "disable",
      label: "Disable Provider",
      icon: <PowerIcon size={14} />,
      itemVariant: "destructive",
      onClick: () => setTurnOffDialogOpen(true),
    },
  ];

  return (
    <DesignCardTint gradient="default" className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl ring-1 ring-black/[0.08] dark:ring-white/[0.08] shadow-sm bg-foreground/[0.04]">
            <GlobeIcon size={18} className="text-foreground/70" />
          </div>
          <span className="text-sm font-semibold text-foreground truncate">{provider.displayName || provider.id}</span>
          <DesignBadge label="Custom OIDC" color="blue" size="sm" />
        </div>
        <DesignMenu
          variant="actions"
          trigger="icon"
          triggerLabel="Open menu"
          align="end"
          withIcons
          items={items}
        />
      </div>

      <CustomOidcProviderDialog
        open={editDialogOpen}
        onClose={() => setEditDialogOpen(false)}
        existing={provider}
      />

      <ActionDialog
        title={`Disable ${provider.displayName || provider.id}`}
        open={turnOffDialogOpen}
        onClose={() => setTurnOffDialogOpen(false)}
        danger
        okButton={{
          label: `Disable ${provider.displayName || provider.id}`,
          onClick: deleteProvider,
        }}
        cancelButton
        confirmText="I understand that this will disable sign-in and sign-up for new and existing users with this provider."
      >
        <DesignAlert
          variant="error"
          title="This action affects existing users"
          description="Disabling this provider will prevent users from signing in with it, including existing users who have already used it."
        />
      </ActionDialog>
    </DesignCardTint>
  );
}

function DisabledProvidersDialog({ open, onOpenChange }: { open?: boolean, onOpenChange?: (open: boolean) => void }) {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const oauthProviders = project.config.oauthProviders;
  const config = project.useConfig();
  const updateConfig = useUpdateConfig();
  const [providerSearch, setProviderSearch] = useState("");
  const filteredProviders = allProviders
    .filter((id) => id.toLowerCase().includes(providerSearch.toLowerCase()))
    .map((id) => [id, oauthProviders.find((provider: AdminOAuthProviderConfig) => provider.id === id)] as const)
    .filter(([, provider]) => {
      return !provider;
    });

  return <ActionDialog
    title="Add New Auth Method"
    open={open}
    onOpenChange={onOpenChange}
    cancelButton
  >
    <DesignInput
      className="mb-4"
      placeholder="Search for a provider..."
      value={providerSearch}
      onChange={(e) => setProviderSearch(e.target.value)}
      leadingIcon={<MagnifyingGlassIcon className="h-3.5 w-3.5" />}
    />
    <div className="flex gap-2 flex-wrap justify-center">
      {filteredProviders
        .map(([id, provider]) => {
          return <ProviderSettingSwitch
            key={id}
            id={id}
            provider={provider}
            updateProvider={async (provider) => {
              await updateConfig({
                adminApp: hexclaveAdminApp,
                configUpdate: {
                  [`auth.oauth.providers.${provider.id}`]: adminProviderToConfigProvider(provider, config.auth.oauth.providers[provider.id]),
                },
                pushable: false,
              });
            }}
            deleteProvider={async (id) => {
              await updateConfig({
                adminApp: hexclaveAdminApp,
                configUpdate: {
                  [`auth.oauth.providers.${id}`]: null,
                },
                pushable: false,
              });
            }}
          />;
        })}

      { filteredProviders.length === 0 && (
        <Typography variant="secondary">No providers found.</Typography>
      ) }
    </div>

  </ActionDialog>;
}

// ─── Provider action menu (dots) ──────────────────────────────────────────

function OAuthActionCell({ config }: { config: AdminOAuthProviderConfig }) {
  const hexclaveAdminApp = useAdminApp();
  const completeConfig = hexclaveAdminApp.useProject().useConfig();
  const updateConfig = useUpdateConfig();
  const [turnOffProviderDialogOpen, setTurnOffProviderDialogOpen] = useState(false);
  const [providerSettingDialogOpen, setProviderSettingDialogOpen] = useState(false);

  const updateProvider = async (provider: AdminOAuthProviderConfig) => {
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`auth.oauth.providers.${provider.id}`]: adminProviderToConfigProvider(provider, completeConfig.auth.oauth.providers[provider.id]),
      },
      pushable: false,
    });
  };

  const deleteProvider = async (id: string) => {
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: {
        [`auth.oauth.providers.${id}`]: null,
      },
      pushable: false,
    });
  };

  const items: DesignMenuActionItem[] = [
    {
      id: "configure",
      label: "Configure",
      icon: <GearSixIcon size={14} />,
      onClick: () => setProviderSettingDialogOpen(true),
    },
    {
      id: "disable",
      label: "Disable Provider",
      icon: <PowerIcon size={14} />,
      itemVariant: "destructive",
      onClick: () => setTurnOffProviderDialogOpen(true),
    },
  ];

  return (
    <>
      <TurnOffProviderDialog
        open={turnOffProviderDialogOpen}
        onClose={() => setTurnOffProviderDialogOpen(false)}
        providerId={config.id}
        onConfirm={async () => {
          await deleteProvider(config.id);
        }}
      />
      <ProviderSettingDialog
        id={config.id}
        open={providerSettingDialogOpen}
        onClose={() => setProviderSettingDialogOpen(false)}
        provider={config}
        updateProvider={updateProvider}
        deleteProvider={deleteProvider}
      />

      <DesignMenu
        variant="actions"
        trigger="icon"
        triggerLabel="Open menu"
        align="end"
        withIcons
        items={items}
      />
    </>
  );
}

// ─── Method toggle row (used everywhere) ──────────────────────────────────

type MethodIcon = React.ElementType;

function MethodToggleRow({
  icon: Icon,
  label,
  hint,
  checked,
  onCheckedChange,
  density = "default",
}: {
  icon: MethodIcon,
  label: string,
  hint?: string,
  checked: boolean,
  onCheckedChange: (checked: boolean) => void,
  density?: "compact" | "default" | "card",
}) {
  const id = useId();
  const padding = density === "compact" ? "px-3 py-2.5" : density === "card" ? "p-4" : "px-3.5 py-3";
  const innerRing = density === "card"
    ? "bg-foreground/[0.03] ring-1 ring-black/[0.06] dark:ring-white/[0.06] rounded-2xl"
    : "rounded-xl hover:bg-foreground/[0.03] transition-colors duration-150 hover:transition-none";
  const iconSize = density === "card" ? 20 : 18;

  return (
    <Label
      htmlFor={id}
      className={`flex items-center gap-3 cursor-pointer ${innerRing} ${padding}`}
    >
      <div className="p-2 rounded-lg bg-foreground/[0.06] dark:bg-foreground/[0.04] shrink-0">
        <Icon size={iconSize} className="text-foreground/70 dark:text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate">{label}</div>
        {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
    </Label>
  );
}

// ─── Provider row ─────────────────────────────────────────────────────────

function ProviderInlineRow({ provider }: { provider: AdminOAuthProviderConfig }) {
  return (
    <DesignCardTint gradient="default" className="px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderIcon id={provider.id} size="sm" />
          <span className="text-sm font-semibold text-foreground truncate">{BrandIcons.toTitle(provider.id)}</span>
          {provider.type === 'shared' && (
            <SimpleTooltip tooltip={SHARED_TOOLTIP}>
              <DesignBadge label="Shared keys" color="orange" size="sm" />
            </SimpleTooltip>
          )}
        </div>
        <OAuthActionCell config={provider} />
      </div>
    </DesignCardTint>
  );
}

// ─── Live preview content ────────────────────────────────────────────────

function LivePreviewBody({
  config,
  projectDisplayName,
  passwordEnabled,
  otpEnabled,
  passkeyEnabled,
  enabledProviders,
}: {
  config: AdminProject['config'],
  projectDisplayName: string,
  passwordEnabled: boolean,
  otpEnabled: boolean,
  passkeyEnabled: boolean,
  enabledProviders: AdminOAuthProviderConfig[],
}) {
  return (
    <div className="self-stretch py-2 min-w-[400px] items-center">
      <BrowserFrame url="your-website.com/signin">
        <div className="flex flex-col items-center justify-center min-h-[400px]">
          <div className="w-full sm:max-w-xs m-auto scale-90">
            <HostedAuthMethodPreview
              project={{
                displayName: projectDisplayName,
                config: {
                  signUpEnabled: config.signUpEnabled,
                  credentialEnabled: passwordEnabled,
                  magicLinkEnabled: otpEnabled,
                  passkeyEnabled,
                  oauthProviders: enabledProviders.map((provider) => ({ id: provider.id })),
                },
              }}
            />
          </div>
        </div>
      </BrowserFrame>
    </div>
  );
}

const MERGE_STRATEGY_SHORT: Record<OAuthAccountMergeStrategy, string> = {
  link_method: "Link accounts",
  allow_duplicates: "Create new account",
  raise_error: "Block sign-up",
};

// ─── Designed Email Verification toggle (logic copied from EmailVerificationSetting) ──

type AffectedUser = {
  id: string,
  displayName: string | null,
  primaryEmail: string | null,
  restrictedReason: RestrictedReason,
};

type PendingChange = {
  affectedUsers: AffectedUser[],
  totalAffectedCount: number,
  onConfirm: () => Promise<void>,
};

function useEmailVerificationToggle() {
  const hexclaveAdminApp = useAdminApp();
  const project = hexclaveAdminApp.useProject();
  const projectConfig = project.useConfig();
  const updateConfig = useUpdateConfig();
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);

  const checked = projectConfig.onboarding.requireEmailVerification;

  const handleChange = async (next: boolean) => {
    if (next && !projectConfig.onboarding.requireEmailVerification) {
      // any cast needed: previewAffectedUsersByOnboardingChange is a dynamically-typed admin API method
      const preview = await (hexclaveAdminApp as any).previewAffectedUsersByOnboardingChange(
        { requireEmailVerification: true },
        10,
      );
      if (preview.totalAffectedCount > 0) {
        setPendingChange({
          affectedUsers: preview.affectedUsers,
          totalAffectedCount: preview.totalAffectedCount,
          onConfirm: async () => {
            await updateConfig({
              adminApp: hexclaveAdminApp,
              configUpdate: { "onboarding.requireEmailVerification": true },
              pushable: true,
            });
            setPendingChange(null);
          },
        });
        return;
      }
    }
    await updateConfig({
      adminApp: hexclaveAdminApp,
      configUpdate: { "onboarding.requireEmailVerification": next },
      pushable: true,
    });
  };

  const onCheckedChange = (next: boolean) => {
    runAsynchronouslyWithAlert(handleChange(next));
  };

  const dialog = (
    <ActionDialog
      open={!!pendingChange}
      onClose={() => setPendingChange(null)}
      title="Enable email verification requirement"
      size="2xl"
      danger
      okButton={{
        label: "Apply Change",
        onClick: async () => {
          await pendingChange?.onConfirm();
        },
      }}
      cancelButton={{ label: "Cancel" }}
    >
      <div className="flex flex-col gap-4">
        <DesignAlert
          variant="warning"
          title={`${pendingChange?.totalAffectedCount ?? 0} user${(pendingChange?.totalAffectedCount ?? 0) === 1 ? "" : "s"} will be required to verify their email`}
          description="Affected users will be prompted to verify their email the next time they visit your application."
        />
        {pendingChange && pendingChange.affectedUsers.length > 0 && (
          <div className="flex flex-col gap-2">
            <Typography variant="secondary" type="label">
              Affected users
            </Typography>
            <div className="overflow-hidden rounded-xl ring-1 ring-black/[0.06] dark:ring-white/[0.06]">
              <table className="w-full table-fixed text-sm">
                <colgroup>
                  <col className="w-[22%]" />
                  <col />
                  <col className="w-[7.5rem]" />
                </colgroup>
                <thead className="bg-zinc-50 dark:bg-background">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">User</th>
                    <th className="px-3 py-2 text-left font-medium">Email</th>
                    <th className="px-3 py-2 text-left font-medium whitespace-nowrap">Reason</th>
                  </tr>
                </thead>
              </table>
              <div className="max-h-52 overflow-y-auto border-t border-black/[0.06] dark:border-white/[0.06]">
                <table className="w-full table-fixed text-sm">
                  <colgroup>
                    <col className="w-[22%]" />
                    <col />
                    <col className="w-[7.5rem]" />
                  </colgroup>
                  <tbody>
                    {pendingChange.affectedUsers.map((user) => (
                      <tr key={user.id} className="border-t border-black/[0.06] dark:border-white/[0.06] first:border-t-0">
                        <td className="px-3 py-2 align-middle">
                          {user.displayName || <span className="text-muted-foreground italic">No name</span>}
                        </td>
                        <td className="px-3 py-2 align-middle truncate" title={user.primaryEmail ?? undefined}>
                          {user.primaryEmail || <span className="text-muted-foreground italic">No email</span>}
                        </td>
                        <td className="px-3 py-2 align-middle">
                          <DesignBadge
                            label={user.restrictedReason.type === "email_not_verified" ? "Not verified" : "Anonymous"}
                            color="orange"
                            size="sm"
                            contentMode="text"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {pendingChange.totalAffectedCount > pendingChange.affectedUsers.length && (
              <Typography variant="secondary" type="footnote">
                ... and {pendingChange.totalAffectedCount - pendingChange.affectedUsers.length} more user{pendingChange.totalAffectedCount - pendingChange.affectedUsers.length === 1 ? "" : "s"}
              </Typography>
            )}
          </div>
        )}
      </div>
    </ActionDialog>
  );

  return { checked, onCheckedChange, dialog };
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function PageClient(props: { variant?: AuthMethodsPageVariant, embedded?: boolean }) {
  const variant = props.variant ?? "full";
  const embedded = props.embedded === true;
  const hexclaveAdminApp = useAdminApp();
  const projectId = useProjectId();
  const project = hexclaveAdminApp.useProject();
  const config = project.useConfig();
  const oauthProviders = project.config.oauthProviders;
  const updateConfig = useUpdateConfig();
  const showBranchSections = variant === "full" || variant === "branch";
  const showOauthSections = variant === "full" || variant === "oauth";
  const environmentOauthHref = `/projects/${projectId}/project-settings/oauth`;
  const [confirmSignUpEnabled, setConfirmSignUpEnabled] = useState(false);
  const [confirmSignUpDisabled, setConfirmSignUpDisabled] = useState(false);
  const [disabledProvidersDialogOpen, setDisabledProvidersDialogOpen] = useState(false);
  const [customOidcDialogOpen, setCustomOidcDialogOpen] = useState(false);

  const customOidcProviders = useMemo(() => getCustomOidcProviders(config), [config]);

  // ===== AUTH METHODS local state =====
  const [localPasswordEnabled, setLocalPasswordEnabled] = useState<boolean | undefined>(undefined);
  const [localOtpEnabled, setLocalOtpEnabled] = useState<boolean | undefined>(undefined);
  const [localPasskeyEnabled, setLocalPasskeyEnabled] = useState<boolean | undefined>(undefined);

  const passwordEnabled = localPasswordEnabled ?? config.auth.password.allowSignIn;
  const otpEnabled = localOtpEnabled ?? config.auth.otp.allowSignIn;
  const passkeyEnabled = localPasskeyEnabled ?? config.auth.passkey.allowSignIn;

  const authMethodsHasChanges = useMemo(() =>
    localPasswordEnabled !== undefined ||
    localOtpEnabled !== undefined ||
    localPasskeyEnabled !== undefined,
  [localPasswordEnabled, localOtpEnabled, localPasskeyEnabled]);

  const handleAuthMethodsSave = async () => {
    const configUpdate: Record<string, boolean> = {};
    if (localPasswordEnabled !== undefined) {
      configUpdate['auth.password.allowSignIn'] = localPasswordEnabled;
    }
    if (localOtpEnabled !== undefined) {
      configUpdate['auth.otp.allowSignIn'] = localOtpEnabled;
    }
    if (localPasskeyEnabled !== undefined) {
      configUpdate['auth.passkey.allowSignIn'] = localPasskeyEnabled;
    }
    await updateConfig({ adminApp: hexclaveAdminApp, configUpdate, pushable: true });
    setLocalPasswordEnabled(undefined);
    setLocalOtpEnabled(undefined);
    setLocalPasskeyEnabled(undefined);
  };

  const handleAuthMethodsDiscard = () => {
    setLocalPasswordEnabled(undefined);
    setLocalOtpEnabled(undefined);
    setLocalPasskeyEnabled(undefined);
  };

  // ===== SIGN-UP local state =====
  const [localAllowSignUp, setLocalAllowSignUp] = useState<boolean | undefined>(undefined);
  const [localMergeStrategy, setLocalMergeStrategy] = useState<OAuthAccountMergeStrategy | undefined>(undefined);

  const allowSignUp = localAllowSignUp ?? config.auth.allowSignUp;
  const mergeStrategy = localMergeStrategy ?? config.auth.oauth.accountMergeStrategy;

  const signUpHasChanges = useMemo(() =>
    localAllowSignUp !== undefined || localMergeStrategy !== undefined,
  [localAllowSignUp, localMergeStrategy]);

  const handleSignUpSave = async () => {
    if (localAllowSignUp !== undefined && localAllowSignUp !== config.auth.allowSignUp) {
      if (localAllowSignUp) {
        setConfirmSignUpEnabled(true);
      } else {
        setConfirmSignUpDisabled(true);
      }
      return;
    }

    if (localMergeStrategy !== undefined) {
      await updateConfig({
        adminApp: hexclaveAdminApp,
        configUpdate: { 'auth.oauth.accountMergeStrategy': localMergeStrategy },
        pushable: true,
      });
    }
    setLocalAllowSignUp(undefined);
    setLocalMergeStrategy(undefined);
  };

  const handleSignUpDiscard = () => {
    setLocalAllowSignUp(undefined);
    setLocalMergeStrategy(undefined);
  };

  const handleSignUpConfirmed = async (newAllowSignUp: boolean) => {
    const configUpdate: Record<string, any> = { 'auth.allowSignUp': newAllowSignUp };
    if (localMergeStrategy !== undefined) {
      configUpdate['auth.oauth.accountMergeStrategy'] = localMergeStrategy;
    }
    await updateConfig({ adminApp: hexclaveAdminApp, configUpdate, pushable: true });
    setLocalAllowSignUp(undefined);
    setLocalMergeStrategy(undefined);
  };

  // ===== USER DELETION local state =====
  const [localAllowClientDeletion, setLocalAllowClientDeletion] = useState<boolean | undefined>(undefined);
  const allowClientDeletion = localAllowClientDeletion ?? config.users.allowClientUserDeletion;
  const userDeletionHasChanges = localAllowClientDeletion !== undefined;

  const handleUserDeletionSave = async () => {
    if (localAllowClientDeletion !== undefined) {
      await updateConfig({
        adminApp: hexclaveAdminApp,
        configUpdate: { 'users.allowClientUserDeletion': localAllowClientDeletion },
        pushable: true,
      });
    }
    setLocalAllowClientDeletion(undefined);
  };

  const handleUserDeletionDiscard = () => {
    setLocalAllowClientDeletion(undefined);
  };

  const enabledProviders = allProviders
    .map((id) => [id, oauthProviders.find((provider: AdminOAuthProviderConfig) => provider.id === id)] as const)
    .filter(([, provider]) => !!provider);

  const enabledProvidersList = enabledProviders
    .map(([, provider]) => provider)
    .filter((provider): provider is AdminOAuthProviderConfig => !!provider);

  // ===== Toggle helpers =====
  const onPasswordChange = (checked: boolean) => {
    setLocalPasswordEnabled(checked === config.auth.password.allowSignIn ? undefined : checked);
  };
  const onOtpChange = (checked: boolean) => {
    setLocalOtpEnabled(checked === config.auth.otp.allowSignIn ? undefined : checked);
  };
  const onPasskeyChange = (checked: boolean) => {
    setLocalPasskeyEnabled(checked === config.auth.passkey.allowSignIn ? undefined : checked);
  };
  const onAllowSignUpChange = (checked: boolean) => {
    setLocalAllowSignUp(checked === config.auth.allowSignUp ? undefined : checked);
  };
  const onMergeStrategyChange = (value: string) => {
    if (value !== "link_method" && value !== "raise_error" && value !== "allow_duplicates") {
      throw new HexclaveAssertionError(`Unknown OAuth account merge strategy: ${value}`);
    }
    const next: OAuthAccountMergeStrategy = value;
    setLocalMergeStrategy(next === config.auth.oauth.accountMergeStrategy ? undefined : next);
  };
  const onAllowClientDeletionChange = (checked: boolean) => {
    setLocalAllowClientDeletion(checked === config.users.allowClientUserDeletion ? undefined : checked);
  };

  const emailVerification = useEmailVerificationToggle();

  return (
    <AppEnabledGuard appId="authentication">
      <PageLayout
        title={embedded ? undefined : (variant === "oauth" ? "OAuth credentials" : "Auth Methods")}
        description={
          embedded
            ? undefined
            : variant === "oauth"
              ? "Provider credentials and shared OAuth apps for this environment."
              : "Configure how users can sign in to your app"
        }
      >
        <section className="flex flex-col gap-4">
          {showBranchSections && (
            <div className="flex gap-4">
              <DesignCard
                title="Sign-in methods"
                subtitle="Each method below is independently toggleable"
                icon={UserCircleIcon}
                className="flex-grow"
                gradient="default"
              >
                <div className="flex flex-col gap-2">
                  <MethodToggleRow icon={AsteriskIcon} label="Email/password authentication" hint="Classic email + password credentials." checked={passwordEnabled} onCheckedChange={onPasswordChange} density="default" />
                  <MethodToggleRow icon={LinkIcon} label="Magic link (Email OTP)" hint="One-time codes delivered by email." checked={otpEnabled} onCheckedChange={onOtpChange} density="default" />
                  <MethodToggleRow icon={KeyIcon} label="Passkey" hint="Phishing-resistant device-bound credentials." checked={passkeyEnabled} onCheckedChange={onPasskeyChange} density="default" />
                </div>
                <InlineSaveDiscard hasChanges={authMethodsHasChanges} onSave={handleAuthMethodsSave} onDiscard={handleAuthMethodsDiscard} />

                {variant === "branch" ? (
                  <>
                    <div className="mt-5 mb-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-foreground">SSO Providers</div>
                    </div>
                    <DesignAlert
                      variant="info"
                      title="OAuth credentials live in Project Settings"
                      description={
                        enabledProvidersList.length === 0 && customOidcProviders.length === 0
                          ? "Enable and configure SSO providers under Project Settings → OAuth."
                          : `${enabledProvidersList.length + customOidcProviders.length} provider(s) enabled. Manage credentials and shared apps in Project Settings.`
                      }
                    />
                    <div className="mt-3">
                      <DesignButton asChild variant="secondary" size="sm">
                        <Link href={environmentOauthHref}>Manage OAuth credentials</Link>
                      </DesignButton>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="mt-5 mb-3">
                      <div className="text-xs font-semibold uppercase tracking-wider text-foreground">SSO Providers</div>
                    </div>
                    <div className="flex flex-col gap-2">
                      {enabledProvidersList.map(provider => (
                        <ProviderInlineRow key={provider.id} provider={provider} />
                      ))}
                      {customOidcProviders.map(provider => (
                        <CustomOidcProviderInlineRow key={provider.id} provider={provider} />
                      ))}
                      {enabledProvidersList.length === 0 && customOidcProviders.length === 0 && (
                        <DesignAlert
                          variant="info"
                          description="No SSO providers enabled. Add one to let users sign in with their existing accounts."
                        />
                      )}
                    </div>
                    <div className="flex gap-2 mt-4 flex-wrap">
                      <DesignButton
                        onClick={() => setDisabledProvidersDialogOpen(true)}
                        variant="secondary"
                      >
                        <PlusCircleIcon size={16} className="mr-1.5" />
                        Add SSO providers
                      </DesignButton>
                      <AddCustomOidcButton onClick={() => setCustomOidcDialogOpen(true)} />
                    </div>
                  </>
                )}
              </DesignCard>
              <DesignCard
                title="Live preview"
                icon={EyeIcon}
                className="hidden lg:flex"
                gradient="default"
              >
                <LivePreviewBody
                  config={project.config}
                  projectDisplayName={project.displayName}
                  passwordEnabled={passwordEnabled}
                  otpEnabled={otpEnabled}
                  passkeyEnabled={passkeyEnabled}
                  enabledProviders={enabledProvidersList}
                />
              </DesignCard>
            </div>
          )}

          {showOauthSections && !showBranchSections && (
            <DesignCard
              title="SSO Providers"
              subtitle="Enable providers and manage client credentials for this environment"
              icon={GlobeIcon}
              gradient="default"
            >
              <div className="flex flex-col gap-2">
                {enabledProvidersList.map(provider => (
                  <ProviderInlineRow key={provider.id} provider={provider} />
                ))}
                {customOidcProviders.map(provider => (
                  <CustomOidcProviderInlineRow key={provider.id} provider={provider} />
                ))}
                {enabledProvidersList.length === 0 && customOidcProviders.length === 0 && (
                  <DesignAlert
                    variant="info"
                    description="No SSO providers enabled. Add one to let users sign in with their existing accounts."
                  />
                )}
              </div>
              <div className="flex gap-2 mt-4 flex-wrap">
                <DesignButton
                  onClick={() => setDisabledProvidersDialogOpen(true)}
                  variant="secondary"
                >
                  <PlusCircleIcon size={16} className="mr-1.5" />
                  Add SSO providers
                </DesignButton>
                <AddCustomOidcButton onClick={() => setCustomOidcDialogOpen(true)} />
              </div>
            </DesignCard>
          )}

          {showBranchSections && (
            <DesignCard title="Sign-up" subtitle="Account creation policies for new users" icon={UserPlusIcon} gradient="default">
              <div className="flex flex-col gap-2">
                <MethodToggleRow
                  icon={SignInIcon}
                  label="Allow new user sign-ups"
                  hint="Existing users can still sign in when sign-up is disabled. You can always create new accounts manually via the dashboard."
                  checked={allowSignUp}
                  onCheckedChange={onAllowSignUpChange}
                  density="compact"
                />
                <MethodToggleRow
                  icon={EnvelopeSimpleIcon}
                  label="Require email verification"
                  hint="Users must verify their primary email before they can use your application. Unverified users will be restricted."
                  checked={emailVerification.checked}
                  onCheckedChange={emailVerification.onCheckedChange}
                  density="compact"
                />
                <Label
                  className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-foreground/[0.03] transition-colors duration-150 hover:transition-none cursor-pointer"
                >
                  <div className="p-2 rounded-lg bg-foreground/[0.06] dark:bg-foreground/[0.04] shrink-0">
                    <UserCircleIcon size={18} className="text-foreground/70 dark:text-muted-foreground" aria-hidden="true" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">Same-email social login policy</div>
                    <div className="text-xs text-muted-foreground mt-0.5">Determines what happens when a user uses a new social login provider with an email that&apos;s already connected to an account</div>
                  </div>
                  <DesignSelectorDropdown
                    value={mergeStrategy}
                    onValueChange={onMergeStrategyChange}
                    options={[
                      { value: "link_method", label: MERGE_STRATEGY_SHORT.link_method },
                      { value: "allow_duplicates", label: MERGE_STRATEGY_SHORT.allow_duplicates },
                      { value: "raise_error", label: MERGE_STRATEGY_SHORT.raise_error },
                    ]}
                    size="sm"
                    className="w-[180px]"
                  />
                </Label>
              </div>
              <InlineSaveDiscard hasChanges={signUpHasChanges} onSave={handleSignUpSave} onDiscard={handleSignUpDiscard} />
            </DesignCard>
          )}

          {showBranchSections && (
            <DesignCard title="User deletion" subtitle="Self-service account removal" icon={TrashIcon} gradient="default">
              <MethodToggleRow
                icon={TrashIcon}
                label="Allow users to delete their own accounts on the client-side"
                hint="A delete button will also be added to the account settings page."
                checked={allowClientDeletion}
                onCheckedChange={onAllowClientDeletionChange}
                density="default"
              />
              <InlineSaveDiscard hasChanges={userDeletionHasChanges} onSave={handleUserDeletionSave} onDiscard={handleUserDeletionDiscard} />
            </DesignCard>
          )}

          <div className="h-5 shrink-0" aria-hidden="true" />
        </section>

        {showBranchSections && (
          <>
            <ConfirmSignUpEnabledDialog
              open={confirmSignUpEnabled}
              onOpenChange={setConfirmSignUpEnabled}
              onConfirm={async () => {
                await handleSignUpConfirmed(true);
              }}
            />
            <ConfirmSignUpDisabledDialog
              open={confirmSignUpDisabled}
              onOpenChange={setConfirmSignUpDisabled}
              onConfirm={async () => {
                await handleSignUpConfirmed(false);
              }}
            />
          </>
        )}
        {showOauthSections && (
          <>
            <DisabledProvidersDialog
              open={disabledProvidersDialogOpen}
              onOpenChange={(x) => setDisabledProvidersDialogOpen(x)}
            />
            <CustomOidcProviderDialog
              open={customOidcDialogOpen}
              onClose={() => setCustomOidcDialogOpen(false)}
            />
          </>
        )}
        {showBranchSections && emailVerification.dialog}
      </PageLayout>
    </AppEnabledGuard>
  );
}

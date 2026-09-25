import { CrudTypeOf, createCrud } from "../../crud";
import { ALL_APPS } from "../../apps/apps-config";
import * as schemaFields from "../../schema-fields";
import { yupArray, yupNumber, yupObject, yupString, yupUnion } from "../../schema-fields";

const teamPermissionSchema = yupObject({
  id: yupString().defined(),
}).defined();

const oauthProviderReadSchema = yupObject({
  provider_config_id: schemaFields.yupString().defined(),
  id: schemaFields.oauthIdSchema.defined(),
  type: schemaFields.oauthTypeSchema.defined(),
  client_id: schemaFields.yupDefinedAndNonEmptyWhen(
    schemaFields.oauthClientIdSchema,
    { type: 'standard' },
  ),
  client_secret: schemaFields.oauthClientSecretSchema.optional(),
  apple_team_id: schemaFields.oauthAppleTeamIdSchema.optional(),
  apple_key_id: schemaFields.oauthAppleKeyIdSchema.optional(),
  apple_private_key: schemaFields.oauthApplePrivateKeySchema.optional(),

  // extra params
  facebook_config_id: schemaFields.oauthFacebookConfigIdSchema.optional(),
  microsoft_tenant_id: schemaFields.oauthMicrosoftTenantIdSchema.optional(),
  apple_bundle_ids: schemaFields.oauthAppleBundleIdsSchema.optional(),
}).test(
  "apple-credentials",
  "client_secret is required for standard providers, unless the provider is apple with all Apple key credentials set",
  (provider) => {
    if (provider.type !== "standard") return true;
    const hasClientSecret = provider.client_secret != null && provider.client_secret !== "";
    const keyFields = [provider.apple_team_id, provider.apple_key_id, provider.apple_private_key];
    const hasAnyKeyField = keyFields.some(value => value != null && value !== "");
    const hasAllKeyFields = keyFields.every(value => value != null && value !== "");
    return provider.id === "apple"
      ? (hasClientSecret || hasAllKeyFields) && (!hasAnyKeyField || hasAllKeyFields)
      : hasClientSecret;
  },
);

const oauthProviderWriteSchema = oauthProviderReadSchema.omit(['provider_config_id']);

const enabledOAuthProviderSchema = yupObject({
  id: schemaFields.oauthIdSchema.defined(),
});

const pushedConfigErrorSchema = yupObject({
  message: yupString().defined(),
}).defined();

const configWarningSchema = yupObject({
  message: yupString().defined(),
}).defined();

const onboardingConfigChoiceValues = ["create-new", "link-existing"] as const;
const onboardingSignInMethodValues = ["credential", "magicLink", "passkey", "google", "github", "microsoft"] as const;
const onboardingPaymentsCountryValues = ["US", "OTHER"] as const;

const legacyProjectOnboardingStateSchema = yupObject({
  selected_config_choice: yupString().oneOf(onboardingConfigChoiceValues).defined(),
  selected_apps: yupArray(yupString().oneOf(Object.keys(ALL_APPS)).defined()).defined(),
  selected_sign_in_methods: yupArray(yupString().oneOf(onboardingSignInMethodValues).defined()).defined(),
  selected_email_theme_id: schemaFields.emailThemeSchema.nullable().defined(),
  selected_payments_country: yupString().oneOf(onboardingPaymentsCountryValues).defined(),
});

const cloudOnboardingStepValues = [
  "welcome-to-hexclave",
  "select-primary-app",
  "select-additional-apps",
  "configure-authentication",
  "select-email-theme",
  "setup-sdk",
  "development-setup-complete",
  "where-is-project",
  "cli-push",
  "setup-github-workflow",
  "onboarding-complete",
] as const;

export const cloudProjectOnboardingStateSchema = yupObject({
  version: yupNumber().oneOf([1]).defined(),
  step: yupString().oneOf(cloudOnboardingStepValues).defined(),
  journey: yupString().oneOf(["add", "deploy-existing"]).defined(),
  primary_app_id: yupString().oneOf(Object.keys(ALL_APPS)).nullable().defined(),
  additional_app_ids: yupArray(yupString().oneOf(Object.keys(ALL_APPS)).defined()).defined(),
  selected_apps: yupArray(yupString().oneOf(Object.keys(ALL_APPS)).defined()).defined(),
  selected_sign_in_methods: yupArray(yupString().oneOf(onboardingSignInMethodValues).defined()).defined(),
  selected_email_theme_id: schemaFields.emailThemeSchema.nullable().defined(),
  project_location: yupString().oneOf(["local", "github"]).nullable().defined(),
}).defined();

const projectOnboardingStateSchema = yupUnion(
  legacyProjectOnboardingStateSchema,
  cloudProjectOnboardingStateSchema,
);

export const emailConfigSchema = yupObject({
  type: schemaFields.emailTypeSchema.defined(),
  host: schemaFields.yupDefinedAndNonEmptyWhen(schemaFields.emailHostSchema, {
    type: 'standard',
  }),
  port: schemaFields.yupDefinedWhen(schemaFields.emailPortSchema, {
    type: 'standard',
  }),
  username: schemaFields.yupDefinedAndNonEmptyWhen(schemaFields.emailUsernameSchema, {
    type: 'standard',
  }),
  password: schemaFields.yupDefinedAndNonEmptyWhen(schemaFields.emailPasswordSchema, {
    type: 'standard',
  }),
  sender_name: schemaFields.yupDefinedAndNonEmptyWhen(schemaFields.emailSenderNameSchema, {
    type: 'standard',
  }),
  sender_email: schemaFields.yupDefinedAndNonEmptyWhen(schemaFields.emailSenderEmailSchema, {
    type: 'standard',
  }),
});

export const emailConfigWithoutPasswordSchema = emailConfigSchema.pick(['type', 'host', 'port', 'username', 'sender_name', 'sender_email']);

const domainSchema = yupObject({
  domain: schemaFields.urlSchema.defined()
    .matches(/^https?:\/\//, 'URL must start with http:// or https://')
    .meta({ openapiField: { description: 'URL. Must start with http:// or https://', exampleValue: 'https://example.com' } }),
  handler_path: schemaFields.handlerPathSchema.defined(),
});

export const projectsCrudAdminReadSchema = yupObject({
  id: schemaFields.projectIdSchema.defined(),
  display_name: schemaFields.projectDisplayNameSchema.defined(),
  description: schemaFields.projectDescriptionSchema.nonNullable().defined(),
  logo_url: schemaFields.projectLogoUrlSchema.nullable().optional(),
  logo_full_url: schemaFields.projectLogoFullUrlSchema.nullable().optional(),
  logo_dark_mode_url: schemaFields.projectLogoDarkModeUrlSchema.nullable().optional(),
  logo_full_dark_mode_url: schemaFields.projectLogoFullDarkModeUrlSchema.nullable().optional(),
  created_at_millis: schemaFields.projectCreatedAtMillisSchema.defined(),
  is_production_mode: schemaFields.projectIsProductionModeSchema.defined(),
  is_development_environment: schemaFields.yupBoolean().defined(),
  owner_team_id: schemaFields.yupString().nullable().defined(),
  onboarding_status: schemaFields.projectOnboardingStatusSchema.defined(),
  onboarding_state: projectOnboardingStateSchema.nullable().optional(),
  pushed_config_error: pushedConfigErrorSchema.nullable().defined(),
  config_warnings: yupArray(configWarningSchema).defined(),
  /** @deprecated */
  config: yupObject({
    allow_localhost: schemaFields.projectAllowLocalhostSchema.defined(),
    sign_up_enabled: schemaFields.projectSignUpEnabledSchema.defined(),
    credential_enabled: schemaFields.projectCredentialEnabledSchema.defined(),
    magic_link_enabled: schemaFields.projectMagicLinkEnabledSchema.defined(),
    passkey_enabled: schemaFields.projectPasskeyEnabledSchema.defined(),
    // TODO: remove this
    client_team_creation_enabled: schemaFields.projectClientTeamCreationEnabledSchema.defined(),
    client_user_deletion_enabled: schemaFields.projectClientUserDeletionEnabledSchema.defined(),
    allow_user_api_keys: schemaFields.yupBoolean().defined(),
    allow_team_api_keys: schemaFields.yupBoolean().defined(),
    oauth_providers: yupArray(oauthProviderReadSchema.defined()).defined(),
    enabled_oauth_providers: yupArray(enabledOAuthProviderSchema.defined()).defined().meta({ openapiField: { hidden: true } }),
    domains: yupArray(domainSchema.defined()).defined(),
    email_config: emailConfigSchema.defined(),
    email_theme: schemaFields.emailThemeSchema.defined(),
    create_team_on_sign_up: schemaFields.projectCreateTeamOnSignUpSchema.defined(),
    team_creator_default_permissions: yupArray(teamPermissionSchema.defined()).defined(),
    team_member_default_permissions: yupArray(teamPermissionSchema.defined()).defined(),
    user_default_permissions: yupArray(teamPermissionSchema.defined()).defined(),
    oauth_account_merge_strategy: schemaFields.oauthAccountMergeStrategySchema.defined(),
  }).defined().meta({ openapiField: { hidden: true } }),
}).defined();

export const projectsCrudClientReadSchema = yupObject({
  id: schemaFields.projectIdSchema.defined(),
  display_name: schemaFields.projectDisplayNameSchema.defined(),
  is_development_environment: schemaFields.yupBoolean().defined(),
  pushed_config_error: pushedConfigErrorSchema.nullable().defined(),
  config_warnings: yupArray(configWarningSchema).defined(),
  config: yupObject({
    sign_up_enabled: schemaFields.projectSignUpEnabledSchema.defined(),
    credential_enabled: schemaFields.projectCredentialEnabledSchema.defined(),
    magic_link_enabled: schemaFields.projectMagicLinkEnabledSchema.defined(),
    passkey_enabled: schemaFields.projectPasskeyEnabledSchema.defined(),
    client_team_creation_enabled: schemaFields.projectClientTeamCreationEnabledSchema.defined(),
    client_user_deletion_enabled: schemaFields.projectClientUserDeletionEnabledSchema.defined(),
    allow_localhost: schemaFields.projectAllowLocalhostSchema.defined(),
    allow_user_api_keys: schemaFields.yupBoolean().defined(),
    allow_team_api_keys: schemaFields.yupBoolean().defined(),
    enabled_oauth_providers: yupArray(enabledOAuthProviderSchema.defined()).defined().meta({ openapiField: { hidden: true } }),
    domains: yupArray(domainSchema.defined()).defined(),
  }).defined().meta({ openapiField: { hidden: true } }),
}).defined();


export const projectsCrudAdminUpdateSchema = yupObject({
  display_name: schemaFields.projectDisplayNameSchema.optional(),
  description: schemaFields.projectDescriptionSchema.optional(),
  logo_url: schemaFields.projectLogoUrlSchema.nullable().optional(),
  logo_full_url: schemaFields.projectLogoFullUrlSchema.nullable().optional(),
  logo_dark_mode_url: schemaFields.projectLogoDarkModeUrlSchema.nullable().optional(),
  logo_full_dark_mode_url: schemaFields.projectLogoFullDarkModeUrlSchema.nullable().optional(),
  is_production_mode: schemaFields.projectIsProductionModeSchema.optional(),
  onboarding_status: schemaFields.projectOnboardingStatusSchema.optional(),
  onboarding_state: projectOnboardingStateSchema.nullable().optional(),
  /** @deprecated */
  config: yupObject({
    sign_up_enabled: schemaFields.projectSignUpEnabledSchema.optional(),
    credential_enabled: schemaFields.projectCredentialEnabledSchema.optional(),
    magic_link_enabled: schemaFields.projectMagicLinkEnabledSchema.optional(),
    passkey_enabled: schemaFields.projectPasskeyEnabledSchema.optional(),
    client_team_creation_enabled: schemaFields.projectClientTeamCreationEnabledSchema.optional(),
    client_user_deletion_enabled: schemaFields.projectClientUserDeletionEnabledSchema.optional(),
    allow_localhost: schemaFields.projectAllowLocalhostSchema.optional(),
    allow_user_api_keys: schemaFields.yupBoolean().optional(),
    allow_team_api_keys: schemaFields.yupBoolean().optional(),
    email_config: emailConfigSchema.optional().default(undefined),
    email_theme: schemaFields.emailThemeSchema.optional(),
    domains: yupArray(domainSchema.defined()).optional().default(undefined),
    oauth_providers: yupArray(oauthProviderWriteSchema.defined()).optional().default(undefined),
    create_team_on_sign_up: schemaFields.projectCreateTeamOnSignUpSchema.optional(),
    team_creator_default_permissions: yupArray(teamPermissionSchema.defined()).optional(),
    team_member_default_permissions: yupArray(teamPermissionSchema.defined()).optional(),
    user_default_permissions: yupArray(teamPermissionSchema.defined()).optional(),
    oauth_account_merge_strategy: schemaFields.oauthAccountMergeStrategySchema.optional(),
    require_email_verification: schemaFields.yupBoolean().optional(),
  }).optional().default(undefined),
}).defined();

export const projectsCrudAdminCreateSchema = projectsCrudAdminUpdateSchema.concat(yupObject({
  display_name: schemaFields.projectDisplayNameSchema.defined(),
  is_development_environment: schemaFields.yupBoolean().optional(),
  owner_team_id: schemaFields.yupString().uuid().defined(),
}).defined());

export const projectsCrudAdminDeleteSchema = schemaFields.yupMixed();

export const clientProjectsCrud = createCrud({
  clientReadSchema: projectsCrudClientReadSchema,
  docs: {
    clientRead: {
      summary: 'Get the current project',
      description: 'Get the current project information including display name, OAuth providers and authentication methods. Useful for displaying the available login options to the user.',
      tags: ['Projects'],
    },
  },
});
export type ClientProjectsCrud = CrudTypeOf<typeof clientProjectsCrud>;

export const projectsCrud = createCrud({
  adminReadSchema: projectsCrudAdminReadSchema,
  adminUpdateSchema: projectsCrudAdminUpdateSchema,
  adminDeleteSchema: projectsCrudAdminDeleteSchema,
  docs: {
    adminRead: {
      summary: 'Get the current project',
      description: 'Get the current project information and configuration including display name, OAuth providers, email configuration, etc.',
      tags: ['Projects'],
      hidden: true,
    },
    adminUpdate: {
      summary: 'Update the current project',
      description: 'Update the current project information and configuration including display name, OAuth providers, email configuration, etc.',
      tags: ['Projects'],
      hidden: true,
    },
    adminDelete: {
      summary: 'Delete the current project',
      description: 'Delete the current project and all associated data (including users, teams, API keys, project configs, etc.). Be careful, this action is irreversible.',
      tags: ['Projects'],
      hidden: true,
    },
  },
});
export type ProjectsCrud = CrudTypeOf<typeof projectsCrud>;

export const adminUserProjectsCrud = createCrud({
  clientReadSchema: projectsCrudAdminReadSchema,
  clientCreateSchema: projectsCrudAdminCreateSchema,
  docs: {
    clientList: {
      hidden: true,
    },
    clientCreate: {
      hidden: true,
    },
  },
});
export type AdminUserProjectsCrud = CrudTypeOf<typeof adminUserProjectsCrud>;

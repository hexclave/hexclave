import { AdminTeamPermission } from "../permissions";

export type ProjectConfig = {
  readonly signUpEnabled: boolean,
  readonly credentialEnabled: boolean,
  readonly magicLinkEnabled: boolean,
  readonly passkeyEnabled: boolean,
  readonly clientTeamCreationEnabled: boolean,
  readonly clientUserDeletionEnabled: boolean,
  readonly oauthProviders: OAuthProviderConfig[],
  readonly allowUserApiKeys: boolean,
  readonly allowTeamApiKeys: boolean,
  readonly allowPromoCodes: boolean,
  readonly allowStackingPromoCodes: boolean,
};

export type OAuthProviderConfig = {
  readonly id: string,
};

/**
 * @deprecated This type is deprecated. Use the new config override setup instead.
 */
export type AdminProjectConfig = {
  readonly signUpEnabled: boolean,
  readonly credentialEnabled: boolean,
  readonly magicLinkEnabled: boolean,
  readonly passkeyEnabled: boolean,
  readonly clientTeamCreationEnabled: boolean,
  readonly clientUserDeletionEnabled: boolean,
  readonly allowLocalhost: boolean,
  readonly oauthProviders: AdminOAuthProviderConfig[],
  readonly emailConfig?: AdminEmailConfig,
  readonly emailTheme: string,
  readonly domains: AdminDomainConfig[],
  readonly createTeamOnSignUp: boolean,
  readonly teamCreatorDefaultPermissions: AdminTeamPermission[],
  readonly teamMemberDefaultPermissions: AdminTeamPermission[],
  readonly userDefaultPermissions: AdminTeamPermission[],
  readonly oauthAccountMergeStrategy: 'link_method' | 'raise_error' | 'allow_duplicates',
  readonly allowUserApiKeys: boolean,
  readonly allowTeamApiKeys: boolean,
  readonly allowPromoCodes: boolean,
  readonly allowStackingPromoCodes: boolean,
};

export type AdminEmailConfig = (
  {
    type: "standard" | "resend",
    senderName: string,
    senderEmail: string,
    host: string,
    port: number,
    username: string,
    password: string,
  }
  | {
    type: "shared",
  }
);

export type AdminDomainConfig = {
  domain: string,
  handlerPath: string,
};

export type AdminOAuthProviderConfig = {
  id: string,
} & (
    | { type: 'shared' }
    | {
      type: 'standard',
      clientId: string,
      clientSecret?: string,
      facebookConfigId?: string,
      microsoftTenantId?: string,
      appleTeamId?: string,
      appleKeyId?: string,
      applePrivateKey?: string,
      appleBundleIds?: string[],
    }
    | {
      type: 'custom_oidc',
      clientId: string,
      clientSecret: string,
      issuerUrl: string,
      scope?: string,
      displayName?: string,
    }
  ) & OAuthProviderConfig;

export type AdminProjectConfigUpdateOptions = {
  domains?: {
    domain: string,
    handlerPath: string,
  }[],
  oauthProviders?: AdminOAuthProviderConfig[],
  signUpEnabled?: boolean,
  credentialEnabled?: boolean,
  magicLinkEnabled?: boolean,
  passkeyEnabled?: boolean,
  clientTeamCreationEnabled?: boolean,
  clientUserDeletionEnabled?: boolean,
  allowLocalhost?: boolean,
  createTeamOnSignUp?: boolean,
  emailConfig?: AdminEmailConfig,
  emailTheme?: string,
  teamCreatorDefaultPermissions?: { id: string }[],
  teamMemberDefaultPermissions?: { id: string }[],
  userDefaultPermissions?: { id: string }[],
  oauthAccountMergeStrategy?: 'link_method' | 'raise_error' | 'allow_duplicates',
  allowUserApiKeys?: boolean,
  allowTeamApiKeys?: boolean,
};

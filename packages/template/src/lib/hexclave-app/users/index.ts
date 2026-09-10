import { KnownErrors } from "@hexclave/shared";
import { CurrentUserCrud } from "@hexclave/shared/dist/interface/crud/current-user";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import type { RestrictedReason } from "@hexclave/shared/dist/schema-fields";
import { InternalSession } from "@hexclave/shared/dist/sessions";
import { encodeBase64 } from "@hexclave/shared/dist/utils/bytes";
import { GeoInfo } from "@hexclave/shared/dist/utils/geo";
import { ReadonlyJson } from "@hexclave/shared/dist/utils/json";
import { ProviderType } from "@hexclave/shared/dist/utils/oauth";
import { Result } from "@hexclave/shared/dist/utils/results";
import { ApiKeyCreationOptions, UserApiKey, UserApiKeyFirstView } from "../api-keys";
import { AsyncStoreProperty, AuthLike } from "../common";
import { DeprecatedOAuthConnection, OAuthConnection } from "../connected-accounts";
import { ContactChannel, ContactChannelCreateOptions, ServerContactChannel, ServerContactChannelCreateOptions } from "../contact-channels";
import { Customer } from "../customers";
import { NotificationCategory } from "../notification-categories";
import { AdminTeamPermission, TeamPermission } from "../permissions";
import { AdminOwnedProject, AdminProjectCreateOptions } from "../projects";
import { EditableTeamMemberProfile, ReceivedTeamInvitation, ServerListTeamsOptions, ServerTeam, ServerTeamCreateOptions, Team, TeamCreateOptions } from "../teams";

const userGetterErrorMessage = "Hexclave: useUser() already returns the user object. Use `const user = useUser()` (or `const user = await app.getUser()`) instead of destructuring it like `const { user } = ...`.";

export function withUserDestructureGuard<T extends object>(target: T): T {
  Object.freeze(target);
  return new Proxy(target, {
    get(target, prop, receiver) {
      if (prop === "user") {
        return guardGetter();
      }
      return target[prop as keyof T];
    },
  });
}

function guardGetter(): never {
  throw new Error(userGetterErrorMessage);
}

export type OAuthProvider = {
  readonly id: string,
  readonly type: string,
  readonly userId: string,
  readonly accountId?: string,
  readonly email?: string,
  readonly allowSignIn: boolean,
  readonly allowConnectedAccounts: boolean,
  update(data: { allowSignIn?: boolean, allowConnectedAccounts?: boolean }): Promise<Result<void,
    InstanceType<typeof KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn>
  >>,
  delete(): Promise<void>,
};

export type ServerOAuthProvider = {
  readonly id: string,
  readonly type: string,
  readonly userId: string,
  readonly accountId: string,
  readonly email?: string,
  readonly allowSignIn: boolean,
  readonly allowConnectedAccounts: boolean,
  update(data: { accountId?: string, email?: string, allowSignIn?: boolean, allowConnectedAccounts?: boolean }): Promise<Result<void,
    InstanceType<typeof KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn>
  >>,
  delete(): Promise<void>,
};


/**
 * Contains everything related to the current user session.
 */
export type Auth = AuthLike<{}> & {
  readonly _internalSession: InternalSession,
  readonly currentSession: {
    getTokens(): Promise<{ accessToken: string | null, refreshToken: string | null }>,
    useTokens(): { accessToken: string | null, refreshToken: string | null }, // THIS_LINE_PLATFORM react-like
  },
};

/**
 * ```
 * +----------+-------------+-------------------+
 * |    \     |   !Server   |      Server       |
 * +----------+-------------+-------------------+
 * | !Session | User        | ServerUser        |
 * | Session  | CurrentUser | CurrentServerUser |
 * +----------+-------------+-------------------+
 * ```
 *
 * The fields on each of these types are available iff:
 * BaseUser: true
 * Auth: Session
 * ServerBaseUser: Server
 * UserExtra: Session OR Server
 *
 * The types are defined as follows (in the typescript manner):
 * User = BaseUser
 * CurrentUser = BaseUser & Auth & UserExtra
 * ServerUser = BaseUser & ServerBaseUser & UserExtra
 * CurrentServerUser = BaseUser & ServerBaseUser & Auth & UserExtra
 **/

export type BaseUser = {
  readonly id: string,

  readonly displayName: string | null,

  /**
   * The user's email address.
   *
   * Note: This might NOT be unique across multiple users, so always use `id` for unique identification.
   */
  readonly primaryEmail: string | null,
  readonly primaryEmailVerified: boolean,
  readonly profileImageUrl: string | null,

  readonly signedUpAt: Date,

  readonly clientMetadata: any,
  readonly clientReadOnlyMetadata: any,

  /**
   * Whether the user has a password set.
   */
  readonly hasPassword: boolean,
  readonly otpAuthEnabled: boolean,
  readonly passkeyAuthEnabled: boolean,

  readonly isMultiFactorRequired: boolean,
  readonly isAnonymous: boolean,
  /**
   * Whether the user is in restricted state (signed up but hasn't completed onboarding requirements).
   * For example, if email verification is required but the user hasn't verified their email yet.
   */
  readonly isRestricted: boolean,
  /**
   * The reason why the user is restricted, e.g., { type: "email_not_verified" }, { type: "anonymous" }, or { type: "restricted_by_administrator" }.
   * Null if the user is not restricted.
   */
  readonly restrictedReason: RestrictedReason | null,
  /** Whether the user is restricted by an administrator. Can be set manually or by sign-up rules. */
  readonly restrictedByAdmin: boolean,
  /**
   * Public reason shown to the user explaining why an administrator restricted them, or null if none was given.
   *
   * This is intentionally readable by the user themselves (unlike `restrictedByAdminPrivateDetails`, which is
   * server-only), so onboarding screens can tell them why they can't continue.
   */
  readonly restrictedByAdminReason: string | null,
  toClientJson(): CurrentUserCrud["Client"]["Read"],

  /**
   * @deprecated, use contact channel's usedForAuth instead
   */
  readonly emailAuthEnabled: boolean,
  /**
   * @deprecated
   */
  readonly oauthProviders: readonly { id: string }[],
}

export type UserExtra = {
  setDisplayName(displayName: string | null): Promise<void>,
  /** @deprecated Use contact channel's sendVerificationEmail instead */
  sendVerificationEmail(): Promise<KnownErrors["EmailAlreadyVerified"] | void>,
  setClientMetadata(metadata: any): Promise<void>,
  updatePassword(options: { oldPassword: string, newPassword: string}): Promise<KnownErrors["PasswordConfirmationMismatch"] | KnownErrors["PasswordRequirementsNotMet"] | void>,
  setPassword(options: { password: string }): Promise<KnownErrors["PasswordRequirementsNotMet"] | void>,

  /**
   * A shorthand method to update multiple fields of the user at once.
   */
  update(update: UserUpdateOptions): Promise<void>,

  useContactChannels(): ContactChannel[], // THIS_LINE_PLATFORM react-like
  listContactChannels(): Promise<ContactChannel[]>,
  createContactChannel(data: ContactChannelCreateOptions): Promise<ContactChannel>,

  useNotificationCategories(): NotificationCategory[], // THIS_LINE_PLATFORM react-like
  listNotificationCategories(): Promise<NotificationCategory[]>,

  delete(): Promise<void>,

  /** @deprecated Use `getOrLinkConnectedAccount` for redirect behavior, or `getConnectedAccount({ provider, providerAccountId })` for existence check. */
  getConnectedAccount(id: ProviderType, options: { or: 'redirect', scopes?: string[] }): Promise<DeprecatedOAuthConnection>,
  /** @deprecated Use `getConnectedAccount({ provider, providerAccountId })` for existence check, or `getOrLinkConnectedAccount` for redirect behavior. */
  getConnectedAccount(id: ProviderType, options?: { or?: 'redirect' | 'throw' | 'return-null', scopes?: string[] }): Promise<DeprecatedOAuthConnection | null>,
  /** Get a specific connected account by provider and providerAccountId. Returns null if not found. */
  getConnectedAccount(account: { provider: string, providerAccountId: string }): Promise<OAuthConnection | null>,

  // IF_PLATFORM react-like
  /** @deprecated Use `useOrLinkConnectedAccount` for redirect behavior, or `useConnectedAccount({ provider, providerAccountId })` for existence check. */
  useConnectedAccount(id: ProviderType, options: { or: 'redirect', scopes?: string[] }): DeprecatedOAuthConnection,
  /** @deprecated Use `useConnectedAccount({ provider, providerAccountId })` for existence check, or `useOrLinkConnectedAccount` for redirect behavior. */
  useConnectedAccount(id: ProviderType, options?: { or?: 'redirect' | 'throw' | 'return-null', scopes?: string[] }): DeprecatedOAuthConnection | null,
  /** Get a specific connected account by provider and providerAccountId. Returns null if not found. */
  useConnectedAccount(account: { provider: string, providerAccountId: string }): OAuthConnection | null,
  // END_PLATFORM

  /** List all connected accounts for this user (only those with allowConnectedAccounts enabled). */
  listConnectedAccounts(): Promise<OAuthConnection[]>,
  /** React hook to list all connected accounts. */
  useConnectedAccounts(): OAuthConnection[], // THIS_LINE_PLATFORM react-like
  /** Redirect the user to the OAuth flow to link a new connected account. Always redirects, never returns. */
  linkConnectedAccount(provider: string, options?: { scopes?: string[] }): Promise<void>,
  /** Get a connected account for the given provider, or redirect to link one if none exists or the token/scopes are insufficient. */
  getOrLinkConnectedAccount(provider: string, options?: { scopes?: string[] }): Promise<OAuthConnection>,
  /** React hook: get a connected account for the given provider, or redirect to link one if none exists or the token/scopes are insufficient. */
  useOrLinkConnectedAccount(provider: string, options?: { scopes?: string[] }): OAuthConnection, // THIS_LINE_PLATFORM react-like

  hasPermission(scope: Team, permissionId: string): Promise<boolean>,
  hasPermission(permissionId: string): Promise<boolean>,

  getPermission(scope: Team, permissionId: string): Promise<TeamPermission | null>,
  getPermission(permissionId: string): Promise<TeamPermission | null>,

  listPermissions(scope: Team, options?: { recursive?: boolean }): Promise<TeamPermission[]>,
  listPermissions(options?: { recursive?: boolean }): Promise<TeamPermission[]>,

  // IF_PLATFORM react-like
  usePermissions(scope: Team, options?: { recursive?: boolean }): TeamPermission[],
  usePermissions(options?: { recursive?: boolean }): TeamPermission[],

  usePermission(scope: Team, permissionId: string): TeamPermission | null,
  usePermission(permissionId: string): TeamPermission | null,
  // END_PLATFORM

  readonly selectedTeam: Team | null,
  setSelectedTeam(teamOrId: string | Team | null): Promise<void>,
  createTeam(data: TeamCreateOptions): Promise<Team>,
  leaveTeam(team: Team): Promise<void>,

  /**
   * Lists all pending team invitations sent to any of the current user's verified email addresses.
   *
   * This allows the user to discover which teams have invited them, even if they haven't
   * joined those teams yet. Only invitations sent to verified email addresses are included.
   *
   * @returns An array of `ReceivedTeamInvitation` objects, each containing the team ID, team
   * display name, recipient email, and expiration date.
   *
   * @example
   * ```ts
   * const invitations = await user.listTeamInvitations();
   * for (const invitation of invitations) {
   *   console.log(`Invited to ${invitation.teamDisplayName} via ${invitation.recipientEmail}`);
   * }
   * ```
   */
  listTeamInvitations(): Promise<ReceivedTeamInvitation[]>,
  /**
   * Lists all pending team invitations sent to any of the current user's verified email addresses.
   *
   * React hook version of `listTeamInvitations()`. Automatically re-renders when invitations change.
   */
  useTeamInvitations(): ReceivedTeamInvitation[], // THIS_LINE_PLATFORM react-like

  getActiveSessions(): Promise<ActiveSession[]>,
  revokeSession(sessionId: string): Promise<void>,
  getTeamProfile(team: Team): Promise<EditableTeamMemberProfile>,
  useTeamProfile(team: Team): EditableTeamMemberProfile, // THIS_LINE_PLATFORM react-like

  createApiKey(options: ApiKeyCreationOptions<"user">): Promise<UserApiKeyFirstView>,

  useOAuthProviders(): OAuthProvider[], // THIS_LINE_PLATFORM react-like
  listOAuthProviders(): Promise<OAuthProvider[]>,

  useOAuthProvider(id: string): OAuthProvider | null, // THIS_LINE_PLATFORM react-like
  getOAuthProvider(id: string): Promise<OAuthProvider | null>,

  registerPasskey(options?: { hostname?: string }): Promise<Result<undefined, KnownErrors["PasskeyRegistrationFailed"] | KnownErrors["PasskeyWebAuthnError"]>>,
}
& AsyncStoreProperty<"apiKeys", [], UserApiKey[], true>
& AsyncStoreProperty<"team", [id: string], Team | null, false>
& AsyncStoreProperty<"teams", [], Team[], true>
& AsyncStoreProperty<"teamInvitations", [], ReceivedTeamInvitation[], true>
& AsyncStoreProperty<"permission", [scope: Team, permissionId: string, options?: { recursive?: boolean }], TeamPermission | null, false>
& AsyncStoreProperty<"permissions", [scope: Team, options?: { recursive?: boolean }], TeamPermission[], true>;

export type InternalUserExtra =
  & {
    createProject(newProject: AdminProjectCreateOptions): Promise<AdminOwnedProject>,
    transferProject(projectIdToTransfer: string, newTeamId: string): Promise<void>,
  }
  & AsyncStoreProperty<"ownedProjects", [], AdminOwnedProject[], true>

export type User = BaseUser;

export type CurrentUser = BaseUser & Auth & UserExtra & Customer;

export type CurrentInternalUser = CurrentUser & InternalUserExtra;

export type ProjectCurrentUser<ProjectId> = ProjectId extends "internal" ? CurrentInternalUser : CurrentUser;

export type TokenPartialUser = Pick<
  User,
  | "id"
  | "displayName"
  | "primaryEmail"
  | "primaryEmailVerified"
  | "isAnonymous"
  | "isMultiFactorRequired"
  | "isRestricted"
  | "restrictedReason"
>

export type SyncedPartialUser = TokenPartialUser & Pick<
  User,
  | "id"
  | "displayName"
  | "primaryEmail"
  | "primaryEmailVerified"
  | "profileImageUrl"
  | "signedUpAt"
  | "clientMetadata"
  | "clientReadOnlyMetadata"
  | "isAnonymous"
  | "hasPassword"
  | "isRestricted"
  | "restrictedReason"
>;


export type ActiveSession = {
  id: string,
  userId: string,
  createdAt: Date,
  isImpersonation: boolean,
  lastUsedAt: Date | undefined,
  isCurrentSession: boolean,
  geoInfo?: GeoInfo,
};

export type UserUpdateOptions = {
  displayName?: string | null,
  clientMetadata?: ReadonlyJson,
  selectedTeamId?: string | null,
  totpMultiFactorSecret?: Uint8Array | null,
  profileImageUrl?: string | null,
  otpAuthEnabled?: boolean,
  passkeyAuthEnabled?: boolean,
  primaryEmail?: string | null,
}
export function userUpdateOptionsToCrud(options: UserUpdateOptions): CurrentUserCrud["Client"]["Update"] {
  return {
    display_name: options.displayName,
    client_metadata: options.clientMetadata,
    selected_team_id: options.selectedTeamId,
    totp_secret_base64: options.totpMultiFactorSecret != null ? encodeBase64(options.totpMultiFactorSecret) : options.totpMultiFactorSecret,
    profile_image_url: options.profileImageUrl,
    otp_auth_enabled: options.otpAuthEnabled,
    passkey_auth_enabled: options.passkeyAuthEnabled,
    primary_email: options.primaryEmail,
  };
}


export type ServerBaseUser = {
  setPrimaryEmail(email: string | null, options?: { verified?: boolean | undefined }): Promise<void>,

  readonly lastActiveAt: Date,

  readonly serverMetadata: any,
  setServerMetadata(metadata: any): Promise<void>,
  setClientReadOnlyMetadata(metadata: any): Promise<void>,

  /** Private details about the restriction (e.g., which sign-up rule triggered). Only visible to server access and above. */
  readonly restrictedByAdminPrivateDetails: string | null,
  /** Best-effort ISO country code captured at sign-up time from request geo headers. */
  readonly countryCode: string | null,
  /** Server-only risk scores used during sign-up risk evaluation. */
  readonly riskScores: {
    readonly signUp: {
      readonly bot: number,
      readonly freeTrialAbuse: number,
    },
  },

  createTeam(data: Omit<ServerTeamCreateOptions, "creatorUserId">): Promise<ServerTeam>,

  useContactChannels(): ServerContactChannel[], // THIS_LINE_PLATFORM react-like
  listContactChannels(): Promise<ServerContactChannel[]>,
  createContactChannel(data: ServerContactChannelCreateOptions): Promise<ServerContactChannel>,

  update(user: ServerUserUpdateOptions): Promise<void>,

  grantPermission(scope: Team, permissionId: string): Promise<void>,
  grantPermission(permissionId: string): Promise<void>,

  revokePermission(scope: Team, permissionId: string): Promise<void>,
  revokePermission(permissionId: string): Promise<void>,

  getPermission(scope: Team, permissionId: string): Promise<TeamPermission | null>,
  getPermission(permissionId: string): Promise<TeamPermission | null>,

  hasPermission(scope: Team, permissionId: string): Promise<boolean>,
  hasPermission(permissionId: string): Promise<boolean>,

  listPermissions(scope: Team, options?: { recursive?: boolean }): Promise<TeamPermission[]>,
  listPermissions(options?: { recursive?: boolean }): Promise<TeamPermission[]>,

  // IF_PLATFORM react-like
  usePermissions(scope: Team, options?: { recursive?: boolean }): TeamPermission[],
  usePermissions(options?: { recursive?: boolean }): TeamPermission[],

  usePermission(scope: Team, permissionId: string): TeamPermission | null,
  usePermission(permissionId: string): TeamPermission | null,
  // END_PLATFORM

  useOAuthProviders(): ServerOAuthProvider[], // THIS_LINE_PLATFORM react-like
  listOAuthProviders(): Promise<ServerOAuthProvider[]>,

  useOAuthProvider(id: string): ServerOAuthProvider | null, // THIS_LINE_PLATFORM react-like
  getOAuthProvider(id: string): Promise<ServerOAuthProvider | null>,

  /**
   * Creates a new session object with a refresh token for this user. Can be used to impersonate them.
   */
  createSession(options?: { expiresInMillis?: number, isImpersonation?: boolean, reason?: string | null }): Promise<{
    getTokens(): Promise<{ accessToken: string | null, refreshToken: string | null }>,
  }>,
}
& AsyncStoreProperty<"team", [id: string], ServerTeam | null, false>
& AsyncStoreProperty<"teams", [options?: ServerListTeamsOptions], ServerTeam[] & { nextCursor: string | null }, true>
& AsyncStoreProperty<"permission", [scope: Team, permissionId: string, options?: { direct?: boolean }], AdminTeamPermission | null, false>
& AsyncStoreProperty<"permissions", [scope: Team, options?: { direct?: boolean }], AdminTeamPermission[], true>;

/**
 * A user including sensitive fields that should only be used on the server, never sent to the client
 * (such as sensitive information and serverMetadata).
 */
export type ServerUser = ServerBaseUser & BaseUser & UserExtra & Customer<true>;

export type CurrentServerUser = Auth & ServerUser;

export type CurrentInternalServerUser = CurrentServerUser & InternalUserExtra;

export type ProjectCurrentServerUser<ProjectId> = ProjectId extends "internal" ? CurrentInternalServerUser : CurrentServerUser;

export type SyncedPartialServerUser = SyncedPartialUser & Pick<
  ServerUser,
  | "serverMetadata"
>;

export type ServerUserUpdateOptions = {
  primaryEmail?: string | null,
  primaryEmailVerified?: boolean,
  primaryEmailAuthEnabled?: boolean,
  clientReadOnlyMetadata?: ReadonlyJson,
  serverMetadata?: ReadonlyJson,
  password?: string,
  restrictedByAdmin?: boolean,
  restrictedByAdminReason?: string | null,
  restrictedByAdminPrivateDetails?: string | null,
  countryCode?: string | null,
  riskScores?: {
    signUp: {
      bot: number,
      freeTrialAbuse: number,
    },
  },
} & UserUpdateOptions;
export function serverUserUpdateOptionsToCrud(options: ServerUserUpdateOptions): CurrentUserCrud["Server"]["Update"] {
  // Base update options
  const baseUpdate: CurrentUserCrud["Server"]["Update"] = {
    display_name: options.displayName,
    primary_email: options.primaryEmail,
    client_metadata: options.clientMetadata,
    client_read_only_metadata: options.clientReadOnlyMetadata,
    server_metadata: options.serverMetadata,
    selected_team_id: options.selectedTeamId,
    primary_email_auth_enabled: options.primaryEmailAuthEnabled,
    primary_email_verified: options.primaryEmailVerified,
    password: options.password,
    profile_image_url: options.profileImageUrl,
    totp_secret_base64: options.totpMultiFactorSecret != null ? encodeBase64(options.totpMultiFactorSecret) : options.totpMultiFactorSecret,
  };
  return {
    ...baseUpdate,
    restricted_by_admin: options.restrictedByAdmin,
    restricted_by_admin_reason: options.restrictedByAdminReason,
    restricted_by_admin_private_details: options.restrictedByAdminPrivateDetails,
    country_code: options.countryCode,
    risk_scores: options.riskScores ? {
      sign_up: {
        bot: options.riskScores.signUp.bot,
        free_trial_abuse: options.riskScores.signUp.freeTrialAbuse,
      },
    } : undefined,
  };
}


export type ServerUserCreateOptions = {
  primaryEmail?: string | null,
  primaryEmailAuthEnabled?: boolean,
  password?: string,
  otpAuthEnabled?: boolean,
  displayName?: string,
  primaryEmailVerified?: boolean,
  clientMetadata?: any,
  clientReadOnlyMetadata?: any,
  serverMetadata?: any,
  countryCode?: string | null,
  riskScores?: {
    signUp: {
      bot: number,
      freeTrialAbuse: number,
    },
  },
}
export function serverUserCreateOptionsToCrud(options: ServerUserCreateOptions): UsersCrud["Server"]["Create"] {
  return {
    primary_email: options.primaryEmail,
    password: options.password,
    otp_auth_enabled: options.otpAuthEnabled,
    primary_email_auth_enabled: options.primaryEmailAuthEnabled,
    display_name: options.displayName,
    primary_email_verified: options.primaryEmailVerified,
    client_metadata: options.clientMetadata,
    client_read_only_metadata: options.clientReadOnlyMetadata,
    server_metadata: options.serverMetadata,
    country_code: options.countryCode,
    risk_scores: options.riskScores ? {
      sign_up: {
        bot: options.riskScores.signUp.bot,
        free_trial_abuse: options.riskScores.signUp.freeTrialAbuse,
      },
    } : undefined,
  };
}

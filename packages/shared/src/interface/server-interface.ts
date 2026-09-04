import * as yup from "yup";
import { decryptValue, encryptValue, hashKey } from "../helpers/vault/client-side";
import { KnownErrors } from "../known-errors";
import { inlineProductSchema } from "../schema-fields";
import { AccessToken, InternalSession, RefreshToken } from "../sessions";
import { HexclaveAssertionError } from "../utils/errors";
import { filterUndefined } from "../utils/objects";
import { Result } from "../utils/results";
import { urlString } from "../utils/urls";
import {
  ClientInterfaceOptions,
  HexclaveClientInterface
} from "./client-interface";
import type { AnalyticsQueryOptions, AnalyticsQueryResponse } from "./crud/analytics";
import type {
  AdminGetSessionReplayAllEventsResponse,
  AdminGetSessionReplayChunkEventsResponse,
  AdminGetSessionReplayResponse,
  AdminListSessionReplayChunksOptions,
  AdminListSessionReplayChunksResponse,
  AdminListSessionReplaysOptions,
  AdminListSessionReplaysResponse
} from "./crud/session-replays";
import { ConnectedAccountAccessTokenCrud, ConnectedAccountCrud } from "./crud/connected-accounts";
import { ContactChannelsCrud } from "./crud/contact-channels";
import { CurrentUserCrud } from "./crud/current-user";
import { ItemCrud } from "./crud/items";
import { NotificationPreferenceCrud } from "./crud/notification-preferences";
import { OAuthProviderCrud } from "./crud/oauth-providers";
import { ProjectPermissionsCrud } from "./crud/project-permissions";
import { SessionsCrud } from "./crud/sessions";
import { TeamInvitationCrud } from "./crud/team-invitation";
import { TeamMemberProfilesCrud } from "./crud/team-member-profiles";
import { TeamMembershipsCrud } from "./crud/team-memberships";
import { TeamPermissionsCrud } from "./crud/team-permissions";
import { TeamsCrud } from "./crud/teams";
import { UsersCrud } from "./crud/users";

export type ServerAuthApplicationOptions = (
  & ClientInterfaceOptions
  & (
    | {
      readonly secretServerKey: string,
    }
    | {
      readonly projectOwnerSession: InternalSession | (() => Promise<string | null>),
    }
  )
);

export class HexclaveServerInterface extends HexclaveClientInterface {
  constructor(public override options: ServerAuthApplicationOptions) {
    super(options);
  }

  protected async sendServerRequest(path: string, options: RequestInit, session: InternalSession | null, requestType: "server" | "admin" = "server") {
    return await this.sendClientRequest(
      path,
      {
        ...options,
        headers: {
          // Hexclave rebrand: emit x-hexclave-* request header; the backend proxy dual-accepts both names.
          "x-hexclave-secret-server-key": "secretServerKey" in this.options ? this.options.secretServerKey : "",
          ...options.headers,
        },
      },
      session,
      requestType,
    );
  }

  override async getCustomerBilling(
    customerType: "user" | "team",
    customerId: string,
    session: InternalSession | null,
  ): Promise<{
    has_customer: boolean,
    default_payment_method: {
      id: string,
      brand: string | null,
      last4: string | null,
      exp_month: number | null,
      exp_year: number | null,
    } | null,
  }> {
    const response = await this.sendServerRequest(
      urlString`/payments/billing/${customerType}/${customerId}`,
      {},
      session,
    );
    return await response.json();
  }

  override async createCustomerPaymentMethodSetupIntent(
    customerType: "user" | "team",
    customerId: string,
    session: InternalSession | null,
  ): Promise<{
    client_secret: string,
    stripe_account_id: string,
  }> {
    const response = await this.sendServerRequest(
      urlString`/payments/payment-method/${customerType}/${customerId}/setup-intent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      session,
    );
    return await response.json();
  }

  override async setDefaultCustomerPaymentMethodFromSetupIntent(
    customerType: "user" | "team",
    customerId: string,
    setupIntentId: string,
    session: InternalSession | null,
  ): Promise<{
    default_payment_method: {
      id: string,
      brand: string | null,
      last4: string | null,
      exp_month: number | null,
      exp_year: number | null,
    },
  }> {
    const response = await this.sendServerRequest(
      urlString`/payments/payment-method/${customerType}/${customerId}/set-default`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          setup_intent_id: setupIntentId,
        }),
      },
      session,
    );
    return await response.json();
  }


  protected async sendServerRequestAndCatchKnownError<E extends typeof KnownErrors[keyof KnownErrors]>(
    path: string,
    requestOptions: RequestInit,
    tokenStoreOrNull: InternalSession | null,
    errorsToCatch: readonly E[],
  ): Promise<Result<
    Response & {
      usedTokens: {
        accessToken: AccessToken,
        refreshToken: RefreshToken | null,
      } | null,
    },
    InstanceType<E>
  >> {
    try {
      return Result.ok(await this.sendServerRequest(path, requestOptions, tokenStoreOrNull));
    } catch (e) {
      for (const errorType of errorsToCatch) {
        if (errorType.isInstance(e)) {
          return Result.error(e as InstanceType<E>);
        }
      }
      throw e;
    }
  }

  async createServerUser(data: UsersCrud['Server']['Create']): Promise<UsersCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      "/users",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async getServerUserByToken(session: InternalSession): Promise<CurrentUserCrud['Server']['Read'] | null> {
    const responseOrError = await this.sendServerRequestAndCatchKnownError(
      "/users/me",
      {},
      session,
      [KnownErrors.CannotGetOwnUserWithoutUser],
    );
    if (responseOrError.status === "error") {
      if (KnownErrors.CannotGetOwnUserWithoutUser.isInstance(responseOrError.error)) {
        return null;
      } else {
        throw new HexclaveAssertionError("Unexpected uncaught error", { cause: responseOrError.error });
      }
    }
    const response = responseOrError.data;
    const user: CurrentUserCrud['Server']['Read'] = await response.json();
    if (!(user as any)) throw new HexclaveAssertionError("User endpoint returned null; this should never happen");
    return user;
  }

  async getServerUserById(userId: string): Promise<Result<UsersCrud['Server']['Read']>> {
    const responseOrError = await this.sendServerRequestAndCatchKnownError(
      urlString`/users/${userId}`,
      {},
      null,
      [KnownErrors.UserNotFound],
    );
    if (responseOrError.status === "error") {
      return Result.error(responseOrError.error);
    }
    const user: UsersCrud['Server']['Read'] = await responseOrError.data.json();
    return Result.ok(user);
  }

  async listServerTeamInvitations(options: {
    teamId: string,
  }): Promise<TeamInvitationCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(
      urlString`/team-invitations?team_id=${options.teamId}`,
      {},
      null,
    );
    const result = await response.json() as TeamInvitationCrud['Server']['List'];
    return result.items;
  }

  async revokeServerTeamInvitation(invitationId: string, teamId: string) {
    await this.sendServerRequest(
      urlString`/team-invitations/${invitationId}?team_id=${teamId}`,
      { method: "DELETE" },
      null,
    );
  }

  async listServerTeamMemberProfiles(
    options: {
      teamId: string,
    },
  ): Promise<TeamMemberProfilesCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(
      urlString`/team-member-profiles?team_id=${options.teamId}`,
      {},
      null,
    );
    const result = await response.json() as TeamMemberProfilesCrud['Server']['List'];
    return result.items;
  }

  async getServerTeamMemberProfile(
    options: {
      teamId: string,
      userId: string,
    },
  ): Promise<TeamMemberProfilesCrud['Client']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/team-member-profiles/${options.teamId}/${options.userId}`,
      {},
      null,
    );
    return await response.json();
  }

  async listServerTeamPermissions(
    options: {
      userId?: string,
      teamId?: string,
      recursive: boolean,
    },
    session: InternalSession | null,
  ): Promise<TeamPermissionsCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(
      `/team-permissions?${new URLSearchParams(filterUndefined({
        user_id: options.userId,
        team_id: options.teamId,
        recursive: options.recursive.toString(),
      }))}`,
      {},
      session,
    );
    const result = await response.json() as TeamPermissionsCrud['Server']['List'];
    return result.items;
  }

  async listServerProjectPermissions(
    options: {
      userId?: string,
      recursive: boolean,
    },
    session: InternalSession | null,
  ): Promise<ProjectPermissionsCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(
      `/project-permissions?${new URLSearchParams(filterUndefined({
        user_id: options.userId,
        recursive: options.recursive.toString(),
      }))}`,
      {},
      session,
    );
    const result = await response.json() as ProjectPermissionsCrud['Server']['List'];
    return result.items;
  }

  async listServerUsers(options: (
    & {
      cursor?: string,
      limit?: number,
      orderBy?: 'signedUpAt' | 'lastActiveAt',
      desc?: boolean,
      query?: string,
      excludedEmailDomains?: string[],
      includeRestricted?: boolean,
      teamId?: string,
    }
    & (
      {
        includeAnonymous?: boolean,
        onlyAnonymous?: false,
      }
      | {
        includeAnonymous: true,
        onlyAnonymous: true,
      }
    )
  )): Promise<UsersCrud['Server']['List']> {
    const searchParams = new URLSearchParams(filterUndefined({
      cursor: options.cursor,
      limit: options.limit?.toString(),
      desc: options.desc?.toString(),
      team_id: options.teamId,
      ...options.orderBy ? {
        order_by: {
          signedUpAt: "signed_up_at",
          lastActiveAt: "last_active_at",
        }[options.orderBy],
      } : {},
      ...options.query ? {
        query: options.query,
      } : {},
      ...options.excludedEmailDomains && options.excludedEmailDomains.length > 0 ? {
        excluded_email_domains: options.excludedEmailDomains.join(","), // backend expects comma-separated list of domains.
      } : {},
      ...options.includeRestricted ? {
        include_restricted: 'true',
      } : {},
      ...options.includeAnonymous ? {
        include_anonymous: 'true',
      } : {},
      ...options.onlyAnonymous ? {
        only_anonymous: 'true',
      } : {},
    }));
    const response = await this.sendServerRequest("/users?" + searchParams.toString(), {}, null);
    return await response.json();
  }

  async listServerTeams(options?: {
    userId?: string,
  }): Promise<TeamsCrud['Server']['Read'][]> {
    const result = await this.listServerTeamsPaginated(options);
    return result.items;
  }

  async listServerTeamsPaginated(options?: {
    userId?: string,
    orderBy?: 'createdAt',
    desc?: boolean,
    cursor?: string,
    limit?: number,
    query?: string,
  }): Promise<TeamsCrud['Server']['List']> {
    const response = await this.sendServerRequest(
      `/teams?${new URLSearchParams(filterUndefined({
        user_id: options?.userId,
        // SDK option uses camelCase `createdAt`; backend uses snake_case.
        order_by: options?.orderBy === 'createdAt' ? 'created_at' : options?.orderBy,
        desc: options?.desc !== undefined ? String(options.desc) : undefined,
        cursor: options?.cursor,
        limit: options?.limit?.toString(),
        query: options?.query,
      }))}`,
      {},
      null
    );
    return await response.json() as TeamsCrud['Server']['List'];
  }

  async getServerTeam(teamId: string): Promise<TeamsCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      `/teams/${teamId}`,
      {},
      null
    );
    return await response.json();
  }

  async listServerTeamUsers(teamId: string): Promise<UsersCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(`/users?team_id=${teamId}`, {}, null);
    const result = await response.json() as UsersCrud['Server']['List'];
    return result.items;
  }

  /* when passing a session, the user will be added to the team */
  async createServerTeam(data: TeamsCrud['Server']['Create']): Promise<TeamsCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      "/teams",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null
    );
    return await response.json();
  }

  async updateServerTeam(teamId: string, data: TeamsCrud['Server']['Update']): Promise<TeamsCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/teams/${teamId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async deleteServerTeam(teamId: string): Promise<void> {
    await this.sendServerRequest(
      urlString`/teams/${teamId}`,
      { method: "DELETE" },
      null,
    );
  }

  async addServerUserToTeam(options: {
    userId: string,
    teamId: string,
  }): Promise<TeamMembershipsCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/team-memberships/${options.teamId}/${options.userId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
    return await response.json();
  }

  async removeServerUserFromTeam(options: {
    userId: string,
    teamId: string,
  }) {
    await this.sendServerRequest(
      urlString`/team-memberships/${options.teamId}/${options.userId}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
  }

  async listServerUserTeamInvitations(userId: string): Promise<TeamInvitationCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(
      "/team-invitations?" + new URLSearchParams({ user_id: userId }),
      {},
      null,
    );
    const result = await response.json() as TeamInvitationCrud['Server']['List'];
    return result.items;
  }

  async acceptServerTeamInvitationById(
    invitationId: string,
    userId: string,
  ) {
    await this.sendServerRequest(
      urlString`/team-invitations/${invitationId}/accept` + "?" + new URLSearchParams({ user_id: userId }),
      { method: "POST" },
      null,
    );
  }

  async updateServerUser(userId: string, update: UsersCrud['Server']['Update']): Promise<UsersCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/users/${userId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(update),
      },
      null,
    );
    return await response.json();
  }

  async createServerProviderAccessToken(
    userId: string,
    provider: string,
    scope: string,
  ): Promise<ConnectedAccountAccessTokenCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/connected-accounts/${userId}/${provider}/access-token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope }),
      },
      null,
    );
    return await response.json();
  }

  /**
   * Get access token for a specific connected account by provider ID and provider account ID.
   * This is the preferred method when dealing with multiple accounts of the same provider.
   */
  async createServerProviderAccessTokenByAccount(
    userId: string,
    providerId: string,
    providerAccountId: string,
    scope: string,
  ): Promise<ConnectedAccountAccessTokenCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/connected-accounts/${userId}/${providerId}/${providerAccountId}/access-token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ scope }),
      },
      null,
    );
    return await response.json();
  }

  /**
   * List all connected accounts for a user.
   */
  async listServerConnectedAccounts(
    userId: string,
  ): Promise<ConnectedAccountCrud['Server']['List']> {
    const response = await this.sendServerRequest(
      urlString`/connected-accounts/${userId}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async createServerUserSession(
    userId: string,
    expiresInMillis: number,
    isImpersonation: boolean,
    reason?: string | null,
  ): Promise<{ accessToken: string, refreshToken: string }> {
    const response = await this.sendServerRequest(
      "/auth/sessions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          user_id: userId,
          expires_in_millis: expiresInMillis,
          is_impersonation: isImpersonation,
          ...(reason != null && reason.trim() !== "" ? { reason: reason.trim() } : {}),
        }),
      },
      null,
    );
    const result = await response.json();
    return {
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
    };
  }

  async leaveServerTeam(
    options: {
      teamId: string,
      userId: string,
    },
  ) {
    await this.sendClientRequest(
      urlString`/team-memberships/${options.teamId}/${options.userId}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
  }

  async updateServerTeamMemberProfile(options: {
    teamId: string,
    userId: string,
    profile: TeamMemberProfilesCrud['Server']['Update'],
  }) {
    await this.sendServerRequest(
      urlString`/team-member-profiles/${options.teamId}/${options.userId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(options.profile),
      },
      null,
    );
  }

  async grantServerTeamUserPermission(teamId: string, userId: string, permissionId: string) {
    await this.sendServerRequest(
      urlString`/team-permissions/${teamId}/${userId}/${permissionId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
  }

  async grantServerProjectPermission(userId: string, permissionId: string) {
    await this.sendServerRequest(
      urlString`/project-permissions/${userId}/${permissionId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
  }

  async revokeServerTeamUserPermission(teamId: string, userId: string, permissionId: string) {
    await this.sendServerRequest(
      urlString`/team-permissions/${teamId}/${userId}/${permissionId}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
  }

  async revokeServerProjectPermission(userId: string, permissionId: string) {
    await this.sendServerRequest(
      urlString`/project-permissions/${userId}/${permissionId}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
  }

  async deleteServerUser(userId: string) {
    await this.sendServerRequest(
      urlString`/users/${userId}`,
      {
        method: "DELETE",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({}),
      },
      null,
    );
  }

  async createServerContactChannel(
    data: ContactChannelsCrud['Server']['Create'],
  ): Promise<ContactChannelsCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      "/contact-channels",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async updateServerContactChannel(
    userId: string,
    contactChannelId: string,
    data: ContactChannelsCrud['Server']['Update'],
  ): Promise<ContactChannelsCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/contact-channels/${userId}/${contactChannelId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async deleteServerContactChannel(
    userId: string,
    contactChannelId: string,
  ): Promise<void> {
    await this.sendServerRequest(
      urlString`/contact-channels/${userId}/${contactChannelId}`,
      {
        method: "DELETE",
      },
      null,
    );
  }

  async listServerContactChannels(
    userId: string,
  ): Promise<ContactChannelsCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(
      urlString`/contact-channels?user_id=${userId}`,
      {
        method: "GET",
      },
      null,
    );
    const json = await response.json() as ContactChannelsCrud['Server']['List'];
    return json.items;
  }

  async listServerNotificationCategories(
    userId: string,
  ): Promise<NotificationPreferenceCrud['Server']['Read'][]> {
    const response = await this.sendServerRequest(
      urlString`/emails/notification-preference/${userId}`,
      {
        method: "GET",
      },
      null,
    );
    const json = await response.json() as NotificationPreferenceCrud['Server']['List'];
    return json.items;
  }

  async setServerNotificationsEnabled(
    userId: string,
    notificationCategoryId: string,
    enabled: boolean,
  ): Promise<void> {
    await this.sendServerRequest(
      urlString`/emails/notification-preference/${userId}/${notificationCategoryId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          enabled,
        }),
      },
      null,
    );
  }

  async sendServerContactChannelVerificationEmail(
    userId: string,
    contactChannelId: string,
    callbackUrl: string,
  ): Promise<void> {
    await this.sendServerRequest(
      urlString`/contact-channels/${userId}/${contactChannelId}/send-verification-code`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ callback_url: callbackUrl }),
      },
      null,
    );
  }


  async listServerSessions(userId: string): Promise<SessionsCrud['Server']['List']> {
    const response = await this.sendServerRequest(
      urlString`/auth/sessions?user_id=${userId}`,
      {
        method: "GET",
      },
      null,
    );
    return await response.json();
  }

  async deleteServerSession(sessionId: string) {
    await this.sendServerRequest(
      urlString`/auth/sessions/${sessionId}`,
      {
        method: "DELETE",
      },
      null,
    );
  }


  async sendServerTeamInvitation(options: {
    email: string,
    teamId: string,
    callbackUrl: string,
  }): Promise<void> {
    await this.sendServerRequest(
      "/team-invitations/send-code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          email: options.email,
          team_id: options.teamId,
          callback_url: options.callbackUrl,
        }),
      },
      null,
    );
  }

  async updatePassword(
    options: { oldPassword: string, newPassword: string },
  ): Promise<KnownErrors["PasswordConfirmationMismatch"] | KnownErrors["PasswordRequirementsNotMet"] | undefined> {
    const res = await this.sendServerRequestAndCatchKnownError(
      "/auth/password/update",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          old_password: options.oldPassword,
          new_password: options.newPassword,
        }),
      },
      null,
      [KnownErrors.PasswordConfirmationMismatch, KnownErrors.PasswordRequirementsNotMet]
    );

    if (res.status === "error") {
      return res.error;
    }
  }

  // OAuth Providers CRUD operations
  async createServerOAuthProvider(
    data: OAuthProviderCrud['Server']['Create'],
  ): Promise<OAuthProviderCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      "/oauth-providers",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }


  async listServerOAuthProviders(
    options: {
      user_id?: string,
    } = {},
  ): Promise<OAuthProviderCrud['Server']['Read'][]> {
    const queryParams = new URLSearchParams(filterUndefined(options));
    const response = await this.sendServerRequest(
      `/oauth-providers${queryParams.toString() ? `?${queryParams.toString()}` : ''}`,
      {
        method: "GET",
      },
      null,
    );
    const result = await response.json();
    return result.items;
  }

  async updateServerOAuthProvider(
    userId: string,
    providerId: string,
    data: OAuthProviderCrud['Server']['Update'],
  ): Promise<OAuthProviderCrud['Server']['Read']> {
    const response = await this.sendServerRequest(
      urlString`/oauth-providers/${userId}/${providerId}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(data),
      },
      null,
    );
    return await response.json();
  }

  async deleteServerOAuthProvider(
    userId: string,
    providerId: string,
  ): Promise<void> {
    const response = await this.sendServerRequest(
      urlString`/oauth-providers/${userId}/${providerId}`,
      {
        method: "DELETE",
      },
      null,
    );
    return await response.json();
  }

  async sendEmail(options: {
    userIds?: string[],
    allUsers?: true,
    emails?: string[],
    themeId?: string | null | false,
    html?: string,
    subject?: string,
    notificationCategoryName?: string,
    templateId?: string,
    variables?: Record<string, any>,
    draftId?: string,
    scheduledAt?: Date,
  }): Promise<Result<void, KnownErrors["RequiresCustomEmailServer"] | KnownErrors["SchemaError"] | KnownErrors["UserIdDoesNotExist"]>> {
    const res = await this.sendServerRequest(
      "/emails/send-email",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          user_ids: options.userIds,
          all_users: options.allUsers,
          emails: options.emails,
          theme_id: options.themeId,
          html: options.html,
          subject: options.subject,
          notification_category_name: options.notificationCategoryName,
          template_id: options.templateId,
          variables: options.variables,
          draft_id: options.draftId,
          scheduled_at_millis: options.scheduledAt?.getTime(),
        }),
      },
      null,
    );
    return Result.ok(undefined);
  }

  async getEmailDeliveryInfo(): Promise<{
    stats: {
      hour: { sent: number, bounced: number, marked_as_spam: number },
      day: { sent: number, bounced: number, marked_as_spam: number },
      week: { sent: number, bounced: number, marked_as_spam: number },
      month: { sent: number, bounced: number, marked_as_spam: number },
    },
    capacity: {
      rate_per_second: number,
      boost_multiplier: number,
      penalty_factor: number,
      is_boost_active: boolean,
      boost_expires_at: string | null,
    },
  }> {
    const res = await this.sendServerRequest(
      "/emails/delivery-info",
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
        },
      },
      null,
    );
    return await res.json();
  }

  async activateEmailCapacityBoost(): Promise<{ expires_at: string }> {
    const res = await this.sendServerRequest(
      "/emails/capacity-boost",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({}),
      },
      null,
    );
    return await res.json();
  }

  async queryAnalytics(options: AnalyticsQueryOptions): Promise<AnalyticsQueryResponse> {
    const response = await this.sendServerRequest(
      "/analytics/query",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: options.query,
          params: options.params ?? {},
          timeout_ms: options.timeout_ms ?? 1000,
          include_all_branches: options.include_all_branches ?? false,
        }),
      },
      null,
    );

    return await response.json();
  }

  async updateItemQuantity(
    options: (
      { itemId: string, userId: string } |
      { itemId: string, teamId: string } |
      { itemId: string, customCustomerId: string }
    ),
    data: ItemCrud['Server']['Update'],
  ): Promise<void> {
    let customerType: "user" | "team" | "custom";
    let customerId: string;
    const itemId: string = options.itemId;

    if ("userId" in options) {
      customerType = "user";
      customerId = options.userId;
    } else if ("teamId" in options) {
      customerType = "team";
      customerId = options.teamId;
    } else if ("customCustomerId" in options) {
      customerType = "custom";
      customerId = options.customCustomerId;
    } else {
      throw new HexclaveAssertionError("updateItemQuantity requires one of userId, teamId, or customCustomerId");
    }

    const queryParams = new URLSearchParams({ allow_negative: (data.allow_negative ?? false).toString() });
    await this.sendServerRequest(
      `/payments/items/${customerType}/${customerId}/${itemId}/update-quantity?${queryParams.toString()}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delta: data.delta, expires_at: data.expires_at, description: data.description }),
      },
      null
    );
  }

  async grantProduct(
    options: {
      customerType: "user" | "team" | "custom",
      customerId: string,
      productId?: string,
      product?: yup.InferType<typeof inlineProductSchema>,
      quantity?: number,
    },
  ): Promise<void> {
    if (!options.productId && !options.product) {
      throw new HexclaveAssertionError("grantProduct requires either productId or product");
    }
    if (options.productId && options.product) {
      throw new HexclaveAssertionError("grantProduct should not receive both productId and product");
    }
    const body = filterUndefined({
      product_id: options.productId,
      product_inline: options.product,
      quantity: options.quantity,
    });
    await this.sendServerRequest(
      urlString`/payments/products/${options.customerType}/${options.customerId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      null,
    );
  }

  async getDataVaultStoreValue(secret: string, storeId: string, key: string) {
    const hashedKey = await hashKey(secret, key);
    const response = await this.sendServerRequestAndCatchKnownError(
      `/data-vault/stores/${storeId}/get`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hashed_key: hashedKey }),
      },
      null,
      [KnownErrors.DataVaultStoreHashedKeyDoesNotExist] as const,
    );
    if (response.status === "error") {
      if (KnownErrors.DataVaultStoreHashedKeyDoesNotExist.isInstance(response.error)) {
        return null;
      } else {
        throw new HexclaveAssertionError("Unexpected uncaught error", { cause: response.error });
      }
    }
    const json = await response.data.json();
    const encryptedValue = json.encrypted_value;
    if (typeof encryptedValue !== "string") throw new HexclaveAssertionError("encrypted_value is not a string", { type: typeof encryptedValue });
    return await decryptValue(secret, key, encryptedValue);
  }

  async setDataVaultStoreValue(secret: string, storeId: string, key: string, value: string) {
    const hashedKey = await hashKey(secret, key);
    const encryptedValue = await encryptValue(secret, key, value);
    await this.sendServerRequest(
      `/data-vault/stores/${storeId}/set`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hashed_key: hashedKey, encrypted_value: encryptedValue }),
      },
      null,
    );
  }

  async initiateServerPasskeyRegistration(userId: string): Promise<Result<{ options_json: any, code: string }, KnownErrors[]>> {
    // Create a temporary session for this user to use for passkey registration
    // TODO instead of creating a new session, this should just call the endpoint in a way in which it doesn't require a session
    // (currently this shows up on session history etc... not ideal)
    const { accessToken, refreshToken } = await this.createServerUserSession(userId, 60000 * 2, false); // 2 minute session
    const tempSession = new InternalSession({
      accessToken,
      refreshToken,
      refreshAccessTokenCallback: async () => null, // No refresh for temporary sessions
    });

    // Use the existing initiatePasskeyRegistration method with the temporary session
    return await this.initiatePasskeyRegistration({}, tempSession);
  }

  async listSessionReplays(params?: AdminListSessionReplaysOptions): Promise<AdminListSessionReplaysResponse> {
    const qs = new URLSearchParams();
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (typeof params?.limit === "number") qs.set("limit", String(params.limit));
    if (params?.user_ids && params.user_ids.length > 0) qs.set("user_ids", params.user_ids.join(","));
    if (params?.team_ids && params.team_ids.length > 0) qs.set("team_ids", params.team_ids.join(","));
    if (typeof params?.duration_ms_min === "number") qs.set("duration_ms_min", String(params.duration_ms_min));
    if (typeof params?.duration_ms_max === "number") qs.set("duration_ms_max", String(params.duration_ms_max));
    if (typeof params?.last_event_at_from_millis === "number") qs.set("last_event_at_from_millis", String(params.last_event_at_from_millis));
    if (typeof params?.last_event_at_to_millis === "number") qs.set("last_event_at_to_millis", String(params.last_event_at_to_millis));
    if (typeof params?.click_count_min === "number") qs.set("click_count_min", String(params.click_count_min));
    const response = await this.sendServerRequest(
      `/session-replays${qs.size ? `?${qs.toString()}` : ""}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async getSessionReplay(sessionReplayId: string): Promise<AdminGetSessionReplayResponse> {
    const response = await this.sendServerRequest(
      `/session-replays/${encodeURIComponent(sessionReplayId)}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async listSessionReplayChunks(sessionReplayId: string, params?: AdminListSessionReplayChunksOptions): Promise<AdminListSessionReplayChunksResponse> {
    const qs = new URLSearchParams();
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (typeof params?.limit === "number") qs.set("limit", String(params.limit));
    const response = await this.sendServerRequest(
      `/session-replays/${encodeURIComponent(sessionReplayId)}/chunks${qs.size ? `?${qs.toString()}` : ""}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async getSessionReplayChunkEvents(sessionReplayId: string, chunkId: string): Promise<AdminGetSessionReplayChunkEventsResponse> {
    const response = await this.sendServerRequest(
      `/session-replays/${encodeURIComponent(sessionReplayId)}/chunks/${encodeURIComponent(chunkId)}/events`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }

  async getSessionReplayEvents(sessionReplayId: string, options?: { offset?: number, limit?: number }): Promise<AdminGetSessionReplayAllEventsResponse> {
    const qs = new URLSearchParams();
    if (typeof options?.offset === "number") qs.set("offset", String(options.offset));
    if (typeof options?.limit === "number") qs.set("limit", String(options.limit));
    const response = await this.sendServerRequest(
      `/session-replays/${encodeURIComponent(sessionReplayId)}/events${qs.size ? `?${qs.toString()}` : ""}`,
      { method: "GET" },
      null,
    );
    return await response.json();
  }
}

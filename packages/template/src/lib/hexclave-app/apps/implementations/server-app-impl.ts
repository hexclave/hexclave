import { HexclaveServerInterface, KnownErrors } from "@hexclave/shared";
import type { AnalyticsQueryOptions, AnalyticsQueryResponse } from "@hexclave/shared/dist/interface/crud/analytics";
import type { AdminGetSessionReplayChunkEventsResponse } from "@hexclave/shared/dist/interface/crud/session-replays";
import type { AdminSessionReplay, AdminSessionReplayChunk, ListSessionReplayChunksOptions, ListSessionReplayChunksResult, ListSessionReplaysOptions, ListSessionReplaysResult, SessionReplayAllEventsResult } from "../../session-replays";
import { ContactChannelsCrud } from "@hexclave/shared/dist/interface/crud/contact-channels";
import { ItemCrud } from "@hexclave/shared/dist/interface/crud/items";
import { NotificationPreferenceCrud } from "@hexclave/shared/dist/interface/crud/notification-preferences";
import { OAuthProviderCrud } from "@hexclave/shared/dist/interface/crud/oauth-providers";
import type { CustomerProductsListResponse } from "@hexclave/shared/dist/interface/crud/products";
import { TeamApiKeysCrud, UserApiKeysCrud, teamApiKeysCreateOutputSchema, userApiKeysCreateOutputSchema } from "@hexclave/shared/dist/interface/crud/project-api-keys";
import { ProjectPermissionDefinitionsCrud, ProjectPermissionsCrud } from "@hexclave/shared/dist/interface/crud/project-permissions";
import { TeamInvitationCrud } from "@hexclave/shared/dist/interface/crud/team-invitation";
import { TeamMemberProfilesCrud } from "@hexclave/shared/dist/interface/crud/team-member-profiles";
import { TeamPermissionDefinitionsCrud, TeamPermissionsCrud } from "@hexclave/shared/dist/interface/crud/team-permissions";
import { TeamsCrud } from "@hexclave/shared/dist/interface/crud/teams";
import { UsersCrud } from "@hexclave/shared/dist/interface/crud/users";
import { InternalSession } from "@hexclave/shared/dist/sessions";
import type { AsyncCache } from "@hexclave/shared/dist/utils/caches";
import { HexclaveAssertionError, captureError, throwErr } from "@hexclave/shared/dist/utils/errors";
import { ProviderType } from "@hexclave/shared/dist/utils/oauth";
import { runAsynchronously } from "@hexclave/shared/dist/utils/promises";
import { suspend } from "@hexclave/shared/dist/utils/react";
import { Result } from "@hexclave/shared/dist/utils/results";
import { isUuid } from "@hexclave/shared/dist/utils/uuids";
import { WebAuthnError, startRegistration } from "@simplewebauthn/browser";
import { useMemo } from "react"; // THIS_LINE_PLATFORM react-like
import * as yup from "yup";
import { constructRedirectUrl } from "../../../../utils/url";
import { ApiKey, ApiKeyCreationOptions, ApiKeyUpdateOptions, apiKeyCreationOptionsToCrud, apiKeyUpdateOptionsToCrud } from "../../api-keys";
import { ConvexCtx, GetCurrentUserOptions } from "../../common";
import { DeprecatedOAuthConnection, OAuthConnection } from "../../connected-accounts";
import { ServerContactChannel, ServerContactChannelCreateOptions, ServerContactChannelUpdateOptions, serverContactChannelCreateOptionsToCrud, serverContactChannelUpdateOptionsToCrud } from "../../contact-channels";
import { Customer, CustomerProductsList, CustomerProductsRequestOptions, InlineProduct, ServerItem } from "../../customers";
import { DataVaultStore } from "../../data-vault";
import { EmailDeliveryInfo, SendEmailOptions } from "../../email";
import { NotificationCategory } from "../../notification-categories";
import { scopePasskeyRegistrationToHostname } from "../../passkey-rp-id";
import { AdminProjectPermissionDefinition, AdminTeamPermission, AdminTeamPermissionDefinition } from "../../permissions";
import { EditableTeamMemberProfile, ReceivedTeamInvitation, SentTeamInvitation, ServerListTeamsOptions, ServerListUsersOptions, ServerTeam, ServerTeamCreateOptions, ServerTeamUpdateOptions, ServerTeamUser, Team, serverTeamCreateOptionsToCrud, serverTeamUpdateOptionsToCrud } from "../../teams";
import { ProjectCurrentServerUser, ServerOAuthProvider, ServerUser, ServerUserCreateOptions, ServerUserUpdateOptions, serverUserCreateOptionsToCrud, serverUserUpdateOptionsToCrud, withUserDestructureGuard } from "../../users";
import { StackServerAppConstructorOptions } from "../interfaces/server-app";
import { _HexclaveClientAppImplIncomplete } from "./client-app-impl";
import { clientVersion, createCache, createCacheBySession, getDefaultExtraRequestHeaders, getDefaultProjectId, getDefaultPublishableClientKey, getDefaultSecretServerKey, resolveApiUrls, resolveConstructorOptions } from "./common";

import { useAsyncCache } from "./common"; // THIS_LINE_PLATFORM react-like

export class _HexclaveServerAppImplIncomplete<HasTokenStore extends boolean, ProjectId extends string> extends _HexclaveClientAppImplIncomplete<HasTokenStore, ProjectId> {
  declare protected _interface: HexclaveServerInterface;

  // TODO override the client user cache to use the server user cache, so we save some requests
  private readonly _currentServerUserCache = createCacheBySession(async (session) => {
    if (session.isKnownToBeInvalid()) {
      // see comment in _currentUserCache for more details on why we do this
      return null;
    }
    return await this._interface.getServerUserByToken(session);
  });
  private readonly _serverUsersCache = createCache<[
    cursor?: string,
    limit?: number,
    orderBy?: 'signedUpAt' | 'lastActiveAt',
    desc?: boolean,
    query?: string,
    includeRestricted?: boolean,
    includeAnonymous?: boolean,
    onlyAnonymous?: boolean,
    teamId?: string,
    excludedEmailDomains?: string,
  ], UsersCrud['Server']['List']>(async ([cursor, limit, orderBy, desc, query, includeRestricted, includeAnonymous, onlyAnonymous, teamId, excludedEmailDomains]) => {
    if (onlyAnonymous && !includeAnonymous) {
      throw new HexclaveAssertionError("onlyAnonymous=true requires includeAnonymous=true");
    }
    const excludedEmailDomainList = excludedEmailDomains?.split(",");
    if (onlyAnonymous) {
      return await this._interface.listServerUsers({ cursor, limit, orderBy, desc, query, excludedEmailDomains: excludedEmailDomainList, includeRestricted, includeAnonymous: true, onlyAnonymous: true, teamId });
    }
    return await this._interface.listServerUsers({ cursor, limit, orderBy, desc, query, excludedEmailDomains: excludedEmailDomainList, includeRestricted, includeAnonymous, teamId });
  });
  private readonly _serverUserCache = createCache<string[], UsersCrud['Server']['Read'] | null>(async ([userId]) => {
    const user = await this._interface.getServerUserById(userId);
    return Result.or(user, null);
  });
  private readonly _serverTeamsCache = createCache<[
    userId?: string,
    orderBy?: 'createdAt',
    desc?: boolean,
    cursor?: string,
    limit?: number,
    query?: string,
  ], TeamsCrud['Server']['List']>(async ([userId, orderBy, desc, cursor, limit, query]) => {
    return await this._interface.listServerTeamsPaginated({ userId, orderBy, desc, cursor, limit, query });
  });
  private readonly _serverTeamCache = createCache<string[], TeamsCrud['Server']['Read'] | null>(async ([teamId]) => {
    // The previous list-and-find implementation treated unknown or malformed IDs as null; preserve that behavior without making an invalid request.
    if (!isUuid(teamId)) {
      return null;
    }
    try {
      return await this._interface.getServerTeam(teamId);
    } catch (error) {
      if (KnownErrors.TeamNotFound.isInstance(error)) {
        return null;
      }
      throw error;
    }
  });

  protected async _refreshTeamMembership(teamId: string, userId: string) {
    await Promise.all([
      this._serverTeamMemberProfilesCache.refresh([teamId]),
      this._serverTeamsCache.refreshWhere(([u]) => u === userId || u === undefined),
      this._serverUsersCache.refreshWhere((key) => key[8] === teamId),
    ]);
  }
  private readonly _serverUserTeamInvitationsCache = createCache<string[], TeamInvitationCrud['Client']['Read'][]>(async ([userId]) => {
    return await this._interface.listServerUserTeamInvitations(userId);
  });
  private readonly _serverTeamUserPermissionsCache = createCache<
    [string, string, boolean],
    TeamPermissionsCrud['Server']['Read'][]
  >(async ([teamId, userId, recursive]) => {
    return await this._interface.listServerTeamPermissions({ teamId, userId, recursive }, null);
  });
  // Bulk variant: one request returning permissions for every member of a
  // team. Used by the dashboard's team-member table to avoid N per-row
  // calls. Keyed without userId so it's a distinct cache entry from the
  // per-user lookup above.
  private readonly _serverAllTeamMemberPermissionsCache = createCache<
    [string, boolean],
    TeamPermissionsCrud['Server']['Read'][]
  >(async ([teamId, recursive]) => {
    return await this._interface.listServerTeamPermissions({ teamId, recursive }, null);
  });
  private readonly _serverUserProjectPermissionsCache = createCache<
    [string, boolean],
    ProjectPermissionsCrud['Server']['Read'][]
  >(async ([userId, recursive]) => {
    return await this._interface.listServerProjectPermissions({ userId, recursive }, null);
  });
  /** @deprecated Used by legacy getConnectedAccount(providerId) — uses old per-provider access token endpoint */
  private readonly _serverUserOAuthConnectionAccessTokensCache = createCache<[string, string, string], { accessToken: string } | null>(
    async ([userId, providerId, scope]) => {
      try {
        const result = await this._interface.createServerProviderAccessToken(userId, providerId, scope || "");
        return { accessToken: result.access_token };
      } catch (err) {
        if (!(KnownErrors.OAuthAccessTokenNotAvailable.isInstance(err) || KnownErrors.OAuthConnectionDoesNotHaveRequiredScope.isInstance(err) || KnownErrors.OAuthConnectionNotConnectedToUser.isInstance(err))) {
          throw err;
        }
      }
      return null;
    }
  );
  /** @deprecated Used by legacy getConnectedAccount(providerId) — combines token check + redirect */
  private readonly _serverUserOAuthConnectionCache = createCache<[string, ProviderType, string, boolean], DeprecatedOAuthConnection | null>(
    async ([userId, providerId, scope, redirect]) => {
      return await this._getUserOAuthConnectionCacheFn({
        getUser: async () => Result.orThrow(await this._serverUserCache.getOrWait([userId], "write-only")),
        getOrWaitOAuthToken: async () => Result.orThrow(await this._serverUserOAuthConnectionAccessTokensCache.getOrWait([userId, providerId, scope || ""] as const, "write-only")),
        // IF_PLATFORM react-like
        useOAuthToken: () => useAsyncCache(this._serverUserOAuthConnectionAccessTokensCache, [userId, providerId, scope || ""] as const, "user.useConnectedAccount()"),
        // END_PLATFORM
        providerId,
        scope,
        redirect,
        session: null,
      });
    }
  );
  private readonly _serverUserConnectedAccountsCache = createCache<[string], OAuthConnection[]>(
    async ([userId]) => {
      const result = await this._interface.listServerConnectedAccounts(userId);
      return result.items.map((item) => this._createServerOAuthConnectionFromCrudItem(userId, item));
    }
  );
  private readonly _serverUserOAuthConnectionAccessTokensByAccountCache = createCache<[string, string, string, string], { accessToken: string } | null>(
    async ([userId, providerId, providerAccountId, scope]) => {
      try {
        const result = await this._interface.createServerProviderAccessTokenByAccount(userId, providerId, providerAccountId, scope || "");
        return { accessToken: result.access_token };
      } catch (err) {
        if (!(KnownErrors.OAuthAccessTokenNotAvailable.isInstance(err) || KnownErrors.OAuthConnectionDoesNotHaveRequiredScope.isInstance(err) || KnownErrors.OAuthConnectionNotConnectedToUser.isInstance(err))) {
          throw err;
        }
      }
      return null;
    }
  );
  private readonly _serverTeamMemberProfilesCache = createCache<[string], TeamMemberProfilesCrud['Server']['Read'][]>(
    async ([teamId]) => {
      return await this._interface.listServerTeamMemberProfiles({ teamId });
    }
  );
  private readonly _serverTeamInvitationsCache = createCache<[string], TeamInvitationCrud['Server']['Read'][]>(
    async ([teamId]) => {
      return await this._interface.listServerTeamInvitations({ teamId });
    }
  );
  private readonly _serverUserTeamProfileCache = createCache<[string, string], TeamMemberProfilesCrud['Client']['Read']>(
    async ([teamId, userId]) => {
      return await this._interface.getServerTeamMemberProfile({ teamId, userId });
    }
  );
  private readonly _serverContactChannelsCache = createCache<[string], ContactChannelsCrud['Server']['Read'][]>(
    async ([userId]) => {
      return await this._interface.listServerContactChannels(userId);
    }
  );
  private readonly _serverNotificationCategoriesCache = createCache<[string], NotificationPreferenceCrud['Server']['Read'][]>(
    async ([userId]) => {
      return await this._interface.listServerNotificationCategories(userId);
    }
  );
  private readonly _serverDataVaultStoreValueCache = createCache<[string, string, string], string | null>(async ([storeId, key, secret]) => {
    return await this._interface.getDataVaultStoreValue(secret, storeId, key);
  });

  private readonly _emailDeliveryInfoCache = createCache(async () => {
    return await this._interface.getEmailDeliveryInfo();
  });

  private readonly _serverUserApiKeysCache = createCache<[string], UserApiKeysCrud['Server']['Read'][]>(
    async ([userId]) => {
      const result = await this._interface.listProjectApiKeys({
        user_id: userId,
      }, null, "server");
      return result as UserApiKeysCrud['Server']['Read'][];
    }
  );

  private readonly _serverTeamApiKeysCache = createCache<[string], TeamApiKeysCrud['Server']['Read'][]>(
    async ([teamId]) => {
      const result = await this._interface.listProjectApiKeys({
        team_id: teamId,
      }, null, "server");
      return result as TeamApiKeysCrud['Server']['Read'][];
    }
  );

  private readonly _convexIdentitySubjectCache = createCache<[ConvexCtx], string | null>(
    async ([ctx]) => {
      const identity = await ctx.auth.getUserIdentity();
      return identity ? identity.subject : null;
    }
  );

  private readonly _serverCheckApiKeyCache = createCache<["user" | "team", string], UserApiKeysCrud['Server']['Read'] | TeamApiKeysCrud['Server']['Read'] | null>(async ([type, apiKey]) => {
    const result = await this._interface.checkProjectApiKey(
      type,
      apiKey,
      null,
      "server",
    );
    return result;
  });

  private readonly _serverOAuthProvidersCache = createCache<[string], OAuthProviderCrud['Server']['Read'][]>(
    async ([userId]) => {
      return await this._interface.listServerOAuthProviders({ user_id: userId });
    }
  );

  private readonly _serverTeamItemsCache = createCache<[string, string], ItemCrud['Client']['Read']>(
    async ([teamId, itemId]) => {
      return await this._interface.getItem({ teamId, itemId }, null, "server");
    }
  );

  private readonly _serverUserItemsCache = createCache<[string, string], ItemCrud['Client']['Read']>(
    async ([userId, itemId]) => {
      return await this._interface.getItem({ userId, itemId }, null, "server");
    }
  );

  private readonly _serverCustomItemsCache = createCache<[string, string], ItemCrud['Client']['Read']>(
    async ([customCustomerId, itemId]) => {
      return await this._interface.getItem({ customCustomerId, itemId }, null, "server");
    }
  );

  private readonly _serverUserProductsCache = createCache<[string, string | null, number | null], CustomerProductsListResponse>(
    async ([userId, cursor, limit]) => {
      return await this._interface.listProducts({
        customer_type: "user",
        customer_id: userId,
        cursor: cursor ?? undefined,
        limit: limit ?? undefined,
      }, null, "server");
    }
  );

  private readonly _serverTeamProductsCache = createCache<[string, string | null, number | null], CustomerProductsListResponse>(
    async ([teamId, cursor, limit]) => {
      return await this._interface.listProducts({
        customer_type: "team",
        customer_id: teamId,
        cursor: cursor ?? undefined,
        limit: limit ?? undefined,
      }, null, "server");
    }
  );

  private readonly _serverCustomProductsCache = createCache<[string, string | null, number | null], CustomerProductsListResponse>(
    async ([customCustomerId, cursor, limit]) => {
      return await this._interface.listProducts({
        customer_type: "custom",
        customer_id: customCustomerId,
        cursor: cursor ?? undefined,
        limit: limit ?? undefined,
      }, null, "server");
    }
  );

  protected _createServerCustomer(userIdOrTeamId: string, type: "user" | "team"): Omit<Customer<true>, "id"> {
    const app = this;
    const productsCache = type === "user" ? app._serverUserProductsCache : app._serverTeamProductsCache;
    const customerOptions = type === "user" ? { userId: userIdOrTeamId } : { teamId: userIdOrTeamId };
    return {
      ...this._createCustomer(userIdOrTeamId, type, null),
      async getItem(itemId: string) {
        return await app.getItem({ itemId, ...customerOptions });
      },
      // IF_PLATFORM react-like
      useItem(itemId: string) {
        return app.useItem({ itemId, ...customerOptions });
      },
      // END_PLATFORM
      async grantProduct(productOptions: { productId: string, quantity?: number } | { product: InlineProduct, quantity?: number }) {
        if (type === "user") {
          if ("productId" in productOptions) {
            await app.grantProduct({ userId: userIdOrTeamId, productId: productOptions.productId, quantity: productOptions.quantity });
          } else {
            await app.grantProduct({ userId: userIdOrTeamId, product: productOptions.product, quantity: productOptions.quantity });
          }
        } else {
          if ("productId" in productOptions) {
            await app.grantProduct({ teamId: userIdOrTeamId, productId: productOptions.productId, quantity: productOptions.quantity });
          } else {
            await app.grantProduct({ teamId: userIdOrTeamId, product: productOptions.product, quantity: productOptions.quantity });
          }
        }
        await productsCache.refresh([userIdOrTeamId, null, null]);
      },
      async createCheckoutUrl(options: { productId: string, returnUrl?: string } | { product: InlineProduct, returnUrl?: string }) {
        const productIdOrInline = "productId" in options ? options.productId : options.product;
        return await app._interface.createCheckoutUrl(type, userIdOrTeamId, productIdOrInline, null, options.returnUrl, "server");
      },
    };
  }

  private async _updateServerUser(userId: string, update: ServerUserUpdateOptions): Promise<UsersCrud['Server']['Read']> {
    const result = await this._interface.updateServerUser(userId, serverUserUpdateOptionsToCrud(update));
    await this._refreshUsers();
    return result;
  }

  protected _serverEditableTeamProfileFromCrud(crud: TeamMemberProfilesCrud['Client']['Read']): EditableTeamMemberProfile {
    const app = this;
    return {
      displayName: crud.display_name,
      profileImageUrl: crud.profile_image_url,
      async update(update: { displayName?: string, profileImageUrl?: string }) {
        await app._interface.updateServerTeamMemberProfile({
          teamId: crud.team_id,
          userId: crud.user_id,
          profile: {
            display_name: update.displayName,
            profile_image_url: update.profileImageUrl,
          },
        });
        await app._serverUserTeamProfileCache.refresh([crud.team_id, crud.user_id]);
      }
    };
  }

  protected _serverContactChannelFromCrud(userId: string, crud: ContactChannelsCrud['Server']['Read']): ServerContactChannel {
    const app = this;
    return {
      id: crud.id,
      value: crud.value,
      type: crud.type,
      isVerified: crud.is_verified,
      isPrimary: crud.is_primary,
      usedForAuth: crud.used_for_auth,
      async sendVerificationEmail(options?: { callbackUrl?: string }) {
        await app._interface.sendServerContactChannelVerificationEmail(userId, crud.id, options?.callbackUrl ?? constructRedirectUrl(app._getUrls().emailVerification, "callbackUrl"));
      },
      async update(data: ServerContactChannelUpdateOptions) {
        await app._interface.updateServerContactChannel(userId, crud.id, serverContactChannelUpdateOptionsToCrud(data));
        await Promise.all([
          app._serverContactChannelsCache.refresh([userId]),
          app._serverUserCache.refresh([userId])
        ]);
      },
      async delete() {
        await app._interface.deleteServerContactChannel(userId, crud.id);
        await Promise.all([
          app._serverContactChannelsCache.refresh([userId]),
          app._serverUserCache.refresh([userId])
        ]);
      },
    };
  }

  protected _serverNotificationCategoryFromCrud(userId: string, crud: NotificationPreferenceCrud['Server']['Read']): NotificationCategory {
    const app = this;
    return {
      id: crud.notification_category_id,
      name: crud.notification_category_name,
      enabled: crud.enabled,
      canDisable: crud.can_disable,

      async setEnabled(enabled: boolean) {
        await app._interface.setServerNotificationsEnabled(userId, crud.notification_category_id, enabled);
        await app._serverNotificationCategoriesCache.refresh([userId]);
      },
    };
  }

  protected _serverOAuthProviderFromCrud(crud: OAuthProviderCrud['Server']['Read']) {
    const app = this;
    return {
      id: crud.id,
      type: crud.type,
      userId: crud.user_id,
      accountId: crud.account_id,
      email: crud.email,
      allowSignIn: crud.allow_sign_in,
      allowConnectedAccounts: crud.allow_connected_accounts,

      async update(data: { accountId?: string, email?: string, allowSignIn?: boolean, allowConnectedAccounts?: boolean }): Promise<Result<void,
        InstanceType<typeof KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn>
      >> {
        try {
          await app._interface.updateServerOAuthProvider(crud.user_id, crud.id, {
            account_id: data.accountId,
            email: data.email,
            allow_sign_in: data.allowSignIn,
            allow_connected_accounts: data.allowConnectedAccounts,
          });
          await Promise.all([
            app._serverOAuthProvidersCache.refresh([crud.user_id]),
            app._serverUserConnectedAccountsCache.refresh([crud.user_id]),
          ]);
          return Result.ok(undefined);
        } catch (error) {
          if (KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn.isInstance(error)) {
            return Result.error(error);
          }
          throw error;
        }
      },

      async delete() {
        await app._interface.deleteServerOAuthProvider(crud.user_id, crud.id);
        await Promise.all([
          app._serverOAuthProvidersCache.refresh([crud.user_id]),
          app._serverUserConnectedAccountsCache.refresh([crud.user_id]),
        ]);
      },
    };
  }

  constructor(options: StackServerAppConstructorOptions<HasTokenStore, ProjectId>, extraOptions?: { uniqueIdentifier?: string, checkString?: string, interface?: HexclaveServerInterface }) {
    const resolvedOptions = resolveConstructorOptions(options);

    const publishableClientKey = resolvedOptions.publishableClientKey ?? getDefaultPublishableClientKey();

    super(resolvedOptions, {
      ...extraOptions,
      interface: extraOptions?.interface ?? (() => {
        const apiUrls = resolveApiUrls(resolvedOptions.baseUrl);
        return new HexclaveServerInterface({
          getBaseUrl: () => apiUrls()[0],
          getApiUrls: apiUrls,
          projectId: resolvedOptions.projectId ?? getDefaultProjectId(),
          extraRequestHeaders: resolvedOptions.extraRequestHeaders ?? getDefaultExtraRequestHeaders(),
          clientVersion,
          ...(publishableClientKey != null ? { publishableClientKey } : {}),
          secretServerKey: resolvedOptions.secretServerKey ?? getDefaultSecretServerKey(),
        });
      })(),
    });
  }


  protected _serverApiKeyFromCrud(crud: TeamApiKeysCrud['Client']['Read']): ApiKey<"team">;
  protected _serverApiKeyFromCrud(crud: UserApiKeysCrud['Client']['Read']): ApiKey<"user">;
  protected _serverApiKeyFromCrud(crud: yup.InferType<typeof teamApiKeysCreateOutputSchema>): ApiKey<"team", true>;
  protected _serverApiKeyFromCrud(crud: yup.InferType<typeof userApiKeysCreateOutputSchema>): ApiKey<"user", true>;
  protected _serverApiKeyFromCrud(crud: TeamApiKeysCrud['Client']['Read'] | UserApiKeysCrud['Client']['Read'] | yup.InferType<typeof teamApiKeysCreateOutputSchema> | yup.InferType<typeof userApiKeysCreateOutputSchema>): ApiKey<"user" | "team", boolean> {
    return {
      ...this._baseApiKeyFromCrud(crud),
      async revoke() {
        await this.update({ revoked: true });
      },
      update: async (options: ApiKeyUpdateOptions) => {
        await this._interface.updateProjectApiKey(
          crud.type === "team" ? { team_id: crud.team_id } : { user_id: crud.user_id },
          crud.id,
          await apiKeyUpdateOptionsToCrud(crud.type, options),
          null,
          "server");
        if (crud.type === "team") {
          await this._serverTeamApiKeysCache.refresh([crud.team_id]);
        } else {
          await this._serverUserApiKeysCache.refresh([crud.user_id]);
        }
      },
    };
  }

  protected _createServerOAuthConnectionFromCrudItem(
    userId: string,
    item: { provider: string, provider_account_id: string },
  ): OAuthConnection {
    const app = this;
    const providerId = item.provider;
    const providerAccountId = item.provider_account_id;
    return {
      id: providerId, // deprecated, for backward compat
      provider: providerId,
      providerAccountId,
      async getAccessToken(options?: { scopes?: string[] }) {
        const scopeString = options?.scopes?.join(" ") ?? "";
        const result = Result.orThrow(await app._serverUserOAuthConnectionAccessTokensByAccountCache.getOrWait([userId, providerId, providerAccountId, scopeString], "write-only"));
        if (!result) {
          const scopeDetail = scopeString ? `The requested scopes [${scopeString}] are not available on the existing token.` : "The OAuth refresh token has likely been revoked or expired.";
          return Result.error(new KnownErrors.OAuthAccessTokenNotAvailable(providerId, `${scopeDetail} The user needs to re-authorize by calling \`linkConnectedAccount\` or using \`getOrLinkConnectedAccount\`.`));
        }
        return Result.ok(result);
      },
      // IF_PLATFORM react-like
      useAccessToken(options?: { scopes?: string[] }) {
        const scopeString = options?.scopes?.join(" ") ?? "";
        const result = useAsyncCache(app._serverUserOAuthConnectionAccessTokensByAccountCache, [userId, providerId, providerAccountId, scopeString] as const, "connection.useAccessToken()");
        if (!result) {
          const scopeDetail = scopeString ? `The requested scopes [${scopeString}] are not available on the existing token.` : "The OAuth refresh token has likely been revoked or expired.";
          return Result.error(new KnownErrors.OAuthAccessTokenNotAvailable(providerId, `${scopeDetail} The user needs to re-authorize by calling \`linkConnectedAccount\` or using \`getOrLinkConnectedAccount\`.`));
        }
        return Result.ok(result);
      },
      // END_PLATFORM
    };
  }

  protected _serverUserFromCrud(crud: UsersCrud['Server']['Read']): ServerUser {
    const app = this;

    /** @deprecated The string-based overloads are deprecated. Use `getConnectedAccount({ provider, providerAccountId })` for existence check. */
    async function getConnectedAccount(id: ProviderType, options?: { scopes?: string[] }): Promise<DeprecatedOAuthConnection | null>;
    async function getConnectedAccount(id: ProviderType, options: { or: 'redirect', scopes?: string[] }): Promise<DeprecatedOAuthConnection>;
    async function getConnectedAccount(account: { provider: string, providerAccountId: string }): Promise<OAuthConnection | null>;
    async function getConnectedAccount(
      idOrAccount: ProviderType | { provider: string, providerAccountId: string },
      options?: { or?: 'redirect', scopes?: string[] }
    ): Promise<DeprecatedOAuthConnection | OAuthConnection | null> {
      const scopeString = options?.scopes?.join(" ") ?? "";

      // Check if it's the new object-based API
      if (typeof idOrAccount === 'object' && 'provider' in idOrAccount && 'providerAccountId' in idOrAccount) {
        const { provider, providerAccountId } = idOrAccount;
        // Check if the account exists in the connected accounts list
        const connectedAccounts = Result.orThrow(await app._serverUserConnectedAccountsCache.getOrWait([crud.id], "write-only"));
        const found = connectedAccounts.find(
          a => a.provider === provider && a.providerAccountId === providerAccountId
        );
        if (!found) {
          return null;
        }
        return found;
      }

      // Original behavior: by provider ID (returns first match)
      return Result.orThrow(await app._serverUserOAuthConnectionCache.getOrWait([crud.id, idOrAccount, scopeString, options?.or === 'redirect'], "write-only"));
    }

    // IF_PLATFORM react-like
    /** @deprecated The string-based overloads are deprecated. Use `useConnectedAccount({ provider, providerAccountId })` for existence check. */
    function useConnectedAccount(id: ProviderType, options?: { scopes?: string[] }): DeprecatedOAuthConnection | null;
    function useConnectedAccount(id: ProviderType, options: { or: 'redirect', scopes?: string[] }): DeprecatedOAuthConnection;
    function useConnectedAccount(account: { provider: string, providerAccountId: string }): OAuthConnection | null;
    function useConnectedAccount(
      idOrAccount: ProviderType | { provider: string, providerAccountId: string },
      options?: { or?: 'redirect', scopes?: string[] }
    ): DeprecatedOAuthConnection | OAuthConnection | null {
      const scopeString = options?.scopes?.join(" ") ?? "";

      // Check if it's the new object-based API
      if (typeof idOrAccount === 'object' && 'provider' in idOrAccount && 'providerAccountId' in idOrAccount) {
        const { provider, providerAccountId } = idOrAccount;
        // Check if the account exists in the connected accounts list
        const connectedAccounts = useAsyncCache(
          app._serverUserConnectedAccountsCache,
          [crud.id] as const,
          "user.useConnectedAccount()"
        );
        const found = connectedAccounts.find(
          a => a.provider === provider && a.providerAccountId === providerAccountId
        );
        return found ?? null;
      }

      // Original behavior: by provider ID (returns first match)
      return useAsyncCache(app._serverUserOAuthConnectionCache, [crud.id, idOrAccount, scopeString, options?.or === 'redirect'] as const, "user.useConnectedAccount()");
    }
    // END_PLATFORM

    const serverUser = withUserDestructureGuard({
      ...super._createBaseUser(crud),
      lastActiveAt: new Date(crud.last_active_at_millis),
      serverMetadata: crud.server_metadata,
      restrictedByAdminPrivateDetails: crud.restricted_by_admin_private_details,
      countryCode: crud.country_code,
      riskScores: {
        signUp: {
          bot: crud.risk_scores.sign_up.bot,
          freeTrialAbuse: crud.risk_scores.sign_up.free_trial_abuse,
        },
      },
      async setPrimaryEmail(email: string | null, options?: { verified?: boolean }) {
        await app._updateServerUser(crud.id, { primaryEmail: email, primaryEmailVerified: options?.verified });
      },
      async grantPermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<void> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string' && permissionId) {
          const scope = scopeOrPermissionId;
          await app._interface.grantServerTeamUserPermission(scope.id, crud.id, permissionId);

          for (const recursive of [true, false]) {
            await app._serverTeamUserPermissionsCache.refresh([scope.id, crud.id, recursive]);
            await app._serverAllTeamMemberPermissionsCache.refresh([scope.id, recursive]);
          }
        } else {
          const pId = scopeOrPermissionId as string;
          await app._interface.grantServerProjectPermission(crud.id, pId);

          for (const recursive of [true, false]) {
            await app._serverUserProjectPermissionsCache.refresh([crud.id, recursive]);
          }
        }
      },
      async revokePermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<void> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string' && permissionId) {
          const scope = scopeOrPermissionId;
          await app._interface.revokeServerTeamUserPermission(scope.id, crud.id, permissionId);

          for (const recursive of [true, false]) {
            await app._serverTeamUserPermissionsCache.refresh([scope.id, crud.id, recursive]);
            await app._serverAllTeamMemberPermissionsCache.refresh([scope.id, recursive]);
          }
        } else {
          const pId = scopeOrPermissionId as string;
          await app._interface.revokeServerProjectPermission(crud.id, pId);

          for (const recursive of [true, false]) {
            await app._serverUserProjectPermissionsCache.refresh([crud.id, recursive]);
          }
        }
      },
      async delete() {
        const res = await app._interface.deleteServerUser(crud.id);
        await app._refreshUsers();
        return res;
      },
      async createSession(options: { expiresInMillis?: number, isImpersonation?: boolean, reason?: string | null }) {
        // TODO this should also refresh the access token when it expires (like InternalSession)
        const tokens = await app._interface.createServerUserSession(
          crud.id,
          options.expiresInMillis ?? 1000 * 60 * 60 * 24 * 365,
          options.isImpersonation ?? false,
          options.reason,
        );
        return {
          async getTokens() {
            return tokens;
          },
        };
      },

      async getActiveSessions() {
        const sessions = await app._interface.listServerSessions(crud.id);
        return sessions.items.map((session) => app._clientSessionFromCrud(session));
      },

      async revokeSession(sessionId: string) {
        await app._interface.deleteServerSession(sessionId);
      },
      async setDisplayName(displayName: string | null) {
        return await this.update({ displayName });
      },
      async setClientMetadata(metadata: Record<string, any>) {
        return await this.update({ clientMetadata: metadata });
      },
      async setClientReadOnlyMetadata(metadata: Record<string, any>) {
        return await this.update({ clientReadOnlyMetadata: metadata });
      },
      async setServerMetadata(metadata: Record<string, any>) {
        return await this.update({ serverMetadata: metadata });
      },
      async setSelectedTeam(team: Team | string | null) {
        return await this.update({ selectedTeamId: typeof team === 'string' ? team : team?.id ?? null });
      },
      getConnectedAccount,
      useConnectedAccount, // THIS_LINE_PLATFORM react-like
      async listConnectedAccounts() {
        return Result.orThrow(await app._serverUserConnectedAccountsCache.getOrWait([crud.id], "write-only"));
      },
      // IF_PLATFORM react-like
      useConnectedAccounts() {
        return useAsyncCache(app._serverUserConnectedAccountsCache, [crud.id] as const, "user.useConnectedAccounts()");
      },
      // END_PLATFORM
      async linkConnectedAccount(): Promise<void> {
        throw new HexclaveAssertionError("linkConnectedAccount is not available for server users. OAuth flows must be initiated on the client side.");
      },
      async getOrLinkConnectedAccount(): Promise<OAuthConnection> {
        throw new HexclaveAssertionError("getOrLinkConnectedAccount is not available for server users. OAuth flows must be initiated on the client side.");
      },
      // IF_PLATFORM react-like
      useOrLinkConnectedAccount(): OAuthConnection {
        throw new HexclaveAssertionError("useOrLinkConnectedAccount is not available for server users. OAuth flows must be initiated on the client side.");
      },
      // END_PLATFORM
      selectedTeam: crud.selected_team ? app._serverTeamFromCrud(crud.selected_team) : null,
      // Unlike the app-level getTeam/useTeam (which fetch any team by id),
      // the user-scoped variants search the user's own team list on purpose:
      // they must return null for teams the user is not a member of, and some
      // callers rely on that as a membership check.
      async getTeam(teamId: string) {
        const teams = await this.listTeams();
        return teams.find((t) => t.id === teamId) ?? null;
      },
      // IF_PLATFORM react-like
      useTeam(teamId: string) {
        const teams = this.useTeams();
        return useMemo(() => {
          return teams.find((t) => t.id === teamId) ?? null;
        }, [teams, teamId]);
      },
      // END_PLATFORM
      async listTeams(options?: ServerListTeamsOptions): Promise<ServerTeam[] & { nextCursor: string | null }> {
        const result = Result.orThrow(await app._serverTeamsCache.getOrWait([crud.id, options?.orderBy, options?.desc, options?.cursor, options?.limit, options?.query] as const, "write-only"));
        const teams: any = result.items.map((t) => app._serverTeamFromCrud(t));
        teams.nextCursor = result.pagination?.next_cursor ?? null;
        return teams as any;
      },
      // IF_PLATFORM react-like
      useTeams(options?: ServerListTeamsOptions): ServerTeam[] & { nextCursor: string | null } {
        const result = useAsyncCache(app._serverTeamsCache, [crud.id, options?.orderBy, options?.desc, options?.cursor, options?.limit, options?.query] as const, "user.useTeams()");
        return useMemo(() => {
          const teams: any = result.items.map((t) => app._serverTeamFromCrud(t));
          teams.nextCursor = result.pagination?.next_cursor ?? null;
          return teams as any;
        }, [result]);
      },
      // END_PLATFORM
      createTeam: async (data: Omit<ServerTeamCreateOptions, "creatorUserId">) => {
        const team = await app._interface.createServerTeam(serverTeamCreateOptionsToCrud({
          creatorUserId: crud.id,
          ...data,
        }));
        await app._serverTeamsCache.refreshWhere(() => true);
        await app._updateServerUser(crud.id, { selectedTeamId: team.id });
        return app._serverTeamFromCrud(team);
      },
      leaveTeam: async (team: Team) => {
        await app._interface.leaveServerTeam({ teamId: team.id, userId: crud.id });
        await app._refreshTeamMembership(team.id, crud.id);
      },
      async listTeamInvitations() {
        const invitations = Result.orThrow(await app._serverUserTeamInvitationsCache.getOrWait([crud.id], "write-only"));
        return invitations.map((inv) => app._serverReceivedTeamInvitationFromCrud(crud.id, inv));
      },
      // IF_PLATFORM react-like
      useTeamInvitations() {
        const invitations = useAsyncCache(app._serverUserTeamInvitationsCache, [crud.id], "user.useTeamInvitations()");
        return useMemo(() => invitations.map((inv) => app._serverReceivedTeamInvitationFromCrud(crud.id, inv)), [invitations]);
      },
      // END_PLATFORM
      async listPermissions(scopeOrOptions?: Team | { recursive?: boolean }, options?: { recursive?: boolean }): Promise<AdminTeamPermission[]> {
        if (scopeOrOptions && 'id' in scopeOrOptions) {
          const scope = scopeOrOptions;
          const recursive = options?.recursive ?? true;
          const permissions = Result.orThrow(await app._serverTeamUserPermissionsCache.getOrWait([scope.id, crud.id, recursive], "write-only"));
          return permissions.map((crud) => app._serverPermissionFromCrud(crud));
        } else {
          const opts = scopeOrOptions;
          const recursive = opts?.recursive ?? true;
          const permissions = Result.orThrow(await app._serverUserProjectPermissionsCache.getOrWait([crud.id, recursive], "write-only"));
          return permissions.map((crud) => app._serverPermissionFromCrud(crud));
        }
      },
      // IF_PLATFORM react-like
      usePermissions(scopeOrOptions?: Team | { recursive?: boolean }, options?: { recursive?: boolean }): AdminTeamPermission[] {
        if (scopeOrOptions && 'id' in scopeOrOptions) {
          const scope = scopeOrOptions;
          const recursive = options?.recursive ?? true;
          const permissions = useAsyncCache(app._serverTeamUserPermissionsCache, [scope.id, crud.id, recursive] as const, "user.usePermissions()");
          return useMemo(() => permissions.map((crud) => app._serverPermissionFromCrud(crud)), [permissions]);
        } else {
          const opts = scopeOrOptions;
          const recursive = opts?.recursive ?? true;
          const permissions = useAsyncCache(app._serverUserProjectPermissionsCache, [crud.id, recursive] as const, "user.usePermissions()");
          return useMemo(() => permissions.map((crud) => app._serverPermissionFromCrud(crud)), [permissions]);
        }
      },
      // END_PLATFORM
      async getPermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<AdminTeamPermission | null> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string') {
          const scope = scopeOrPermissionId;
          const permissions = await this.listPermissions(scope);
          return permissions.find((p) => p.id === permissionId) ?? null;
        } else {
          const pid = scopeOrPermissionId;
          const permissions = await this.listPermissions();
          return permissions.find((p) => p.id === pid) ?? null;
        }
      },
      // IF_PLATFORM react-like
      usePermission(scopeOrPermissionId: Team | string, permissionId?: string): AdminTeamPermission | null {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string') {
          const scope = scopeOrPermissionId;
          const permissions = this.usePermissions(scope);
          return useMemo(() => permissions.find((p) => p.id === permissionId) ?? null, [permissions, permissionId]);
        } else {
          const pid = scopeOrPermissionId;
          const permissions = this.usePermissions();
          return useMemo(() => permissions.find((p) => p.id === pid) ?? null, [permissions, pid]);
        }
      },
      // END_PLATFORM
      async hasPermission(scopeOrPermissionId: Team | string, permissionId?: string): Promise<boolean> {
        if (scopeOrPermissionId && typeof scopeOrPermissionId !== 'string') {
          const scope = scopeOrPermissionId;
          return (await this.getPermission(scope, permissionId as string)) !== null;
        } else {
          const pid = scopeOrPermissionId;
          return (await this.getPermission(pid)) !== null;
        }
      },
      async update(update: ServerUserUpdateOptions) {
        await app._updateServerUser(crud.id, update);
      },
      async sendVerificationEmail() {
        return await app._checkFeatureSupport("sendVerificationEmail() on ServerUser", {});
      },
      async updatePassword(options: { oldPassword: string, newPassword: string }) {
        const result = await app._interface.updatePassword(options);
        await app._serverUserCache.refresh([crud.id]);
        return result;
      },
      async setPassword(options: { password: string }) {
        const result = await this.update(options);
        await app._serverUserCache.refresh([crud.id]);
        return result;
      },
      async getTeamProfile(team: Team) {
        const result = Result.orThrow(await app._serverUserTeamProfileCache.getOrWait([team.id, crud.id], "write-only"));
        return app._serverEditableTeamProfileFromCrud(result);
      },
      // IF_PLATFORM react-like
      useTeamProfile(team: Team) {
        const result = useAsyncCache(app._serverUserTeamProfileCache, [team.id, crud.id] as const, "user.useTeamProfile()");
        return useMemo(() => app._serverEditableTeamProfileFromCrud(result), [result]);
      },
      // END_PLATFORM
      async listContactChannels() {
        const result = Result.orThrow(await app._serverContactChannelsCache.getOrWait([crud.id], "write-only"));
        return result.map((data) => app._serverContactChannelFromCrud(crud.id, data));
      },
      // IF_PLATFORM react-like
      useContactChannels() {
        const result = useAsyncCache(app._serverContactChannelsCache, [crud.id] as const, "user.useContactChannels()");
        return useMemo(() => result.map((data) => app._serverContactChannelFromCrud(crud.id, data)), [result]);
      },
      // END_PLATFORM
      createContactChannel: async (data: ServerContactChannelCreateOptions) => {
        const contactChannel = await app._interface.createServerContactChannel(serverContactChannelCreateOptionsToCrud(crud.id, data));
        await Promise.all([
          app._serverContactChannelsCache.refresh([crud.id]),
          app._serverUserCache.refresh([crud.id])
        ]);
        return app._serverContactChannelFromCrud(crud.id, contactChannel);
      },
      // IF_PLATFORM react-like
      useNotificationCategories() {
        const results = useAsyncCache(app._serverNotificationCategoriesCache, [crud.id] as const, "user.useNotificationCategories()");
        return results.map((category) => app._serverNotificationCategoryFromCrud(crud.id, category));
      },
      // END_PLATFORM
      async listNotificationCategories() {
        const results = Result.orThrow(await app._serverNotificationCategoriesCache.getOrWait([crud.id], "write-only"));
        return results.map((category) => app._serverNotificationCategoryFromCrud(crud.id, category));
      },
      // IF_PLATFORM react-like
      useApiKeys() {
        const result = useAsyncCache(app._serverUserApiKeysCache, [crud.id] as const, "user.useApiKeys()");
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      // END_PLATFORM
      async listApiKeys() {
        const result = Result.orThrow(await app._serverUserApiKeysCache.getOrWait([crud.id], "write-only"));
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      async createApiKey(options: ApiKeyCreationOptions<"user">) {
        const result = await app._interface.createProjectApiKey(
          await apiKeyCreationOptionsToCrud("user", crud.id, options),
          null,
          "server",
        );
        await app._serverUserApiKeysCache.refresh([crud.id]);
        return app._serverApiKeyFromCrud(result);
      },
      // IF_PLATFORM react-like
      useOAuthProviders() {
        const results = useAsyncCache(app._serverOAuthProvidersCache, [crud.id] as const, "user.useOAuthProviders()");
        return useMemo(() => results.map((oauthCrud) => app._serverOAuthProviderFromCrud(oauthCrud)), [results]);
      },
      // END_PLATFORM

      async listOAuthProviders() {
        const results = Result.orThrow(await app._serverOAuthProvidersCache.getOrWait([crud.id], "write-only"));
        return results.map((oauthCrud) => app._serverOAuthProviderFromCrud(oauthCrud));
      },

      // IF_PLATFORM react-like
      useOAuthProvider(id: string) {
        const providers = this.useOAuthProviders();
        return useMemo(() => providers.find((p) => p.id === id) ?? null, [providers, id]);
      },
      // END_PLATFORM
      async getOAuthProvider(id: string) {
        const providers = await this.listOAuthProviders();
        return providers.find((p) => p.id === id) ?? null;
      },
      async registerPasskey(options?: { hostname?: string }): Promise<Result<undefined, KnownErrors["PasskeyRegistrationFailed"] | KnownErrors["PasskeyWebAuthnError"]>> {
        const hostname = options?.hostname || (await app._getCurrentUrl())?.hostname;
        if (!hostname) {
          throw new HexclaveAssertionError("hostname must be provided if the Stack App does not have a redirect method");
        }

        // Use server interface to initiate passkey registration for this specific user
        const initiationResult = await app._interface.initiateServerPasskeyRegistration(crud.id);

        if (initiationResult.status !== "ok") {
          return Result.error(new KnownErrors.PasskeyRegistrationFailed("Failed to get initiation options for passkey registration"));
        }

        const { options_json, code } = initiationResult.data;

        scopePasskeyRegistrationToHostname(options_json, hostname);

        let attResp;
        try {
          attResp = await startRegistration({ optionsJSON: options_json });
        } catch (error: any) {
          if (error instanceof WebAuthnError) {
            return Result.error(new KnownErrors.PasskeyWebAuthnError(error.message, error.name));
          } else {
            // This should never happen
            captureError("passkey-registration-failed", error);
            return Result.error(new KnownErrors.PasskeyRegistrationFailed("Failed to start passkey registration due to unknown error"));
          }
        }

        // Create a temporary session to complete the registration
        // TODO instead of creating a new session, this should just call the endpoint in a way in which it doesn't require a session
        // (currently this shows up on session history etc... not ideal)
        const { accessToken, refreshToken } = await app._interface.createServerUserSession(crud.id, 60000 * 2, false);
        const tempSession = new InternalSession({
          accessToken,
          refreshToken,
          refreshAccessTokenCallback: async () => null,
        });

        const registrationResult = await app._interface.registerPasskey({ credential: attResp, code }, tempSession);

        await app._serverUserCache.refresh([crud.id]);
        return registrationResult;
      },
      ...app._createServerCustomer(crud.id, "user"),
    } satisfies ServerUser);

    return serverUser;
  }

  protected _serverTeamUserFromCrud(crud: TeamMemberProfilesCrud["Server"]["Read"]): ServerTeamUser {
    const teamUser = withUserDestructureGuard({
      ...this._serverUserFromCrud(crud.user),
      teamProfile: {
        displayName: crud.display_name,
        profileImageUrl: crud.profile_image_url,
      },
    } satisfies ServerTeamUser);

    return teamUser;
  }

  protected _serverSentTeamInvitationFromCrud(crud: TeamInvitationCrud['Server']['Read']): SentTeamInvitation {
    return {
      id: crud.id,
      recipientEmail: crud.recipient_email,
      expiresAt: new Date(crud.expires_at_millis),
      revoke: async () => {
        await this._interface.revokeServerTeamInvitation(crud.id, crud.team_id);
        await this._serverTeamInvitationsCache.refresh([crud.team_id]);
      },
    };
  }

  protected _serverReceivedTeamInvitationFromCrud(userId: string, crud: TeamInvitationCrud['Client']['Read']): ReceivedTeamInvitation {
    const app = this;
    return {
      id: crud.id,
      teamId: crud.team_id,
      teamDisplayName: crud.team_display_name,
      recipientEmail: crud.recipient_email,
      expiresAt: new Date(crud.expires_at_millis),
      accept: async () => {
        await app._interface.acceptServerTeamInvitationById(crud.id, userId);
        await Promise.all([
          app._serverUserTeamInvitationsCache.refresh([userId]),
          app._serverTeamInvitationsCache.refresh([crud.team_id]),
          app._refreshTeamMembership(crud.team_id, userId),
        ]);
      },
    };
  }

  protected override _currentUserFromCrud(crud: UsersCrud['Server']['Read'], session: InternalSession): ProjectCurrentServerUser<ProjectId> {
    const currentUser = withUserDestructureGuard({
      ...this._serverUserFromCrud(crud),
      ...this._createAuth(session),
      ...this._isInternalProject() ? this._createInternalUserExtra(session) : {},
    } satisfies ServerUser);

    return currentUser as ProjectCurrentServerUser<ProjectId>;
  }

  protected _serverTeamFromCrud(crud: TeamsCrud['Server']['Read']): ServerTeam {
    const app = this;
    return {
      id: crud.id,
      displayName: crud.display_name,
      profileImageUrl: crud.profile_image_url,
      createdAt: new Date(crud.created_at_millis),
      clientMetadata: crud.client_metadata,
      clientReadOnlyMetadata: crud.client_read_only_metadata,
      serverMetadata: crud.server_metadata,
      async update(update: Partial<ServerTeamUpdateOptions>) {
        await app._interface.updateServerTeam(crud.id, serverTeamUpdateOptionsToCrud(update));
        await Promise.all([
          app._serverTeamCache.refresh([crud.id]),
          app._serverTeamsCache.refreshWhere(() => true),
          app._serverUsersCache.refreshWhere(() => true),
        ]);
      },
      async delete() {
        await app._interface.deleteServerTeam(crud.id);
        await Promise.all([
          app._serverTeamCache.refresh([crud.id]),
          app._serverTeamsCache.refreshWhere(() => true),
          app._serverUsersCache.refreshWhere(() => true),
        ]);
      },
      async listUsers() {
        const result = Result.orThrow(await app._serverTeamMemberProfilesCache.getOrWait([crud.id], "write-only"));
        return result.map(u => app._serverTeamUserFromCrud(u));
      },
      // IF_PLATFORM react-like
      useUsers() {
        const result = useAsyncCache(app._serverTeamMemberProfilesCache, [crud.id] as const, "team.useUsers()");
        return useMemo(() => result.map(u => app._serverTeamUserFromCrud(u)), [result]);
      },
      // END_PLATFORM
      async addUser(userId) {
        await app._interface.addServerUserToTeam({
          teamId: crud.id,
          userId,
        });
        await app._refreshTeamMembership(crud.id, userId);
      },
      async removeUser(userId) {
        await app._interface.removeServerUserFromTeam({
          teamId: crud.id,
          userId,
        });
        await app._refreshTeamMembership(crud.id, userId);
      },
      async inviteUser(options: { email: string, callbackUrl?: string }) {
        await app._interface.sendServerTeamInvitation({
          teamId: crud.id,
          email: options.email,
          callbackUrl: options.callbackUrl ?? constructRedirectUrl(app._getUrls().teamInvitation, "callbackUrl"),
        });
        await app._serverTeamInvitationsCache.refresh([crud.id]);
      },
      async listInvitations() {
        const result = Result.orThrow(await app._serverTeamInvitationsCache.getOrWait([crud.id], "write-only"));
        return result.map((crud) => app._serverSentTeamInvitationFromCrud(crud));
      },
      // IF_PLATFORM react-like
      useInvitations() {
        const result = useAsyncCache(app._serverTeamInvitationsCache, [crud.id] as const, "team.useInvitations()");
        return useMemo(() => result.map((crud) => app._serverSentTeamInvitationFromCrud(crud)), [result]);
      },
      // END_PLATFORM
      // IF_PLATFORM react-like
      useApiKeys() {
        const result = useAsyncCache(app._serverTeamApiKeysCache, [crud.id] as const, "team.useApiKeys()");
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      // END_PLATFORM
      async listApiKeys() {
        const result = Result.orThrow(await app._serverTeamApiKeysCache.getOrWait([crud.id], "write-only"));
        return result.map((apiKey) => app._serverApiKeyFromCrud(apiKey));
      },
      async createApiKey(options: ApiKeyCreationOptions<"team">) {
        const result = await app._interface.createProjectApiKey(
          await apiKeyCreationOptionsToCrud("team", crud.id, options),
          null,
          "server",
        );
        await app._serverTeamApiKeysCache.refresh([crud.id]);
        return app._serverApiKeyFromCrud(result);
      },
      ...app._createServerCustomer(crud.id, "team"),
    };
  }

  protected _serverItemFromCrud(customer: { type: "user" | "team" | "custom", id: string }, crud: ItemCrud['Client']['Read']): ServerItem {
    const app = this;
    return {
      displayName: crud.display_name,
      quantity: crud.quantity,
      nonNegativeQuantity: Math.max(0, crud.quantity),
      increaseQuantity: async (delta: number) => {
        const updateOptions = customer.type === "user"
          ? { itemId: crud.id, userId: customer.id }
          : customer.type === "team"
            ? { itemId: crud.id, teamId: customer.id }
            : { itemId: crud.id, customCustomerId: customer.id };
        await app._interface.updateItemQuantity(updateOptions, { delta });
        if (customer.type === "user") await app._serverUserItemsCache.refresh([customer.id, crud.id]);
        else if (customer.type === "team") await app._serverTeamItemsCache.refresh([customer.id, crud.id]);
        else await app._serverCustomItemsCache.refresh([customer.id, crud.id]);
      },
      decreaseQuantity: async (delta: number) => {
        const updateOptions = customer.type === "user"
          ? { itemId: crud.id, userId: customer.id }
          : customer.type === "team"
            ? { itemId: crud.id, teamId: customer.id }
            : { itemId: crud.id, customCustomerId: customer.id };
        await app._interface.updateItemQuantity(updateOptions, { delta: -delta, allow_negative: true });
        if (customer.type === "user") await app._serverUserItemsCache.refresh([customer.id, crud.id]);
        else if (customer.type === "team") await app._serverTeamItemsCache.refresh([customer.id, crud.id]);
        else await app._serverCustomItemsCache.refresh([customer.id, crud.id]);
      },
      tryDecreaseQuantity: async (delta: number) => {
        try {
          const updateOptions = customer.type === "user"
            ? { itemId: crud.id, userId: customer.id }
            : customer.type === "team"
              ? { itemId: crud.id, teamId: customer.id }
              : { itemId: crud.id, customCustomerId: customer.id };
          await app._interface.updateItemQuantity(updateOptions, { delta: -delta });
          if (customer.type === "user") await app._serverUserItemsCache.refresh([customer.id, crud.id]);
          else if (customer.type === "team") await app._serverTeamItemsCache.refresh([customer.id, crud.id]);
          else await app._serverCustomItemsCache.refresh([customer.id, crud.id]);
          return true;
        } catch (error) {
          if (error instanceof KnownErrors.ItemQuantityInsufficientAmount) {
            return false;
          }
          throw error;
        }
      },
    };
  }

  protected async _getUserApiKey(options: { apiKey: string }): Promise<ApiKey<"user"> | null> {
    const crud = Result.orThrow(await this._serverCheckApiKeyCache.getOrWait(["user", options.apiKey], "write-only")) as UserApiKeysCrud['Server']['Read'] | null;
    return crud ? this._serverApiKeyFromCrud(crud) : null;
  }

  protected async _getTeamApiKey(options: { apiKey: string }): Promise<ApiKey<"team"> | null> {
    const crud = Result.orThrow(await this._serverCheckApiKeyCache.getOrWait(["team", options.apiKey], "write-only")) as TeamApiKeysCrud['Server']['Read'] | null;
    return crud ? this._serverApiKeyFromCrud(crud) : null;
  }
  // IF_PLATFORM react-like
  protected _useUserApiKey(options: { apiKey: string }): ApiKey<"user"> | null {
    const crud = useAsyncCache(this._serverCheckApiKeyCache, ["user", options.apiKey] as const, "serverApp.useUserApiKey()") as UserApiKeysCrud['Server']['Read'] | null;
    return useMemo(() => crud ? this._serverApiKeyFromCrud(crud) : null, [crud]);
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  protected _useTeamApiKey(options: { apiKey: string }): ApiKey<"team"> | null {
    const crud = useAsyncCache(this._serverCheckApiKeyCache, ["team", options.apiKey] as const, "serverApp.useTeamApiKey()") as TeamApiKeysCrud['Server']['Read'] | null;
    return useMemo(() => crud ? this._serverApiKeyFromCrud(crud) : null, [crud]);
  }
  // END_PLATFORM
  protected async _getUserByApiKey(apiKey: string): Promise<ServerUser | null> {
    const apiKeyObject = await this._getUserApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return await this.getServerUserById(apiKeyObject.userId);
  }

  protected async _getUserByConvex(ctx: ConvexCtx, includeAnonymous: boolean): Promise<ServerUser | null> {
    const identity = await ctx.auth.getUserIdentity();
    if (identity === null) {
      return null;
    }
    const user = await this.getServerUserById(identity.subject);
    if (user?.isAnonymous && !includeAnonymous) {
      return null;
    }
    return user;
  }
  // IF_PLATFORM react-like
  protected _useUserByConvex(ctx: ConvexCtx, includeAnonymous: boolean): ServerUser | null {
    const subject = useAsyncCache(this._convexIdentitySubjectCache, [ctx] as const, "serverApp.useUserByConvex()");
    if (subject === null) {
      return null;
    }
    const user = this.useUserById(subject);
    if (user?.isAnonymous && !includeAnonymous) {
      return null;
    }
    return user;
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  protected _useUserByApiKey(apiKey: string): ServerUser | null {
    const apiKeyObject = this._useUserApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return this.useUserById(apiKeyObject.userId);
  }
  // END_PLATFORM

  protected async _getTeamByApiKey(apiKey: string): Promise<ServerTeam | null> {
    const apiKeyObject = await this._getTeamApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return await this.getTeam(apiKeyObject.teamId);
  }
  // IF_PLATFORM react-like
  protected _useTeamByApiKey(apiKey: string): ServerTeam | null {
    const apiKeyObject = this._useTeamApiKey({ apiKey });
    if (apiKeyObject === null) {
      return null;
    }
    return this.useTeam(apiKeyObject.teamId);
  }
  // END_PLATFORM

  async createUser(options: ServerUserCreateOptions): Promise<ServerUser> {
    const crud = await this._interface.createServerUser(serverUserCreateOptionsToCrud(options));
    await this._refreshUsers();
    return this._serverUserFromCrud(crud);
  }

  async getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): Promise<ProjectCurrentServerUser<ProjectId>>;
  async getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): Promise<ProjectCurrentServerUser<ProjectId>>;
  async getUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): Promise<ProjectCurrentServerUser<ProjectId>>;
  async getUser(options?: GetCurrentUserOptions<HasTokenStore>): Promise<ProjectCurrentServerUser<ProjectId> | null>;
  async getUser(id: string): Promise<ServerUser | null>;
  async getUser(options: { apiKey: string }): Promise<ServerUser | null>;
  async getUser(options: { from: "convex", ctx: ConvexCtx, or?: "return-null" | "anonymous" }): Promise<ServerUser | null>;
  async getUser(options?: string | GetCurrentUserOptions<HasTokenStore> | { apiKey: string } | { from: "convex", ctx: ConvexCtx }): Promise<ProjectCurrentServerUser<ProjectId> | ServerUser | null> {
    if (typeof options === "string") {
      return await this.getServerUserById(options);
    } else if (typeof options === "object" && "apiKey" in options) {
      return await this._getUserByApiKey(options.apiKey);
    } else if (typeof options === "object" && "from" in options && options.from as string === "convex") {
      return await this._getUserByConvex(options.ctx, "or" in options && options.or === "anonymous");
    } else {
      options = options as GetCurrentUserOptions<HasTokenStore> | undefined;

      // Validate that includeRestricted: false and or: 'anonymous' are mutually exclusive
      if (options?.or === 'anonymous' && options.includeRestricted === false) {
        throw new Error("Cannot use { or: 'anonymous' } with { includeRestricted: false }. Anonymous users implicitly include restricted users.");
      }

      // TODO this code is duplicated from the client app; fix that
      this._ensurePersistentTokenStore(options?.tokenStore);
      const session = await this._getSession(options?.tokenStore);
      let crud = Result.orThrow(await this._currentServerUserCache.getOrWait([session], "write-only"));
      const includeAnonymous = options?.or === "anonymous" || options?.or === "anonymous-if-exists[deprecated]";
      const includeRestricted = options?.includeRestricted === true || includeAnonymous;

      if (crud === null || (crud.is_anonymous && !includeAnonymous) || (crud.is_restricted && !includeRestricted)) {
        switch (options?.or) {
          case 'redirect': {
            if (!crud?.is_anonymous && crud?.is_restricted) {
              await this.redirectToOnboarding({ replace: true });
            } else {
              await this.redirectToSignIn({ replace: true });
            }
            // TODO: see client-app-impl. We probably want to `await neverResolve()` here instead of returning null
            break;
          }
          case 'throw': {
            throw new Error("User is not signed in but getUser was called with { or: 'throw' }");
          }
          case 'anonymous': {
            const tokens = await this._signUpAnonymously();
            return await this.getUser({ tokenStore: tokens, or: "anonymous-if-exists[deprecated]", includeRestricted: true }) ?? throwErr("Something went wrong while signing up anonymously");
          }
          case undefined:
          case "anonymous-if-exists[deprecated]":
          case "return-null": {
            return null;
          }
        }
      }

      return crud && this._currentUserFromCrud(crud, session);
    }
  }

  async getServerUser(): Promise<ProjectCurrentServerUser<ProjectId> | null> {
    console.warn("hexclaveServerApp.getServerUser is deprecated; use hexclaveServerApp.getUser instead");
    return await this.getUser();
  }

  async getServerUserById(userId: string): Promise<ServerUser | null> {
    const crud = Result.orThrow(await this._serverUserCache.getOrWait([userId], "write-only"));
    return crud && this._serverUserFromCrud(crud);
  }

  // IF_PLATFORM react-like
  useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'redirect' }): ProjectCurrentServerUser<ProjectId>;
  useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'throw' }): ProjectCurrentServerUser<ProjectId>;
  useUser(options: GetCurrentUserOptions<HasTokenStore> & { or: 'anonymous' }): ProjectCurrentServerUser<ProjectId>;
  useUser(options?: GetCurrentUserOptions<HasTokenStore>): ProjectCurrentServerUser<ProjectId> | null;
  useUser(id: string): ServerUser | null;
  useUser(options: { apiKey: string }): ServerUser | null;
  useUser(options: { from: "convex", ctx: ConvexCtx, or?: "return-null" | "anonymous" }): ServerUser | null;
  useUser(options?: GetCurrentUserOptions<HasTokenStore> | string | { apiKey: string } | { from: "convex", ctx: ConvexCtx }): ProjectCurrentServerUser<ProjectId> | ServerUser | null {
    if (typeof options === "string") {
      return this.useUserById(options);
    } else if (typeof options === "object" && "apiKey" in options) {
      return this._useUserByApiKey(options.apiKey);
    } else if (typeof options === "object" && "from" in options && options.from as string === "convex") {
      return this._useUserByConvex(options.ctx, "or" in options && options.or === "anonymous");
    } else {
      options = options as GetCurrentUserOptions<HasTokenStore> | undefined;
      // TODO this code is duplicated from the client app; fix that

      // Validate that includeRestricted: false and or: 'anonymous' are mutually exclusive
      if (options?.or === 'anonymous' && options.includeRestricted === false) {
        throw new Error("Cannot use { or: 'anonymous' } with { includeRestricted: false }. Anonymous users implicitly include restricted users.");
      }

      this._ensurePersistentTokenStore(options?.tokenStore);

      const session = this._useSession(options?.tokenStore);
      let crud = useAsyncCache(this._currentServerUserCache, [session] as const, "serverApp.useUser()");
      const includeAnonymous = options?.or === "anonymous" || options?.or === "anonymous-if-exists[deprecated]";
      const includeRestricted = options?.includeRestricted === true || includeAnonymous;

      if (crud === null) {
        switch (options?.or) {
          case 'redirect': {
            runAsynchronously(this.redirectToSignIn({ replace: true }));
            suspend();
            throw new HexclaveAssertionError("suspend should never return");
          }
          case 'throw': {
            throw new Error("User is not signed in but useUser was called with { or: 'throw' }");
          }
          case 'anonymous': {
            // TODO we should think about the behavior when calling useUser (or getUser) in anonymous with a custom token store. signUpAnonymously always sets the current token store on app level, instead of the one passed to this function
            // TODO we shouldn't reload & suspend here, instead we should use a promise that resolves to the new anonymous user
            runAsynchronously(async () => {
              await this._signUpAnonymously();
              if (typeof window !== "undefined") {
                window.location.reload();
              }
            });
            suspend();
            throw new HexclaveAssertionError("suspend should never return");
          }
          case undefined:
          case "anonymous-if-exists[deprecated]":
          case "return-null": {
            // do nothing
          }
        }
      }

      return useMemo(() => {
        return crud && this._currentUserFromCrud(crud, session);
      }, [crud, session, options?.or]);
    }
  }
  // END_PLATFORM
  // IF_PLATFORM react-like
  useUserById(userId: string): ServerUser | null {
    const crud = useAsyncCache(this._serverUserCache, [userId], "serverApp.useUserById()");
    return useMemo(() => {
      return crud && this._serverUserFromCrud(crud);
    }, [crud]);
  }
  // END_PLATFORM

  async listUsers(options?: ServerListUsersOptions): Promise<ServerUser[] & { nextCursor: string | null }> {
    const excludedEmailDomains = options?.excludedEmailDomains && options.excludedEmailDomains.length > 0 ? options.excludedEmailDomains.join(",") : undefined;
    const crud = Result.orThrow(await this._serverUsersCache.getOrWait([options?.cursor, options?.limit, options?.orderBy, options?.desc, options?.query, options?.includeRestricted, options?.includeAnonymous, options?.onlyAnonymous, options?.teamId, excludedEmailDomains], "write-only"));
    const result: any = crud.items.map((j) => this._serverUserFromCrud(j));
    result.nextCursor = crud.pagination?.next_cursor ?? null;
    return result as any;
  }

  // IF_PLATFORM react-like
  useUsers(options?: ServerListUsersOptions): ServerUser[] & { nextCursor: string | null } {
    const excludedEmailDomains = options?.excludedEmailDomains && options.excludedEmailDomains.length > 0 ? options.excludedEmailDomains.join(",") : undefined;
    const crud = useAsyncCache(this._serverUsersCache, [options?.cursor, options?.limit, options?.orderBy, options?.desc, options?.query, options?.includeRestricted, options?.includeAnonymous, options?.onlyAnonymous, options?.teamId, excludedEmailDomains] as const, "serverApp.useUsers()");
    const result: any = crud.items.map((j) => this._serverUserFromCrud(j));
    result.nextCursor = crud.pagination?.next_cursor ?? null;
    return result as any;
  }
  // END_PLATFORM

  _serverPermissionFromCrud(crud: TeamPermissionsCrud['Server']['Read'] | ProjectPermissionsCrud['Server']['Read']): AdminTeamPermission {
    return {
      id: crud.id,
    };
  }

  _serverTeamPermissionDefinitionFromCrud(crud: TeamPermissionDefinitionsCrud['Admin']['Read']): AdminTeamPermissionDefinition {
    return {
      id: crud.id,
      description: crud.description,
      containedPermissionIds: crud.contained_permission_ids,
    };
  }

  _serverProjectPermissionDefinitionFromCrud(crud: ProjectPermissionDefinitionsCrud['Admin']['Read']): AdminProjectPermissionDefinition {
    return {
      id: crud.id,
      description: crud.description,
      containedPermissionIds: crud.contained_permission_ids,
    };
  }

  async getItem(options: { itemId: string, userId: string } | { itemId: string, teamId: string } | { itemId: string, customCustomerId: string }): Promise<ServerItem> {
    if ("userId" in options) {
      const result = Result.orThrow(await this._serverUserItemsCache.getOrWait([options.userId, options.itemId], "write-only"));
      return this._serverItemFromCrud({ type: "user", id: options.userId }, result);
    } else if ("teamId" in options) {
      const result = Result.orThrow(await this._serverTeamItemsCache.getOrWait([options.teamId, options.itemId], "write-only"));
      return this._serverItemFromCrud({ type: "team", id: options.teamId }, result);
    } else {
      const result = Result.orThrow(await this._serverCustomItemsCache.getOrWait([options.customCustomerId, options.itemId], "write-only"));
      return this._serverItemFromCrud({ type: "custom", id: options.customCustomerId }, result);
    }
  }

  protected async _refreshItemCache(customerType: "user" | "team" | "custom", customerId: string, itemId: string): Promise<void> {
    if (customerType === "user") {
      await this._serverUserItemsCache.refresh([customerId, itemId]);
    } else if (customerType === "team") {
      await this._serverTeamItemsCache.refresh([customerId, itemId]);
    } else {
      await this._serverCustomItemsCache.refresh([customerId, itemId]);
    }
  }

  async listProducts(options: CustomerProductsRequestOptions): Promise<CustomerProductsList> {
    if ("userId" in options) {
      const response = Result.orThrow(await this._serverUserProductsCache.getOrWait([options.userId, options.cursor ?? null, options.limit ?? null], "write-only"));
      return this._customerProductsFromResponse(response);
    } else if ("teamId" in options) {
      const response = Result.orThrow(await this._serverTeamProductsCache.getOrWait([options.teamId, options.cursor ?? null, options.limit ?? null], "write-only"));
      return this._customerProductsFromResponse(response);
    }
    const response = Result.orThrow(await this._serverCustomProductsCache.getOrWait([options.customCustomerId, options.cursor ?? null, options.limit ?? null], "write-only"));
    return this._customerProductsFromResponse(response);
  }

  // IF_PLATFORM react-like
  useItem(options: { itemId: string, userId: string } | { itemId: string, teamId: string } | { itemId: string, customCustomerId: string }): ServerItem {
    let type: "user" | "team" | "custom";
    let id: string;
    let cache: AsyncCache<[string, string], Result<ItemCrud['Client']['Read']>>;
    if ("userId" in options) {
      type = "user";
      id = options.userId;
      cache = this._serverUserItemsCache;
    } else if ("teamId" in options) {
      type = "team";
      id = options.teamId;
      cache = this._serverTeamItemsCache;
    } else {
      type = "custom";
      id = options.customCustomerId;
      cache = this._serverCustomItemsCache;
    }

    const cacheKey = [id, options.itemId] as [string, string];
    const debugLabel = "serverApp.useItem()";
    const result = useAsyncCache(cache, cacheKey, debugLabel);
    return useMemo(() => this._serverItemFromCrud({ type, id }, result), [result]);
  }
  // END_PLATFORM
  private _resolveCustomer(
    options: { userId: string } | { teamId: string } | { customCustomerId: string }
  ): { customerType: "user" | "team" | "custom", customerId: string } {
    if ("userId" in options) {
      return { customerType: "user", customerId: options.userId };
    }
    if ("teamId" in options) {
      return { customerType: "team", customerId: options.teamId };
    }
    return { customerType: "custom", customerId: options.customCustomerId };
  }

  async grantProduct(options: (
    ({ userId: string } | { teamId: string } | { customCustomerId: string }) &
    ({ productId: string } | { product: InlineProduct }) &
    { quantity?: number }
  )): Promise<void> {
    const { customerType, customerId } = this._resolveCustomer(options);

    await this._interface.grantProduct({
      customerType,
      customerId,
      productId: "productId" in options ? options.productId : undefined,
      product: "product" in options ? options.product : undefined,
      quantity: options.quantity,
    });

    const cache = customerType === "user"
      ? this._serverUserProductsCache
      : customerType === "team"
        ? this._serverTeamProductsCache
        : this._serverCustomProductsCache;
    await cache.refresh([customerId, null, null]);
  }

  async createCheckoutUrl(options: (
    ({ userId: string } | { teamId: string } | { customCustomerId: string }) &
    ({ productId: string } | { product: InlineProduct }) &
    { returnUrl?: string }
  )): Promise<string> {
    const { customerType, customerId } = this._resolveCustomer(options);

    const productIdOrInline = "productId" in options ? options.productId : options.product;
    return await this._interface.createCheckoutUrl(customerType, customerId, productIdOrInline, null, options.returnUrl, "server");
  }

  async createTeam(data: ServerTeamCreateOptions): Promise<ServerTeam> {
    const team = await this._interface.createServerTeam(serverTeamCreateOptionsToCrud(data));
    await this._serverTeamCache.refresh([team.id]);
    await this._serverTeamsCache.refreshWhere(() => true);
    return this._serverTeamFromCrud(team);
  }

  async listTeams(options?: ServerListTeamsOptions): Promise<ServerTeam[] & { nextCursor: string | null }> {
    const crud = Result.orThrow(await this._serverTeamsCache.getOrWait([undefined, options?.orderBy, options?.desc, options?.cursor, options?.limit, options?.query] as const, "write-only"));
    const teams: any = crud.items.map((t) => this._serverTeamFromCrud(t));
    teams.nextCursor = crud.pagination?.next_cursor ?? null;
    return teams as any;
  }

  // IF_PLATFORM react-like
  useTeams(options?: ServerListTeamsOptions): ServerTeam[] & { nextCursor: string | null } {
    const crud = useAsyncCache(this._serverTeamsCache, [undefined, options?.orderBy, options?.desc, options?.cursor, options?.limit, options?.query] as const, "serverApp.useTeams()");
    return useMemo(() => {
      const teams: any = crud.items.map((t) => this._serverTeamFromCrud(t));
      teams.nextCursor = crud.pagination?.next_cursor ?? null;
      return teams as any;
    }, [crud]);
  }
  // END_PLATFORM

  async listTeamMemberPermissions(teamId: string, options?: { recursive?: boolean }): Promise<{ userId: string, permissionId: string }[]> {
    const recursive = options?.recursive ?? false;
    const rows = Result.orThrow(await this._serverAllTeamMemberPermissionsCache.getOrWait([teamId, recursive] as const, "write-only"));
    return rows.map((r) => ({ userId: r.user_id, permissionId: r.id }));
  }

  // IF_PLATFORM react-like
  useTeamMemberPermissions(teamId: string, options?: { recursive?: boolean }): { userId: string, permissionId: string }[] {
    const recursive = options?.recursive ?? false;
    const rows = useAsyncCache(this._serverAllTeamMemberPermissionsCache, [teamId, recursive] as const, "serverApp.useTeamMemberPermissions()");
    return useMemo(() => rows.map((r) => ({ userId: r.user_id, permissionId: r.id })), [rows]);
  }
  // END_PLATFORM

  async getTeam(options: { apiKey: string }): Promise<ServerTeam | null>;
  async getTeam(teamId: string): Promise<ServerTeam | null>;
  async getTeam(options?: { apiKey: string } | string): Promise<ServerTeam | null> {
    if (typeof options === "object" && "apiKey" in options) {
      return await this._getTeamByApiKey(options.apiKey);
    } else {
      const teamId = options;
      if (teamId == null) {
        return null;
      }
      const team = Result.orThrow(await this._serverTeamCache.getOrWait([teamId], "write-only"));
      return team == null ? null : this._serverTeamFromCrud(team);
    }
  }

  // IF_PLATFORM react-like
  useTeam(options: { apiKey: string }): ServerTeam | null;
  useTeam(teamId: string): ServerTeam | null;
  useTeam(options?: { apiKey: string } | string): ServerTeam | null {
    if (typeof options === "object" && "apiKey" in options) {
      return this._useTeamByApiKey(options.apiKey);
    } else {
      const teamId = options;
      // "" is never a valid UUID, so the cache resolves a nullish id to null while keeping the hook call order stable.
      const team = useAsyncCache(this._serverTeamCache, [teamId ?? ""], "serverApp.useTeam()");
      return useMemo(() => {
        return team == null ? null : this._serverTeamFromCrud(team);
      }, [team]);
    }
  }
  // END_PLATFORM

  protected _createServerDataVaultStore(id: string): DataVaultStore {
    const validateOptions = (options: { secret: string }) => {
      if (typeof options.secret !== "string") throw new Error("secret must be a string, got " + typeof options.secret);
    };
    return {
      id,
      setValue: async (key, value, options) => {
        validateOptions(options);
        await this._interface.setDataVaultStoreValue(options.secret, id, key, value);
      },
      getValue: async (key, options) => {
        validateOptions(options);
        return Result.orThrow(await this._serverDataVaultStoreValueCache.getOrWait([id, key, options.secret], "write-only"));
      },
      // IF_PLATFORM react-like
      useValue: (key, options) => {
        validateOptions(options);
        return useAsyncCache(this._serverDataVaultStoreValueCache, [id, key, options.secret] as const, "store.useValue()");
      },
      // END_PLATFORM
    };
  }

  async getDataVaultStore(id: string): Promise<DataVaultStore> {
    return this._createServerDataVaultStore(id);
  }

  // IF_PLATFORM react-like
  useDataVaultStore(id: string): DataVaultStore {
    return useMemo(() => this._createServerDataVaultStore(id), [id]);
  }
  // END_PLATFORM

  async sendEmail(options: SendEmailOptions): Promise<void> {
    await this._interface.sendEmail(options);
    await this._emailDeliveryInfoCache.refresh([]);
  }

  async getEmailDeliveryStats(): Promise<EmailDeliveryInfo> {
    return Result.orThrow(await this._emailDeliveryInfoCache.getOrWait([], "write-only"));
  }

  // IF_PLATFORM react-like
  useEmailDeliveryStats(): EmailDeliveryInfo {
    return useAsyncCache(this._emailDeliveryInfoCache, [], "hexclaveServerApp.useEmailDeliveryStats()");
  }
  // END_PLATFORM

  async activateEmailCapacityBoost(): Promise<void> {
    await this._interface.activateEmailCapacityBoost();
    // Refresh the cache so UI updates immediately
    await this._emailDeliveryInfoCache.refresh([]);
  }

  async queryAnalytics(options: AnalyticsQueryOptions): Promise<AnalyticsQueryResponse> {
    return await this._interface.queryAnalytics(options);
  }

  async listSessionReplays(options?: ListSessionReplaysOptions): Promise<ListSessionReplaysResult> {
    const response = await this._interface.listSessionReplays({
      cursor: options?.cursor,
      limit: options?.limit,
      user_ids: options?.userIds,
      team_ids: options?.teamIds,
      duration_ms_min: options?.durationMsMin,
      duration_ms_max: options?.durationMsMax,
      last_event_at_from_millis: options?.lastEventAtFromMillis,
      last_event_at_to_millis: options?.lastEventAtToMillis,
      click_count_min: options?.clickCountMin,
    });

    const items: AdminSessionReplay[] = response.items.map((r) => ({
      id: r.id,
      refreshTokenId: r.refresh_token_id,
      projectUser: {
        id: r.project_user.id,
        displayName: r.project_user.display_name,
        primaryEmail: r.project_user.primary_email,
      },
      startedAt: new Date(r.started_at_millis),
      lastEventAt: new Date(r.last_event_at_millis),
      chunkCount: r.chunk_count,
      eventCount: r.event_count,
    }));

    return {
      items,
      nextCursor: response.pagination.next_cursor,
    };
  }

  async getSessionReplay(sessionReplayId: string): Promise<AdminSessionReplay> {
    const response = await this._interface.getSessionReplay(sessionReplayId);
    return {
      id: response.id,
      refreshTokenId: response.refresh_token_id,
      projectUser: {
        id: response.project_user.id,
        displayName: response.project_user.display_name,
        primaryEmail: response.project_user.primary_email,
      },
      startedAt: new Date(response.started_at_millis),
      lastEventAt: new Date(response.last_event_at_millis),
      chunkCount: response.chunk_count,
      eventCount: response.event_count,
    };
  }

  async listSessionReplayChunks(sessionReplayId: string, options?: ListSessionReplayChunksOptions): Promise<ListSessionReplayChunksResult> {
    const response = await this._interface.listSessionReplayChunks(sessionReplayId, {
      cursor: options?.cursor,
      limit: options?.limit,
    });

    const items: AdminSessionReplayChunk[] = response.items.map((c) => ({
      id: c.id,
      batchId: c.batch_id,
      sessionReplaySegmentId: c.session_replay_segment_id,
      browserSessionId: c.browser_session_id,
      eventCount: c.event_count,
      byteLength: c.byte_length,
      firstEventAt: new Date(c.first_event_at_millis),
      lastEventAt: new Date(c.last_event_at_millis),
      createdAt: new Date(c.created_at_millis),
    }));

    return {
      items,
      nextCursor: response.pagination.next_cursor,
    };
  }

  async getSessionReplayChunkEvents(sessionReplayId: string, chunkId: string): Promise<AdminGetSessionReplayChunkEventsResponse> {
    return await this._interface.getSessionReplayChunkEvents(sessionReplayId, chunkId);
  }

  async getSessionReplayEvents(sessionReplayId: string, options?: { offset?: number, limit?: number }): Promise<SessionReplayAllEventsResult> {
    const response = await this._interface.getSessionReplayEvents(sessionReplayId, options);
    return {
      chunks: response.chunks.map((c) => ({
        id: c.id,
        batchId: c.batch_id,
        sessionReplaySegmentId: c.session_replay_segment_id,
        eventCount: c.event_count,
        byteLength: c.byte_length,
        firstEventAt: new Date(c.first_event_at_millis),
        lastEventAt: new Date(c.last_event_at_millis),
        createdAt: new Date(c.created_at_millis),
      })),
      chunkEvents: response.chunk_events.map((ce) => ({
        chunkId: ce.chunk_id,
        events: ce.events,
      })),
    };
  }

  protected override async _refreshSession(session: InternalSession) {
    await Promise.all([
      super._refreshUser(session),
      this._currentServerUserCache.refresh([session]),
    ]);
  }

  protected override async _refreshUsers() {
    await Promise.all([
      super._refreshUsers(),
      this._serverUserCache.refreshWhere(() => true),
      this._serverUsersCache.refreshWhere(() => true),
      this._serverContactChannelsCache.refreshWhere(() => true),
      this._serverOAuthProvidersCache.refreshWhere(() => true),
      this._serverUserConnectedAccountsCache.refreshWhere(() => true),
    ]);
  }

  async createOAuthProvider(options: {
    userId: string,
    providerConfigId: string,
    accountId: string,
    email: string,
    allowSignIn: boolean,
    allowConnectedAccounts: boolean,
  }): Promise<Result<ServerOAuthProvider, InstanceType<typeof KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn>>> {
    try {
      const crud = await this._interface.createServerOAuthProvider({
        user_id: options.userId,
        provider_config_id: options.providerConfigId,
        account_id: options.accountId,
        email: options.email,
        allow_sign_in: options.allowSignIn,
        allow_connected_accounts: options.allowConnectedAccounts,
      });

      await Promise.all([
        this._serverOAuthProvidersCache.refresh([options.userId]),
        this._serverUserConnectedAccountsCache.refresh([options.userId]),
      ]);
      return Result.ok(this._serverOAuthProviderFromCrud(crud));
    } catch (error) {
      if (KnownErrors.OAuthProviderAccountIdAlreadyUsedForSignIn.isInstance(error)) {
        return Result.error(error);
      }
      throw error;
    }
  }
}

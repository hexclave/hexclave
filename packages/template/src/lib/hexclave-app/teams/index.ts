import { TeamsCrud } from "@hexclave/shared/dist/interface/crud/teams";
import { ReadonlyJson } from "@hexclave/shared/dist/utils/json";

import { ApiKeyCreationOptions, TeamApiKey, TeamApiKeyFirstView } from "../api-keys";
import { AsyncStoreProperty } from "../common";
import { Customer } from "../customers";
import { ServerUser } from "../users";


export type TeamMemberProfile = {
  displayName: string | null,
  profileImageUrl: string | null,
}

export type TeamMemberProfileUpdateOptions = {
  displayName?: string,
  profileImageUrl?: string | null,
};

export type EditableTeamMemberProfile = TeamMemberProfile & {
  update(update: TeamMemberProfileUpdateOptions): Promise<void>,
}

export type TeamUser = {
  id: string,
  teamProfile: TeamMemberProfile,
}

/**
 * A team invitation as seen from the team's perspective (ie. the sender).
 *
 * Returned by `team.listInvitations()`. Contains the recipient email and allows
 * revoking the invitation.
 */
export type SentTeamInvitation = {
  id: string,
  recipientEmail: string | null,
  expiresAt: Date,
  revoke(): Promise<void>,
}

/**
 * @deprecated Use `SentTeamInvitation` instead.
 */
export type TeamInvitation = SentTeamInvitation;

/**
 * A team invitation as seen from the invited user's perspective (ie. the receiver).
 *
 * Returned by `user.listTeamInvitations()`. Contains information about teams that have
 * sent invitations to any of the user's verified email addresses, and allows accepting
 * the invitation to join the team.
 */
export type ReceivedTeamInvitation = {
  id: string,
  teamId: string,
  teamDisplayName: string,
  recipientEmail: string,
  expiresAt: Date,

  /**
   * Accepts the invitation, adding the current user to the team.
   *
   * The user must have a verified email address matching the invitation's recipient email.
   */
  accept(): Promise<void>,
}

export type Team = {
  id: string,
  displayName: string,
  profileImageUrl: string | null,
  clientMetadata: any,
  clientReadOnlyMetadata: any,
  inviteUser(options: { email: string, callbackUrl?: string }): Promise<void>,
  listUsers(): Promise<TeamUser[]>,
  removeUser(userId: string): Promise<void>,
  useUsers(): TeamUser[], // THIS_LINE_PLATFORM react-like
  listInvitations(): Promise<SentTeamInvitation[]>,
  useInvitations(): SentTeamInvitation[], // THIS_LINE_PLATFORM react-like
  update(update: TeamUpdateOptions): Promise<void>,
  delete(): Promise<void>,
  createApiKey(options: ApiKeyCreationOptions<"team">): Promise<TeamApiKeyFirstView>,
} & AsyncStoreProperty<"apiKeys", [], TeamApiKey[], true> & Customer;

export type TeamUpdateOptions = {
  displayName?: string,
  profileImageUrl?: string | null,
  clientMetadata?: ReadonlyJson,
};
export function teamUpdateOptionsToCrud(options: TeamUpdateOptions): TeamsCrud["Client"]["Update"] {
  return {
    display_name: options.displayName,
    profile_image_url: options.profileImageUrl,
    client_metadata: options.clientMetadata,
  };
}

export type TeamCreateOptions = {
  displayName: string,
  profileImageUrl?: string,
}
export function teamCreateOptionsToCrud(options: TeamCreateOptions, creatorUserId: string): TeamsCrud["Client"]["Create"] {
  return {
    display_name: options.displayName,
    profile_image_url: options.profileImageUrl,
    creator_user_id: creatorUserId,
  };
}


export type ServerTeamMemberProfile = TeamMemberProfile;

export type ServerTeamUser = ServerUser & {
  teamProfile: ServerTeamMemberProfile,
}

export type ServerTeam = {
  createdAt: Date,
  serverMetadata: any,
  listUsers(): Promise<ServerTeamUser[]>,
  useUsers(): ServerUser[], // THIS_LINE_PLATFORM react-like
  update(update: ServerTeamUpdateOptions): Promise<void>,
  delete(): Promise<void>,
  addUser(userId: string): Promise<void>,
  inviteUser(options: { email: string, callbackUrl?: string }): Promise<void>,
  removeUser(userId: string): Promise<void>,
} & Team;

type ServerListUsersOptionsBase = {
  cursor?: string,
  /**
   * Maximum number of users to return per page. Must be at most 1000.
   */
  limit?: number,
  orderBy?: 'signedUpAt' | 'lastActiveAt',
  desc?: boolean,
  /**
   * Free-text search. Matches user ID (exact UUID), display name, and contact channels (e.g. primary email).
   */
  query?: string,
  /**
   * Exclude users whose primary email domain matches one of these exact domains.
   */
  excludedEmailDomains?: string[],
  /**
   * Only return users who are members of the given team.
   */
  teamId?: string,
  /**
   * Whether to include restricted users (users who haven't completed onboarding requirements).
   * Defaults to false.
   */
  includeRestricted?: boolean,
  /**
   * Whether to include anonymous users (and restricted users).
   * Defaults to false.
   */
  includeAnonymous?: boolean,
};

export type ServerListUsersOptions = ServerListUsersOptionsBase & (
  {
    onlyAnonymous?: false,
  } | {
  /**
   * Whether to return only anonymous users.
   * Requires includeAnonymous=true.
   * Defaults to false.
   */
    onlyAnonymous: true,
    includeAnonymous: true,
  }
);

export type ListTeamsOptions = {
  orderBy?: 'createdAt',
  desc?: boolean,
  /**
   * Free-text search. Matches team ID (exact UUID) and display name.
   */
  query?: string,
} & (
  {
    /**
     * Maximum number of teams to return (at most 200). If omitted, all teams are returned, but the request fails if
     * more than 500 teams match; prefer setting `limit`. When there are more teams than `limit`, `nextCursor` on the
     * result is set and can be passed as `cursor` (together with `limit`) to fetch the rest.
     */
    limit?: number,
    cursor?: undefined,
  } | {
    limit: number,
    /**
     * The `nextCursor` of the previous page. The backend rejects a cursor without a `limit`.
     */
    cursor?: string,
  }
);

export type TeamList<T> = T[] & { nextCursor: string | null };

export function teamListFromCrud<Crud, T>(crud: { items: Crud[], pagination?: { next_cursor: string | null } }, mapTeam: (crud: Crud) => T): TeamList<T> {
  return Object.assign(crud.items.map(mapTeam), { nextCursor: crud.pagination?.next_cursor ?? null });
}

export type ServerListTeamsOptions = ListTeamsOptions;

export type ServerTeamCreateOptions = TeamCreateOptions & {
  creatorUserId?: string,
};
export function serverTeamCreateOptionsToCrud(options: ServerTeamCreateOptions): TeamsCrud["Server"]["Create"] {
  return {
    display_name: options.displayName,
    profile_image_url: options.profileImageUrl,
    creator_user_id: options.creatorUserId,
  };
}

export type ServerTeamUpdateOptions = TeamUpdateOptions & {
  clientReadOnlyMetadata?: ReadonlyJson,
  serverMetadata?: ReadonlyJson,
};
export function serverTeamUpdateOptionsToCrud(options: ServerTeamUpdateOptions): TeamsCrud["Server"]["Update"] {
  return {
    display_name: options.displayName,
    profile_image_url: options.profileImageUrl,
    client_metadata: options.clientMetadata,
    client_read_only_metadata: options.clientReadOnlyMetadata,
    server_metadata: options.serverMetadata,
  };
}

"""StackServerApp and AsyncStackServerApp facade classes.

These are the primary entry points for the Stack Auth Python SDK.
Developers instantiate one of these classes and call methods like
``get_user``, ``list_users``, ``create_user``, etc.

Both classes compose an HTTP client from :mod:`stack_auth._client` and
delegate response parsing to Pydantic models.
"""

from __future__ import annotations

from typing import Any, Optional

from stack_auth._auth import TokenPartialUser, decode_access_token_claims
from stack_auth._client import AsyncAPIClient, SyncAPIClient
from stack_auth._constants import DEFAULT_BASE_URL
from stack_auth._pagination import PaginatedResult, _PaginationMeta
from stack_auth._token_store import TokenStore, TokenStoreInit, resolve_token_store
from stack_auth.errors import ApiKeyError, NotFoundError
from stack_auth.models.data_vault import AsyncDataVaultStore, DataVaultStore
from stack_auth.models.email import EmailDeliveryInfo
from stack_auth.models.payments import AsyncServerItem, Item, Product, ServerItem
from stack_auth.models.api_keys import (
    TeamApiKey,
    TeamApiKeyFirstView,
    UserApiKey,
    UserApiKeyFirstView,
)
from stack_auth.models.contact_channels import ContactChannel
from stack_auth.models.oauth import OAuthProvider
from stack_auth.models.permissions import TeamPermission
from stack_auth.models.sessions import ActiveSession
from stack_auth.models.teams import ServerTeam, TeamInvitation, TeamMemberProfile
from stack_auth.models.users import ServerUser

# Sentinel object to distinguish "not provided" from "explicitly None".
_UNSET = object()


def _build_params(**kwargs: Any) -> dict[str, Any]:
    """Build a dict from keyword arguments, omitting any whose value is None."""
    return {k: v for k, v in kwargs.items() if v is not None}


def _resolve_customer_path(
    user_id: str | None = None,
    team_id: str | None = None,
    custom_customer_id: str | None = None,
) -> tuple[str, str, str]:
    """Resolve polymorphic customer identification.

    Exactly one of *user_id*, *team_id*, or *custom_customer_id* must be
    provided.

    Returns:
        A tuple of ``(customer_type, customer_id, id_field_name)`` where
        *customer_type* is one of ``"user"``, ``"team"``, ``"custom"`` and
        *id_field_name* is the corresponding body key.
    """
    options = [
        ("user", user_id, "user_id"),
        ("team", team_id, "team_id"),
        ("custom", custom_customer_id, "custom_customer_id"),
    ]
    provided = [(t, i, f) for t, i, f in options if i is not None]
    if len(provided) != 1:
        raise ValueError(
            "Exactly one of user_id, team_id, or custom_customer_id must be provided"
        )
    return provided[0]


# ---------------------------------------------------------------------------
# StackServerApp (sync)
# ---------------------------------------------------------------------------


class StackServerApp:
    """Synchronous facade for the Stack Auth API.

    Provides type-safe, synchronous methods for user management, team
    management, permissions, API keys, OAuth providers, payments, email,
    and data vault operations.

    Example::

        from stack_auth import StackServerApp

        # Constructor with all parameters
        app = StackServerApp(
            project_id="my-project-id",
            secret_server_key="ssk_...",
            base_url="https://api.stack-auth.com",
            token_store=None,  # optional TokenStoreInit
        )

        # Or use as a context manager for automatic cleanup
        with StackServerApp(
            project_id="my-project-id",
            secret_server_key="ssk_...",
        ) as app:
            # User CRUD
            user = app.create_user(
                primary_email="alice@example.com",
                display_name="Alice",
            )
            fetched = app.get_user(user.id)
            users = app.list_users(limit=10)

            # Team operations
            team = app.create_team(
                display_name="Engineering",
                creator_user_id=user.id,
            )
            app.add_team_member(team.id, user.id)
    """

    def __init__(
        self,
        *,
        project_id: str,
        secret_server_key: str,
        publishable_client_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        token_store: TokenStoreInit | None = None,
    ) -> None:
        """Initialize the synchronous Stack Auth application client.

        Args:
            project_id: The Stack Auth project identifier.
            secret_server_key: Server-side secret key for authentication.
            publishable_client_key: Optional publishable client key.
            base_url: Stack Auth API base URL.
            token_store: Optional token storage initializer for user sessions.
        """
        self._project_id = project_id
        self._client = SyncAPIClient(
            project_id=project_id,
            secret_server_key=secret_server_key,
            publishable_client_key=publishable_client_key,
            base_url=base_url,
        )
        self._token_store: TokenStore | None = None
        if token_store is not None:
            self._token_store = resolve_token_store(token_store, project_id)

    # -- lifecycle -----------------------------------------------------------

    def close(self) -> None:
        """Close the underlying HTTP client.

        Args:
            (none)

        Returns:
            None.
        """
        self._client.close()

    def __enter__(self) -> StackServerApp:
        """Enter the context manager."""
        return self

    def __exit__(self, *_: Any) -> None:
        """Exit the context manager and close the client."""
        self.close()

    # -- partial user (local JWT decode) -------------------------------------

    def get_partial_user(
        self,
        *,
        token_store: TokenStoreInit | None = _UNSET,
    ) -> TokenPartialUser | None:
        """Get minimal user info from the access token without a network request.

        Decodes the JWT payload from the token store's access token to extract
        partial user information. Does NOT verify the token's signature.

        Args:
            token_store: Override token storage for this call. If not provided,
                uses the instance's token store. Pass ``None`` explicitly to
                indicate no token store.

        Returns:
            A :class:`TokenPartialUser` with user ID and claims from the JWT,
            or ``None`` if no access token is available or the token is malformed.
        """
        if token_store is _UNSET:
            store = self._token_store
        elif token_store is None:
            store = None
        else:
            store = resolve_token_store(token_store, self._project_id)

        if store is None:
            return None

        access_token = store.get_stored_access_token()
        if access_token is None:
            return None

        return decode_access_token_claims(access_token)

    # -- user CRUD -----------------------------------------------------------

    def get_user(self, user_id: str) -> ServerUser | None:
        """Fetch a user by ID.

        Args:
            user_id: The unique identifier of the user to retrieve.

        Returns:
            A :class:`ServerUser` if found, or ``None`` if the user does
            not exist (HTTP 404).

        Raises:
            StackAuthError: If the API returns an unexpected error.
        """
        try:
            data = self._client.request("GET", f"/users/{user_id}")
        except NotFoundError:
            return None
        if data is None:
            return None
        return ServerUser.model_validate(data)

    def list_users(
        self,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        order_by: Optional[str] = None,
        desc: Optional[bool] = None,
        query: Optional[str] = None,
        include_restricted: Optional[bool] = None,
        include_anonymous: Optional[bool] = None,
    ) -> PaginatedResult[ServerUser]:
        """List users with optional filtering and pagination.

        Args:
            cursor: Pagination cursor from a previous response.
            limit: Maximum number of users to return per page.
            order_by: Field name to sort by (e.g., ``"created_at"``).
            desc: If ``True``, sort in descending order.
            query: Full-text search query to filter users.
            include_restricted: If ``True``, include restricted users.
            include_anonymous: If ``True``, include anonymous users.

        Returns:
            A :class:`PaginatedResult` containing :class:`ServerUser` items
            and pagination metadata for fetching additional pages.
        """
        params = _build_params(
            cursor=cursor,
            limit=limit,
            order_by=order_by,
            desc=desc,
            query=query,
            include_restricted=include_restricted,
            include_anonymous=include_anonymous,
        )
        data = self._client.request("GET", "/users", params=params)
        if data is None:
            return PaginatedResult(items=[])
        items = [ServerUser.model_validate(i) for i in data.get("items", [])]
        pagination = _PaginationMeta(**(data.get("pagination") or {}))
        return PaginatedResult(items=items, pagination=pagination)

    def create_user(
        self,
        *,
        primary_email: Optional[str] = None,
        primary_email_auth_enabled: Optional[bool] = None,
        password: Optional[str] = None,
        otp_auth_enabled: Optional[bool] = None,
        display_name: Optional[str] = None,
        primary_email_verified: Optional[bool] = None,
        client_metadata: Optional[dict[str, Any]] = None,
        client_read_only_metadata: Optional[dict[str, Any]] = None,
        server_metadata: Optional[dict[str, Any]] = None,
    ) -> ServerUser:
        """Create a new user. Only non-None fields are sent.

        Args:
            primary_email: The user's primary email address.
            primary_email_auth_enabled: Whether email-based auth is enabled.
            password: Initial password for password-based auth.
            otp_auth_enabled: Whether OTP (one-time password) auth is enabled.
            display_name: Human-readable display name.
            primary_email_verified: Whether to mark the email as pre-verified.
            client_metadata: Arbitrary metadata readable by the client SDK.
            client_read_only_metadata: Metadata readable but not writable
                by the client SDK.
            server_metadata: Metadata only accessible from the server.

        Returns:
            The newly created :class:`ServerUser`.

        Raises:
            ValidationError: If the provided fields fail server-side validation.
            StackAuthError: If the API returns an unexpected error.
        """
        body = _build_params(
            primary_email=primary_email,
            primary_email_auth_enabled=primary_email_auth_enabled,
            password=password,
            otp_auth_enabled=otp_auth_enabled,
            display_name=display_name,
            primary_email_verified=primary_email_verified,
            client_metadata=client_metadata,
            client_read_only_metadata=client_read_only_metadata,
            server_metadata=server_metadata,
        )
        data = self._client.request("POST", "/users", body=body)
        return ServerUser.model_validate(data)

    def update_user(
        self,
        user_id: str,
        *,
        display_name: Any = _UNSET,
        client_metadata: Any = _UNSET,
        client_read_only_metadata: Any = _UNSET,
        server_metadata: Any = _UNSET,
        primary_email: Any = _UNSET,
        primary_email_verified: Any = _UNSET,
        primary_email_auth_enabled: Any = _UNSET,
        password: Any = _UNSET,
        otp_auth_enabled: Any = _UNSET,
        profile_image_url: Any = _UNSET,
        selected_team_id: Any = _UNSET,
    ) -> ServerUser:
        """Update a user. Only explicitly provided fields are sent.

        Pass ``None`` to clear a field. Omit a parameter to leave it unchanged.

        Args:
            user_id: The unique identifier of the user to update.
            display_name: New display name, or ``None`` to clear.
            client_metadata: New client metadata dict, or ``None`` to clear.
            client_read_only_metadata: New client read-only metadata dict,
                or ``None`` to clear.
            server_metadata: New server metadata dict, or ``None`` to clear.
            primary_email: New primary email, or ``None`` to clear.
            primary_email_verified: Whether the email is verified.
            primary_email_auth_enabled: Whether email auth is enabled.
            password: New password.
            otp_auth_enabled: Whether OTP auth is enabled.
            profile_image_url: URL to profile image, or ``None`` to clear.
            selected_team_id: The user's selected team, or ``None`` to clear.

        Returns:
            The updated :class:`ServerUser`.

        Raises:
            ValidationError: If the provided fields fail server-side validation.
            NotFoundError: If the user does not exist.
        """
        fields = {
            "display_name": display_name,
            "client_metadata": client_metadata,
            "client_read_only_metadata": client_read_only_metadata,
            "server_metadata": server_metadata,
            "primary_email": primary_email,
            "primary_email_verified": primary_email_verified,
            "primary_email_auth_enabled": primary_email_auth_enabled,
            "password": password,
            "otp_auth_enabled": otp_auth_enabled,
            "profile_image_url": profile_image_url,
            "selected_team_id": selected_team_id,
        }
        body = {k: v for k, v in fields.items() if v is not _UNSET}
        data = self._client.request("PATCH", f"/users/{user_id}", body=body)
        return ServerUser.model_validate(data)

    def delete_user(self, user_id: str) -> None:
        """Delete a user by ID.

        Args:
            user_id: The unique identifier of the user to delete.

        Returns:
            None.

        Raises:
            NotFoundError: If the user does not exist.
        """
        self._client.request("DELETE", f"/users/{user_id}")

    def get_user_by_api_key(self, api_key: str) -> ServerUser | None:
        """Look up a user by their API key.

        Performs a two-step lookup: first validates the key, then fetches the user.

        Args:
            api_key: The API key string to look up.

        Returns:
            The :class:`ServerUser` associated with the key, or ``None``
            if the key is invalid or has no associated user.
        """
        try:
            data = self._client.request(
                "POST", "/api-keys/check", body={"api_key": api_key}
            )
        except (NotFoundError, ApiKeyError):
            return None
        if data is None or "user_id" not in data:
            return None
        return self.get_user(data["user_id"])

    # -- session management --------------------------------------------------

    def list_sessions(self, user_id: str) -> list[ActiveSession]:
        """List active sessions for a user.

        Args:
            user_id: The user whose sessions to list.

        Returns:
            A list of :class:`ActiveSession` objects.
        """
        data = self._client.request(
            "GET", "/auth/sessions", params={"user_id": user_id}
        )
        return [
            ActiveSession.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def get_session(
        self, session_id: str, *, user_id: str
    ) -> ActiveSession | None:
        """Get a specific session by ID.

        Fetches all sessions for the user and filters by *session_id*.

        Args:
            session_id: The session to retrieve.
            user_id: The user who owns the session.

        Returns:
            The :class:`ActiveSession` if found, or ``None``.
        """
        sessions = self.list_sessions(user_id)
        return next((s for s in sessions if s.id == session_id), None)

    def revoke_session(self, session_id: str, *, user_id: str) -> None:
        """Revoke (delete) a session.

        Args:
            session_id: The session to revoke.
            user_id: The user who owns the session.

        Returns:
            None.
        """
        self._client.request(
            "DELETE",
            f"/auth/sessions/{session_id}",
            params={"user_id": user_id},
        )

    # -- team CRUD -----------------------------------------------------------

    def get_team(self, team_id: str) -> ServerTeam | None:
        """Fetch a team by ID.

        Args:
            team_id: The unique identifier of the team to retrieve.

        Returns:
            A :class:`ServerTeam` if found, or ``None`` if the team does
            not exist (HTTP 404).

        Raises:
            StackAuthError: If the API returns an unexpected error.
        """
        try:
            data = self._client.request("GET", f"/teams/{team_id}")
        except NotFoundError:
            return None
        if data is None:
            return None
        return ServerTeam.model_validate(data)

    def list_teams(
        self, *, user_id: Optional[str] = None
    ) -> list[ServerTeam]:
        """List teams, optionally filtered by user membership.

        This endpoint does not support pagination.

        Args:
            user_id: If provided, only return teams where this user
                is a member.

        Returns:
            A list of :class:`ServerTeam` objects.
        """
        params = _build_params(user_id=user_id)
        data = self._client.request("GET", "/teams", params=params)
        return [
            ServerTeam.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def create_team(
        self,
        *,
        display_name: str,
        profile_image_url: Optional[str] = None,
        creator_user_id: Optional[str] = None,
    ) -> ServerTeam:
        """Create a new team.

        Args:
            display_name: The display name for the team.
            profile_image_url: Optional URL for the team's profile image.
            creator_user_id: If provided, this user will be added as the
                initial team member and creator.

        Returns:
            The newly created :class:`ServerTeam`.

        Raises:
            ValidationError: If the provided fields fail server-side validation.
        """
        body = _build_params(
            display_name=display_name,
            profile_image_url=profile_image_url,
            creator_user_id=creator_user_id,
        )
        data = self._client.request("POST", "/teams", body=body)
        return ServerTeam.model_validate(data)

    def update_team(
        self,
        team_id: str,
        *,
        display_name: Any = _UNSET,
        profile_image_url: Any = _UNSET,
        client_metadata: Any = _UNSET,
        client_read_only_metadata: Any = _UNSET,
        server_metadata: Any = _UNSET,
    ) -> ServerTeam:
        """Update a team. Only explicitly provided fields are sent.

        Pass ``None`` to clear a field. Omit a parameter to leave it unchanged.

        Args:
            team_id: The unique identifier of the team to update.
            display_name: New display name, or ``None`` to clear.
            profile_image_url: New profile image URL, or ``None`` to clear.
            client_metadata: New client metadata dict, or ``None`` to clear.
            client_read_only_metadata: New client read-only metadata dict,
                or ``None`` to clear.
            server_metadata: New server metadata dict, or ``None`` to clear.

        Returns:
            The updated :class:`ServerTeam`.

        Raises:
            NotFoundError: If the team does not exist.
        """
        fields = {
            "display_name": display_name,
            "profile_image_url": profile_image_url,
            "client_metadata": client_metadata,
            "client_read_only_metadata": client_read_only_metadata,
            "server_metadata": server_metadata,
        }
        body = {k: v for k, v in fields.items() if v is not _UNSET}
        data = self._client.request("PATCH", f"/teams/{team_id}", body=body)
        return ServerTeam.model_validate(data)

    def delete_team(self, team_id: str) -> None:
        """Delete a team by ID.

        Args:
            team_id: The unique identifier of the team to delete.

        Returns:
            None.

        Raises:
            NotFoundError: If the team does not exist.
        """
        self._client.request("DELETE", f"/teams/{team_id}")

    def get_team_by_api_key(self, api_key: str) -> ServerTeam | None:
        """Look up a team by its API key.

        Performs a two-step lookup: first validates the key, then fetches the team.

        Args:
            api_key: The API key string to look up.

        Returns:
            The :class:`ServerTeam` associated with the key, or ``None``
            if the key is invalid or has no associated team.
        """
        try:
            data = self._client.request(
                "POST", "/api-keys/check", body={"api_key": api_key}
            )
        except (NotFoundError, ApiKeyError):
            return None
        if data is None or "team_id" not in data:
            return None
        return self.get_team(data["team_id"])

    # -- team membership -----------------------------------------------------

    def add_team_member(self, team_id: str, user_id: str) -> None:
        """Add a user to a team.

        Args:
            team_id: The team to add the user to.
            user_id: The user to add.

        Returns:
            None.

        Raises:
            NotFoundError: If the team or user does not exist.
        """
        self._client.request(
            "POST", f"/team-memberships/{team_id}/{user_id}", body={}
        )

    def remove_team_member(self, team_id: str, user_id: str) -> None:
        """Remove a user from a team.

        Args:
            team_id: The team to remove the user from.
            user_id: The user to remove.

        Returns:
            None.

        Raises:
            NotFoundError: If the membership does not exist.
        """
        self._client.request(
            "DELETE", f"/team-memberships/{team_id}/{user_id}"
        )

    # -- team invitations ----------------------------------------------------

    def send_team_invitation(
        self,
        team_id: str,
        email: str,
        *,
        callback_url: Optional[str] = None,
    ) -> None:
        """Send an invitation email to join a team.

        Args:
            team_id: The team to invite the user to.
            email: The recipient's email address.
            callback_url: Optional URL to redirect after accepting.

        Returns:
            None.
        """
        body = _build_params(
            email=email, team_id=team_id, callback_url=callback_url
        )
        self._client.request("POST", "/team-invitations/send-code", body=body)

    def list_team_invitations(self, team_id: str) -> list[TeamInvitation]:
        """List pending invitations for a team.

        Args:
            team_id: The team whose invitations to list.

        Returns:
            A list of :class:`TeamInvitation` objects.
        """
        data = self._client.request(
            "GET", f"/teams/{team_id}/invitations"
        )
        return [
            TeamInvitation.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def revoke_team_invitation(
        self, team_id: str, invitation_id: str
    ) -> None:
        """Revoke (delete) a team invitation.

        Args:
            team_id: The team that owns the invitation.
            invitation_id: The invitation to revoke.

        Returns:
            None.
        """
        self._client.request(
            "DELETE", f"/teams/{team_id}/invitations/{invitation_id}"
        )

    # -- team member profiles ------------------------------------------------

    def list_team_member_profiles(
        self, team_id: str
    ) -> list[TeamMemberProfile]:
        """List member profiles for a team.

        Args:
            team_id: The team whose member profiles to list.

        Returns:
            A list of :class:`TeamMemberProfile` objects.
        """
        data = self._client.request(
            "GET", "/team-member-profiles", params={"team_id": team_id}
        )
        return [
            TeamMemberProfile.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def get_team_member_profile(
        self, team_id: str, user_id: str
    ) -> TeamMemberProfile | None:
        """Get a specific team member's profile.

        Fetches all member profiles for the team and filters by *user_id*.

        Args:
            team_id: The team to look up the profile in.
            user_id: The user whose profile to retrieve.

        Returns:
            The :class:`TeamMemberProfile` if found, or ``None``.
        """
        profiles = self.list_team_member_profiles(team_id)
        return next((p for p in profiles if p.user_id == user_id), None)

    # -- permissions ---------------------------------------------------------

    def grant_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> None:
        """Grant a permission to a user.

        Args:
            user_id: The user to grant the permission to.
            permission_id: The permission to grant.
            team_id: If provided, grants at team scope; otherwise project scope.

        Returns:
            None.
        """
        body = _build_params(
            team_id=team_id, permission_id=permission_id
        )
        self._client.request(
            "POST", f"/users/{user_id}/permissions", body=body
        )

    def revoke_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> None:
        """Revoke a permission from a user.

        Args:
            user_id: The user to revoke the permission from.
            permission_id: The permission to revoke.
            team_id: If provided, revokes at team scope; otherwise project scope.

        Returns:
            None.
        """
        params = _build_params(team_id=team_id)
        self._client.request(
            "DELETE",
            f"/users/{user_id}/permissions/{permission_id}",
            params=params,
        )

    def list_permissions(
        self,
        user_id: str,
        *,
        team_id: Optional[str] = None,
        direct: Optional[bool] = None,
    ) -> list[TeamPermission]:
        """List permissions for a user.

        Args:
            user_id: The user whose permissions to list.
            team_id: Filter by team scope.
            direct: If ``True``, only return directly assigned permissions.

        Returns:
            A list of :class:`TeamPermission` objects.
        """
        params = _build_params(team_id=team_id, direct=direct)
        data = self._client.request(
            "GET", f"/users/{user_id}/permissions", params=params
        )
        return [
            TeamPermission.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def has_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> bool:
        """Check if a user has a specific permission.

        Args:
            user_id: The user to check.
            permission_id: The permission to check for.
            team_id: Check at team scope if provided.

        Returns:
            ``True`` if the user has the permission, ``False`` otherwise.
        """
        params = _build_params(
            team_id=team_id, permission_id=permission_id
        )
        data = self._client.request(
            "GET", f"/users/{user_id}/permissions", params=params
        )
        return len((data or {}).get("items", [])) > 0

    def get_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> TeamPermission | None:
        """Get a specific permission for a user.

        Args:
            user_id: The user to check.
            permission_id: The permission to look up.
            team_id: Check at team scope if provided.

        Returns:
            The :class:`TeamPermission` if found, or ``None``.
        """
        params = _build_params(
            team_id=team_id, permission_id=permission_id
        )
        data = self._client.request(
            "GET", f"/users/{user_id}/permissions", params=params
        )
        items = (data or {}).get("items", [])
        if not items:
            return None
        return TeamPermission.model_validate(items[0])

    # -- contact channels ----------------------------------------------------

    def list_contact_channels(self, user_id: str) -> list[ContactChannel]:
        """List contact channels for a user.

        Args:
            user_id: The user whose contact channels to list.

        Returns:
            A list of :class:`ContactChannel` objects.
        """
        data = self._client.request(
            "GET", "/contact-channels", params={"user_id": user_id}
        )
        return [
            ContactChannel.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def create_contact_channel(
        self,
        user_id: str,
        *,
        value: str,
        type: str = "email",
        used_for_auth: bool,
        is_primary: Optional[bool] = None,
        is_verified: Optional[bool] = None,
    ) -> ContactChannel:
        """Create a new contact channel for a user.

        Args:
            user_id: The user to create the channel for.
            value: The channel value (e.g., email address).
            type: The channel type (default: ``"email"``).
            used_for_auth: Whether this channel is used for authentication.
            is_primary: Whether this is the primary channel.
            is_verified: Whether the channel is pre-verified.

        Returns:
            The created :class:`ContactChannel`.
        """
        body = _build_params(
            user_id=user_id,
            value=value,
            type=type,
            used_for_auth=used_for_auth,
            is_primary=is_primary,
            is_verified=is_verified,
        )
        data = self._client.request(
            "POST", "/contact-channels", body=body
        )
        return ContactChannel.model_validate(data)

    def send_verification_code(
        self,
        contact_channel_id: str,
        *,
        callback_url: Optional[str] = None,
    ) -> None:
        """Send a verification email for a contact channel.

        Args:
            contact_channel_id: The channel to send verification for.
            callback_url: Optional URL to redirect after verification.

        Returns:
            None.
        """
        body = _build_params(callback_url=callback_url)
        self._client.request(
            "POST",
            f"/contact-channels/{contact_channel_id}/send-verification-email",
            body=body,
        )

    def verify_contact_channel(self, code: str) -> None:
        """Verify a contact channel with a verification code.

        Args:
            code: The verification code received via email.

        Returns:
            None.
        """
        self._client.request(
            "POST", "/contact-channels/verify", body={"code": code}
        )

    # -- API keys ------------------------------------------------------------

    def create_user_api_key(
        self,
        user_id: str,
        *,
        description: str,
        expires_at_millis: Optional[int] = None,
        scope: Optional[str] = None,
        team_id: Optional[str] = None,
    ) -> UserApiKeyFirstView:
        """Create a user API key.

        Args:
            user_id: The user to create the key for.
            description: Human-readable description of the key's purpose.
            expires_at_millis: Optional expiration timestamp in milliseconds
                since epoch.
            scope: Optional scope restriction for the key.
            team_id: Optional team to associate the key with.

        Returns:
            A :class:`UserApiKeyFirstView` containing the key including the
            secret (only available at creation time).
        """
        body = _build_params(
            description=description,
            expires_at_millis=expires_at_millis,
            scope=scope,
            team_id=team_id,
        )
        data = self._client.request(
            "POST", f"/users/{user_id}/api-keys", body=body
        )
        return UserApiKeyFirstView.model_validate(data)

    def list_user_api_keys(self, user_id: str) -> list[UserApiKey]:
        """List API keys for a user.

        Args:
            user_id: The user whose API keys to list.

        Returns:
            A list of :class:`UserApiKey` objects (secrets are not included).
        """
        data = self._client.request("GET", f"/users/{user_id}/api-keys")
        return [
            UserApiKey.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def revoke_user_api_key(self, api_key_id: str) -> None:
        """Revoke (delete) a user API key.

        Args:
            api_key_id: The unique identifier of the API key to revoke.

        Returns:
            None.
        """
        self._client.request("DELETE", f"/api-keys/{api_key_id}")

    def create_team_api_key(
        self,
        team_id: str,
        *,
        description: str,
        expires_at_millis: Optional[int] = None,
        scope: Optional[str] = None,
    ) -> TeamApiKeyFirstView:
        """Create a team API key.

        Args:
            team_id: The team to create the key for.
            description: Human-readable description of the key's purpose.
            expires_at_millis: Optional expiration timestamp in milliseconds
                since epoch.
            scope: Optional scope restriction for the key.

        Returns:
            A :class:`TeamApiKeyFirstView` containing the key including the
            secret (only available at creation time).
        """
        body = _build_params(
            description=description,
            expires_at_millis=expires_at_millis,
            scope=scope,
        )
        data = self._client.request(
            "POST", f"/teams/{team_id}/api-keys", body=body
        )
        return TeamApiKeyFirstView.model_validate(data)

    def list_team_api_keys(self, team_id: str) -> list[TeamApiKey]:
        """List API keys for a team.

        Args:
            team_id: The team whose API keys to list.

        Returns:
            A list of :class:`TeamApiKey` objects (secrets are not included).
        """
        data = self._client.request("GET", f"/teams/{team_id}/api-keys")
        return [
            TeamApiKey.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def revoke_team_api_key(self, api_key_id: str) -> None:
        """Revoke (delete) a team API key.

        Args:
            api_key_id: The unique identifier of the API key to revoke.

        Returns:
            None.
        """
        self._client.request("DELETE", f"/api-keys/{api_key_id}")

    def check_api_key(self, api_key: str) -> dict[str, Any] | None:
        """Validate an API key and return associated user/team info.

        Args:
            api_key: The API key string to validate.

        Returns:
            A dict with ``user_id`` and/or ``team_id`` if the key is valid,
            or ``None`` if the key is invalid.
        """
        try:
            data = self._client.request(
                "POST", "/api-keys/check", body={"api_key": api_key}
            )
        except (NotFoundError, ApiKeyError):
            return None
        if data is None:
            return None
        return data

    # -- OAuth providers -----------------------------------------------------

    def create_oauth_provider(
        self,
        user_id: str,
        *,
        account_id: str,
        provider_config_id: str,
        email: str,
        allow_sign_in: bool,
        allow_connected_accounts: bool,
    ) -> OAuthProvider:
        """Link an OAuth provider to a user.

        Args:
            user_id: The user to link the provider to.
            account_id: The external account ID from the OAuth provider.
            provider_config_id: The provider configuration ID in Stack Auth.
            email: The email address from the OAuth provider.
            allow_sign_in: Whether this provider can be used for sign-in.
            allow_connected_accounts: Whether this counts as a connected account.

        Returns:
            The created :class:`OAuthProvider` link.
        """
        body = _build_params(
            account_id=account_id,
            provider_config_id=provider_config_id,
            email=email,
            allow_sign_in=allow_sign_in,
            allow_connected_accounts=allow_connected_accounts,
        )
        data = self._client.request(
            "POST", f"/users/{user_id}/oauth-providers", body=body
        )
        return OAuthProvider.model_validate(data)

    def list_oauth_providers(self, user_id: str) -> list[OAuthProvider]:
        """List OAuth providers linked to a user.

        Args:
            user_id: The user whose OAuth providers to list.

        Returns:
            A list of :class:`OAuthProvider` objects.
        """
        data = self._client.request(
            "GET", f"/users/{user_id}/oauth-providers"
        )
        return [
            OAuthProvider.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    def get_oauth_provider(
        self, user_id: str, provider_id: str
    ) -> OAuthProvider | None:
        """Get a specific OAuth provider for a user.

        Fetches all providers and filters by *provider_id*.

        Args:
            user_id: The user who owns the provider link.
            provider_id: The provider ID to look up.

        Returns:
            The :class:`OAuthProvider` if found, or ``None``.
        """
        providers = self.list_oauth_providers(user_id)
        return next((p for p in providers if p.id == provider_id), None)

    def list_connected_accounts(self, user_id: str) -> list[OAuthProvider]:
        """List connected accounts for a user.

        This is an alias for :meth:`list_oauth_providers`.

        Args:
            user_id: The user whose connected accounts to list.

        Returns:
            A list of :class:`OAuthProvider` objects.
        """
        return self.list_oauth_providers(user_id)

    # -- payments ------------------------------------------------------------

    def list_products(
        self,
        *,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> PaginatedResult[Product]:
        """List products for a customer.

        Exactly one of *user_id*, *team_id*, or *custom_customer_id* must be
        provided.

        Args:
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.
            cursor: Pagination cursor from a previous response.
            limit: Maximum number of products to return per page.

        Returns:
            A :class:`PaginatedResult` containing :class:`Product` items.

        Raises:
            ValueError: If not exactly one customer identifier is provided.
        """
        ctype, cid, _ = _resolve_customer_path(user_id, team_id, custom_customer_id)
        params = _build_params(cursor=cursor, limit=limit)
        data = self._client.request(
            "GET", f"/customers/{ctype}/{cid}/products", params=params
        )
        if data is None:
            return PaginatedResult(items=[])
        items = [Product.model_validate(i) for i in data.get("items", [])]
        pagination = _PaginationMeta(**(data.get("pagination") or {}))
        return PaginatedResult(items=items, pagination=pagination)

    def get_item(
        self,
        item_id: str,
        *,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
    ) -> ServerItem:
        """Get a server-side item with quantity modification methods.

        Exactly one of *user_id*, *team_id*, or *custom_customer_id* must be
        provided.

        Args:
            item_id: The unique identifier of the item.
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.

        Returns:
            A :class:`ServerItem` wrapping the :class:`Item` data and
            providing ``increase_quantity``, ``decrease_quantity``, and
            ``try_decrease_quantity`` methods.

        Raises:
            ValueError: If not exactly one customer identifier is provided.
            NotFoundError: If the item does not exist.
        """
        ctype, cid, field_name = _resolve_customer_path(
            user_id, team_id, custom_customer_id
        )
        data = self._client.request(
            "GET", f"/customers/{ctype}/{cid}/items/{item_id}"
        )
        if data is None:
            raise NotFoundError(code="ITEM_NOT_FOUND", message=f"Item '{item_id}' not found")
        item = Item.model_validate(data)
        return ServerItem(
            item,
            _client=self._client,
            _customer_path=f"/customers/{ctype}/{cid}",
            _item_id=item_id,
            _customer_id_field=field_name,
            _customer_id_value=cid,
        )

    def grant_product(
        self,
        *,
        product_id: Optional[str] = None,
        product: Optional[dict[str, Any]] = None,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
        quantity: Optional[int] = None,
    ) -> None:
        """Grant a product to a customer.

        Provide either *product_id* (existing product) or *product* (inline
        product definition). Exactly one of *user_id*, *team_id*, or
        *custom_customer_id* must be provided.

        Args:
            product_id: ID of an existing product to grant.
            product: Inline product definition dict.
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.
            quantity: Number of units to grant (for quantity-based items).

        Returns:
            None.

        Raises:
            ValueError: If not exactly one customer identifier is provided,
                or if both/neither of product_id and product are given.
        """
        if (product_id is None) == (product is None):
            raise ValueError("Provide exactly one of product_id or product, not both or neither")
        ctype, cid, _ = _resolve_customer_path(user_id, team_id, custom_customer_id)
        body = _build_params(
            product_id=product_id,
            product=product,
            quantity=quantity,
        )
        self._client.request(
            "POST", f"/customers/{ctype}/{cid}/products", body=body
        )

    def cancel_subscription(
        self,
        product_id: str,
        *,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
    ) -> None:
        """Cancel a subscription for a customer.

        Exactly one of *user_id*, *team_id*, or *custom_customer_id* must be
        provided.

        Args:
            product_id: The product/subscription to cancel.
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.

        Returns:
            None.

        Raises:
            ValueError: If not exactly one customer identifier is provided.
        """
        _, cid, field_name = _resolve_customer_path(
            user_id, team_id, custom_customer_id
        )
        body: dict[str, Any] = {"product_id": product_id, field_name: cid}
        self._client.request("POST", "/subscriptions/cancel", body=body)

    # -- email ---------------------------------------------------------------

    def send_email(
        self,
        to: str | list[str],
        subject: str,
        *,
        html: Optional[str] = None,
        text: Optional[str] = None,
    ) -> None:
        """Send a transactional email.

        Args:
            to: Recipient email address or list of addresses.
            subject: Email subject line.
            html: HTML body content.
            text: Plain-text body content.

        Returns:
            None.
        """
        body: dict[str, Any] = {"to": to, "subject": subject}
        if html is not None:
            body["html"] = html
        if text is not None:
            body["text"] = text
        self._client.request("POST", "/emails", body=body)

    def get_email_delivery_stats(self) -> EmailDeliveryInfo:
        """Get email delivery statistics.

        Args:
            (none)

        Returns:
            An :class:`EmailDeliveryInfo` with delivery counts and statuses.
        """
        data = self._client.request("GET", "/emails/delivery-stats")
        if data is None:
            return EmailDeliveryInfo(delivered=0, bounced=0, complained=0, total=0)
        return EmailDeliveryInfo.model_validate(data)

    # -- data vault ----------------------------------------------------------

    def get_data_vault_store(self, store_id: str) -> DataVaultStore:
        """Get a data vault store by ID.

        The returned :class:`DataVaultStore` object provides ``get``,
        ``set``, ``delete``, and ``list_keys`` methods for key-value
        operations within the store.

        Args:
            store_id: The unique identifier of the data vault store.

        Returns:
            A :class:`DataVaultStore` for performing key-value operations.
        """
        return DataVaultStore(store_id, _client=self._client)


# ---------------------------------------------------------------------------
# AsyncStackServerApp (async)
# ---------------------------------------------------------------------------


class AsyncStackServerApp:
    """Asynchronous facade for the Stack Auth API.

    Provides type-safe, asynchronous methods for user management, team
    management, permissions, API keys, OAuth providers, payments, email,
    and data vault operations. All methods mirror :class:`StackServerApp`
    but use ``async``/``await``.

    Example::

        from stack_auth import AsyncStackServerApp

        # Constructor with all parameters
        app = AsyncStackServerApp(
            project_id="my-project-id",
            secret_server_key="ssk_...",
            base_url="https://api.stack-auth.com",
            token_store=None,  # optional TokenStoreInit
        )

        # Use as an async context manager for automatic cleanup
        async with AsyncStackServerApp(
            project_id="my-project-id",
            secret_server_key="ssk_...",
        ) as app:
            # User CRUD
            user = await app.create_user(
                primary_email="alice@example.com",
                display_name="Alice",
            )
            fetched = await app.get_user(user.id)
            users = await app.list_users(limit=10)

            # Team operations
            team = await app.create_team(
                display_name="Engineering",
                creator_user_id=user.id,
            )
            await app.add_team_member(team.id, user.id)
    """

    def __init__(
        self,
        *,
        project_id: str,
        secret_server_key: str,
        publishable_client_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        token_store: TokenStoreInit | None = None,
    ) -> None:
        """Initialize the asynchronous Stack Auth application client.

        Args:
            project_id: The Stack Auth project identifier.
            secret_server_key: Server-side secret key for authentication.
            publishable_client_key: Optional publishable client key.
            base_url: Stack Auth API base URL.
            token_store: Optional token storage initializer for user sessions.
        """
        self._project_id = project_id
        self._client = AsyncAPIClient(
            project_id=project_id,
            secret_server_key=secret_server_key,
            publishable_client_key=publishable_client_key,
            base_url=base_url,
        )
        self._token_store: TokenStore | None = None
        if token_store is not None:
            self._token_store = resolve_token_store(token_store, project_id)

    # -- lifecycle -----------------------------------------------------------

    async def aclose(self) -> None:
        """Close the underlying HTTP client.

        Args:
            (none)

        Returns:
            None.
        """
        await self._client.aclose()

    async def __aenter__(self) -> AsyncStackServerApp:
        """Enter the async context manager."""
        return self

    async def __aexit__(self, *_: Any) -> None:
        """Exit the async context manager and close the client."""
        await self.aclose()

    # -- partial user (local JWT decode) -------------------------------------

    def get_partial_user(
        self,
        *,
        token_store: TokenStoreInit | None = _UNSET,
    ) -> TokenPartialUser | None:
        """Get minimal user info from the access token without a network request.

        Decodes the JWT payload from the token store's access token to extract
        partial user information. Does NOT verify the token's signature.

        Note: This method is synchronous because it performs no network I/O.
        It only decodes the JWT payload locally.

        Args:
            token_store: Override token storage for this call. If not provided,
                uses the instance's token store. Pass ``None`` explicitly to
                indicate no token store.

        Returns:
            A :class:`TokenPartialUser` with user ID and claims from the JWT,
            or ``None`` if no access token is available or the token is malformed.
        """
        if token_store is _UNSET:
            store = self._token_store
        elif token_store is None:
            store = None
        else:
            store = resolve_token_store(token_store, self._project_id)

        if store is None:
            return None

        access_token = store.get_stored_access_token()
        if access_token is None:
            return None

        return decode_access_token_claims(access_token)

    # -- user CRUD -----------------------------------------------------------

    async def get_user(self, user_id: str) -> ServerUser | None:
        """Fetch a user by ID.

        Args:
            user_id: The unique identifier of the user to retrieve.

        Returns:
            A :class:`ServerUser` if found, or ``None`` if the user does
            not exist (HTTP 404).

        Raises:
            StackAuthError: If the API returns an unexpected error.
        """
        try:
            data = await self._client.request("GET", f"/users/{user_id}")
        except NotFoundError:
            return None
        if data is None:
            return None
        return ServerUser.model_validate(data)

    async def list_users(
        self,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
        order_by: Optional[str] = None,
        desc: Optional[bool] = None,
        query: Optional[str] = None,
        include_restricted: Optional[bool] = None,
        include_anonymous: Optional[bool] = None,
    ) -> PaginatedResult[ServerUser]:
        """List users with optional filtering and pagination.

        Args:
            cursor: Pagination cursor from a previous response.
            limit: Maximum number of users to return per page.
            order_by: Field name to sort by (e.g., ``"created_at"``).
            desc: If ``True``, sort in descending order.
            query: Full-text search query to filter users.
            include_restricted: If ``True``, include restricted users.
            include_anonymous: If ``True``, include anonymous users.

        Returns:
            A :class:`PaginatedResult` containing :class:`ServerUser` items
            and pagination metadata for fetching additional pages.
        """
        params = _build_params(
            cursor=cursor,
            limit=limit,
            order_by=order_by,
            desc=desc,
            query=query,
            include_restricted=include_restricted,
            include_anonymous=include_anonymous,
        )
        data = await self._client.request("GET", "/users", params=params)
        if data is None:
            return PaginatedResult(items=[])
        items = [ServerUser.model_validate(i) for i in data.get("items", [])]
        pagination = _PaginationMeta(**(data.get("pagination") or {}))
        return PaginatedResult(items=items, pagination=pagination)

    async def create_user(
        self,
        *,
        primary_email: Optional[str] = None,
        primary_email_auth_enabled: Optional[bool] = None,
        password: Optional[str] = None,
        otp_auth_enabled: Optional[bool] = None,
        display_name: Optional[str] = None,
        primary_email_verified: Optional[bool] = None,
        client_metadata: Optional[dict[str, Any]] = None,
        client_read_only_metadata: Optional[dict[str, Any]] = None,
        server_metadata: Optional[dict[str, Any]] = None,
    ) -> ServerUser:
        """Create a new user. Only non-None fields are sent.

        Args:
            primary_email: The user's primary email address.
            primary_email_auth_enabled: Whether email-based auth is enabled.
            password: Initial password for password-based auth.
            otp_auth_enabled: Whether OTP (one-time password) auth is enabled.
            display_name: Human-readable display name.
            primary_email_verified: Whether to mark the email as pre-verified.
            client_metadata: Arbitrary metadata readable by the client SDK.
            client_read_only_metadata: Metadata readable but not writable
                by the client SDK.
            server_metadata: Metadata only accessible from the server.

        Returns:
            The newly created :class:`ServerUser`.

        Raises:
            ValidationError: If the provided fields fail server-side validation.
            StackAuthError: If the API returns an unexpected error.
        """
        body = _build_params(
            primary_email=primary_email,
            primary_email_auth_enabled=primary_email_auth_enabled,
            password=password,
            otp_auth_enabled=otp_auth_enabled,
            display_name=display_name,
            primary_email_verified=primary_email_verified,
            client_metadata=client_metadata,
            client_read_only_metadata=client_read_only_metadata,
            server_metadata=server_metadata,
        )
        data = await self._client.request("POST", "/users", body=body)
        return ServerUser.model_validate(data)

    async def update_user(
        self,
        user_id: str,
        *,
        display_name: Any = _UNSET,
        client_metadata: Any = _UNSET,
        client_read_only_metadata: Any = _UNSET,
        server_metadata: Any = _UNSET,
        primary_email: Any = _UNSET,
        primary_email_verified: Any = _UNSET,
        primary_email_auth_enabled: Any = _UNSET,
        password: Any = _UNSET,
        otp_auth_enabled: Any = _UNSET,
        profile_image_url: Any = _UNSET,
        selected_team_id: Any = _UNSET,
    ) -> ServerUser:
        """Update a user. Only explicitly provided fields are sent.

        Pass ``None`` to clear a field. Omit a parameter to leave it unchanged.

        Args:
            user_id: The unique identifier of the user to update.
            display_name: New display name, or ``None`` to clear.
            client_metadata: New client metadata dict, or ``None`` to clear.
            client_read_only_metadata: New client read-only metadata dict,
                or ``None`` to clear.
            server_metadata: New server metadata dict, or ``None`` to clear.
            primary_email: New primary email, or ``None`` to clear.
            primary_email_verified: Whether the email is verified.
            primary_email_auth_enabled: Whether email auth is enabled.
            password: New password.
            otp_auth_enabled: Whether OTP auth is enabled.
            profile_image_url: URL to profile image, or ``None`` to clear.
            selected_team_id: The user's selected team, or ``None`` to clear.

        Returns:
            The updated :class:`ServerUser`.

        Raises:
            ValidationError: If the provided fields fail server-side validation.
            NotFoundError: If the user does not exist.
        """
        fields = {
            "display_name": display_name,
            "client_metadata": client_metadata,
            "client_read_only_metadata": client_read_only_metadata,
            "server_metadata": server_metadata,
            "primary_email": primary_email,
            "primary_email_verified": primary_email_verified,
            "primary_email_auth_enabled": primary_email_auth_enabled,
            "password": password,
            "otp_auth_enabled": otp_auth_enabled,
            "profile_image_url": profile_image_url,
            "selected_team_id": selected_team_id,
        }
        body = {k: v for k, v in fields.items() if v is not _UNSET}
        data = await self._client.request("PATCH", f"/users/{user_id}", body=body)
        return ServerUser.model_validate(data)

    async def delete_user(self, user_id: str) -> None:
        """Delete a user by ID.

        Args:
            user_id: The unique identifier of the user to delete.

        Returns:
            None.

        Raises:
            NotFoundError: If the user does not exist.
        """
        await self._client.request("DELETE", f"/users/{user_id}")

    async def get_user_by_api_key(self, api_key: str) -> ServerUser | None:
        """Look up a user by their API key.

        Performs a two-step lookup: first validates the key, then fetches the user.

        Args:
            api_key: The API key string to look up.

        Returns:
            The :class:`ServerUser` associated with the key, or ``None``
            if the key is invalid or has no associated user.
        """
        try:
            data = await self._client.request(
                "POST", "/api-keys/check", body={"api_key": api_key}
            )
        except (NotFoundError, ApiKeyError):
            return None
        if data is None or "user_id" not in data:
            return None
        return await self.get_user(data["user_id"])

    # -- session management --------------------------------------------------

    async def list_sessions(self, user_id: str) -> list[ActiveSession]:
        """List active sessions for a user.

        Args:
            user_id: The user whose sessions to list.

        Returns:
            A list of :class:`ActiveSession` objects.
        """
        data = await self._client.request(
            "GET", "/auth/sessions", params={"user_id": user_id}
        )
        return [
            ActiveSession.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def get_session(
        self, session_id: str, *, user_id: str
    ) -> ActiveSession | None:
        """Get a specific session by ID.

        Fetches all sessions for the user and filters by *session_id*.

        Args:
            session_id: The session to retrieve.
            user_id: The user who owns the session.

        Returns:
            The :class:`ActiveSession` if found, or ``None``.
        """
        sessions = await self.list_sessions(user_id)
        return next((s for s in sessions if s.id == session_id), None)

    async def revoke_session(self, session_id: str, *, user_id: str) -> None:
        """Revoke (delete) a session.

        Args:
            session_id: The session to revoke.
            user_id: The user who owns the session.

        Returns:
            None.
        """
        await self._client.request(
            "DELETE",
            f"/auth/sessions/{session_id}",
            params={"user_id": user_id},
        )

    # -- team CRUD -----------------------------------------------------------

    async def get_team(self, team_id: str) -> ServerTeam | None:
        """Fetch a team by ID.

        Args:
            team_id: The unique identifier of the team to retrieve.

        Returns:
            A :class:`ServerTeam` if found, or ``None`` if the team does
            not exist (HTTP 404).

        Raises:
            StackAuthError: If the API returns an unexpected error.
        """
        try:
            data = await self._client.request("GET", f"/teams/{team_id}")
        except NotFoundError:
            return None
        if data is None:
            return None
        return ServerTeam.model_validate(data)

    async def list_teams(
        self, *, user_id: Optional[str] = None
    ) -> list[ServerTeam]:
        """List teams, optionally filtered by user membership.

        This endpoint does not support pagination.

        Args:
            user_id: If provided, only return teams where this user
                is a member.

        Returns:
            A list of :class:`ServerTeam` objects.
        """
        params = _build_params(user_id=user_id)
        data = await self._client.request("GET", "/teams", params=params)
        return [
            ServerTeam.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def create_team(
        self,
        *,
        display_name: str,
        profile_image_url: Optional[str] = None,
        creator_user_id: Optional[str] = None,
    ) -> ServerTeam:
        """Create a new team.

        Args:
            display_name: The display name for the team.
            profile_image_url: Optional URL for the team's profile image.
            creator_user_id: If provided, this user will be added as the
                initial team member and creator.

        Returns:
            The newly created :class:`ServerTeam`.

        Raises:
            ValidationError: If the provided fields fail server-side validation.
        """
        body = _build_params(
            display_name=display_name,
            profile_image_url=profile_image_url,
            creator_user_id=creator_user_id,
        )
        data = await self._client.request("POST", "/teams", body=body)
        return ServerTeam.model_validate(data)

    async def update_team(
        self,
        team_id: str,
        *,
        display_name: Any = _UNSET,
        profile_image_url: Any = _UNSET,
        client_metadata: Any = _UNSET,
        client_read_only_metadata: Any = _UNSET,
        server_metadata: Any = _UNSET,
    ) -> ServerTeam:
        """Update a team. Only explicitly provided fields are sent.

        Pass ``None`` to clear a field. Omit a parameter to leave it unchanged.

        Args:
            team_id: The unique identifier of the team to update.
            display_name: New display name, or ``None`` to clear.
            profile_image_url: New profile image URL, or ``None`` to clear.
            client_metadata: New client metadata dict, or ``None`` to clear.
            client_read_only_metadata: New client read-only metadata dict,
                or ``None`` to clear.
            server_metadata: New server metadata dict, or ``None`` to clear.

        Returns:
            The updated :class:`ServerTeam`.

        Raises:
            NotFoundError: If the team does not exist.
        """
        fields = {
            "display_name": display_name,
            "profile_image_url": profile_image_url,
            "client_metadata": client_metadata,
            "client_read_only_metadata": client_read_only_metadata,
            "server_metadata": server_metadata,
        }
        body = {k: v for k, v in fields.items() if v is not _UNSET}
        data = await self._client.request(
            "PATCH", f"/teams/{team_id}", body=body
        )
        return ServerTeam.model_validate(data)

    async def delete_team(self, team_id: str) -> None:
        """Delete a team by ID.

        Args:
            team_id: The unique identifier of the team to delete.

        Returns:
            None.

        Raises:
            NotFoundError: If the team does not exist.
        """
        await self._client.request("DELETE", f"/teams/{team_id}")

    async def get_team_by_api_key(self, api_key: str) -> ServerTeam | None:
        """Look up a team by its API key.

        Performs a two-step lookup: first validates the key, then fetches the team.

        Args:
            api_key: The API key string to look up.

        Returns:
            The :class:`ServerTeam` associated with the key, or ``None``
            if the key is invalid or has no associated team.
        """
        try:
            data = await self._client.request(
                "POST", "/api-keys/check", body={"api_key": api_key}
            )
        except (NotFoundError, ApiKeyError):
            return None
        if data is None or "team_id" not in data:
            return None
        return await self.get_team(data["team_id"])

    # -- team membership -----------------------------------------------------

    async def add_team_member(self, team_id: str, user_id: str) -> None:
        """Add a user to a team.

        Args:
            team_id: The team to add the user to.
            user_id: The user to add.

        Returns:
            None.

        Raises:
            NotFoundError: If the team or user does not exist.
        """
        await self._client.request(
            "POST", f"/team-memberships/{team_id}/{user_id}", body={}
        )

    async def remove_team_member(self, team_id: str, user_id: str) -> None:
        """Remove a user from a team.

        Args:
            team_id: The team to remove the user from.
            user_id: The user to remove.

        Returns:
            None.

        Raises:
            NotFoundError: If the membership does not exist.
        """
        await self._client.request(
            "DELETE", f"/team-memberships/{team_id}/{user_id}"
        )

    # -- team invitations ----------------------------------------------------

    async def send_team_invitation(
        self,
        team_id: str,
        email: str,
        *,
        callback_url: Optional[str] = None,
    ) -> None:
        """Send an invitation email to join a team.

        Args:
            team_id: The team to invite the user to.
            email: The recipient's email address.
            callback_url: Optional URL to redirect after accepting.

        Returns:
            None.
        """
        body = _build_params(
            email=email, team_id=team_id, callback_url=callback_url
        )
        await self._client.request(
            "POST", "/team-invitations/send-code", body=body
        )

    async def list_team_invitations(
        self, team_id: str
    ) -> list[TeamInvitation]:
        """List pending invitations for a team.

        Args:
            team_id: The team whose invitations to list.

        Returns:
            A list of :class:`TeamInvitation` objects.
        """
        data = await self._client.request(
            "GET", f"/teams/{team_id}/invitations"
        )
        return [
            TeamInvitation.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def revoke_team_invitation(
        self, team_id: str, invitation_id: str
    ) -> None:
        """Revoke (delete) a team invitation.

        Args:
            team_id: The team that owns the invitation.
            invitation_id: The invitation to revoke.

        Returns:
            None.
        """
        await self._client.request(
            "DELETE", f"/teams/{team_id}/invitations/{invitation_id}"
        )

    # -- team member profiles ------------------------------------------------

    async def list_team_member_profiles(
        self, team_id: str
    ) -> list[TeamMemberProfile]:
        """List member profiles for a team.

        Args:
            team_id: The team whose member profiles to list.

        Returns:
            A list of :class:`TeamMemberProfile` objects.
        """
        data = await self._client.request(
            "GET", "/team-member-profiles", params={"team_id": team_id}
        )
        return [
            TeamMemberProfile.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def get_team_member_profile(
        self, team_id: str, user_id: str
    ) -> TeamMemberProfile | None:
        """Get a specific team member's profile.

        Fetches all member profiles for the team and filters by *user_id*.

        Args:
            team_id: The team to look up the profile in.
            user_id: The user whose profile to retrieve.

        Returns:
            The :class:`TeamMemberProfile` if found, or ``None``.
        """
        profiles = await self.list_team_member_profiles(team_id)
        return next((p for p in profiles if p.user_id == user_id), None)

    # -- permissions ---------------------------------------------------------

    async def grant_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> None:
        """Grant a permission to a user.

        Args:
            user_id: The user to grant the permission to.
            permission_id: The permission to grant.
            team_id: If provided, grants at team scope; otherwise project scope.

        Returns:
            None.
        """
        body = _build_params(
            team_id=team_id, permission_id=permission_id
        )
        await self._client.request(
            "POST", f"/users/{user_id}/permissions", body=body
        )

    async def revoke_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> None:
        """Revoke a permission from a user.

        Args:
            user_id: The user to revoke the permission from.
            permission_id: The permission to revoke.
            team_id: If provided, revokes at team scope; otherwise project scope.

        Returns:
            None.
        """
        params = _build_params(team_id=team_id)
        await self._client.request(
            "DELETE",
            f"/users/{user_id}/permissions/{permission_id}",
            params=params,
        )

    async def list_permissions(
        self,
        user_id: str,
        *,
        team_id: Optional[str] = None,
        direct: Optional[bool] = None,
    ) -> list[TeamPermission]:
        """List permissions for a user.

        Args:
            user_id: The user whose permissions to list.
            team_id: Filter by team scope.
            direct: If ``True``, only return directly assigned permissions.

        Returns:
            A list of :class:`TeamPermission` objects.
        """
        params = _build_params(team_id=team_id, direct=direct)
        data = await self._client.request(
            "GET", f"/users/{user_id}/permissions", params=params
        )
        return [
            TeamPermission.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def has_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> bool:
        """Check if a user has a specific permission.

        Args:
            user_id: The user to check.
            permission_id: The permission to check for.
            team_id: Check at team scope if provided.

        Returns:
            ``True`` if the user has the permission, ``False`` otherwise.
        """
        params = _build_params(
            team_id=team_id, permission_id=permission_id
        )
        data = await self._client.request(
            "GET", f"/users/{user_id}/permissions", params=params
        )
        return len((data or {}).get("items", [])) > 0

    async def get_permission(
        self,
        user_id: str,
        permission_id: str,
        *,
        team_id: Optional[str] = None,
    ) -> TeamPermission | None:
        """Get a specific permission for a user.

        Args:
            user_id: The user to check.
            permission_id: The permission to look up.
            team_id: Check at team scope if provided.

        Returns:
            The :class:`TeamPermission` if found, or ``None``.
        """
        params = _build_params(
            team_id=team_id, permission_id=permission_id
        )
        data = await self._client.request(
            "GET", f"/users/{user_id}/permissions", params=params
        )
        items = (data or {}).get("items", [])
        if not items:
            return None
        return TeamPermission.model_validate(items[0])

    # -- contact channels ----------------------------------------------------

    async def list_contact_channels(
        self, user_id: str
    ) -> list[ContactChannel]:
        """List contact channels for a user.

        Args:
            user_id: The user whose contact channels to list.

        Returns:
            A list of :class:`ContactChannel` objects.
        """
        data = await self._client.request(
            "GET", "/contact-channels", params={"user_id": user_id}
        )
        return [
            ContactChannel.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def create_contact_channel(
        self,
        user_id: str,
        *,
        value: str,
        type: str = "email",
        used_for_auth: bool,
        is_primary: Optional[bool] = None,
        is_verified: Optional[bool] = None,
    ) -> ContactChannel:
        """Create a new contact channel for a user.

        Args:
            user_id: The user to create the channel for.
            value: The channel value (e.g., email address).
            type: The channel type (default: ``"email"``).
            used_for_auth: Whether this channel is used for authentication.
            is_primary: Whether this is the primary channel.
            is_verified: Whether the channel is pre-verified.

        Returns:
            The created :class:`ContactChannel`.
        """
        body = _build_params(
            user_id=user_id,
            value=value,
            type=type,
            used_for_auth=used_for_auth,
            is_primary=is_primary,
            is_verified=is_verified,
        )
        data = await self._client.request(
            "POST", "/contact-channels", body=body
        )
        return ContactChannel.model_validate(data)

    async def send_verification_code(
        self,
        contact_channel_id: str,
        *,
        callback_url: Optional[str] = None,
    ) -> None:
        """Send a verification email for a contact channel.

        Args:
            contact_channel_id: The channel to send verification for.
            callback_url: Optional URL to redirect after verification.

        Returns:
            None.
        """
        body = _build_params(callback_url=callback_url)
        await self._client.request(
            "POST",
            f"/contact-channels/{contact_channel_id}/send-verification-email",
            body=body,
        )

    async def verify_contact_channel(self, code: str) -> None:
        """Verify a contact channel with a verification code.

        Args:
            code: The verification code received via email.

        Returns:
            None.
        """
        await self._client.request(
            "POST", "/contact-channels/verify", body={"code": code}
        )

    # -- API keys ------------------------------------------------------------

    async def create_user_api_key(
        self,
        user_id: str,
        *,
        description: str,
        expires_at_millis: Optional[int] = None,
        scope: Optional[str] = None,
        team_id: Optional[str] = None,
    ) -> UserApiKeyFirstView:
        """Create a user API key.

        Args:
            user_id: The user to create the key for.
            description: Human-readable description of the key's purpose.
            expires_at_millis: Optional expiration timestamp in milliseconds
                since epoch.
            scope: Optional scope restriction for the key.
            team_id: Optional team to associate the key with.

        Returns:
            A :class:`UserApiKeyFirstView` containing the key including the
            secret (only available at creation time).
        """
        body = _build_params(
            description=description,
            expires_at_millis=expires_at_millis,
            scope=scope,
            team_id=team_id,
        )
        data = await self._client.request(
            "POST", f"/users/{user_id}/api-keys", body=body
        )
        return UserApiKeyFirstView.model_validate(data)

    async def list_user_api_keys(self, user_id: str) -> list[UserApiKey]:
        """List API keys for a user.

        Args:
            user_id: The user whose API keys to list.

        Returns:
            A list of :class:`UserApiKey` objects (secrets are not included).
        """
        data = await self._client.request(
            "GET", f"/users/{user_id}/api-keys"
        )
        return [
            UserApiKey.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def revoke_user_api_key(self, api_key_id: str) -> None:
        """Revoke (delete) a user API key.

        Args:
            api_key_id: The unique identifier of the API key to revoke.

        Returns:
            None.
        """
        await self._client.request("DELETE", f"/api-keys/{api_key_id}")

    async def create_team_api_key(
        self,
        team_id: str,
        *,
        description: str,
        expires_at_millis: Optional[int] = None,
        scope: Optional[str] = None,
    ) -> TeamApiKeyFirstView:
        """Create a team API key.

        Args:
            team_id: The team to create the key for.
            description: Human-readable description of the key's purpose.
            expires_at_millis: Optional expiration timestamp in milliseconds
                since epoch.
            scope: Optional scope restriction for the key.

        Returns:
            A :class:`TeamApiKeyFirstView` containing the key including the
            secret (only available at creation time).
        """
        body = _build_params(
            description=description,
            expires_at_millis=expires_at_millis,
            scope=scope,
        )
        data = await self._client.request(
            "POST", f"/teams/{team_id}/api-keys", body=body
        )
        return TeamApiKeyFirstView.model_validate(data)

    async def list_team_api_keys(self, team_id: str) -> list[TeamApiKey]:
        """List API keys for a team.

        Args:
            team_id: The team whose API keys to list.

        Returns:
            A list of :class:`TeamApiKey` objects (secrets are not included).
        """
        data = await self._client.request(
            "GET", f"/teams/{team_id}/api-keys"
        )
        return [
            TeamApiKey.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def revoke_team_api_key(self, api_key_id: str) -> None:
        """Revoke (delete) a team API key.

        Args:
            api_key_id: The unique identifier of the API key to revoke.

        Returns:
            None.
        """
        await self._client.request("DELETE", f"/api-keys/{api_key_id}")

    async def check_api_key(self, api_key: str) -> dict[str, Any] | None:
        """Validate an API key and return associated user/team info.

        Args:
            api_key: The API key string to validate.

        Returns:
            A dict with ``user_id`` and/or ``team_id`` if the key is valid,
            or ``None`` if the key is invalid.
        """
        try:
            data = await self._client.request(
                "POST", "/api-keys/check", body={"api_key": api_key}
            )
        except (NotFoundError, ApiKeyError):
            return None
        if data is None:
            return None
        return data

    # -- OAuth providers -----------------------------------------------------

    async def create_oauth_provider(
        self,
        user_id: str,
        *,
        account_id: str,
        provider_config_id: str,
        email: str,
        allow_sign_in: bool,
        allow_connected_accounts: bool,
    ) -> OAuthProvider:
        """Link an OAuth provider to a user.

        Args:
            user_id: The user to link the provider to.
            account_id: The external account ID from the OAuth provider.
            provider_config_id: The provider configuration ID in Stack Auth.
            email: The email address from the OAuth provider.
            allow_sign_in: Whether this provider can be used for sign-in.
            allow_connected_accounts: Whether this counts as a connected account.

        Returns:
            The created :class:`OAuthProvider` link.
        """
        body = _build_params(
            account_id=account_id,
            provider_config_id=provider_config_id,
            email=email,
            allow_sign_in=allow_sign_in,
            allow_connected_accounts=allow_connected_accounts,
        )
        data = await self._client.request(
            "POST", f"/users/{user_id}/oauth-providers", body=body
        )
        return OAuthProvider.model_validate(data)

    async def list_oauth_providers(
        self, user_id: str
    ) -> list[OAuthProvider]:
        """List OAuth providers linked to a user.

        Args:
            user_id: The user whose OAuth providers to list.

        Returns:
            A list of :class:`OAuthProvider` objects.
        """
        data = await self._client.request(
            "GET", f"/users/{user_id}/oauth-providers"
        )
        return [
            OAuthProvider.model_validate(item)
            for item in (data or {}).get("items", [])
        ]

    async def get_oauth_provider(
        self, user_id: str, provider_id: str
    ) -> OAuthProvider | None:
        """Get a specific OAuth provider for a user.

        Fetches all providers and filters by *provider_id*.

        Args:
            user_id: The user who owns the provider link.
            provider_id: The provider ID to look up.

        Returns:
            The :class:`OAuthProvider` if found, or ``None``.
        """
        providers = await self.list_oauth_providers(user_id)
        return next((p for p in providers if p.id == provider_id), None)

    async def list_connected_accounts(
        self, user_id: str
    ) -> list[OAuthProvider]:
        """List connected accounts for a user.

        This is an alias for :meth:`list_oauth_providers`.

        Args:
            user_id: The user whose connected accounts to list.

        Returns:
            A list of :class:`OAuthProvider` objects.
        """
        return await self.list_oauth_providers(user_id)

    # -- payments ------------------------------------------------------------

    async def list_products(
        self,
        *,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> PaginatedResult[Product]:
        """List products for a customer.

        Exactly one of *user_id*, *team_id*, or *custom_customer_id* must be
        provided.

        Args:
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.
            cursor: Pagination cursor from a previous response.
            limit: Maximum number of products to return per page.

        Returns:
            A :class:`PaginatedResult` containing :class:`Product` items.

        Raises:
            ValueError: If not exactly one customer identifier is provided.
        """
        ctype, cid, _ = _resolve_customer_path(user_id, team_id, custom_customer_id)
        params = _build_params(cursor=cursor, limit=limit)
        data = await self._client.request(
            "GET", f"/customers/{ctype}/{cid}/products", params=params
        )
        if data is None:
            return PaginatedResult(items=[])
        items = [Product.model_validate(i) for i in data.get("items", [])]
        pagination = _PaginationMeta(**(data.get("pagination") or {}))
        return PaginatedResult(items=items, pagination=pagination)

    async def get_item(
        self,
        item_id: str,
        *,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
    ) -> AsyncServerItem:
        """Get a server-side item with async quantity modification methods.

        Exactly one of *user_id*, *team_id*, or *custom_customer_id* must be
        provided.

        Args:
            item_id: The unique identifier of the item.
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.

        Returns:
            An :class:`AsyncServerItem` wrapping the :class:`Item` data and
            providing ``increase_quantity``, ``decrease_quantity``, and
            ``try_decrease_quantity`` coroutines.

        Raises:
            ValueError: If not exactly one customer identifier is provided.
            NotFoundError: If the item does not exist.
        """
        ctype, cid, field_name = _resolve_customer_path(
            user_id, team_id, custom_customer_id
        )
        data = await self._client.request(
            "GET", f"/customers/{ctype}/{cid}/items/{item_id}"
        )
        if data is None:
            raise NotFoundError(code="ITEM_NOT_FOUND", message=f"Item '{item_id}' not found")
        item = Item.model_validate(data)
        return AsyncServerItem(
            item,
            _client=self._client,
            _customer_path=f"/customers/{ctype}/{cid}",
            _item_id=item_id,
            _customer_id_field=field_name,
            _customer_id_value=cid,
        )

    async def grant_product(
        self,
        *,
        product_id: Optional[str] = None,
        product: Optional[dict[str, Any]] = None,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
        quantity: Optional[int] = None,
    ) -> None:
        """Grant a product to a customer.

        Provide either *product_id* (existing product) or *product* (inline
        product definition). Exactly one of *user_id*, *team_id*, or
        *custom_customer_id* must be provided.

        Args:
            product_id: ID of an existing product to grant.
            product: Inline product definition dict.
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.
            quantity: Number of units to grant (for quantity-based items).

        Returns:
            None.

        Raises:
            ValueError: If not exactly one customer identifier is provided,
                or if both/neither of product_id and product are given.
        """
        if (product_id is None) == (product is None):
            raise ValueError("Provide exactly one of product_id or product, not both or neither")
        ctype, cid, _ = _resolve_customer_path(user_id, team_id, custom_customer_id)
        body = _build_params(
            product_id=product_id,
            product=product,
            quantity=quantity,
        )
        await self._client.request(
            "POST", f"/customers/{ctype}/{cid}/products", body=body
        )

    async def cancel_subscription(
        self,
        product_id: str,
        *,
        user_id: Optional[str] = None,
        team_id: Optional[str] = None,
        custom_customer_id: Optional[str] = None,
    ) -> None:
        """Cancel a subscription for a customer.

        Exactly one of *user_id*, *team_id*, or *custom_customer_id* must be
        provided.

        Args:
            product_id: The product/subscription to cancel.
            user_id: Identify the customer by user ID.
            team_id: Identify the customer by team ID.
            custom_customer_id: Identify the customer by custom ID.

        Returns:
            None.

        Raises:
            ValueError: If not exactly one customer identifier is provided.
        """
        _, cid, field_name = _resolve_customer_path(
            user_id, team_id, custom_customer_id
        )
        body: dict[str, Any] = {"product_id": product_id, field_name: cid}
        await self._client.request("POST", "/subscriptions/cancel", body=body)

    # -- email ---------------------------------------------------------------

    async def send_email(
        self,
        to: str | list[str],
        subject: str,
        *,
        html: Optional[str] = None,
        text: Optional[str] = None,
    ) -> None:
        """Send a transactional email.

        Args:
            to: Recipient email address or list of addresses.
            subject: Email subject line.
            html: HTML body content.
            text: Plain-text body content.

        Returns:
            None.
        """
        body: dict[str, Any] = {"to": to, "subject": subject}
        if html is not None:
            body["html"] = html
        if text is not None:
            body["text"] = text
        await self._client.request("POST", "/emails", body=body)

    async def get_email_delivery_stats(self) -> EmailDeliveryInfo:
        """Get email delivery statistics.

        Args:
            (none)

        Returns:
            An :class:`EmailDeliveryInfo` with delivery counts and statuses.
        """
        data = await self._client.request("GET", "/emails/delivery-stats")
        if data is None:
            return EmailDeliveryInfo(delivered=0, bounced=0, complained=0, total=0)
        return EmailDeliveryInfo.model_validate(data)

    # -- data vault ----------------------------------------------------------

    def get_data_vault_store(self, store_id: str) -> AsyncDataVaultStore:
        """Get a data vault store by ID.

        The returned :class:`AsyncDataVaultStore` object provides async
        ``get``, ``set``, ``delete``, and ``list_keys`` methods for
        key-value operations within the store.

        Args:
            store_id: The unique identifier of the data vault store.

        Returns:
            An :class:`AsyncDataVaultStore` for performing async key-value
            operations.
        """
        return AsyncDataVaultStore(store_id, _client=self._client)

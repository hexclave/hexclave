"""Stack Auth Python SDK.

A type-safe Python client for the Stack Auth API, providing both
synchronous and asynchronous interfaces for user management, team
management, permissions, API keys, OAuth, payments, email, and more.

Quick Start:
    Install the package::

        pip install stack-auth

    Synchronous usage with :class:`StackServerApp`::

        from stack_auth import StackServerApp

        app = StackServerApp(
            project_id="my-project-id",
            secret_server_key="ssk_...",
        )
        user = app.get_user("user-123")
        users = app.list_users(limit=10)
        app.close()

    Async usage with :class:`AsyncStackServerApp`::

        from stack_auth import AsyncStackServerApp

        async with AsyncStackServerApp(
            project_id="my-project-id",
            secret_server_key="ssk_...",
        ) as app:
            user = await app.get_user("user-123")
            users = await app.list_users(limit=10)

    Error handling with :class:`StackAuthError`::

        from stack_auth import StackServerApp, StackAuthError, NotFoundError

        app = StackServerApp(project_id="...", secret_server_key="...")
        try:
            user = app.create_user(primary_email="alice@example.com")
        except StackAuthError as e:
            print(f"API error: {e}")

Key Features:
    - **Type-safe**: All responses are validated Pydantic v2 models.
    - **Sync + Async**: Choose :class:`StackServerApp` or
      :class:`AsyncStackServerApp` based on your application's needs.
    - **Full API coverage**: Users, teams, permissions, sessions,
      API keys, OAuth, payments, email, and data vault.
"""

from stack_auth._app import AsyncStackServerApp, StackServerApp
from stack_auth._auth import (
    AuthState,
    TokenPartialUser,
    async_authenticate_request,
    decode_access_token_claims,
    sync_authenticate_request,
)
from stack_auth._pagination import PaginatedResult
from stack_auth._version import __version__
from stack_auth.errors import (
    AnalyticsError,
    ApiKeyError,
    AuthenticationError,
    CliError,
    ConflictError,
    EmailError,
    NotFoundError,
    OAuthError,
    PasskeyError,
    PaymentError,
    PermissionDeniedError,
    RateLimitError,
    StackAuthError,
    ValidationError,
)
from stack_auth.models import (
    ActiveSession,
    ApiKey,
    AsyncDataVaultStore,
    AsyncServerItem,
    BaseUser,
    ContactChannel,
    DataVaultStore,
    EmailDeliveryInfo,
    GeoInfo,
    Item,
    NotificationCategory,
    OAuthConnection,
    OAuthProvider,
    Product,
    Project,
    ProjectConfig,
    ProjectPermission,
    ServerItem,
    ServerTeam,
    ServerUser,
    Team,
    TeamApiKey,
    TeamApiKeyFirstView,
    TeamInvitation,
    TeamMemberProfile,
    TeamPermission,
    UserApiKey,
    UserApiKeyFirstView,
)

__all__ = [
    "__version__",
    "StackServerApp",
    "AsyncStackServerApp",
    "PaginatedResult",
    # Errors
    "StackAuthError",
    "AuthenticationError",
    "NotFoundError",
    "ValidationError",
    "PermissionDeniedError",
    "ConflictError",
    "OAuthError",
    "PasskeyError",
    "ApiKeyError",
    "PaymentError",
    "EmailError",
    "RateLimitError",
    "CliError",
    "AnalyticsError",
    # Auth
    "AuthState",
    "TokenPartialUser",
    "decode_access_token_claims",
    "sync_authenticate_request",
    "async_authenticate_request",
    # Models
    "DataVaultStore",
    "AsyncDataVaultStore",
    "BaseUser",
    "ServerUser",
    "Team",
    "ServerTeam",
    "TeamMemberProfile",
    "TeamInvitation",
    "ActiveSession",
    "GeoInfo",
    "ContactChannel",
    "TeamPermission",
    "ProjectPermission",
    "Project",
    "ProjectConfig",
    "ApiKey",
    "UserApiKey",
    "UserApiKeyFirstView",
    "TeamApiKey",
    "TeamApiKeyFirstView",
    "OAuthConnection",
    "OAuthProvider",
    "Product",
    "Item",
    "ServerItem",
    "AsyncServerItem",
    "EmailDeliveryInfo",
    "NotificationCategory",
]

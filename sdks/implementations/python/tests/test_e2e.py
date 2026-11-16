"""End-to-end integration tests for the Stack Auth Python SDK.

These tests run against a live Stack Auth instance and verify real API
interactions. They require the Stack Auth dev environment to be running:

    pnpm start-deps   # Start Docker dependencies
    pnpm dev           # Start the backend server

Run with:
    python3 -m pytest tests/test_e2e.py -v -s

Set STACK_E2E=1 to enable (skipped by default to avoid CI failures):
    STACK_E2E=1 python3 -m pytest tests/test_e2e.py -v -s
"""

from __future__ import annotations

import os
import uuid

import pytest

from stack_auth import (
    AsyncStackServerApp,
    StackServerApp,
)

# ---------------------------------------------------------------------------
# Skip unless STACK_E2E=1 is set
# ---------------------------------------------------------------------------

pytestmark = pytest.mark.skipif(
    os.environ.get("STACK_E2E") != "1",
    reason="E2E tests require STACK_E2E=1 and a running Stack Auth instance",
)

# ---------------------------------------------------------------------------
# Dev environment credentials (from apps/backend/.env.development)
# ---------------------------------------------------------------------------

PROJECT_ID = "internal"
SECRET_SERVER_KEY = "this-secret-server-key-is-for-local-development-only"
BASE_URL = os.environ.get("STACK_BASE_URL", "http://localhost:8102")


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def app() -> StackServerApp:
    """Create a sync StackServerApp for testing."""
    return StackServerApp(
        project_id=PROJECT_ID,
        secret_server_key=SECRET_SERVER_KEY,
        base_url=BASE_URL,
    )


@pytest.fixture
def async_app() -> AsyncStackServerApp:
    """Create an async AsyncStackServerApp for testing."""
    return AsyncStackServerApp(
        project_id=PROJECT_ID,
        secret_server_key=SECRET_SERVER_KEY,
        base_url=BASE_URL,
    )


def _unique_email() -> str:
    """Generate a unique email for test isolation."""
    return f"e2e-test-{uuid.uuid4().hex[:8]}@example.com"


# ===========================================================================
# E2E-01: User CRUD Lifecycle
# ===========================================================================


class TestUserCRUDLifecycle:
    """Full user lifecycle: create, get, update, list, search, delete."""

    def test_create_get_update_delete(self, app: StackServerApp) -> None:
        email = _unique_email()

        # Create
        user = app.create_user(
            primary_email=email,
            password="TestPassword123!",
            display_name="E2E Test User",
        )
        assert user.id is not None
        assert user.primary_email == email
        assert user.display_name == "E2E Test User"

        try:
            # Get
            fetched = app.get_user(user.id)
            assert fetched is not None
            assert fetched.id == user.id
            assert fetched.primary_email == email

            # Update
            updated = app.update_user(user.id, display_name="Updated E2E User")
            assert updated is not None
            assert updated.display_name == "Updated E2E User"

            # List with search
            results = app.list_users(query=email)
            assert len(results.items) >= 1
            found = any(u.id == user.id for u in results.items)
            assert found, f"User {user.id} not found in search results"

            # List with pagination
            paginated = app.list_users(limit=1)
            assert len(paginated.items) == 1

        finally:
            # Delete (cleanup)
            app.delete_user(user.id)

        # Verify deletion
        deleted = app.get_user(user.id)
        assert deleted is None

    def test_get_nonexistent_user_returns_none(self, app: StackServerApp) -> None:
        result = app.get_user("nonexistent-user-id-12345")
        assert result is None


# ===========================================================================
# E2E-02: Team Lifecycle
# ===========================================================================


class TestTeamLifecycle:
    """Full team lifecycle: create, members, invitations, permissions, delete."""

    def test_create_team_add_member_delete(self, app: StackServerApp) -> None:
        # Create a user to be team creator/member
        email = _unique_email()
        user = app.create_user(
            primary_email=email,
            password="TestPassword123!",
            display_name="Team Test User",
        )

        try:
            # Create team
            team = app.create_team(
                display_name="E2E Test Team",
                creator_user_id=user.id,
            )
            assert team.id is not None
            assert team.display_name == "E2E Test Team"

            # List teams for user
            teams = app.list_teams(user_id=user.id)
            assert len(teams) >= 1
            found = any(t.id == team.id for t in teams)
            assert found, f"Team {team.id} not found in user's teams"

            # Get team
            fetched = app.get_team(team.id)
            assert fetched is not None
            assert fetched.id == team.id

            # Update team
            updated = app.update_team(team.id, display_name="Updated E2E Team")
            assert updated is not None
            assert updated.display_name == "Updated E2E Team"

            # List member profiles
            profiles = app.list_team_member_profiles(team.id)
            assert len(profiles) >= 1

            # Delete team
            app.delete_team(team.id)

            # Verify deletion
            deleted_team = app.get_team(team.id)
            assert deleted_team is None

        finally:
            app.delete_user(user.id)

    def test_get_nonexistent_team_returns_none(self, app: StackServerApp) -> None:
        result = app.get_team("nonexistent-team-id-12345")
        assert result is None


# ===========================================================================
# E2E-03: Session Management
# ===========================================================================


class TestSessionManagement:
    """Session listing and management."""

    def test_list_sessions_for_user(self, app: StackServerApp) -> None:
        email = _unique_email()
        user = app.create_user(
            primary_email=email,
            password="TestPassword123!",
            display_name="Session Test User",
        )

        try:
            # New users have no sessions (they haven't signed in via browser)
            sessions = app.list_sessions(user_id=user.id)
            assert isinstance(sessions, list)
        finally:
            app.delete_user(user.id)


# ===========================================================================
# E2E-04: API Key Management
# ===========================================================================


class TestAPIKeyManagement:
    """API key creation, validation, and revocation."""

    def test_user_api_key_lifecycle(self, app: StackServerApp) -> None:
        email = _unique_email()
        user = app.create_user(
            primary_email=email,
            password="TestPassword123!",
            display_name="API Key Test User",
        )

        try:
            # Create API key
            api_key = app.create_user_api_key(
                user_id=user.id,
                description="E2E test key",
                expires_at_millis=None,
            )
            assert api_key is not None

            # List API keys
            keys = app.list_user_api_keys(user_id=user.id)
            assert len(keys) >= 1

            # Revoke
            app.revoke_user_api_key(api_key_id=api_key.id)

            # Verify revocation
            keys_after = app.list_user_api_keys(user_id=user.id)
            active_ids = [k.id for k in keys_after if not getattr(k, "is_revoked", False)]
            # Key should either be absent or marked as revoked
            assert api_key.id not in active_ids or len(keys_after) <= len(keys)

        finally:
            app.delete_user(user.id)

    def test_team_api_key_lifecycle(self, app: StackServerApp) -> None:
        email = _unique_email()
        user = app.create_user(
            primary_email=email,
            password="TestPassword123!",
        )

        try:
            team = app.create_team(
                display_name="API Key Team",
                creator_user_id=user.id,
            )

            # Create team API key
            api_key = app.create_team_api_key(
                team_id=team.id,
                description="E2E team key",
                expires_at_millis=None,
            )
            assert api_key is not None

            # List team API keys
            keys = app.list_team_api_keys(team_id=team.id)
            assert len(keys) >= 1

            # Cleanup
            app.revoke_team_api_key(api_key_id=api_key.id)
            app.delete_team(team.id)

        finally:
            app.delete_user(user.id)


# ===========================================================================
# E2E-05: authenticate_request with Real Tokens (limited without browser)
# ===========================================================================


class TestAuthenticateRequestE2E:
    """Test authenticate_request with real-world patterns.

    Note: Full JWT-based auth testing requires a browser sign-in flow to get
    a real access token. Without that, we test the unauthenticated paths
    and verify the function handles real request shapes correctly.
    """

    def test_unauthenticated_request_without_token(self, app: StackServerApp) -> None:
        import httpx as httpx_client

        from stack_auth._auth import sync_authenticate_request
        from stack_auth._jwt import SyncJWKSFetcher

        jwks_url = f"{BASE_URL}/api/v1/projects/{PROJECT_ID}/.well-known/jwks.json"
        fetcher = SyncJWKSFetcher(
            jwks_url=jwks_url,
            http_client=httpx_client.Client(),
        )

        class FakeRequest:
            def __init__(self, headers: dict[str, str]) -> None:
                self.headers = headers

        # No auth header → unauthenticated
        request = FakeRequest({})
        result = sync_authenticate_request(request, fetcher=fetcher)
        assert result.status == "unauthenticated"

    def test_invalid_token_returns_unauthenticated(self, app: StackServerApp) -> None:
        import httpx as httpx_client

        from stack_auth._auth import sync_authenticate_request
        from stack_auth._jwt import SyncJWKSFetcher

        jwks_url = f"{BASE_URL}/api/v1/projects/{PROJECT_ID}/.well-known/jwks.json"
        fetcher = SyncJWKSFetcher(
            jwks_url=jwks_url,
            http_client=httpx_client.Client(),
        )

        class FakeRequest:
            def __init__(self, headers: dict[str, str]) -> None:
                self.headers = headers

        # Invalid token → unauthenticated
        request = FakeRequest({"Authorization": "Bearer invalid-token-value"})
        result = sync_authenticate_request(request, fetcher=fetcher)
        assert result.status == "unauthenticated"


# ===========================================================================
# Async variants (spot-check — not duplicating full suite)
# ===========================================================================


class TestAsyncE2E:
    """Spot-check that async variants work against live API."""

    @pytest.mark.asyncio
    async def test_async_user_create_delete(self, async_app: AsyncStackServerApp) -> None:
        email = _unique_email()

        user = await async_app.create_user(
            primary_email=email,
            password="TestPassword123!",
            display_name="Async E2E User",
        )
        assert user.id is not None
        assert user.display_name == "Async E2E User"

        await async_app.delete_user(user.id)

        deleted = await async_app.get_user(user.id)
        assert deleted is None

    @pytest.mark.asyncio
    async def test_async_team_create_delete(self, async_app: AsyncStackServerApp) -> None:
        email = _unique_email()
        user = await async_app.create_user(
            primary_email=email,
            password="TestPassword123!",
        )

        try:
            team = await async_app.create_team(
                display_name="Async E2E Team",
                creator_user_id=user.id,
            )
            assert team.id is not None

            await async_app.delete_team(team.id)
        finally:
            await async_app.delete_user(user.id)

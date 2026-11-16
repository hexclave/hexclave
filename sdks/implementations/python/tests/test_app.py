"""Tests for StackServerApp and AsyncStackServerApp facade classes."""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
import respx

from stack_auth._app import AsyncStackServerApp, StackServerApp
from stack_auth._auth import TokenPartialUser


def _make_jwt(claims: dict) -> str:
    """Build a fake JWT with the given payload claims (no real signature)."""
    header = base64.urlsafe_b64encode(
        json.dumps({"typ": "JWT", "alg": "RS256"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps(claims).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{payload}.fake_signature"


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------

USER_JSON = {
    "id": "user-123",
    "displayName": "Alice",
    "primaryEmail": "alice@example.com",
    "primaryEmailVerified": True,
    "profileImageUrl": None,
    "signedUpAtMillis": 1700000000000,
    "lastActiveAtMillis": 1700001000000,
    "clientMetadata": {},
    "clientReadOnlyMetadata": {},
    "serverMetadata": {"role": "admin"},
    "hasPassword": True,
    "otpAuthEnabled": False,
    "passkeyAuthEnabled": False,
    "isMultiFactorRequired": False,
    "isAnonymous": False,
    "isRestricted": False,
    "restrictedReason": None,
}

USERS_LIST_JSON = {
    "items": [USER_JSON],
    "pagination": {"next_cursor": "cursor-abc"},
}


BASE_URL = "https://api.stack-auth.com"
API_PREFIX = f"{BASE_URL}/api/v1"


# ---------------------------------------------------------------------------
# StackServerApp - Construction
# ---------------------------------------------------------------------------


class TestStackServerAppConstruction:
    def test_constructs_with_required_params(self) -> None:
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        assert app is not None

    def test_constructs_with_optional_params(self) -> None:
        app = StackServerApp(
            project_id="proj",
            secret_server_key="sk",
            base_url="https://custom.example.com",
            token_store="memory",
        )
        assert app is not None

    def test_constructs_with_publishable_client_key(self) -> None:
        app = StackServerApp(project_id="proj", secret_server_key="sk", publishable_client_key="pk_test")
        assert app is not None

    def test_async_constructs_with_publishable_client_key(self) -> None:
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk", publishable_client_key="pk_test")
        assert app is not None

    def test_context_manager(self) -> None:
        with StackServerApp(project_id="proj", secret_server_key="sk") as app:
            assert app is not None


# ---------------------------------------------------------------------------
# StackServerApp - get_user
# ---------------------------------------------------------------------------


class TestGetUser:
    @respx.mock
    def test_get_user_success(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        user = app.get_user("user-123")
        assert user is not None
        assert user.id == "user-123"
        assert user.display_name == "Alice"
        assert user.server_metadata == {"role": "admin"}

    @respx.mock
    def test_get_user_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/nonexistent").mock(
            return_value=httpx.Response(
                200,
                json={"message": "User not found"},
                headers={
                    "x-stack-known-error": "USER_NOT_FOUND",
                    "x-stack-actual-status": "404",
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        user = app.get_user("nonexistent")
        assert user is None


# ---------------------------------------------------------------------------
# StackServerApp - list_users
# ---------------------------------------------------------------------------


class TestListUsers:
    @respx.mock
    def test_list_users_basic(self) -> None:
        respx.get(f"{API_PREFIX}/users").mock(
            return_value=httpx.Response(200, json=USERS_LIST_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.list_users()
        assert len(result.items) == 1
        assert result.items[0].id == "user-123"
        assert result.next_cursor == "cursor-abc"
        assert result.has_next_page is True

    @respx.mock
    def test_list_users_with_params(self) -> None:
        route = respx.get(f"{API_PREFIX}/users").mock(
            return_value=httpx.Response(
                200, json={"items": [], "pagination": {}}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.list_users(
            cursor="abc",
            limit=10,
            order_by="created_at",
            desc=True,
            query="search",
            include_restricted=True,
            include_anonymous=False,
        )
        assert len(result.items) == 0
        # Verify query params were sent
        request = route.calls[0].request
        assert "cursor" in dict(request.url.params)
        assert request.url.params["cursor"] == "abc"
        assert request.url.params["limit"] == "10"


# ---------------------------------------------------------------------------
# StackServerApp - create_user
# ---------------------------------------------------------------------------


class TestCreateUser:
    @respx.mock
    def test_create_user_full(self) -> None:
        respx.post(f"{API_PREFIX}/users").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        user = app.create_user(
            primary_email="alice@example.com",
            password="secret123",
            display_name="Alice",
        )
        assert user.id == "user-123"
        assert user.primary_email == "alice@example.com"

    @respx.mock
    def test_create_user_omits_none_fields(self) -> None:
        route = respx.post(f"{API_PREFIX}/users").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.create_user(primary_email="a@b.com")
        request = route.calls[0].request
        import json

        body = json.loads(request.content)
        assert "primary_email" in body
        assert "password" not in body
        assert "display_name" not in body


# ---------------------------------------------------------------------------
# StackServerApp - update_user
# ---------------------------------------------------------------------------


class TestUpdateUser:
    @respx.mock
    def test_update_user_sends_only_provided_fields(self) -> None:
        route = respx.patch(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        user = app.update_user("user-123", display_name="New Name")
        assert user.id == "user-123"
        import json

        body = json.loads(route.calls[0].request.content)
        assert body == {"display_name": "New Name"}

    @respx.mock
    def test_update_user_sends_none_to_clear_field(self) -> None:
        route = respx.patch(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.update_user("user-123", display_name=None)
        import json

        body = json.loads(route.calls[0].request.content)
        assert body == {"display_name": None}

    @respx.mock
    def test_update_user_sentinel_distinguishes_not_provided(self) -> None:
        route = respx.patch(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        # Only provide display_name, not server_metadata
        app.update_user("user-123", display_name="X")
        import json

        body = json.loads(route.calls[0].request.content)
        assert "server_metadata" not in body
        assert body == {"display_name": "X"}


# ---------------------------------------------------------------------------
# StackServerApp - delete_user
# ---------------------------------------------------------------------------


class TestDeleteUser:
    @respx.mock
    def test_delete_user(self) -> None:
        respx.delete(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.delete_user("user-123")
        assert result is None


# ---------------------------------------------------------------------------
# StackServerApp - get_user_by_api_key
# ---------------------------------------------------------------------------


class TestGetUserByApiKey:
    @respx.mock
    def test_get_user_by_api_key_success(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(200, json={"user_id": "user-123"})
        )
        respx.get(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        user = app.get_user_by_api_key("sk_abc")
        assert user is not None
        assert user.id == "user-123"

    @respx.mock
    def test_get_user_by_api_key_invalid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200,
                json={"message": "API key not valid"},
                headers={
                    "x-stack-known-error": "API_KEY_NOT_VALID",
                    "x-stack-actual-status": "400",
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        user = app.get_user_by_api_key("invalid")
        assert user is None

    @respx.mock
    def test_get_user_by_api_key_no_user_id(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(200, json={"team_id": "team-1"})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        user = app.get_user_by_api_key("sk_team")
        assert user is None


# ---------------------------------------------------------------------------
# AsyncStackServerApp - Construction
# ---------------------------------------------------------------------------


class TestAsyncStackServerAppConstruction:
    def test_constructs_with_required_params(self) -> None:
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        assert app is not None

    @pytest.mark.asyncio
    async def test_async_context_manager(self) -> None:
        async with AsyncStackServerApp(
            project_id="proj", secret_server_key="sk"
        ) as app:
            assert app is not None


# ---------------------------------------------------------------------------
# AsyncStackServerApp - get_user
# ---------------------------------------------------------------------------


class TestAsyncGetUser:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_user_success(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        user = await app.get_user("user-123")
        assert user is not None
        assert user.id == "user-123"
        assert user.display_name == "Alice"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_user_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/nonexistent").mock(
            return_value=httpx.Response(
                200,
                json={"message": "User not found"},
                headers={
                    "x-stack-known-error": "USER_NOT_FOUND",
                    "x-stack-actual-status": "404",
                },
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        user = await app.get_user("nonexistent")
        assert user is None
        await app.aclose()


# ---------------------------------------------------------------------------
# AsyncStackServerApp - list_users
# ---------------------------------------------------------------------------


class TestAsyncListUsers:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_users_basic(self) -> None:
        respx.get(f"{API_PREFIX}/users").mock(
            return_value=httpx.Response(200, json=USERS_LIST_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.list_users()
        assert len(result.items) == 1
        assert result.items[0].id == "user-123"
        assert result.next_cursor == "cursor-abc"
        await app.aclose()


# ---------------------------------------------------------------------------
# AsyncStackServerApp - create_user
# ---------------------------------------------------------------------------


class TestAsyncCreateUser:
    @respx.mock
    @pytest.mark.asyncio
    async def test_create_user(self) -> None:
        respx.post(f"{API_PREFIX}/users").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        user = await app.create_user(
            primary_email="alice@example.com",
            display_name="Alice",
        )
        assert user.id == "user-123"
        await app.aclose()


# ---------------------------------------------------------------------------
# AsyncStackServerApp - update_user
# ---------------------------------------------------------------------------


class TestAsyncUpdateUser:
    @respx.mock
    @pytest.mark.asyncio
    async def test_update_user(self) -> None:
        route = respx.patch(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        user = await app.update_user("user-123", display_name="New")
        assert user.id == "user-123"
        import json

        body = json.loads(route.calls[0].request.content)
        assert body == {"display_name": "New"}
        await app.aclose()


# ---------------------------------------------------------------------------
# AsyncStackServerApp - delete_user
# ---------------------------------------------------------------------------


class TestAsyncDeleteUser:
    @respx.mock
    @pytest.mark.asyncio
    async def test_delete_user(self) -> None:
        respx.delete(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.delete_user("user-123")
        assert result is None
        await app.aclose()


# ---------------------------------------------------------------------------
# AsyncStackServerApp - get_user_by_api_key
# ---------------------------------------------------------------------------


class TestAsyncGetUserByApiKey:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_user_by_api_key_success(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(200, json={"user_id": "user-123"})
        )
        respx.get(f"{API_PREFIX}/users/user-123").mock(
            return_value=httpx.Response(200, json=USER_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        user = await app.get_user_by_api_key("sk_abc")
        assert user is not None
        assert user.id == "user-123"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_user_by_api_key_invalid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200,
                json={"message": "API key not valid"},
                headers={
                    "x-stack-known-error": "API_KEY_NOT_VALID",
                    "x-stack-actual-status": "400",
                },
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        user = await app.get_user_by_api_key("invalid")
        assert user is None
        await app.aclose()


# ---------------------------------------------------------------------------
# Session test data
# ---------------------------------------------------------------------------

SESSION_JSON = {
    "id": "sess-1",
    "userId": "user-123",
    "createdAtMillis": 1700000000000,
    "isImpersonation": False,
    "lastUsedAtMillis": 1700001000000,
    "isCurrentSession": False,
    "geoInfo": {
        "city": "San Francisco",
        "region": "CA",
        "country": "US",
        "countryName": "United States",
        "latitude": 37.7749,
        "longitude": -122.4194,
    },
}

SESSION_JSON_2 = {
    "id": "sess-2",
    "userId": "user-123",
    "createdAtMillis": 1700002000000,
    "isImpersonation": False,
    "lastUsedAtMillis": None,
    "isCurrentSession": True,
    "geoInfo": None,
}

SESSIONS_LIST_JSON = {"items": [SESSION_JSON, SESSION_JSON_2]}


# ---------------------------------------------------------------------------
# StackServerApp - list_sessions
# ---------------------------------------------------------------------------


class TestListSessions:
    @respx.mock
    def test_list_sessions(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json=SESSIONS_LIST_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        sessions = app.list_sessions("user-123")
        assert len(sessions) == 2
        assert sessions[0].id == "sess-1"
        assert sessions[0].user_id == "user-123"
        assert sessions[0].geo_info is not None
        assert sessions[0].geo_info.city == "San Francisco"
        assert sessions[1].id == "sess-2"
        assert sessions[1].is_current_session is True

    @respx.mock
    def test_list_sessions_sends_user_id_param(self) -> None:
        route = respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        sessions = app.list_sessions("user-456")
        assert sessions == []
        request = route.calls[0].request
        assert request.url.params["user_id"] == "user-456"

    @respx.mock
    def test_list_sessions_empty(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        sessions = app.list_sessions("user-123")
        assert sessions == []


# ---------------------------------------------------------------------------
# StackServerApp - get_session
# ---------------------------------------------------------------------------


class TestGetSession:
    @respx.mock
    def test_get_session_found(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json=SESSIONS_LIST_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        session = app.get_session("sess-1", user_id="user-123")
        assert session is not None
        assert session.id == "sess-1"

    @respx.mock
    def test_get_session_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json=SESSIONS_LIST_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        session = app.get_session("nonexistent", user_id="user-123")
        assert session is None


# ---------------------------------------------------------------------------
# StackServerApp - revoke_session
# ---------------------------------------------------------------------------


class TestRevokeSession:
    @respx.mock
    def test_revoke_session(self) -> None:
        route = respx.delete(f"{API_PREFIX}/auth/sessions/sess-1").mock(
            return_value=httpx.Response(200)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.revoke_session("sess-1", user_id="user-123")
        assert result is None
        request = route.calls[0].request
        assert request.url.params["user_id"] == "user-123"


# ---------------------------------------------------------------------------
# AsyncStackServerApp - list_sessions
# ---------------------------------------------------------------------------


class TestAsyncListSessions:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_sessions(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json=SESSIONS_LIST_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        sessions = await app.list_sessions("user-123")
        assert len(sessions) == 2
        assert sessions[0].id == "sess-1"
        assert sessions[1].id == "sess-2"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_list_sessions_empty(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        sessions = await app.list_sessions("user-123")
        assert sessions == []
        await app.aclose()


# ---------------------------------------------------------------------------
# AsyncStackServerApp - get_session
# ---------------------------------------------------------------------------


class TestAsyncGetSession:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_session_found(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json=SESSIONS_LIST_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        session = await app.get_session("sess-1", user_id="user-123")
        assert session is not None
        assert session.id == "sess-1"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_session_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/auth/sessions").mock(
            return_value=httpx.Response(200, json=SESSIONS_LIST_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        session = await app.get_session("nonexistent", user_id="user-123")
        assert session is None
        await app.aclose()


# ---------------------------------------------------------------------------
# AsyncStackServerApp - revoke_session
# ---------------------------------------------------------------------------


class TestAsyncRevokeSession:
    @respx.mock
    @pytest.mark.asyncio
    async def test_revoke_session(self) -> None:
        route = respx.delete(f"{API_PREFIX}/auth/sessions/sess-1").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.revoke_session("sess-1", user_id="user-123")
        assert result is None
        request = route.calls[0].request
        assert request.url.params["user_id"] == "user-123"
        await app.aclose()


# ---------------------------------------------------------------------------
# Team test data
# ---------------------------------------------------------------------------

TEAM_JSON = {
    "id": "team-123",
    "displayName": "Engineering",
    "profileImageUrl": None,
    "clientMetadata": {},
    "clientReadOnlyMetadata": {},
    "serverMetadata": {"tier": "pro"},
    "createdAtMillis": 1700000000000,
}

TEAM_JSON_2 = {
    "id": "team-456",
    "displayName": "Design",
    "profileImageUrl": "https://img.example.com/design.png",
    "clientMetadata": {"color": "blue"},
    "clientReadOnlyMetadata": {},
    "serverMetadata": {},
    "createdAtMillis": 1700001000000,
}

TEAMS_LIST_JSON = {"items": [TEAM_JSON, TEAM_JSON_2]}


# ---------------------------------------------------------------------------
# StackServerApp - get_team
# ---------------------------------------------------------------------------


class TestGetTeam:
    @respx.mock
    def test_get_team_success(self) -> None:
        respx.get(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        team = app.get_team("team-123")
        assert team is not None
        assert team.id == "team-123"
        assert team.display_name == "Engineering"
        assert team.server_metadata == {"tier": "pro"}

    @respx.mock
    def test_get_team_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/teams/nonexistent").mock(
            return_value=httpx.Response(
                200,
                json={"message": "Team not found"},
                headers={
                    "x-stack-known-error": "TEAM_NOT_FOUND",
                    "x-stack-actual-status": "404",
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        team = app.get_team("nonexistent")
        assert team is None


# ---------------------------------------------------------------------------
# StackServerApp - list_teams
# ---------------------------------------------------------------------------


class TestListTeams:
    @respx.mock
    def test_list_teams_basic(self) -> None:
        respx.get(f"{API_PREFIX}/teams").mock(
            return_value=httpx.Response(200, json=TEAMS_LIST_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        teams = app.list_teams()
        assert len(teams) == 2
        assert teams[0].id == "team-123"
        assert teams[1].id == "team-456"

    @respx.mock
    def test_list_teams_with_user_id(self) -> None:
        route = respx.get(f"{API_PREFIX}/teams").mock(
            return_value=httpx.Response(200, json={"items": [TEAM_JSON]})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        teams = app.list_teams(user_id="user-1")
        assert len(teams) == 1
        request = route.calls[0].request
        assert request.url.params["user_id"] == "user-1"


# ---------------------------------------------------------------------------
# StackServerApp - create_team
# ---------------------------------------------------------------------------


class TestCreateTeam:
    @respx.mock
    def test_create_team_basic(self) -> None:
        respx.post(f"{API_PREFIX}/teams").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        team = app.create_team(display_name="Engineering")
        assert team.id == "team-123"
        assert team.display_name == "Engineering"

    @respx.mock
    def test_create_team_with_optional_fields(self) -> None:
        route = respx.post(f"{API_PREFIX}/teams").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.create_team(
            display_name="Eng",
            profile_image_url="https://img.example.com/eng.png",
            creator_user_id="user-1",
        )
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["display_name"] == "Eng"
        assert body["profile_image_url"] == "https://img.example.com/eng.png"
        assert body["creator_user_id"] == "user-1"


# ---------------------------------------------------------------------------
# StackServerApp - update_team
# ---------------------------------------------------------------------------


class TestUpdateTeam:
    @respx.mock
    def test_update_team_sends_only_provided_fields(self) -> None:
        route = respx.patch(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        team = app.update_team("team-123", display_name="New Name")
        assert team.id == "team-123"
        import json

        body = json.loads(route.calls[0].request.content)
        assert body == {"display_name": "New Name"}

    @respx.mock
    def test_update_team_sends_none_to_clear_field(self) -> None:
        route = respx.patch(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.update_team("team-123", profile_image_url=None)
        import json

        body = json.loads(route.calls[0].request.content)
        assert body == {"profile_image_url": None}

    @respx.mock
    def test_update_team_unset_sentinel(self) -> None:
        route = respx.patch(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.update_team("team-123", display_name="X")
        import json

        body = json.loads(route.calls[0].request.content)
        assert "server_metadata" not in body
        assert "client_metadata" not in body


# ---------------------------------------------------------------------------
# StackServerApp - delete_team
# ---------------------------------------------------------------------------


class TestDeleteTeam:
    @respx.mock
    def test_delete_team(self) -> None:
        respx.delete(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.delete_team("team-123")
        assert result is None


# ---------------------------------------------------------------------------
# StackServerApp - get_team_by_api_key
# ---------------------------------------------------------------------------


class TestGetTeamByApiKey:
    @respx.mock
    def test_get_team_by_api_key_success(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(200, json={"team_id": "team-123"})
        )
        respx.get(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        team = app.get_team_by_api_key("sk_team_abc")
        assert team is not None
        assert team.id == "team-123"

    @respx.mock
    def test_get_team_by_api_key_invalid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200,
                json={"message": "API key not valid"},
                headers={
                    "x-stack-known-error": "API_KEY_NOT_VALID",
                    "x-stack-actual-status": "400",
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        team = app.get_team_by_api_key("invalid")
        assert team is None

    @respx.mock
    def test_get_team_by_api_key_no_team_id(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(200, json={"user_id": "user-1"})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        team = app.get_team_by_api_key("sk_user_only")
        assert team is None


# ---------------------------------------------------------------------------
# AsyncStackServerApp - Team CRUD
# ---------------------------------------------------------------------------


class TestAsyncGetTeam:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_team_success(self) -> None:
        respx.get(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        team = await app.get_team("team-123")
        assert team is not None
        assert team.id == "team-123"
        assert team.display_name == "Engineering"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_team_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/teams/nonexistent").mock(
            return_value=httpx.Response(
                200,
                json={"message": "Team not found"},
                headers={
                    "x-stack-known-error": "TEAM_NOT_FOUND",
                    "x-stack-actual-status": "404",
                },
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        team = await app.get_team("nonexistent")
        assert team is None
        await app.aclose()


class TestAsyncListTeams:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_teams(self) -> None:
        respx.get(f"{API_PREFIX}/teams").mock(
            return_value=httpx.Response(200, json=TEAMS_LIST_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        teams = await app.list_teams()
        assert len(teams) == 2
        assert teams[0].id == "team-123"
        await app.aclose()


class TestAsyncCreateTeam:
    @respx.mock
    @pytest.mark.asyncio
    async def test_create_team(self) -> None:
        respx.post(f"{API_PREFIX}/teams").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        team = await app.create_team(display_name="Engineering")
        assert team.id == "team-123"
        await app.aclose()


class TestAsyncUpdateTeam:
    @respx.mock
    @pytest.mark.asyncio
    async def test_update_team(self) -> None:
        route = respx.patch(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        team = await app.update_team("team-123", display_name="New")
        assert team.id == "team-123"
        import json

        body = json.loads(route.calls[0].request.content)
        assert body == {"display_name": "New"}
        await app.aclose()


class TestAsyncDeleteTeam:
    @respx.mock
    @pytest.mark.asyncio
    async def test_delete_team(self) -> None:
        respx.delete(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.delete_team("team-123")
        assert result is None
        await app.aclose()


class TestAsyncGetTeamByApiKey:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_team_by_api_key_success(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(200, json={"team_id": "team-123"})
        )
        respx.get(f"{API_PREFIX}/teams/team-123").mock(
            return_value=httpx.Response(200, json=TEAM_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        team = await app.get_team_by_api_key("sk_team_abc")
        assert team is not None
        assert team.id == "team-123"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_team_by_api_key_invalid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200,
                json={"message": "API key not valid"},
                headers={
                    "x-stack-known-error": "API_KEY_NOT_VALID",
                    "x-stack-actual-status": "400",
                },
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        team = await app.get_team_by_api_key("invalid")
        assert team is None
        await app.aclose()


# ---------------------------------------------------------------------------
# Team membership test data
# ---------------------------------------------------------------------------

TEAM_MEMBER_PROFILE_JSON = {
    "userId": "user-1",
    "displayName": "Alice",
    "profileImageUrl": None,
}

TEAM_MEMBER_PROFILE_JSON_2 = {
    "userId": "user-2",
    "displayName": "Bob",
    "profileImageUrl": "https://img.example.com/bob.png",
}

TEAM_MEMBER_PROFILES_LIST_JSON = {
    "items": [TEAM_MEMBER_PROFILE_JSON, TEAM_MEMBER_PROFILE_JSON_2]
}

INVITATION_JSON = {
    "id": "inv-1",
    "recipientEmail": "alice@example.com",
    "expiresAtMillis": 1700100000000,
}

INVITATION_JSON_2 = {
    "id": "inv-2",
    "recipientEmail": "bob@example.com",
    "expiresAtMillis": 1700200000000,
}

INVITATIONS_LIST_JSON = {"items": [INVITATION_JSON, INVITATION_JSON_2]}


# ---------------------------------------------------------------------------
# StackServerApp - add_team_member / remove_team_member
# ---------------------------------------------------------------------------


class TestAddTeamMember:
    @respx.mock
    def test_add_team_member(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/team-memberships/team-1/user-1"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.add_team_member("team-1", "user-1")
        assert result is None
        assert route.called


class TestRemoveTeamMember:
    @respx.mock
    def test_remove_team_member(self) -> None:
        route = respx.delete(
            f"{API_PREFIX}/team-memberships/team-1/user-1"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.remove_team_member("team-1", "user-1")
        assert result is None
        assert route.called


# ---------------------------------------------------------------------------
# StackServerApp - team invitations
# ---------------------------------------------------------------------------


class TestSendTeamInvitation:
    @respx.mock
    def test_send_team_invitation_basic(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/team-invitations/send-code"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.send_team_invitation("team-1", "a@b.com")
        assert result is None
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["email"] == "a@b.com"
        assert body["team_id"] == "team-1"

    @respx.mock
    def test_send_team_invitation_with_callback_url(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/team-invitations/send-code"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.send_team_invitation(
            "team-1", "a@b.com", callback_url="https://example.com/accept"
        )
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["callback_url"] == "https://example.com/accept"


class TestListTeamInvitations:
    @respx.mock
    def test_list_team_invitations(self) -> None:
        respx.get(f"{API_PREFIX}/teams/team-1/invitations").mock(
            return_value=httpx.Response(200, json=INVITATIONS_LIST_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        invitations = app.list_team_invitations("team-1")
        assert len(invitations) == 2
        assert invitations[0].id == "inv-1"
        assert invitations[0].recipient_email == "alice@example.com"
        assert invitations[1].id == "inv-2"


class TestRevokeTeamInvitation:
    @respx.mock
    def test_revoke_team_invitation(self) -> None:
        route = respx.delete(
            f"{API_PREFIX}/teams/team-1/invitations/inv-1"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.revoke_team_invitation("team-1", "inv-1")
        assert result is None
        assert route.called


# ---------------------------------------------------------------------------
# StackServerApp - team member profiles
# ---------------------------------------------------------------------------


class TestListTeamMemberProfiles:
    @respx.mock
    def test_list_team_member_profiles(self) -> None:
        respx.get(f"{API_PREFIX}/team-member-profiles").mock(
            return_value=httpx.Response(
                200, json=TEAM_MEMBER_PROFILES_LIST_JSON
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        profiles = app.list_team_member_profiles("team-1")
        assert len(profiles) == 2
        assert profiles[0].user_id == "user-1"
        assert profiles[0].display_name == "Alice"
        assert profiles[1].user_id == "user-2"


class TestGetTeamMemberProfile:
    @respx.mock
    def test_get_team_member_profile_found(self) -> None:
        respx.get(f"{API_PREFIX}/team-member-profiles").mock(
            return_value=httpx.Response(
                200, json=TEAM_MEMBER_PROFILES_LIST_JSON
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        profile = app.get_team_member_profile("team-1", "user-2")
        assert profile is not None
        assert profile.user_id == "user-2"
        assert profile.display_name == "Bob"

    @respx.mock
    def test_get_team_member_profile_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/team-member-profiles").mock(
            return_value=httpx.Response(
                200, json=TEAM_MEMBER_PROFILES_LIST_JSON
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        profile = app.get_team_member_profile("team-1", "nonexistent")
        assert profile is None


# ---------------------------------------------------------------------------
# AsyncStackServerApp - membership, invitations, profiles
# ---------------------------------------------------------------------------


class TestAsyncAddTeamMember:
    @respx.mock
    @pytest.mark.asyncio
    async def test_add_team_member(self) -> None:
        respx.post(f"{API_PREFIX}/team-memberships/team-1/user-1").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.add_team_member("team-1", "user-1")
        assert result is None
        await app.aclose()


class TestAsyncRemoveTeamMember:
    @respx.mock
    @pytest.mark.asyncio
    async def test_remove_team_member(self) -> None:
        respx.delete(f"{API_PREFIX}/team-memberships/team-1/user-1").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.remove_team_member("team-1", "user-1")
        assert result is None
        await app.aclose()


class TestAsyncSendTeamInvitation:
    @respx.mock
    @pytest.mark.asyncio
    async def test_send_team_invitation(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/team-invitations/send-code"
        ).mock(return_value=httpx.Response(200))
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.send_team_invitation("team-1", "a@b.com")
        assert result is None
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["email"] == "a@b.com"
        assert body["team_id"] == "team-1"
        await app.aclose()


class TestAsyncListTeamInvitations:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_team_invitations(self) -> None:
        respx.get(f"{API_PREFIX}/teams/team-1/invitations").mock(
            return_value=httpx.Response(200, json=INVITATIONS_LIST_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        invitations = await app.list_team_invitations("team-1")
        assert len(invitations) == 2
        assert invitations[0].id == "inv-1"
        await app.aclose()


class TestAsyncRevokeTeamInvitation:
    @respx.mock
    @pytest.mark.asyncio
    async def test_revoke_team_invitation(self) -> None:
        respx.delete(f"{API_PREFIX}/teams/team-1/invitations/inv-1").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.revoke_team_invitation("team-1", "inv-1")
        assert result is None
        await app.aclose()


class TestAsyncListTeamMemberProfiles:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_team_member_profiles(self) -> None:
        respx.get(f"{API_PREFIX}/team-member-profiles").mock(
            return_value=httpx.Response(
                200, json=TEAM_MEMBER_PROFILES_LIST_JSON
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        profiles = await app.list_team_member_profiles("team-1")
        assert len(profiles) == 2
        assert profiles[0].user_id == "user-1"
        await app.aclose()


class TestAsyncGetTeamMemberProfile:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_team_member_profile_found(self) -> None:
        respx.get(f"{API_PREFIX}/team-member-profiles").mock(
            return_value=httpx.Response(
                200, json=TEAM_MEMBER_PROFILES_LIST_JSON
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        profile = await app.get_team_member_profile("team-1", "user-2")
        assert profile is not None
        assert profile.display_name == "Bob"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_team_member_profile_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/team-member-profiles").mock(
            return_value=httpx.Response(
                200, json=TEAM_MEMBER_PROFILES_LIST_JSON
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        profile = await app.get_team_member_profile("team-1", "nonexistent")
        assert profile is None
        await app.aclose()


# ---------------------------------------------------------------------------
# Permission test data
# ---------------------------------------------------------------------------

PERMISSION_JSON = {"id": "read"}
PERMISSION_JSON_2 = {"id": "write"}
PERMISSIONS_LIST_JSON = {"items": [PERMISSION_JSON, PERMISSION_JSON_2]}


# ---------------------------------------------------------------------------
# StackServerApp - grant_permission
# ---------------------------------------------------------------------------


class TestGrantPermission:
    @respx.mock
    def test_grant_permission_with_team_id(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/users/user-1/permissions"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.grant_permission("user-1", "read", team_id="team-1")
        assert result is None
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["permission_id"] == "read"
        assert body["team_id"] == "team-1"

    @respx.mock
    def test_grant_permission_project_level(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/users/user-1/permissions"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.grant_permission("user-1", "admin")
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["permission_id"] == "admin"
        assert "team_id" not in body


# ---------------------------------------------------------------------------
# StackServerApp - revoke_permission
# ---------------------------------------------------------------------------


class TestRevokePermission:
    @respx.mock
    def test_revoke_permission_with_team_id(self) -> None:
        route = respx.delete(
            f"{API_PREFIX}/users/user-1/permissions/read"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.revoke_permission("user-1", "read", team_id="team-1")
        assert result is None
        request = route.calls[0].request
        assert request.url.params["team_id"] == "team-1"

    @respx.mock
    def test_revoke_permission_project_level(self) -> None:
        route = respx.delete(
            f"{API_PREFIX}/users/user-1/permissions/admin"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.revoke_permission("user-1", "admin")
        request = route.calls[0].request
        assert "team_id" not in dict(request.url.params)


# ---------------------------------------------------------------------------
# StackServerApp - list_permissions
# ---------------------------------------------------------------------------


class TestListPermissions:
    @respx.mock
    def test_list_permissions_with_team_id(self) -> None:
        route = respx.get(
            f"{API_PREFIX}/users/user-1/permissions"
        ).mock(return_value=httpx.Response(200, json=PERMISSIONS_LIST_JSON))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        perms = app.list_permissions("user-1", team_id="team-1")
        assert len(perms) == 2
        assert perms[0].id == "read"
        assert perms[1].id == "write"
        request = route.calls[0].request
        assert request.url.params["team_id"] == "team-1"

    @respx.mock
    def test_list_permissions_with_direct(self) -> None:
        route = respx.get(
            f"{API_PREFIX}/users/user-1/permissions"
        ).mock(
            return_value=httpx.Response(
                200, json={"items": [PERMISSION_JSON]}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        perms = app.list_permissions(
            "user-1", team_id="team-1", direct=True
        )
        assert len(perms) == 1
        request = route.calls[0].request
        assert request.url.params["direct"] == "true"


# ---------------------------------------------------------------------------
# StackServerApp - has_permission
# ---------------------------------------------------------------------------


class TestHasPermission:
    @respx.mock
    def test_has_permission_true(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(
                200, json={"items": [PERMISSION_JSON]}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        assert app.has_permission("user-1", "read", team_id="team-1") is True

    @respx.mock
    def test_has_permission_false(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        assert (
            app.has_permission("user-1", "read", team_id="team-1") is False
        )


# ---------------------------------------------------------------------------
# StackServerApp - get_permission
# ---------------------------------------------------------------------------


class TestGetPermission:
    @respx.mock
    def test_get_permission_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(
                200, json={"items": [PERMISSION_JSON]}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        perm = app.get_permission("user-1", "read", team_id="team-1")
        assert perm is not None
        assert perm.id == "read"

    @respx.mock
    def test_get_permission_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        perm = app.get_permission("user-1", "read", team_id="team-1")
        assert perm is None


# ---------------------------------------------------------------------------
# AsyncStackServerApp - Permissions
# ---------------------------------------------------------------------------


class TestAsyncGrantPermission:
    @respx.mock
    @pytest.mark.asyncio
    async def test_grant_permission(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/users/user-1/permissions"
        ).mock(return_value=httpx.Response(200))
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.grant_permission(
            "user-1", "read", team_id="team-1"
        )
        assert result is None
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["permission_id"] == "read"
        assert body["team_id"] == "team-1"
        await app.aclose()


class TestAsyncRevokePermission:
    @respx.mock
    @pytest.mark.asyncio
    async def test_revoke_permission(self) -> None:
        route = respx.delete(
            f"{API_PREFIX}/users/user-1/permissions/read"
        ).mock(return_value=httpx.Response(200))
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.revoke_permission(
            "user-1", "read", team_id="team-1"
        )
        assert result is None
        request = route.calls[0].request
        assert request.url.params["team_id"] == "team-1"
        await app.aclose()


class TestAsyncListPermissions:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_permissions(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(200, json=PERMISSIONS_LIST_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        perms = await app.list_permissions("user-1", team_id="team-1")
        assert len(perms) == 2
        assert perms[0].id == "read"
        await app.aclose()


class TestAsyncHasPermission:
    @respx.mock
    @pytest.mark.asyncio
    async def test_has_permission(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(
                200, json={"items": [PERMISSION_JSON]}
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.has_permission(
            "user-1", "read", team_id="team-1"
        )
        assert result is True
        await app.aclose()


class TestAsyncGetPermission:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_permission_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(
                200, json={"items": [PERMISSION_JSON]}
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        perm = await app.get_permission("user-1", "read", team_id="team-1")
        assert perm is not None
        assert perm.id == "read"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_permission_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/permissions").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        perm = await app.get_permission("user-1", "read", team_id="team-1")
        assert perm is None
        await app.aclose()


# ---------------------------------------------------------------------------
# Contact channel test data
# ---------------------------------------------------------------------------

CONTACT_CHANNEL_JSON = {
    "id": "cc-1",
    "value": "alice@example.com",
    "type": "email",
    "isPrimary": True,
    "isVerified": True,
    "usedForAuth": True,
}

CONTACT_CHANNEL_JSON_2 = {
    "id": "cc-2",
    "value": "bob@example.com",
    "type": "email",
    "isPrimary": False,
    "isVerified": False,
    "usedForAuth": False,
}

CONTACT_CHANNELS_LIST_JSON = {
    "items": [CONTACT_CHANNEL_JSON, CONTACT_CHANNEL_JSON_2]
}


# ---------------------------------------------------------------------------
# StackServerApp - list_contact_channels
# ---------------------------------------------------------------------------


class TestListContactChannels:
    @respx.mock
    def test_list_contact_channels(self) -> None:
        route = respx.get(f"{API_PREFIX}/contact-channels").mock(
            return_value=httpx.Response(
                200, json=CONTACT_CHANNELS_LIST_JSON
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        channels = app.list_contact_channels("user-1")
        assert len(channels) == 2
        assert channels[0].id == "cc-1"
        assert channels[0].value == "alice@example.com"
        assert channels[0].is_primary is True
        assert channels[0].is_verified is True
        assert channels[0].used_for_auth is True
        assert channels[1].id == "cc-2"
        assert channels[1].is_primary is False
        request = route.calls[0].request
        assert request.url.params["user_id"] == "user-1"

    @respx.mock
    def test_list_contact_channels_empty(self) -> None:
        respx.get(f"{API_PREFIX}/contact-channels").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        channels = app.list_contact_channels("user-1")
        assert channels == []


# ---------------------------------------------------------------------------
# StackServerApp - create_contact_channel
# ---------------------------------------------------------------------------


class TestCreateContactChannel:
    @respx.mock
    def test_create_contact_channel_basic(self) -> None:
        route = respx.post(f"{API_PREFIX}/contact-channels").mock(
            return_value=httpx.Response(200, json=CONTACT_CHANNEL_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        channel = app.create_contact_channel(
            "user-1", value="a@b.com", used_for_auth=True
        )
        assert channel.id == "cc-1"
        assert channel.value == "alice@example.com"
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["user_id"] == "user-1"
        assert body["value"] == "a@b.com"
        assert body["type"] == "email"
        assert body["used_for_auth"] is True

    @respx.mock
    def test_create_contact_channel_with_optional_fields(self) -> None:
        route = respx.post(f"{API_PREFIX}/contact-channels").mock(
            return_value=httpx.Response(200, json=CONTACT_CHANNEL_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.create_contact_channel(
            "user-1",
            value="a@b.com",
            used_for_auth=True,
            is_primary=True,
            is_verified=True,
        )
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["is_primary"] is True
        assert body["is_verified"] is True


# ---------------------------------------------------------------------------
# StackServerApp - send_verification_code
# ---------------------------------------------------------------------------


class TestSendVerificationCode:
    @respx.mock
    def test_send_verification_code_basic(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/contact-channels/cc-1/send-verification-email"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.send_verification_code("cc-1")
        assert result is None
        assert route.called

    @respx.mock
    def test_send_verification_code_with_callback_url(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/contact-channels/cc-1/send-verification-email"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.send_verification_code(
            "cc-1", callback_url="https://example.com/verify"
        )
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["callback_url"] == "https://example.com/verify"


# ---------------------------------------------------------------------------
# StackServerApp - verify_contact_channel
# ---------------------------------------------------------------------------


class TestVerifyContactChannel:
    @respx.mock
    def test_verify_contact_channel(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/contact-channels/verify"
        ).mock(return_value=httpx.Response(200))
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.verify_contact_channel("abc123")
        assert result is None
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["code"] == "abc123"


# ---------------------------------------------------------------------------
# AsyncStackServerApp - Contact Channels
# ---------------------------------------------------------------------------


class TestAsyncListContactChannels:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_contact_channels(self) -> None:
        respx.get(f"{API_PREFIX}/contact-channels").mock(
            return_value=httpx.Response(
                200, json=CONTACT_CHANNELS_LIST_JSON
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        channels = await app.list_contact_channels("user-1")
        assert len(channels) == 2
        assert channels[0].id == "cc-1"
        assert channels[0].is_primary is True
        await app.aclose()


class TestAsyncCreateContactChannel:
    @respx.mock
    @pytest.mark.asyncio
    async def test_create_contact_channel(self) -> None:
        route = respx.post(f"{API_PREFIX}/contact-channels").mock(
            return_value=httpx.Response(200, json=CONTACT_CHANNEL_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        channel = await app.create_contact_channel(
            "user-1", value="a@b.com", used_for_auth=True
        )
        assert channel.id == "cc-1"
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["user_id"] == "user-1"
        assert body["value"] == "a@b.com"
        await app.aclose()


class TestAsyncSendVerificationCode:
    @respx.mock
    @pytest.mark.asyncio
    async def test_send_verification_code(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/contact-channels/cc-1/send-verification-email"
        ).mock(return_value=httpx.Response(200))
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.send_verification_code("cc-1")
        assert result is None
        assert route.called
        await app.aclose()


class TestAsyncVerifyContactChannel:
    @respx.mock
    @pytest.mark.asyncio
    async def test_verify_contact_channel(self) -> None:
        route = respx.post(
            f"{API_PREFIX}/contact-channels/verify"
        ).mock(return_value=httpx.Response(200))
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.verify_contact_channel("abc123")
        assert result is None
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["code"] == "abc123"
        await app.aclose()


# ---------------------------------------------------------------------------
# API key test data
# ---------------------------------------------------------------------------

USER_API_KEY_JSON = {
    "id": "key-1",
    "description": "My key",
    "expiresAtMillis": 1700100000000,
    "createdAtMillis": 1700000000000,
    "isValid": True,
    "userId": "user-1",
    "teamId": None,
}

USER_API_KEY_FIRST_VIEW_JSON = {
    **USER_API_KEY_JSON,
    "apiKey": "sk_user_secret_123",
}

TEAM_API_KEY_JSON = {
    "id": "key-2",
    "description": "CI key",
    "expiresAtMillis": None,
    "createdAtMillis": 1700000000000,
    "isValid": True,
    "teamId": "team-1",
}

TEAM_API_KEY_FIRST_VIEW_JSON = {
    **TEAM_API_KEY_JSON,
    "apiKey": "sk_team_secret_456",
}


# ---------------------------------------------------------------------------
# StackServerApp - create_user_api_key
# ---------------------------------------------------------------------------


class TestCreateUserApiKey:
    @respx.mock
    def test_create_user_api_key(self) -> None:
        route = respx.post(f"{API_PREFIX}/users/user-1/api-keys").mock(
            return_value=httpx.Response(200, json=USER_API_KEY_FIRST_VIEW_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        key = app.create_user_api_key("user-1", description="My key")
        assert key.id == "key-1"
        assert key.api_key == "sk_user_secret_123"
        assert key.user_id == "user-1"
        assert key.description == "My key"

    @respx.mock
    def test_create_user_api_key_with_optional_fields(self) -> None:
        route = respx.post(f"{API_PREFIX}/users/user-1/api-keys").mock(
            return_value=httpx.Response(200, json=USER_API_KEY_FIRST_VIEW_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        key = app.create_user_api_key(
            "user-1",
            description="My key",
            expires_at_millis=1700100000000,
            scope="read",
            team_id="team-1",
        )
        assert key.id == "key-1"
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["description"] == "My key"
        assert body["expires_at_millis"] == 1700100000000
        assert body["scope"] == "read"
        assert body["team_id"] == "team-1"


# ---------------------------------------------------------------------------
# StackServerApp - list_user_api_keys
# ---------------------------------------------------------------------------


class TestListUserApiKeys:
    @respx.mock
    def test_list_user_api_keys(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/api-keys").mock(
            return_value=httpx.Response(
                200, json={"items": [USER_API_KEY_JSON]}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        keys = app.list_user_api_keys("user-1")
        assert len(keys) == 1
        assert keys[0].id == "key-1"
        assert keys[0].user_id == "user-1"

    @respx.mock
    def test_list_user_api_keys_empty(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/api-keys").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        keys = app.list_user_api_keys("user-1")
        assert keys == []


# ---------------------------------------------------------------------------
# StackServerApp - revoke_user_api_key
# ---------------------------------------------------------------------------


class TestRevokeUserApiKey:
    @respx.mock
    def test_revoke_user_api_key(self) -> None:
        route = respx.delete(f"{API_PREFIX}/api-keys/key-1").mock(
            return_value=httpx.Response(200)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.revoke_user_api_key("key-1")
        assert result is None
        assert route.called


# ---------------------------------------------------------------------------
# StackServerApp - create_team_api_key
# ---------------------------------------------------------------------------


class TestCreateTeamApiKey:
    @respx.mock
    def test_create_team_api_key(self) -> None:
        route = respx.post(f"{API_PREFIX}/teams/team-1/api-keys").mock(
            return_value=httpx.Response(200, json=TEAM_API_KEY_FIRST_VIEW_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        key = app.create_team_api_key("team-1", description="CI key")
        assert key.id == "key-2"
        assert key.api_key == "sk_team_secret_456"
        assert key.team_id == "team-1"


# ---------------------------------------------------------------------------
# StackServerApp - list_team_api_keys
# ---------------------------------------------------------------------------


class TestListTeamApiKeys:
    @respx.mock
    def test_list_team_api_keys(self) -> None:
        respx.get(f"{API_PREFIX}/teams/team-1/api-keys").mock(
            return_value=httpx.Response(
                200, json={"items": [TEAM_API_KEY_JSON]}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        keys = app.list_team_api_keys("team-1")
        assert len(keys) == 1
        assert keys[0].id == "key-2"
        assert keys[0].team_id == "team-1"


# ---------------------------------------------------------------------------
# StackServerApp - revoke_team_api_key
# ---------------------------------------------------------------------------


class TestRevokeTeamApiKey:
    @respx.mock
    def test_revoke_team_api_key(self) -> None:
        route = respx.delete(f"{API_PREFIX}/api-keys/key-2").mock(
            return_value=httpx.Response(200)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.revoke_team_api_key("key-2")
        assert result is None
        assert route.called


# ---------------------------------------------------------------------------
# StackServerApp - check_api_key
# ---------------------------------------------------------------------------


class TestCheckApiKey:
    @respx.mock
    def test_check_api_key_valid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200, json={"user_id": "user-1", "team_id": "team-1"}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.check_api_key("sk_123")
        assert result is not None
        assert result["user_id"] == "user-1"
        assert result["team_id"] == "team-1"

    @respx.mock
    def test_check_api_key_invalid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200,
                json={"message": "API key not valid"},
                headers={
                    "x-stack-known-error": "API_KEY_NOT_VALID",
                    "x-stack-actual-status": "400",
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.check_api_key("invalid")
        assert result is None

    @respx.mock
    def test_check_api_key_sends_correct_body(self) -> None:
        route = respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200, json={"user_id": "user-1"}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.check_api_key("sk_123")
        import json

        body = json.loads(route.calls[0].request.content)
        assert body == {"api_key": "sk_123"}


# ---------------------------------------------------------------------------
# AsyncStackServerApp - API key methods
# ---------------------------------------------------------------------------


class TestAsyncCreateUserApiKey:
    @respx.mock
    @pytest.mark.asyncio
    async def test_create_user_api_key(self) -> None:
        respx.post(f"{API_PREFIX}/users/user-1/api-keys").mock(
            return_value=httpx.Response(200, json=USER_API_KEY_FIRST_VIEW_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        key = await app.create_user_api_key("user-1", description="My key")
        assert key.id == "key-1"
        assert key.api_key == "sk_user_secret_123"
        await app.aclose()


class TestAsyncListUserApiKeys:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_user_api_keys(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/api-keys").mock(
            return_value=httpx.Response(
                200, json={"items": [USER_API_KEY_JSON]}
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        keys = await app.list_user_api_keys("user-1")
        assert len(keys) == 1
        assert keys[0].id == "key-1"
        await app.aclose()


class TestAsyncRevokeUserApiKey:
    @respx.mock
    @pytest.mark.asyncio
    async def test_revoke_user_api_key(self) -> None:
        route = respx.delete(f"{API_PREFIX}/api-keys/key-1").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.revoke_user_api_key("key-1")
        assert result is None
        assert route.called
        await app.aclose()


class TestAsyncCreateTeamApiKey:
    @respx.mock
    @pytest.mark.asyncio
    async def test_create_team_api_key(self) -> None:
        respx.post(f"{API_PREFIX}/teams/team-1/api-keys").mock(
            return_value=httpx.Response(200, json=TEAM_API_KEY_FIRST_VIEW_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        key = await app.create_team_api_key("team-1", description="CI key")
        assert key.id == "key-2"
        assert key.api_key == "sk_team_secret_456"
        await app.aclose()


class TestAsyncListTeamApiKeys:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_team_api_keys(self) -> None:
        respx.get(f"{API_PREFIX}/teams/team-1/api-keys").mock(
            return_value=httpx.Response(
                200, json={"items": [TEAM_API_KEY_JSON]}
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        keys = await app.list_team_api_keys("team-1")
        assert len(keys) == 1
        assert keys[0].id == "key-2"
        await app.aclose()


class TestAsyncRevokeTeamApiKey:
    @respx.mock
    @pytest.mark.asyncio
    async def test_revoke_team_api_key(self) -> None:
        route = respx.delete(f"{API_PREFIX}/api-keys/key-2").mock(
            return_value=httpx.Response(200)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.revoke_team_api_key("key-2")
        assert result is None
        assert route.called
        await app.aclose()


class TestAsyncCheckApiKey:
    @respx.mock
    @pytest.mark.asyncio
    async def test_check_api_key_valid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200, json={"user_id": "user-1", "team_id": "team-1"}
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.check_api_key("sk_123")
        assert result is not None
        assert result["user_id"] == "user-1"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_check_api_key_invalid(self) -> None:
        respx.post(f"{API_PREFIX}/api-keys/check").mock(
            return_value=httpx.Response(
                200,
                json={"message": "API key not valid"},
                headers={
                    "x-stack-known-error": "API_KEY_NOT_VALID",
                    "x-stack-actual-status": "400",
                },
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.check_api_key("invalid")
        assert result is None
        await app.aclose()


# ---------------------------------------------------------------------------
# OAuth provider test data
# ---------------------------------------------------------------------------

OAUTH_PROVIDER_JSON = {
    "id": "provider-1",
    "type": "google",
    "userId": "user-1",
    "accountId": "google-123",
    "email": "a@b.com",
    "allowSignIn": True,
    "allowConnectedAccounts": False,
}

OAUTH_PROVIDER_JSON_2 = {
    "id": "provider-2",
    "type": "github",
    "userId": "user-1",
    "accountId": "gh-456",
    "email": "a@github.com",
    "allowSignIn": False,
    "allowConnectedAccounts": True,
}


# ---------------------------------------------------------------------------
# StackServerApp - create_oauth_provider
# ---------------------------------------------------------------------------


class TestCreateOAuthProvider:
    @respx.mock
    def test_create_oauth_provider(self) -> None:
        route = respx.post(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(200, json=OAUTH_PROVIDER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        provider = app.create_oauth_provider(
            "user-1",
            account_id="google-123",
            provider_config_id="google",
            email="a@b.com",
            allow_sign_in=True,
            allow_connected_accounts=False,
        )
        assert provider.id == "provider-1"
        assert provider.type == "google"
        assert provider.user_id == "user-1"
        assert provider.email == "a@b.com"
        assert provider.allow_sign_in is True
        assert provider.allow_connected_accounts is False

    @respx.mock
    def test_create_oauth_provider_sends_correct_body(self) -> None:
        route = respx.post(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(200, json=OAUTH_PROVIDER_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.create_oauth_provider(
            "user-1",
            account_id="google-123",
            provider_config_id="google",
            email="a@b.com",
            allow_sign_in=True,
            allow_connected_accounts=False,
        )
        import json

        body = json.loads(route.calls[0].request.content)
        assert body["account_id"] == "google-123"
        assert body["provider_config_id"] == "google"
        assert body["email"] == "a@b.com"
        assert body["allow_sign_in"] is True
        assert body["allow_connected_accounts"] is False


# ---------------------------------------------------------------------------
# StackServerApp - list_oauth_providers
# ---------------------------------------------------------------------------


class TestListOAuthProviders:
    @respx.mock
    def test_list_oauth_providers(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(
                200,
                json={"items": [OAUTH_PROVIDER_JSON, OAUTH_PROVIDER_JSON_2]},
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        providers = app.list_oauth_providers("user-1")
        assert len(providers) == 2
        assert providers[0].id == "provider-1"
        assert providers[1].id == "provider-2"

    @respx.mock
    def test_list_oauth_providers_empty(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        providers = app.list_oauth_providers("user-1")
        assert providers == []


# ---------------------------------------------------------------------------
# StackServerApp - get_oauth_provider
# ---------------------------------------------------------------------------


class TestGetOAuthProvider:
    @respx.mock
    def test_get_oauth_provider_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(
                200,
                json={"items": [OAUTH_PROVIDER_JSON, OAUTH_PROVIDER_JSON_2]},
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        provider = app.get_oauth_provider("user-1", "provider-2")
        assert provider is not None
        assert provider.id == "provider-2"
        assert provider.type == "github"

    @respx.mock
    def test_get_oauth_provider_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        provider = app.get_oauth_provider("user-1", "nonexistent")
        assert provider is None


# ---------------------------------------------------------------------------
# StackServerApp - list_connected_accounts
# ---------------------------------------------------------------------------


class TestListConnectedAccounts:
    @respx.mock
    def test_list_connected_accounts(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(
                200,
                json={"items": [OAUTH_PROVIDER_JSON]},
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        accounts = app.list_connected_accounts("user-1")
        assert len(accounts) == 1
        assert accounts[0].id == "provider-1"


# ---------------------------------------------------------------------------
# AsyncStackServerApp - OAuth provider methods
# ---------------------------------------------------------------------------


class TestAsyncCreateOAuthProvider:
    @respx.mock
    @pytest.mark.asyncio
    async def test_create_oauth_provider(self) -> None:
        respx.post(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(200, json=OAUTH_PROVIDER_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        provider = await app.create_oauth_provider(
            "user-1",
            account_id="google-123",
            provider_config_id="google",
            email="a@b.com",
            allow_sign_in=True,
            allow_connected_accounts=False,
        )
        assert provider.id == "provider-1"
        assert provider.type == "google"
        await app.aclose()


class TestAsyncListOAuthProviders:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_oauth_providers(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(
                200,
                json={"items": [OAUTH_PROVIDER_JSON, OAUTH_PROVIDER_JSON_2]},
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        providers = await app.list_oauth_providers("user-1")
        assert len(providers) == 2
        assert providers[0].id == "provider-1"
        await app.aclose()


class TestAsyncGetOAuthProvider:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_oauth_provider_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(
                200,
                json={"items": [OAUTH_PROVIDER_JSON, OAUTH_PROVIDER_JSON_2]},
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        provider = await app.get_oauth_provider("user-1", "provider-2")
        assert provider is not None
        assert provider.id == "provider-2"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_oauth_provider_not_found(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        provider = await app.get_oauth_provider("user-1", "nonexistent")
        assert provider is None
        await app.aclose()


class TestAsyncListConnectedAccounts:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_connected_accounts(self) -> None:
        respx.get(f"{API_PREFIX}/users/user-1/oauth-providers").mock(
            return_value=httpx.Response(
                200,
                json={"items": [OAUTH_PROVIDER_JSON]},
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        accounts = await app.list_connected_accounts("user-1")
        assert len(accounts) == 1
        assert accounts[0].id == "provider-1"
        await app.aclose()


# ===========================================================================
# Payments
# ===========================================================================

PRODUCT_JSON = {
    "id": "prod-1",
    "quantity": 5,
    "displayName": "Premium Plan",
    "customerType": "user",
    "isServerOnly": False,
    "stackable": False,
    "type": "subscription",
}

ITEM_JSON = {
    "displayName": "Credits",
    "quantity": 100,
    "nonNegativeQuantity": 100,
}


# ---------------------------------------------------------------------------
# StackServerApp - list_products
# ---------------------------------------------------------------------------


class TestListProducts:
    @respx.mock
    def test_list_products_with_user_id(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/products").mock(
            return_value=httpx.Response(
                200,
                json={
                    "items": [PRODUCT_JSON],
                    "pagination": {"next_cursor": "cur-1"},
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.list_products(user_id="user-1")
        assert len(result.items) == 1
        assert result.items[0].display_name == "Premium Plan"
        assert result.items[0].customer_type == "user"
        assert result.next_cursor == "cur-1"

    @respx.mock
    def test_list_products_with_team_id(self) -> None:
        respx.get(f"{API_PREFIX}/customers/team/team-1/products").mock(
            return_value=httpx.Response(
                200, json={"items": [], "pagination": {}}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.list_products(team_id="team-1")
        assert len(result.items) == 0

    @respx.mock
    def test_list_products_with_custom_customer_id(self) -> None:
        respx.get(f"{API_PREFIX}/customers/custom/cust-1/products").mock(
            return_value=httpx.Response(
                200,
                json={"items": [PRODUCT_JSON], "pagination": {}},
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.list_products(custom_customer_id="cust-1")
        assert len(result.items) == 1


# ---------------------------------------------------------------------------
# StackServerApp - get_item
# ---------------------------------------------------------------------------


class TestGetItem:
    @respx.mock
    def test_get_item_success(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        server_item = app.get_item("credits", user_id="user-1")
        assert server_item.display_name == "Credits"
        assert server_item.quantity == 100
        assert server_item.non_negative_quantity == 100

    @respx.mock
    def test_get_item_increase_quantity(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        qty_route = respx.post(f"{API_PREFIX}/internal/items/quantity-changes").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        server_item = app.get_item("credits", user_id="user-1")
        server_item.increase_quantity(10)
        import json as _json

        body = _json.loads(qty_route.calls[0].request.content)
        assert body["quantity"] == 10
        assert body["item_id"] == "credits"

    @respx.mock
    def test_get_item_decrease_quantity(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        qty_route = respx.post(f"{API_PREFIX}/internal/items/quantity-changes").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        server_item = app.get_item("credits", user_id="user-1")
        server_item.decrease_quantity(5)
        import json as _json

        body = _json.loads(qty_route.calls[0].request.content)
        assert body["quantity"] == -5

    @respx.mock
    def test_get_item_try_decrease_quantity(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        respx.post(f"{API_PREFIX}/internal/items/try-decrease").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        server_item = app.get_item("credits", user_id="user-1")
        assert server_item.try_decrease_quantity(5) is True

    @respx.mock
    def test_get_item_try_decrease_quantity_fails(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        respx.post(f"{API_PREFIX}/internal/items/try-decrease").mock(
            return_value=httpx.Response(200, json={"success": False})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        server_item = app.get_item("credits", user_id="user-1")
        assert server_item.try_decrease_quantity(999) is False


# ---------------------------------------------------------------------------
# StackServerApp - grant_product
# ---------------------------------------------------------------------------


class TestGrantProduct:
    @respx.mock
    def test_grant_product_by_id(self) -> None:
        route = respx.post(f"{API_PREFIX}/customers/user/user-1/products").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.grant_product(product_id="prod-1", user_id="user-1")
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["product_id"] == "prod-1"

    @respx.mock
    def test_grant_product_with_quantity(self) -> None:
        route = respx.post(f"{API_PREFIX}/customers/team/team-1/products").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.grant_product(product_id="prod-1", team_id="team-1", quantity=3)
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["product_id"] == "prod-1"
        assert body["quantity"] == 3


# ---------------------------------------------------------------------------
# StackServerApp - cancel_subscription
# ---------------------------------------------------------------------------


class TestCancelSubscription:
    @respx.mock
    def test_cancel_subscription(self) -> None:
        route = respx.post(f"{API_PREFIX}/subscriptions/cancel").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.cancel_subscription("prod-1", user_id="user-1")
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["product_id"] == "prod-1"
        assert body["user_id"] == "user-1"

    @respx.mock
    def test_cancel_subscription_with_team(self) -> None:
        route = respx.post(f"{API_PREFIX}/subscriptions/cancel").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.cancel_subscription("prod-1", team_id="team-1")
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["product_id"] == "prod-1"
        assert body["team_id"] == "team-1"


# ---------------------------------------------------------------------------
# AsyncStackServerApp - payments
# ---------------------------------------------------------------------------


class TestAsyncListProducts:
    @respx.mock
    @pytest.mark.asyncio
    async def test_list_products(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/products").mock(
            return_value=httpx.Response(
                200,
                json={"items": [PRODUCT_JSON], "pagination": {}},
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = await app.list_products(user_id="user-1")
        assert len(result.items) == 1
        assert result.items[0].display_name == "Premium Plan"
        await app.aclose()


class TestAsyncGetItem:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_item(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        server_item = await app.get_item("credits", user_id="user-1")
        assert server_item.display_name == "Credits"
        assert server_item.quantity == 100
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_item_increase_quantity(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        respx.post(f"{API_PREFIX}/internal/items/quantity-changes").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        server_item = await app.get_item("credits", user_id="user-1")
        await server_item.increase_quantity(10)
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_get_item_try_decrease(self) -> None:
        respx.get(f"{API_PREFIX}/customers/user/user-1/items/credits").mock(
            return_value=httpx.Response(200, json=ITEM_JSON)
        )
        respx.post(f"{API_PREFIX}/internal/items/try-decrease").mock(
            return_value=httpx.Response(200, json={"success": True})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        server_item = await app.get_item("credits", user_id="user-1")
        result = await server_item.try_decrease_quantity(5)
        assert result is True
        await app.aclose()


class TestAsyncGrantProduct:
    @respx.mock
    @pytest.mark.asyncio
    async def test_grant_product(self) -> None:
        respx.post(f"{API_PREFIX}/customers/user/user-1/products").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        await app.grant_product(product_id="prod-1", user_id="user-1")
        await app.aclose()


class TestAsyncCancelSubscription:
    @respx.mock
    @pytest.mark.asyncio
    async def test_cancel_subscription(self) -> None:
        respx.post(f"{API_PREFIX}/subscriptions/cancel").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        await app.cancel_subscription("prod-1", user_id="user-1")
        await app.aclose()


# ===========================================================================
# Email
# ===========================================================================


# ---------------------------------------------------------------------------
# StackServerApp - send_email
# ---------------------------------------------------------------------------


class TestSendEmail:
    @respx.mock
    def test_send_email_with_html(self) -> None:
        route = respx.post(f"{API_PREFIX}/emails").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.send_email("alice@example.com", "Hello", html="<h1>Hi</h1>")
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["to"] == "alice@example.com"
        assert body["subject"] == "Hello"
        assert body["html"] == "<h1>Hi</h1>"
        assert "text" not in body

    @respx.mock
    def test_send_email_with_text(self) -> None:
        route = respx.post(f"{API_PREFIX}/emails").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.send_email("bob@example.com", "Hi", text="Plain text body")
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["text"] == "Plain text body"
        assert "html" not in body

    @respx.mock
    def test_send_email_to_multiple_recipients(self) -> None:
        route = respx.post(f"{API_PREFIX}/emails").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.send_email(
            ["alice@example.com", "bob@example.com"],
            "Group email",
            html="<p>Hello all</p>",
        )
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["to"] == ["alice@example.com", "bob@example.com"]

    @respx.mock
    def test_send_email_with_html_and_text(self) -> None:
        route = respx.post(f"{API_PREFIX}/emails").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        app.send_email(
            "alice@example.com",
            "Both",
            html="<h1>HTML</h1>",
            text="TEXT",
        )
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["html"] == "<h1>HTML</h1>"
        assert body["text"] == "TEXT"


# ---------------------------------------------------------------------------
# StackServerApp - get_email_delivery_stats
# ---------------------------------------------------------------------------


class TestGetEmailDeliveryStats:
    @respx.mock
    def test_get_email_delivery_stats(self) -> None:
        respx.get(f"{API_PREFIX}/emails/delivery-stats").mock(
            return_value=httpx.Response(
                200,
                json={
                    "delivered": 100,
                    "bounced": 5,
                    "complained": 2,
                    "total": 107,
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        stats = app.get_email_delivery_stats()
        assert stats.delivered == 100
        assert stats.bounced == 5
        assert stats.complained == 2
        assert stats.total == 107


# ---------------------------------------------------------------------------
# AsyncStackServerApp - email
# ---------------------------------------------------------------------------


class TestAsyncSendEmail:
    @respx.mock
    @pytest.mark.asyncio
    async def test_send_email(self) -> None:
        route = respx.post(f"{API_PREFIX}/emails").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        await app.send_email("alice@example.com", "Hello", html="<h1>Hi</h1>")
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["to"] == "alice@example.com"
        assert body["subject"] == "Hello"
        await app.aclose()


class TestAsyncGetEmailDeliveryStats:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_email_delivery_stats(self) -> None:
        respx.get(f"{API_PREFIX}/emails/delivery-stats").mock(
            return_value=httpx.Response(
                200,
                json={
                    "delivered": 50,
                    "bounced": 1,
                    "complained": 0,
                    "total": 51,
                },
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        stats = await app.get_email_delivery_stats()
        assert stats.delivered == 50
        assert stats.total == 51
        await app.aclose()


# ===========================================================================
# Data Vault
# ===========================================================================


# ---------------------------------------------------------------------------
# StackServerApp - data vault
# ---------------------------------------------------------------------------


class TestDataVaultStore:
    @respx.mock
    def test_get_data_vault_store(self) -> None:
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        assert store.id == "my-store"

    @respx.mock
    def test_vault_get_existing_key(self) -> None:
        respx.get(f"{API_PREFIX}/data-vault/stores/my-store/items/key1").mock(
            return_value=httpx.Response(200, json={"value": "hello"})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        assert store.get("key1") == "hello"

    @respx.mock
    def test_vault_get_missing_key(self) -> None:
        respx.get(f"{API_PREFIX}/data-vault/stores/my-store/items/missing").mock(
            return_value=httpx.Response(
                200,
                json={"code": "DATA_VAULT_STORE_HASHED_KEY_DOES_NOT_EXIST", "message": "Key not found"},
                headers={
                    "x-stack-known-error": "DATA_VAULT_STORE_HASHED_KEY_DOES_NOT_EXIST",
                    "x-stack-actual-status": "404",
                },
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        assert store.get("missing") is None

    @respx.mock
    def test_vault_set(self) -> None:
        route = respx.put(f"{API_PREFIX}/data-vault/stores/my-store/items/key1").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        store.set("key1", "world")
        import json as _json

        body = _json.loads(route.calls[0].request.content)
        assert body["value"] == "world"

    @respx.mock
    def test_vault_delete(self) -> None:
        route = respx.delete(f"{API_PREFIX}/data-vault/stores/my-store/items/key1").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        store.delete("key1")
        assert route.call_count == 1

    @respx.mock
    def test_vault_list_keys(self) -> None:
        respx.get(f"{API_PREFIX}/data-vault/stores/my-store/items").mock(
            return_value=httpx.Response(
                200, json={"items": ["key1", "key2", "key3"]}
            )
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        keys = store.list_keys()
        assert keys == ["key1", "key2", "key3"]

    @respx.mock
    def test_vault_list_keys_empty(self) -> None:
        respx.get(f"{API_PREFIX}/data-vault/stores/my-store/items").mock(
            return_value=httpx.Response(200, json={"items": []})
        )
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        keys = store.list_keys()
        assert keys == []


# ---------------------------------------------------------------------------
# AsyncStackServerApp - data vault
# ---------------------------------------------------------------------------


class TestAsyncDataVaultStore:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_data_vault_store(self) -> None:
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        assert store.id == "my-store"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_vault_get_existing_key(self) -> None:
        respx.get(f"{API_PREFIX}/data-vault/stores/my-store/items/key1").mock(
            return_value=httpx.Response(200, json={"value": "hello"})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        assert await store.get("key1") == "hello"
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_vault_get_missing_key(self) -> None:
        respx.get(f"{API_PREFIX}/data-vault/stores/my-store/items/missing").mock(
            return_value=httpx.Response(
                200,
                json={"code": "DATA_VAULT_STORE_HASHED_KEY_DOES_NOT_EXIST", "message": "Key not found"},
                headers={
                    "x-stack-known-error": "DATA_VAULT_STORE_HASHED_KEY_DOES_NOT_EXIST",
                    "x-stack-actual-status": "404",
                },
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        assert await store.get("missing") is None
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_vault_set(self) -> None:
        respx.put(f"{API_PREFIX}/data-vault/stores/my-store/items/key1").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        await store.set("key1", "world")
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_vault_delete(self) -> None:
        respx.delete(f"{API_PREFIX}/data-vault/stores/my-store/items/key1").mock(
            return_value=httpx.Response(200, json={"ok": True})
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        await store.delete("key1")
        await app.aclose()

    @respx.mock
    @pytest.mark.asyncio
    async def test_vault_list_keys(self) -> None:
        respx.get(f"{API_PREFIX}/data-vault/stores/my-store/items").mock(
            return_value=httpx.Response(
                200, json={"items": ["a", "b"]}
            )
        )
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        store = app.get_data_vault_store("my-store")
        keys = await store.list_keys()
        assert keys == ["a", "b"]
        await app.aclose()


# ---------------------------------------------------------------------------
# StackServerApp - get_partial_user
# ---------------------------------------------------------------------------


class TestGetPartialUser:
    def test_returns_partial_user_from_valid_token(self) -> None:
        token = _make_jwt({
            "sub": "user-abc",
            "name": "Alice",
            "email": "alice@example.com",
            "email_verified": True,
            "is_anonymous": False,
            "is_multi_factor_required": False,
            "is_restricted": False,
            "restricted_reason": None,
        })
        app = StackServerApp(
            project_id="proj",
            secret_server_key="sk",
            token_store={"access_token": token},
        )
        result = app.get_partial_user()
        assert result is not None
        assert isinstance(result, TokenPartialUser)
        assert result.id == "user-abc"
        assert result.display_name == "Alice"
        assert result.primary_email == "alice@example.com"

    def test_returns_none_when_token_store_is_none(self) -> None:
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.get_partial_user()
        assert result is None

    def test_returns_none_with_explicit_none_override(self) -> None:
        token = _make_jwt({"sub": "user-abc"})
        app = StackServerApp(
            project_id="proj",
            secret_server_key="sk",
            token_store={"access_token": token},
        )
        result = app.get_partial_user(token_store=None)
        assert result is None

    def test_returns_none_with_empty_store(self) -> None:
        app = StackServerApp(
            project_id="proj",
            secret_server_key="sk",
            token_store={},
        )
        result = app.get_partial_user()
        assert result is None

    def test_override_token_store(self) -> None:
        token = _make_jwt({"sub": "user-override"})
        app = StackServerApp(project_id="proj", secret_server_key="sk")
        result = app.get_partial_user(token_store={"access_token": token})
        assert result is not None
        assert result.id == "user-override"


class TestAsyncGetPartialUser:
    def test_async_returns_partial_user(self) -> None:
        token = _make_jwt({
            "sub": "user-async",
            "name": "Bob",
            "email": "bob@example.com",
            "email_verified": False,
            "is_anonymous": False,
            "is_multi_factor_required": False,
            "is_restricted": False,
            "restricted_reason": None,
        })
        app = AsyncStackServerApp(
            project_id="proj",
            secret_server_key="sk",
            token_store={"access_token": token},
        )
        # get_partial_user is sync even on async app (no I/O)
        result = app.get_partial_user()
        assert result is not None
        assert isinstance(result, TokenPartialUser)
        assert result.id == "user-async"
        assert result.display_name == "Bob"

    def test_async_returns_none_without_store(self) -> None:
        app = AsyncStackServerApp(project_id="proj", secret_server_key="sk")
        result = app.get_partial_user()
        assert result is None

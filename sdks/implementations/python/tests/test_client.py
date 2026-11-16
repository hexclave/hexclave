"""Tests for the sync and async HTTP client classes."""

from __future__ import annotations

import asyncio
import re
from unittest.mock import AsyncMock, patch

import httpx
import pytest
import respx

from stack_auth._client import AsyncAPIClient, BaseAPIClient, SyncAPIClient
from stack_auth._version import __version__
from stack_auth.errors import AuthenticationError, NotFoundError, StackAuthError


# ---------------------------------------------------------------------------
# Construction tests
# ---------------------------------------------------------------------------


class TestClientConstruction:
    def test_sync_client_constructs(self) -> None:
        client = SyncAPIClient(project_id="proj", secret_server_key="sk")
        assert client is not None
        assert isinstance(client, SyncAPIClient)

    def test_async_client_constructs(self) -> None:
        client = AsyncAPIClient(project_id="proj", secret_server_key="sk")
        assert client is not None
        assert isinstance(client, AsyncAPIClient)


# ---------------------------------------------------------------------------
# Header tests
# ---------------------------------------------------------------------------


class TestBuildHeaders:
    def setup_method(self) -> None:
        self.client = SyncAPIClient(project_id="proj_123", secret_server_key="sk_secret")

    def test_project_id_header(self) -> None:
        headers = self.client._build_headers()
        assert headers["x-stack-project-id"] == "proj_123"

    def test_access_type_header(self) -> None:
        headers = self.client._build_headers()
        assert headers["x-stack-access-type"] == "server"

    def test_secret_server_key_header(self) -> None:
        headers = self.client._build_headers()
        assert headers["x-stack-secret-server-key"] == "sk_secret"

    def test_client_version_header(self) -> None:
        headers = self.client._build_headers()
        assert headers["x-stack-client-version"] == f"python@{__version__}"

    def test_override_error_status_header(self) -> None:
        headers = self.client._build_headers()
        assert headers["x-stack-override-error-status"] == "true"

    def test_random_nonce_header_is_uuid(self) -> None:
        headers = self.client._build_headers()
        nonce = headers["x-stack-random-nonce"]
        # UUID v4 pattern
        uuid_pattern = re.compile(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            re.IGNORECASE,
        )
        assert uuid_pattern.match(nonce), f"Nonce {nonce!r} is not a valid UUID v4"

    def test_publishable_client_key_header_included(self) -> None:
        client = SyncAPIClient(project_id="proj_123", secret_server_key="sk_secret", publishable_client_key="pk_test")
        headers = client._build_headers()
        assert headers["x-stack-publishable-client-key"] == "pk_test"

    def test_publishable_client_key_header_omitted_when_none(self) -> None:
        client = SyncAPIClient(project_id="proj_123", secret_server_key="sk_secret")
        headers = client._build_headers()
        assert "x-stack-publishable-client-key" not in headers


# ---------------------------------------------------------------------------
# URL building tests
# ---------------------------------------------------------------------------


class TestBuildUrl:
    def test_default_base_url(self) -> None:
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        assert client._build_url("/users") == "https://api.stack-auth.com/api/v1/users"

    def test_custom_base_url(self) -> None:
        client = SyncAPIClient(project_id="p", secret_server_key="s", base_url="https://custom.host")
        assert client._build_url("/users") == "https://custom.host/api/v1/users"


# ---------------------------------------------------------------------------
# Sync request tests
# ---------------------------------------------------------------------------


class TestSyncRequest:
    @respx.mock
    def test_get_returns_json(self) -> None:
        route = respx.get("https://api.stack-auth.com/api/v1/users").mock(
            return_value=httpx.Response(
                200,
                json={"id": "user_1"},
                headers={"x-stack-actual-status": "200"},
            )
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        result = client.request("GET", "/users")
        assert result == {"id": "user_1"}

    @respx.mock
    def test_known_error_raises_not_found(self) -> None:
        respx.get("https://api.stack-auth.com/api/v1/users/123").mock(
            return_value=httpx.Response(
                200,
                json={"code": "USER_NOT_FOUND", "message": "User not found"},
                headers={
                    "x-stack-actual-status": "400",
                    "x-stack-known-error": "USER_NOT_FOUND",
                },
            )
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        with pytest.raises(NotFoundError) as exc_info:
            client.request("GET", "/users/123")
        assert exc_info.value.code == "USER_NOT_FOUND"

    @respx.mock
    def test_known_error_raises_authentication_error(self) -> None:
        respx.get("https://api.stack-auth.com/api/v1/me").mock(
            return_value=httpx.Response(
                200,
                json={"code": "INVALID_ACCESS_TOKEN", "message": "Bad token"},
                headers={
                    "x-stack-actual-status": "400",
                    "x-stack-known-error": "INVALID_ACCESS_TOKEN",
                },
            )
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        with pytest.raises(AuthenticationError):
            client.request("GET", "/me")

    @respx.mock
    def test_http_error_on_unknown_status(self) -> None:
        respx.get("https://api.stack-auth.com/api/v1/fail").mock(
            return_value=httpx.Response(
                200,
                json={},
                headers={"x-stack-actual-status": "500"},
            )
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        with pytest.raises(StackAuthError) as exc_info:
            client.request("GET", "/fail")
        assert exc_info.value.code == "HTTP_ERROR"

    @respx.mock
    def test_post_with_none_body_sends_empty_json(self) -> None:
        route = respx.post("https://api.stack-auth.com/api/v1/items").mock(
            return_value=httpx.Response(
                200,
                json={"ok": True},
                headers={"x-stack-actual-status": "200"},
            )
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        client.request("POST", "/items", body=None)
        sent_request = route.calls[0].request
        assert sent_request.content == b"{}"

    @respx.mock
    def test_get_with_none_body_sends_no_body(self) -> None:
        route = respx.get("https://api.stack-auth.com/api/v1/items").mock(
            return_value=httpx.Response(
                200,
                json={"ok": True},
                headers={"x-stack-actual-status": "200"},
            )
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        client.request("GET", "/items", body=None)
        sent_request = route.calls[0].request
        assert sent_request.content == b""


# ---------------------------------------------------------------------------
# Async request tests
# ---------------------------------------------------------------------------


class TestAsyncRequest:
    @respx.mock
    @pytest.mark.asyncio
    async def test_get_returns_json(self) -> None:
        respx.get("https://api.stack-auth.com/api/v1/users").mock(
            return_value=httpx.Response(
                200,
                json={"id": "user_1"},
                headers={"x-stack-actual-status": "200"},
            )
        )
        client = AsyncAPIClient(project_id="p", secret_server_key="s")
        result = await client.request("GET", "/users")
        assert result == {"id": "user_1"}
        await client.aclose()


# ---------------------------------------------------------------------------
# Retry tests (sync)
# ---------------------------------------------------------------------------


class TestRetryLogic:
    @respx.mock
    @patch("time.sleep")
    def test_get_retries_on_connect_error(self, mock_sleep: AsyncMock) -> None:
        url = "https://api.stack-auth.com/api/v1/data"
        route = respx.get(url).mock(side_effect=httpx.ConnectError("Connection refused"))
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        with pytest.raises(httpx.ConnectError):
            client.request("GET", "/data")
        # 1 initial + 5 retries = 6 total attempts
        assert route.call_count == 6

    @respx.mock
    @patch("time.sleep")
    def test_post_does_not_retry_on_connect_error(self, mock_sleep: AsyncMock) -> None:
        url = "https://api.stack-auth.com/api/v1/data"
        route = respx.post(url).mock(side_effect=httpx.ConnectError("Connection refused"))
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        with pytest.raises(httpx.ConnectError):
            client.request("POST", "/data")
        assert route.call_count == 1

    @respx.mock
    @patch("time.sleep")
    def test_retry_exponential_backoff_delays(self, mock_sleep: AsyncMock) -> None:
        url = "https://api.stack-auth.com/api/v1/data"
        respx.get(url).mock(side_effect=httpx.ConnectError("fail"))
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        with pytest.raises(httpx.ConnectError):
            client.request("GET", "/data")
        delays = [call.args[0] for call in mock_sleep.call_args_list]
        assert delays == [1.0, 2.0, 4.0, 8.0, 16.0]

    @respx.mock
    @patch("time.sleep")
    def test_429_retries_with_retry_after(self, mock_sleep: AsyncMock) -> None:
        url = "https://api.stack-auth.com/api/v1/data"
        # First call: 429 with Retry-After, second call: success
        respx.get(url).mock(
            side_effect=[
                httpx.Response(
                    200,
                    json={},
                    headers={"x-stack-actual-status": "429", "Retry-After": "3"},
                ),
                httpx.Response(
                    200,
                    json={"ok": True},
                    headers={"x-stack-actual-status": "200"},
                ),
            ]
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        result = client.request("GET", "/data")
        assert result == {"ok": True}
        mock_sleep.assert_called_once_with(3.0)

    @respx.mock
    @patch("time.sleep")
    def test_429_without_retry_after_uses_backoff(self, mock_sleep: AsyncMock) -> None:
        url = "https://api.stack-auth.com/api/v1/data"
        respx.get(url).mock(
            side_effect=[
                httpx.Response(
                    200,
                    json={},
                    headers={"x-stack-actual-status": "429"},
                ),
                httpx.Response(
                    200,
                    json={"ok": True},
                    headers={"x-stack-actual-status": "200"},
                ),
            ]
        )
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        result = client.request("GET", "/data")
        assert result == {"ok": True}
        # First attempt is attempt=0, so backoff = 1.0 * (2 ** 0) = 1.0
        mock_sleep.assert_called_once_with(1.0)


# ---------------------------------------------------------------------------
# Context manager tests
# ---------------------------------------------------------------------------


class TestContextManager:
    def test_sync_context_manager(self) -> None:
        with SyncAPIClient(project_id="p", secret_server_key="s") as client:
            assert isinstance(client, SyncAPIClient)

    @pytest.mark.asyncio
    async def test_async_context_manager(self) -> None:
        async with AsyncAPIClient(project_id="p", secret_server_key="s") as client:
            assert isinstance(client, AsyncAPIClient)

    def test_sync_close(self) -> None:
        client = SyncAPIClient(project_id="p", secret_server_key="s")
        # Force client creation by accessing it
        _ = client._get_client()
        client.close()
        # After close, internal client should be None
        assert client._client is None

    @pytest.mark.asyncio
    async def test_async_aclose(self) -> None:
        client = AsyncAPIClient(project_id="p", secret_server_key="s")
        _ = client._get_client()
        await client.aclose()
        assert client._client is None

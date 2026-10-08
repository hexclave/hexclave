"""Tests for authentication module: AuthState, TokenPartialUser, decode and authenticate."""

from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any, Mapping
from unittest.mock import AsyncMock, MagicMock, patch

import jwt
import pytest

from stack_auth._auth import (
    AuthState,
    TokenPartialUser,
    _extract_token_from_headers,
    async_authenticate_request,
    decode_access_token_claims,
    sync_authenticate_request,
)
from stack_auth._jwt import AsyncJWKSFetcher, SyncJWKSFetcher
from stack_auth._types import RequestLike


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_fake_jwt(payload: dict[str, Any]) -> str:
    """Build a fake JWT with a valid base64url-encoded payload (no real signature)."""
    header = base64.urlsafe_b64encode(json.dumps({"typ": "JWT"}).encode()).rstrip(b"=").decode()
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()
    return f"{header}.{body}.fakesignature"


class FakeRequest:
    """Minimal RequestLike implementation for tests."""

    def __init__(self, headers: dict[str, str] | None = None) -> None:
        self._headers = headers or {}

    @property
    def headers(self) -> Mapping[str, str]:
        return self._headers


# ---------------------------------------------------------------------------
# decode_access_token_claims
# ---------------------------------------------------------------------------


class TestDecodeAccessTokenClaims:
    """Tests for decode_access_token_claims."""

    def test_returns_token_partial_user_for_valid_jwt_with_all_claims(self) -> None:
        payload = {
            "sub": "user-abc",
            "name": "Alice",
            "email": "alice@example.com",
            "email_verified": True,
            "is_anonymous": False,
            "is_multi_factor_required": True,
            "is_restricted": True,
            "restricted_reason": {"reason": "banned"},
        }
        token = _make_fake_jwt(payload)
        result = decode_access_token_claims(token)
        assert result is not None
        assert isinstance(result, TokenPartialUser)
        assert result.id == "user-abc"
        assert result.display_name == "Alice"
        assert result.primary_email == "alice@example.com"
        assert result.primary_email_verified is True
        assert result.is_anonymous is False
        assert result.is_multi_factor_required is True
        assert result.is_restricted is True
        assert result.restricted_reason == {"reason": "banned"}

    def test_returns_defaults_for_missing_optional_claims(self) -> None:
        payload = {"sub": "user-minimal"}
        token = _make_fake_jwt(payload)
        result = decode_access_token_claims(token)
        assert result is not None
        assert result.id == "user-minimal"
        assert result.display_name is None
        assert result.primary_email is None
        assert result.primary_email_verified is False
        assert result.is_anonymous is False
        assert result.is_multi_factor_required is False
        assert result.is_restricted is False
        assert result.restricted_reason is None

    def test_returns_none_for_malformed_token_not_three_parts(self) -> None:
        assert decode_access_token_claims("only.one") is None
        assert decode_access_token_claims("") is None
        assert decode_access_token_claims("single") is None

    def test_returns_none_for_invalid_base64_payload(self) -> None:
        assert decode_access_token_claims("header.!!!invalid-base64!!!.sig") is None

    def test_returns_none_for_json_missing_sub_field(self) -> None:
        payload = {"name": "NoSub"}
        token = _make_fake_jwt(payload)
        assert decode_access_token_claims(token) is None

    def test_handles_base64url_without_padding(self) -> None:
        # Ensure payload that requires padding still works
        payload = {"sub": "u"}
        raw = json.dumps(payload).encode()
        encoded = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
        # Confirm padding was stripped
        assert "=" not in encoded
        token = f"eyJ0eXAiOiJKV1QifQ.{encoded}.sig"
        result = decode_access_token_claims(token)
        assert result is not None
        assert result.id == "u"


# ---------------------------------------------------------------------------
# _extract_token_from_headers
# ---------------------------------------------------------------------------


class TestExtractTokenFromHeaders:
    """Tests for _extract_token_from_headers."""

    def test_returns_token_from_authorization_bearer(self) -> None:
        headers: dict[str, str] = {"Authorization": "Bearer mytoken123"}
        assert _extract_token_from_headers(headers) == "mytoken123"

    def test_returns_token_from_lowercase_authorization(self) -> None:
        headers: dict[str, str] = {"authorization": "Bearer lowertoken"}
        assert _extract_token_from_headers(headers) == "lowertoken"

    def test_returns_access_token_from_x_stack_auth_json_fallback(self) -> None:
        value = json.dumps({"accessToken": "stack-token-xyz"})
        headers: dict[str, str] = {"x-stack-auth": value}
        assert _extract_token_from_headers(headers) == "stack-token-xyz"

    def test_returns_none_when_no_auth_headers(self) -> None:
        assert _extract_token_from_headers({}) is None
        assert _extract_token_from_headers({"Content-Type": "application/json"}) is None

    def test_returns_none_for_malformed_x_stack_auth_json(self) -> None:
        headers: dict[str, str] = {"x-stack-auth": "not-valid-json"}
        assert _extract_token_from_headers(headers) is None


# ---------------------------------------------------------------------------
# sync_authenticate_request
# ---------------------------------------------------------------------------


class TestSyncAuthenticateRequest:
    """Tests for sync_authenticate_request."""

    def test_returns_authenticated_for_valid_jwt(self) -> None:
        fake_claims = {"sub": "user-42", "iss": "stack-auth", "exp": int(time.time()) + 3600}
        fetcher = MagicMock(spec=SyncJWKSFetcher)

        with patch("stack_auth._auth.sync_verify_token", return_value=fake_claims) as mock_verify:
            request = FakeRequest({"Authorization": "Bearer valid-jwt"})
            result = sync_authenticate_request(request, fetcher=fetcher)

        assert result.status == "authenticated"
        assert result.user_id == "user-42"
        assert result.claims == fake_claims
        assert result.token == "valid-jwt"
        mock_verify.assert_called_once_with("valid-jwt", fetcher)

    def test_returns_unauthenticated_when_no_token(self) -> None:
        fetcher = MagicMock(spec=SyncJWKSFetcher)
        request = FakeRequest({})
        result = sync_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert result.user_id is None
        assert result.claims is None
        assert result.token is None

    def test_returns_unauthenticated_when_verification_fails(self) -> None:
        fetcher = MagicMock(spec=SyncJWKSFetcher)

        with patch("stack_auth._auth.sync_verify_token", side_effect=jwt.PyJWTError("bad token")):
            request = FakeRequest({"Authorization": "Bearer expired-jwt"})
            result = sync_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert result.user_id is None


# ---------------------------------------------------------------------------
# async_authenticate_request
# ---------------------------------------------------------------------------


class TestAsyncAuthenticateRequest:
    """Tests for async_authenticate_request."""

    async def test_returns_authenticated_for_valid_jwt(self) -> None:
        fake_claims = {"sub": "user-99", "iss": "stack-auth", "exp": int(time.time()) + 3600}
        fetcher = MagicMock(spec=AsyncJWKSFetcher)

        with patch("stack_auth._auth.async_verify_token", new_callable=AsyncMock, return_value=fake_claims) as mock_verify:
            request = FakeRequest({"Authorization": "Bearer async-jwt"})
            result = await async_authenticate_request(request, fetcher=fetcher)

        assert result.status == "authenticated"
        assert result.user_id == "user-99"
        assert result.claims == fake_claims
        assert result.token == "async-jwt"
        mock_verify.assert_called_once_with("async-jwt", fetcher)

    async def test_returns_unauthenticated_when_no_token(self) -> None:
        fetcher = MagicMock(spec=AsyncJWKSFetcher)
        request = FakeRequest({})
        result = await async_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert result.user_id is None

    async def test_returns_unauthenticated_when_verification_fails(self) -> None:
        fetcher = MagicMock(spec=AsyncJWKSFetcher)

        with patch("stack_auth._auth.async_verify_token", new_callable=AsyncMock, side_effect=jwt.PyJWTError("expired")):
            request = FakeRequest({"Authorization": "Bearer bad-async-jwt"})
            result = await async_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert result.user_id is None


# ---------------------------------------------------------------------------
# Debug logging on authentication failure
# ---------------------------------------------------------------------------


class TestSyncAuthenticateRequestLogging:
    """Verify that sync_authenticate_request emits debug log on failure."""

    def test_logs_debug_on_verification_failure(self, caplog: pytest.LogCaptureFixture) -> None:
        fetcher = MagicMock(spec=SyncJWKSFetcher)

        with (
            patch("stack_auth._auth.sync_verify_token", side_effect=jwt.PyJWTError("bad token")),
            caplog.at_level(logging.DEBUG, logger="stack_auth"),
        ):
            request = FakeRequest({"Authorization": "Bearer invalid-jwt"})
            result = sync_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert any("authenticate_request failed" in record.message for record in caplog.records)

    def test_still_returns_unauthenticated_after_logging(self) -> None:
        fetcher = MagicMock(spec=SyncJWKSFetcher)

        with patch("stack_auth._auth.sync_verify_token", side_effect=ValueError("corrupt")):
            request = FakeRequest({"Authorization": "Bearer corrupt-jwt"})
            result = sync_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert result.user_id is None


class TestAsyncAuthenticateRequestLogging:
    """Verify that async_authenticate_request emits debug log on failure."""

    async def test_logs_debug_on_verification_failure(self, caplog: pytest.LogCaptureFixture) -> None:
        fetcher = MagicMock(spec=AsyncJWKSFetcher)

        with (
            patch("stack_auth._auth.async_verify_token", new_callable=AsyncMock, side_effect=jwt.PyJWTError("bad token")),
            caplog.at_level(logging.DEBUG, logger="stack_auth"),
        ):
            request = FakeRequest({"Authorization": "Bearer invalid-async-jwt"})
            result = await async_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert any("authenticate_request failed" in record.message for record in caplog.records)

    async def test_still_returns_unauthenticated_after_logging(self) -> None:
        fetcher = MagicMock(spec=AsyncJWKSFetcher)

        with patch("stack_auth._auth.async_verify_token", new_callable=AsyncMock, side_effect=ValueError("corrupt")):
            request = FakeRequest({"Authorization": "Bearer corrupt-async-jwt"})
            result = await async_authenticate_request(request, fetcher=fetcher)

        assert result.status == "unauthenticated"
        assert result.user_id is None

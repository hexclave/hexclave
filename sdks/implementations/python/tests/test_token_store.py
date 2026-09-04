"""Tests for the token store subsystem: ABC, concrete stores, registry, and CAS algorithm."""

from __future__ import annotations

import asyncio
import base64
import json
import time
from typing import Mapping
from unittest.mock import MagicMock, patch

import pytest

from stack_auth._token_store import (
    ExplicitTokenStore,
    MemoryTokenStore,
    RequestTokenStore,
    TokenStore,
    _decode_jwt_payload,
    _is_expired,
    _is_fresh_enough,
    get_or_fetch_likely_valid_tokens_async,
    get_or_fetch_likely_valid_tokens_sync,
    resolve_token_store,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_jwt(claims: dict) -> str:
    """Build a fake JWT with the given payload claims (no real signature)."""
    header = base64.urlsafe_b64encode(
        json.dumps({"typ": "JWT", "alg": "RS256"}).encode()
    ).rstrip(b"=").decode()
    payload = base64.urlsafe_b64encode(
        json.dumps(claims).encode()
    ).rstrip(b"=").decode()
    return f"{header}.{payload}.fake_signature"


def _make_fresh_token(now: float) -> str:
    """Token that is fresh: exp > now+20 and iat > now-75."""
    return _make_jwt({"sub": "user_1", "exp": now + 60, "iat": now - 10})


def _make_expiring_soon_token(now: float) -> str:
    """Token that expires within 20s."""
    return _make_jwt({"sub": "user_1", "exp": now + 10, "iat": now - 10})


def _make_old_token(now: float) -> str:
    """Token issued > 75s ago (stale iat)."""
    return _make_jwt({"sub": "user_1", "exp": now + 60, "iat": now - 100})


def _make_expired_token(now: float) -> str:
    """Token that is already expired."""
    return _make_jwt({"sub": "user_1", "exp": now - 10, "iat": now - 100})


class _FakeRequest:
    """Simple request-like object implementing the RequestLike protocol."""

    def __init__(self, headers: dict[str, str]) -> None:
        self._headers = headers

    @property
    def headers(self) -> Mapping[str, str]:
        return self._headers


# ---------------------------------------------------------------------------
# TokenStore ABC
# ---------------------------------------------------------------------------

class TestTokenStoreABC:
    def test_cannot_instantiate_abstract(self) -> None:
        with pytest.raises(TypeError):
            TokenStore()  # type: ignore[abstract]

    def test_has_sync_and_async_locks(self) -> None:
        store = MemoryTokenStore()
        assert hasattr(store, "_sync_lock")
        assert hasattr(store, "_async_lock")


# ---------------------------------------------------------------------------
# MemoryTokenStore
# ---------------------------------------------------------------------------

class TestMemoryTokenStore:
    def test_stores_and_retrieves_tokens(self) -> None:
        store = MemoryTokenStore()
        assert store.get_stored_access_token() is None
        assert store.get_stored_refresh_token() is None

        store.compare_and_set(None, "rt_1", "at_1")  # type: ignore[arg-type]
        # compare against None should match initial state
        assert store.get_stored_access_token() == "at_1"
        assert store.get_stored_refresh_token() == "rt_1"

    def test_compare_and_set_updates_when_matching(self) -> None:
        store = MemoryTokenStore()
        store.compare_and_set(None, "rt_1", "at_1")  # type: ignore[arg-type]
        store.compare_and_set("rt_1", "rt_2", "at_2")
        assert store.get_stored_access_token() == "at_2"
        assert store.get_stored_refresh_token() == "rt_2"

    def test_compare_and_set_does_not_update_when_mismatched(self) -> None:
        store = MemoryTokenStore()
        store.compare_and_set(None, "rt_1", "at_1")  # type: ignore[arg-type]
        store.compare_and_set("wrong_rt", "rt_2", "at_2")
        assert store.get_stored_access_token() == "at_1"
        assert store.get_stored_refresh_token() == "rt_1"


# ---------------------------------------------------------------------------
# ExplicitTokenStore
# ---------------------------------------------------------------------------

class TestExplicitTokenStore:
    def test_initializes_from_tokens(self) -> None:
        store = ExplicitTokenStore(access_token="at_1", refresh_token="rt_1")
        assert store.get_stored_access_token() == "at_1"
        assert store.get_stored_refresh_token() == "rt_1"

    def test_supports_cas_update(self) -> None:
        store = ExplicitTokenStore(access_token="at_1", refresh_token="rt_1")
        store.compare_and_set("rt_1", "rt_2", "at_2")
        assert store.get_stored_access_token() == "at_2"
        assert store.get_stored_refresh_token() == "rt_2"

    def test_cas_does_not_update_when_mismatched(self) -> None:
        store = ExplicitTokenStore(access_token="at_1", refresh_token="rt_1")
        store.compare_and_set("wrong", "rt_2", "at_2")
        assert store.get_stored_access_token() == "at_1"
        assert store.get_stored_refresh_token() == "rt_1"

    def test_defaults_to_none_without_arguments(self) -> None:
        store = ExplicitTokenStore()
        assert store.get_stored_access_token() is None
        assert store.get_stored_refresh_token() is None

    def test_partial_dict_defaults_missing_to_none(self) -> None:
        store = resolve_token_store({"access_token": "at"}, "proj")
        assert isinstance(store, ExplicitTokenStore)
        assert store.get_stored_access_token() == "at"
        assert store.get_stored_refresh_token() is None


# ---------------------------------------------------------------------------
# RequestTokenStore
# ---------------------------------------------------------------------------

class TestRequestTokenStore:
    def test_extracts_tokens_from_header(self) -> None:
        header_value = json.dumps({"accessToken": "at_req", "refreshToken": "rt_req"})
        request = _FakeRequest({"x-stack-auth": header_value})
        store = RequestTokenStore(request)
        assert store.get_stored_access_token() == "at_req"
        assert store.get_stored_refresh_token() == "rt_req"

    def test_returns_none_when_header_missing(self) -> None:
        request = _FakeRequest({})
        store = RequestTokenStore(request)
        assert store.get_stored_access_token() is None
        assert store.get_stored_refresh_token() is None

    def test_returns_none_when_header_is_malformed_json(self) -> None:
        request = _FakeRequest({"x-stack-auth": "not-json"})
        store = RequestTokenStore(request)
        assert store.get_stored_access_token() is None
        assert store.get_stored_refresh_token() is None

    def test_supports_cas_update(self) -> None:
        header_value = json.dumps({"accessToken": "at_req", "refreshToken": "rt_req"})
        request = _FakeRequest({"x-stack-auth": header_value})
        store = RequestTokenStore(request)
        store.compare_and_set("rt_req", "rt_new", "at_new")
        assert store.get_stored_access_token() == "at_new"
        assert store.get_stored_refresh_token() == "rt_new"


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

class TestTokenStoreRegistry:
    def test_same_project_returns_same_instance(self) -> None:
        store1 = resolve_token_store("memory", "proj_1")
        store2 = resolve_token_store("memory", "proj_1")
        assert store1 is store2

    def test_different_projects_return_different_instances(self) -> None:
        store1 = resolve_token_store("memory", "proj_1")
        store2 = resolve_token_store("memory", "proj_2")
        assert store1 is not store2

    def test_resolve_explicit_token_store(self) -> None:
        store = resolve_token_store(
            {"access_token": "at", "refresh_token": "rt"}, "proj"
        )
        assert isinstance(store, ExplicitTokenStore)
        assert store.get_stored_access_token() == "at"
        assert store.get_stored_refresh_token() == "rt"

    def test_resolve_request_token_store(self) -> None:
        header_value = json.dumps({"accessToken": "at", "refreshToken": "rt"})
        request = _FakeRequest({"x-stack-auth": header_value})
        store = resolve_token_store(request, "proj")
        assert isinstance(store, RequestTokenStore)

    def test_resolve_none(self) -> None:
        assert resolve_token_store(None, "proj") is None

    def test_resolve_raises_type_error_for_invalid_input(self) -> None:
        with pytest.raises(TypeError, match="Invalid token store initializer"):
            resolve_token_store(12345, "proj")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# RequestLike runtime_checkable isinstance checks
# ---------------------------------------------------------------------------

class TestRequestLikeProtocol:
    def test_isinstance_works_on_conforming_object(self) -> None:
        """RequestLike should be runtime_checkable so isinstance works."""
        from stack_auth._types import RequestLike

        request = _FakeRequest({"x-stack-auth": "{}"})
        assert isinstance(request, RequestLike)

    def test_isinstance_rejects_non_conforming_object(self) -> None:
        """Objects without a .headers property should not pass isinstance."""
        from stack_auth._types import RequestLike

        assert not isinstance("a string", RequestLike)
        assert not isinstance(42, RequestLike)
        assert not isinstance({}, RequestLike)

    def test_resolve_token_store_returns_request_token_store_for_request_like(self) -> None:
        """resolve_token_store should detect RequestLike via isinstance and return RequestTokenStore."""
        header_value = json.dumps({"accessToken": "at", "refreshToken": "rt"})
        request = _FakeRequest({"x-stack-auth": header_value})
        store = resolve_token_store(request, "proj")
        assert isinstance(store, RequestTokenStore)
        assert store.get_stored_access_token() == "at"


# ---------------------------------------------------------------------------
# Helper functions: _is_fresh_enough, _is_expired, _decode_jwt_payload
# ---------------------------------------------------------------------------

class TestIsFreshEnough:
    def test_returns_true_for_fresh_token(self) -> None:
        now = time.time()
        token = _make_fresh_token(now)
        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            assert _is_fresh_enough(token) is True

    def test_returns_false_for_expiring_soon(self) -> None:
        now = time.time()
        token = _make_expiring_soon_token(now)
        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            assert _is_fresh_enough(token) is False

    def test_returns_false_for_old_iat(self) -> None:
        now = time.time()
        token = _make_old_token(now)
        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            assert _is_fresh_enough(token) is False

    def test_returns_false_for_none(self) -> None:
        assert _is_fresh_enough(None) is False


class TestDecodeJwtPayload:
    def test_decodes_valid_jwt(self) -> None:
        token = _make_jwt({"sub": "user_1", "exp": 9999999999})
        claims = _decode_jwt_payload(token)
        assert claims is not None
        assert claims["sub"] == "user_1"

    def test_returns_none_for_invalid(self) -> None:
        assert _decode_jwt_payload("not-a-jwt") is None

    def test_returns_none_for_malformed_base64(self) -> None:
        assert _decode_jwt_payload("a.!!!.c") is None


class TestIsExpired:
    def test_expired_token(self) -> None:
        now = time.time()
        token = _make_expired_token(now)
        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            assert _is_expired(token) is True

    def test_valid_token(self) -> None:
        now = time.time()
        token = _make_fresh_token(now)
        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            assert _is_expired(token) is False


# ---------------------------------------------------------------------------
# CAS Refresh: Sync
# ---------------------------------------------------------------------------

class TestCASRefreshSync:
    def test_returns_fresh_access_token(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        fresh_token = _make_fresh_token(now)
        store.compare_and_set(None, "rt_1", fresh_token)  # type: ignore[arg-type]
        refresh_fn = MagicMock(return_value=(True, "new_at"))

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = get_or_fetch_likely_valid_tokens_sync(store, refresh_fn)

        assert rt == "rt_1"
        assert at == fresh_token
        refresh_fn.assert_not_called()

    def test_refreshes_when_expiring_soon(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        expiring_token = _make_expiring_soon_token(now)
        store.compare_and_set(None, "rt_1", expiring_token)  # type: ignore[arg-type]
        refresh_fn = MagicMock(return_value=(True, "new_at"))

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = get_or_fetch_likely_valid_tokens_sync(store, refresh_fn)

        assert rt == "rt_1"
        assert at == "new_at"
        refresh_fn.assert_called_once_with("rt_1")

    def test_refreshes_when_old_iat(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        old_token = _make_old_token(now)
        store.compare_and_set(None, "rt_1", old_token)  # type: ignore[arg-type]
        refresh_fn = MagicMock(return_value=(True, "new_at"))

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = get_or_fetch_likely_valid_tokens_sync(store, refresh_fn)

        assert rt == "rt_1"
        assert at == "new_at"
        refresh_fn.assert_called_once_with("rt_1")

    def test_clears_tokens_on_invalid_refresh(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        expiring_token = _make_expiring_soon_token(now)
        store.compare_and_set(None, "rt_1", expiring_token)  # type: ignore[arg-type]
        refresh_fn = MagicMock(return_value=(False, None))

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = get_or_fetch_likely_valid_tokens_sync(store, refresh_fn)

        assert rt is None
        assert at is None
        # Store should be cleared
        assert store.get_stored_refresh_token() is None
        assert store.get_stored_access_token() is None

    def test_returns_access_without_refresh_when_not_expired(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        fresh_token = _make_fresh_token(now)
        # Set access token but no refresh token
        store._access_token = fresh_token
        refresh_fn = MagicMock()

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = get_or_fetch_likely_valid_tokens_sync(store, refresh_fn)

        assert rt is None
        assert at == fresh_token
        refresh_fn.assert_not_called()

    def test_returns_none_none_when_no_refresh_and_expired(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        expired_token = _make_expired_token(now)
        store._access_token = expired_token
        refresh_fn = MagicMock()

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = get_or_fetch_likely_valid_tokens_sync(store, refresh_fn)

        assert rt is None
        assert at is None
        refresh_fn.assert_not_called()


# ---------------------------------------------------------------------------
# CAS Refresh: Async
# ---------------------------------------------------------------------------

class TestCASRefreshAsync:
    async def test_async_returns_fresh_access_token(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        fresh_token = _make_fresh_token(now)
        store.compare_and_set(None, "rt_1", fresh_token)  # type: ignore[arg-type]

        async def refresh_fn(rt: str) -> tuple[bool, str | None]:
            return (True, "new_at")

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = await get_or_fetch_likely_valid_tokens_async(store, refresh_fn)

        assert rt == "rt_1"
        assert at == fresh_token

    async def test_async_refreshes_when_needed(self) -> None:
        now = time.time()
        store = MemoryTokenStore()
        expiring_token = _make_expiring_soon_token(now)
        store.compare_and_set(None, "rt_1", expiring_token)  # type: ignore[arg-type]
        called = False

        async def refresh_fn(rt: str) -> tuple[bool, str | None]:
            nonlocal called
            called = True
            return (True, "new_at")

        with patch("stack_auth._token_store.time") as mock_time:
            mock_time.time.return_value = now
            rt, at = await get_or_fetch_likely_valid_tokens_async(store, refresh_fn)

        assert rt == "rt_1"
        assert at == "new_at"
        assert called

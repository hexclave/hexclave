"""Token store subsystem: ABC, concrete implementations, registry, and CAS refresh algorithm.

This module implements the token store interface from the SDK spec (_utilities.spec.md):
- TokenStore ABC with three abstract methods
- MemoryTokenStore, ExplicitTokenStore, RequestTokenStore concrete implementations
- Module-level registry for shared MemoryTokenStore instances per project_id
- CAS-based get_or_fetch_likely_valid_tokens algorithm with dual locks
- Token refresh helper using OAuth2 form-encoded endpoint
"""

from __future__ import annotations

import asyncio
import base64
import json
import threading
import time
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

import logging

import httpx

from stack_auth._types import RequestLike

logger = logging.getLogger("stack_auth")


# ---------------------------------------------------------------------------
# TokenStore ABC
# ---------------------------------------------------------------------------

class TokenStore(ABC):
    """Abstract base class for token storage backends.

    Each instance carries its own sync and async locks for CAS refresh.
    """

    def __init__(self) -> None:
        """Initialize the token store with sync and async CAS locks."""
        self._sync_lock = threading.Lock()
        self._async_lock = asyncio.Lock()

    @abstractmethod
    def get_stored_access_token(self) -> str | None:
        """Return the stored access token, or None if not set."""
        ...

    @abstractmethod
    def get_stored_refresh_token(self) -> str | None:
        """Return the stored refresh token, or None if not set."""
        ...

    @abstractmethod
    def compare_and_set(
        self,
        compare_refresh_token: str | None,
        new_refresh_token: str | None,
        new_access_token: str | None,
    ) -> None:
        """Atomically update tokens if the current refresh token matches compare_refresh_token."""
        ...


# ---------------------------------------------------------------------------
# MemoryTokenStore
# ---------------------------------------------------------------------------

class MemoryTokenStore(TokenStore):
    """In-memory token store. Shared per project_id via the module registry."""

    def __init__(self) -> None:
        """Initialize with empty access and refresh tokens."""
        super().__init__()
        self._access_token: str | None = None
        self._refresh_token: str | None = None

    def get_stored_access_token(self) -> str | None:
        """Return the stored access token, or None if not set."""
        return self._access_token

    def get_stored_refresh_token(self) -> str | None:
        """Return the stored refresh token, or None if not set."""
        return self._refresh_token

    def compare_and_set(
        self,
        compare_refresh_token: str | None,
        new_refresh_token: str | None,
        new_access_token: str | None,
    ) -> None:
        """Atomically update tokens if the current refresh token matches."""
        if self._refresh_token == compare_refresh_token:
            self._refresh_token = new_refresh_token
            self._access_token = new_access_token


# ---------------------------------------------------------------------------
# ExplicitTokenStore
# ---------------------------------------------------------------------------

class ExplicitTokenStore(TokenStore):
    """Token store initialized from explicit access_token and refresh_token values.

    Supports CAS update to in-memory state to prevent infinite refresh loops.
    """

    def __init__(self, access_token: str | None = None, refresh_token: str | None = None) -> None:
        """Initialize with explicit token values.

        Args:
            access_token: Initial access token, or None.
            refresh_token: Initial refresh token, or None.
        """
        super().__init__()
        self._access_token: str | None = access_token
        self._refresh_token: str | None = refresh_token

    def get_stored_access_token(self) -> str | None:
        """Return the stored access token, or None if not set."""
        return self._access_token

    def get_stored_refresh_token(self) -> str | None:
        """Return the stored refresh token, or None if not set."""
        return self._refresh_token

    def compare_and_set(
        self,
        compare_refresh_token: str | None,
        new_refresh_token: str | None,
        new_access_token: str | None,
    ) -> None:
        """Atomically update tokens if the current refresh token matches."""
        if self._refresh_token == compare_refresh_token:
            self._refresh_token = new_refresh_token
            self._access_token = new_access_token


# ---------------------------------------------------------------------------
# RequestTokenStore
# ---------------------------------------------------------------------------

class RequestTokenStore(TokenStore):
    """Token store that extracts tokens from a request's x-stack-auth JSON header.

    Supports CAS update to in-memory state for refreshed tokens.
    """

    def __init__(self, request: RequestLike) -> None:
        """Initialize by extracting tokens from the request's x-stack-auth header.

        Args:
            request: A request-like object whose headers may contain x-stack-auth.
        """
        super().__init__()
        self._access_token: str | None = None
        self._refresh_token: str | None = None
        header_value = request.headers.get("x-stack-auth")
        if header_value:
            try:
                data = json.loads(header_value)
                self._access_token = data.get("accessToken")
                self._refresh_token = data.get("refreshToken")
            except (json.JSONDecodeError, AttributeError):
                pass

    def get_stored_access_token(self) -> str | None:
        """Return the stored access token, or None if not set."""
        return self._access_token

    def get_stored_refresh_token(self) -> str | None:
        """Return the stored refresh token, or None if not set."""
        return self._refresh_token

    def compare_and_set(
        self,
        compare_refresh_token: str | None,
        new_refresh_token: str | None,
        new_access_token: str | None,
    ) -> None:
        """Atomically update tokens if the current refresh token matches."""
        if self._refresh_token == compare_refresh_token:
            self._refresh_token = new_refresh_token
            self._access_token = new_access_token


# ---------------------------------------------------------------------------
# Registry: shared MemoryTokenStore per project_id
# ---------------------------------------------------------------------------

_token_store_registry: dict[str, MemoryTokenStore] = {}
"""Module-level registry mapping project_id to shared MemoryTokenStore instances.

Per SDK spec (Token Store Registry): all uses of "memory" with the same project_id
must share the same underlying token store instance and refresh lock. This dict
ensures that invariant.

To reset in tests: ``stack_auth._token_store._token_store_registry.clear()``
"""

_registry_lock = threading.Lock()
"""Guards _token_store_registry against concurrent check-then-set races."""


def _get_or_create_memory_store(project_id: str) -> MemoryTokenStore:
    """Return the shared MemoryTokenStore for a project, creating one if needed.

    Thread-safe: uses _registry_lock to prevent two threads from creating
    duplicate stores for the same project_id.
    """
    with _registry_lock:
        if project_id not in _token_store_registry:
            _token_store_registry[project_id] = MemoryTokenStore()
        return _token_store_registry[project_id]


# ---------------------------------------------------------------------------
# TokenStoreInit type and resolver
# ---------------------------------------------------------------------------

TokenStoreInit = Literal["memory"] | dict | RequestLike | None


def resolve_token_store(init: TokenStoreInit, project_id: str) -> TokenStore | None:
    """Resolve a TokenStoreInit value to a concrete TokenStore instance.

    - "memory" -> shared MemoryTokenStore per project_id
    - dict -> ExplicitTokenStore from access_token/refresh_token keys
    - RequestLike -> RequestTokenStore from x-stack-auth header
    - None -> None
    """
    if init is None:
        return None
    if init == "memory":
        return _get_or_create_memory_store(project_id)
    if isinstance(init, dict):
        return ExplicitTokenStore(
            access_token=init.get("access_token"),
            refresh_token=init.get("refresh_token"),
        )
    if isinstance(init, RequestLike):
        return RequestTokenStore(init)
    raise TypeError(f"Invalid token store initializer: {type(init)}")


# ---------------------------------------------------------------------------
# JWT helpers (no verification)
# ---------------------------------------------------------------------------

def _decode_jwt_payload(token: str) -> dict[str, Any] | None:
    """Base64url decode the JWT payload segment without signature verification.

    Returns the claims dict, or None if the token is malformed.
    """
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None
        payload_b64 = parts[1]
        # Add padding
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        return json.loads(payload_bytes)  # type: ignore[no-any-return]
    except (ValueError, json.JSONDecodeError):
        return None


def _is_expired(token: str) -> bool:
    """Check if the JWT's exp claim is in the past."""
    claims = _decode_jwt_payload(token)
    if claims is None or "exp" not in claims:
        return True
    return claims["exp"] <= time.time()


def _is_fresh_enough(token: str | None) -> bool:
    """Check if token expires in >20s AND was issued <75s ago.

    Returns False for None tokens or tokens with missing exp/iat claims.
    All calculations in seconds (not milliseconds).
    """
    if token is None:
        return False
    claims = _decode_jwt_payload(token)
    if claims is None:
        return False
    exp = claims.get("exp")
    iat = claims.get("iat")
    if exp is None or iat is None:
        return False
    now = time.time()
    return (exp - now) > 20 and (now - iat) < 75


# ---------------------------------------------------------------------------
# CAS refresh algorithm
# ---------------------------------------------------------------------------

def get_or_fetch_likely_valid_tokens_sync(
    store: TokenStore,
    refresh_fn: Callable[[str], tuple[bool, str | None]],
) -> tuple[str | None, str | None]:
    """CAS-based token refresh (sync version).

    Returns (refresh_token, access_token) tuple.

    Algorithm per SDK spec:
    1. If no refresh_token: return (None, access_token) if not expired, else (None, None)
    2. If access_token is fresh enough: return (refresh, access)
    3. Otherwise: call refresh_fn, CAS-update store
    """
    with store._sync_lock:
        original_refresh = store.get_stored_refresh_token()
        original_access = store.get_stored_access_token()

        if original_refresh is None:
            if original_access is not None and not _is_expired(original_access):
                return (None, original_access)
            return (None, None)

        if _is_fresh_enough(original_access):
            return (original_refresh, original_access)

        # Need to refresh
        was_valid, new_access = refresh_fn(original_refresh)
        if was_valid and new_access is not None:
            store.compare_and_set(original_refresh, original_refresh, new_access)
            return (original_refresh, new_access)
        else:
            store.compare_and_set(original_refresh, None, None)
            return (None, None)


async def get_or_fetch_likely_valid_tokens_async(
    store: TokenStore,
    refresh_fn: Callable[[str], Awaitable[tuple[bool, str | None]]],
) -> tuple[str | None, str | None]:
    """CAS-based token refresh (async version).

    Returns (refresh_token, access_token) tuple. Same algorithm as sync variant.
    """
    async with store._async_lock:
        original_refresh = store.get_stored_refresh_token()
        original_access = store.get_stored_access_token()

        if original_refresh is None:
            if original_access is not None and not _is_expired(original_access):
                return (None, original_access)
            return (None, None)

        if _is_fresh_enough(original_access):
            return (original_refresh, original_access)

        # Need to refresh
        was_valid, new_access = await refresh_fn(original_refresh)
        if was_valid and new_access is not None:
            store.compare_and_set(original_refresh, original_refresh, new_access)
            return (original_refresh, new_access)
        else:
            store.compare_and_set(original_refresh, None, None)
            return (None, None)


# ---------------------------------------------------------------------------
# Token refresh helpers (sync + async)
# ---------------------------------------------------------------------------

def _refresh_access_token_sync(
    http_client: httpx.Client,
    base_url: str,
    project_id: str,
    refresh_token: str,
) -> tuple[bool, str | None]:
    """Refresh an access token via the OAuth2 token endpoint (sync).

    POST form-encoded body to {base_url}/api/v1/auth/oauth/token.
    Returns (was_valid, new_access_token).
    """
    url = f"{base_url}/api/v1/auth/oauth/token"
    try:
        resp = http_client.post(
            url,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": project_id,
                "client_secret": "__stack_public_client__",
            },
        )
        if resp.status_code == 200:
            data = resp.json()
            if not isinstance(data, dict):
                return (False, None)
            access_token = data.get("access_token")
            if not access_token:
                return (False, None)
            return (True, access_token)
        return (False, None)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        logger.debug("Token refresh failed (sync)", exc_info=exc)
        return (False, None)


async def _refresh_access_token_async(
    http_client: httpx.AsyncClient,
    base_url: str,
    project_id: str,
    refresh_token: str,
) -> tuple[bool, str | None]:
    """Refresh an access token via the OAuth2 token endpoint (async).

    POST form-encoded body to {base_url}/api/v1/auth/oauth/token.
    Returns (was_valid, new_access_token).
    """
    url = f"{base_url}/api/v1/auth/oauth/token"
    try:
        resp = await http_client.post(
            url,
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": project_id,
                "client_secret": "__stack_public_client__",
            },
        )
        if resp.status_code == 200:
            data = resp.json()
            if not isinstance(data, dict):
                return (False, None)
            access_token = data.get("access_token")
            if not access_token:
                return (False, None)
            return (True, access_token)
        return (False, None)
    except (httpx.HTTPError, ValueError, KeyError) as exc:
        logger.debug("Token refresh failed (async)", exc_info=exc)
        return (False, None)

"""Authentication module for Stack Auth.

Provides AuthState and TokenPartialUser dataclasses, decode_access_token_claims()
for unverified JWT payload extraction, and sync/async authenticate_request()
functions that compose with the JWT verifier from _jwt.py.
"""

from __future__ import annotations

import base64
import json
import logging
from dataclasses import dataclass
from typing import Any, Literal, Mapping

import httpx
import jwt

logger = logging.getLogger("stack_auth")

from stack_auth._jwt import (
    AsyncJWKSFetcher,
    SyncJWKSFetcher,
    async_verify_token,
    sync_verify_token,
)
from stack_auth._types import RequestLike


@dataclass(frozen=True, slots=True)
class TokenPartialUser:
    """Partial user information extracted from a JWT payload without verification.

    This is a lightweight representation suitable for quick user identification
    when full token verification is not required (e.g., logging, routing).
    """

    id: str
    display_name: str | None
    primary_email: str | None
    primary_email_verified: bool
    is_anonymous: bool
    is_multi_factor_required: bool
    is_restricted: bool
    restricted_reason: dict[str, Any] | None


@dataclass(frozen=True, slots=True)
class AuthState:
    """Result of authenticating an incoming request.

    Attributes:
        status: Either ``"authenticated"`` or ``"unauthenticated"``.
        user_id: The user's ID from the ``sub`` claim, or ``None``.
        claims: Full decoded JWT claims, or ``None``.
        token: The raw JWT string, or ``None``.
    """

    status: Literal["authenticated", "unauthenticated"]
    user_id: str | None = None
    claims: dict[str, Any] | None = None
    token: str | None = None


def decode_access_token_claims(token: str) -> TokenPartialUser | None:
    """Extract partial user info from a JWT without verifying its signature.

    This performs a base64url decode of the payload segment only.
    It does NOT verify the token's signature, expiry, or issuer.

    Args:
        token: The encoded JWT string.

    Returns:
        A ``TokenPartialUser`` if the payload contains at least a ``sub`` claim,
        or ``None`` if the token is malformed or missing required fields.
    """
    try:
        parts = token.split(".")
        if len(parts) < 2:
            return None

        payload_b64 = parts[1]
        # Add padding for base64url decoding
        payload_b64 += "=" * (-len(payload_b64) % 4)
        payload_bytes = base64.urlsafe_b64decode(payload_b64)
        data = json.loads(payload_bytes)

        user_id: str = data["sub"]

        return TokenPartialUser(
            id=user_id,
            display_name=data.get("name"),
            primary_email=data.get("email"),
            primary_email_verified=data.get("email_verified", False),
            is_anonymous=data.get("is_anonymous", False),
            is_multi_factor_required=data.get("is_multi_factor_required", False),
            is_restricted=data.get("is_restricted", False),
            restricted_reason=data.get("restricted_reason"),
        )
    except (ValueError, KeyError, json.JSONDecodeError):
        return None


def _extract_token_from_headers(headers: Mapping[str, str]) -> str | None:
    """Extract a bearer token from request headers.

    Checks the ``Authorization`` header first (case-insensitive),
    then falls back to the ``x-stack-auth`` JSON header's ``accessToken`` field.

    Args:
        headers: A mapping of header names to values.

    Returns:
        The extracted token string, or ``None`` if no valid token is found.
    """
    # Check Authorization header (both cases for case-sensitive mappings)
    auth_value = headers.get("Authorization") or headers.get("authorization")
    if auth_value and auth_value.startswith("Bearer "):
        return auth_value[len("Bearer "):]

    # Fallback to x-stack-auth JSON header
    stack_auth_value = headers.get("x-stack-auth")
    if stack_auth_value:
        try:
            data = json.loads(stack_auth_value)
            access_token = data.get("accessToken")
            if access_token:
                return access_token  # type: ignore[no-any-return]
        except (json.JSONDecodeError, AttributeError):
            pass

    return None


def sync_authenticate_request(
    request: RequestLike,
    *,
    fetcher: SyncJWKSFetcher,
) -> AuthState:
    """Authenticate an incoming request using its JWT token (synchronous).

    Extracts the token from request headers and verifies it using the
    provided JWKS fetcher. Returns an ``AuthState`` indicating whether
    the request is authenticated.

    Args:
        request: An object conforming to the ``RequestLike`` protocol.
        fetcher: A ``SyncJWKSFetcher`` for retrieving signing keys.

    Returns:
        An ``AuthState`` with status ``"authenticated"`` on success,
        or ``"unauthenticated"`` if no token is present or verification fails.
    """
    token = _extract_token_from_headers(request.headers)
    if token is None:
        return AuthState(status="unauthenticated")

    try:
        claims = sync_verify_token(token, fetcher)
        return AuthState(
            status="authenticated",
            user_id=claims.get("sub"),
            claims=claims,
            token=token,
        )
    except (jwt.PyJWTError, httpx.HTTPError, ValueError, KeyError) as exc:
        logger.debug("authenticate_request failed", exc_info=exc)
        return AuthState(status="unauthenticated")


async def async_authenticate_request(
    request: RequestLike,
    *,
    fetcher: AsyncJWKSFetcher,
) -> AuthState:
    """Authenticate an incoming request using its JWT token (asynchronous).

    Extracts the token from request headers and verifies it using the
    provided JWKS fetcher. Returns an ``AuthState`` indicating whether
    the request is authenticated.

    Args:
        request: An object conforming to the ``RequestLike`` protocol.
        fetcher: An ``AsyncJWKSFetcher`` for retrieving signing keys.

    Returns:
        An ``AuthState`` with status ``"authenticated"`` on success,
        or ``"unauthenticated"`` if no token is present or verification fails.
    """
    token = _extract_token_from_headers(request.headers)
    if token is None:
        return AuthState(status="unauthenticated")

    try:
        claims = await async_verify_token(token, fetcher)
        return AuthState(
            status="authenticated",
            user_id=claims.get("sub"),
            claims=claims,
            token=token,
        )
    except (jwt.PyJWTError, httpx.HTTPError, ValueError, KeyError) as exc:
        logger.debug("authenticate_request failed", exc_info=exc)
        return AuthState(status="unauthenticated")

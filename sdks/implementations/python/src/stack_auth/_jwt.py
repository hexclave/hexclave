"""JWT verification and JWKS fetching for Stack Auth.

Provides async and sync JWKS fetchers with in-memory TTL caching,
plus RS256 JWT verification functions. Algorithm is hardcoded to RS256
to prevent CVE-2022-29217 style algorithm confusion attacks.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

ALLOWED_ALGORITHMS: list[str] = ["RS256"]
"""Hardcoded algorithm list. NEVER read algorithm from token header (CVE-2022-29217)."""

JWKS_CACHE_TTL: float = 300.0
"""Cache JWKS keys for 5 minutes before re-fetching."""


class AsyncJWKSFetcher:
    """Fetches JWKS from a remote endpoint with in-memory TTL caching (async).

    Args:
        jwks_url: The URL of the JWKS endpoint.
        http_client: An ``httpx.AsyncClient`` instance for making HTTP requests.
    """

    def __init__(self, jwks_url: str, http_client: httpx.AsyncClient) -> None:
        """Initialize the async JWKS fetcher.

        Args:
            jwks_url: The URL of the JWKS endpoint.
            http_client: An httpx.AsyncClient for making HTTP requests.
        """
        self._jwks_url = jwks_url
        self._http_client = http_client
        self._cache: dict[str, Any] | None = None
        self._cache_time: float = 0.0
        self._fetch_lock = asyncio.Lock()

    async def get_signing_key(self, kid: str) -> Any:
        """Return the RSA public key for the given key ID.

        If the key is not in the current JWKS, one forced refresh is attempted.
        Raises ``ValueError`` if the key is still not found after refresh.
        """
        jwks = await self._fetch_jwks()
        key_data = _find_key(jwks, kid)

        if key_data is None:
            # Force-refresh once for potential key rotation
            jwks = await self._fetch_jwks(force=True)
            key_data = _find_key(jwks, kid)

        if key_data is None:
            raise ValueError(f"Signing key '{kid}' not found in JWKS")

        return RSAAlgorithm.from_jwk(key_data)

    async def _fetch_jwks(self, force: bool = False) -> dict[str, Any]:
        """Fetch JWKS from the endpoint, using cache if fresh.

        Uses an asyncio.Lock to deduplicate concurrent fetches so only one
        HTTP request is made when multiple coroutines hit a cold or expired cache.
        """
        async with self._fetch_lock:
            now = time.monotonic()
            if not force and self._cache is not None and (now - self._cache_time) < JWKS_CACHE_TTL:
                return self._cache

            response = await self._http_client.get(self._jwks_url)
            response.raise_for_status()
            self._cache = response.json()
            self._cache_time = time.monotonic()
            return self._cache  # type: ignore[return-value]


class SyncJWKSFetcher:
    """Fetches JWKS from a remote endpoint with in-memory TTL caching (sync).

    Args:
        jwks_url: The URL of the JWKS endpoint.
        http_client: An ``httpx.Client`` instance for making HTTP requests.
    """

    def __init__(self, jwks_url: str, http_client: httpx.Client) -> None:
        """Initialize the sync JWKS fetcher.

        Args:
            jwks_url: The URL of the JWKS endpoint.
            http_client: An httpx.Client for making HTTP requests.
        """
        self._jwks_url = jwks_url
        self._http_client = http_client
        self._cache: dict[str, Any] | None = None
        self._cache_time: float = 0.0
        self._fetch_lock = threading.Lock()

    def get_signing_key(self, kid: str) -> Any:
        """Return the RSA public key for the given key ID.

        If the key is not in the current JWKS, one forced refresh is attempted.
        Raises ``ValueError`` if the key is still not found after refresh.
        """
        jwks = self._fetch_jwks()
        key_data = _find_key(jwks, kid)

        if key_data is None:
            jwks = self._fetch_jwks(force=True)
            key_data = _find_key(jwks, kid)

        if key_data is None:
            raise ValueError(f"Signing key '{kid}' not found in JWKS")

        return RSAAlgorithm.from_jwk(key_data)

    def _fetch_jwks(self, force: bool = False) -> dict[str, Any]:
        """Fetch JWKS from the endpoint, using cache if fresh.

        Uses a threading.Lock to deduplicate concurrent fetches so only one
        HTTP request is made when multiple threads hit a cold or expired cache.
        """
        with self._fetch_lock:
            now = time.monotonic()
            if not force and self._cache is not None and (now - self._cache_time) < JWKS_CACHE_TTL:
                return self._cache

            response = self._http_client.get(self._jwks_url)
            response.raise_for_status()
            self._cache = response.json()
            self._cache_time = time.monotonic()
            return self._cache  # type: ignore[return-value]


def _find_key(jwks: dict[str, Any], kid: str) -> dict[str, Any] | None:
    """Find a key by kid in a JWKS key set."""
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            return key  # type: ignore[no-any-return]
    return None


async def async_verify_token(
    token: str,
    fetcher: AsyncJWKSFetcher,
    *,
    audience: str | None = None,
    issuer: str | None = None,
) -> dict[str, Any]:
    """Verify an RS256 JWT and return decoded claims.

    Algorithm is hardcoded to RS256 -- the ``alg`` field in the token header
    is never trusted (CVE-2022-29217 protection).

    Args:
        token: The encoded JWT string.
        fetcher: An ``AsyncJWKSFetcher`` to retrieve signing keys.
        audience: Optional expected audience claim.
        issuer: Optional expected issuer claim.

    Returns:
        Decoded claims dictionary.

    Raises:
        ValueError: If the JWT header is missing a ``kid`` claim.
        jwt.ExpiredSignatureError: If the token has expired.
        jwt.InvalidSignatureError: If signature verification fails.
        jwt.InvalidAlgorithmError: If the token uses a non-RS256 algorithm.
    """
    unverified_header = jwt.get_unverified_header(token)
    kid = unverified_header.get("kid")
    if kid is None:
        raise ValueError("JWT header missing 'kid' claim")

    key = await fetcher.get_signing_key(kid)

    kwargs: dict[str, Any] = {}
    options: dict[str, bool] = {"verify_exp": True}
    if audience is not None:
        kwargs["audience"] = audience
    else:
        options["verify_aud"] = False
    if issuer is not None:
        kwargs["issuer"] = issuer
    else:
        options["verify_iss"] = False

    return jwt.decode(  # type: ignore[no-any-return]
        token,
        key,
        algorithms=ALLOWED_ALGORITHMS,
        options=options,
        **kwargs,
    )


def sync_verify_token(
    token: str,
    fetcher: SyncJWKSFetcher,
    *,
    audience: str | None = None,
    issuer: str | None = None,
) -> dict[str, Any]:
    """Verify an RS256 JWT and return decoded claims (synchronous version).

    Algorithm is hardcoded to RS256 -- the ``alg`` field in the token header
    is never trusted (CVE-2022-29217 protection).

    Args:
        token: The encoded JWT string.
        fetcher: A ``SyncJWKSFetcher`` to retrieve signing keys.
        audience: Optional expected audience claim.
        issuer: Optional expected issuer claim.

    Returns:
        Decoded claims dictionary.

    Raises:
        ValueError: If the JWT header is missing a ``kid`` claim.
        jwt.ExpiredSignatureError: If the token has expired.
        jwt.InvalidSignatureError: If signature verification fails.
        jwt.InvalidAlgorithmError: If the token uses a non-RS256 algorithm.
    """
    unverified_header = jwt.get_unverified_header(token)
    kid = unverified_header.get("kid")
    if kid is None:
        raise ValueError("JWT header missing 'kid' claim")

    key = fetcher.get_signing_key(kid)

    kwargs: dict[str, Any] = {}
    options: dict[str, bool] = {"verify_exp": True}
    if audience is not None:
        kwargs["audience"] = audience
    else:
        options["verify_aud"] = False
    if issuer is not None:
        kwargs["issuer"] = issuer
    else:
        options["verify_iss"] = False

    return jwt.decode(  # type: ignore[no-any-return]
        token,
        key,
        algorithms=ALLOWED_ALGORITHMS,
        options=options,
        **kwargs,
    )

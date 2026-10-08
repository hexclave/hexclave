"""Tests for JWT verification and JWKS fetching."""

from __future__ import annotations

import time
from typing import Any
from unittest.mock import patch

import httpx
import jwt as pyjwt
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)
from jwt.algorithms import RSAAlgorithm

from stack_auth._jwt import (
    ALLOWED_ALGORITHMS,
    JWKS_CACHE_TTL,
    AsyncJWKSFetcher,
    SyncJWKSFetcher,
    async_verify_token,
    sync_verify_token,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

JWKS_URL = "https://api.stack-auth.com/api/v1/projects/test-project/.well-known/jwks.json"
KID = "test-key-1"


@pytest.fixture()
def rsa_keypair() -> tuple[rsa.RSAPrivateKey, rsa.RSAPublicKey]:
    """Generate an RSA keypair for testing."""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key, private_key.public_key()


@pytest.fixture()
def jwks_response(rsa_keypair: tuple[rsa.RSAPrivateKey, rsa.RSAPublicKey]) -> dict[str, Any]:
    """Build a JWKS JSON response from the test keypair."""
    _, public_key = rsa_keypair
    jwk_dict = RSAAlgorithm.to_jwk(public_key, as_dict=True)
    jwk_dict["kid"] = KID
    jwk_dict["use"] = "sig"
    jwk_dict["alg"] = "RS256"
    return {"keys": [jwk_dict]}


@pytest.fixture()
def private_key_pem(rsa_keypair: tuple[rsa.RSAPrivateKey, rsa.RSAPublicKey]) -> bytes:
    """PEM-encoded private key for signing test tokens."""
    private_key, _ = rsa_keypair
    return private_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())


def _make_token(
    private_key_pem: bytes,
    kid: str = KID,
    exp: int | None = None,
    algorithm: str = "RS256",
    include_kid: bool = True,
) -> str:
    """Create a signed JWT for testing."""
    payload: dict[str, Any] = {"sub": "user-123", "iss": "stack-auth"}
    if exp is not None:
        payload["exp"] = exp
    else:
        payload["exp"] = int(time.time()) + 3600  # 1 hour from now

    headers: dict[str, Any] = {}
    if include_kid:
        headers["kid"] = kid

    return pyjwt.encode(payload, private_key_pem, algorithm=algorithm, headers=headers)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------


def test_allowed_algorithms_is_rs256_only() -> None:
    assert ALLOWED_ALGORITHMS == ["RS256"]


def test_cache_ttl_is_300_seconds() -> None:
    assert JWKS_CACHE_TTL == 300.0


# ---------------------------------------------------------------------------
# AsyncJWKSFetcher
# ---------------------------------------------------------------------------


class TestAsyncJWKSFetcher:
    """Tests for the async JWKS fetcher."""

    async def test_construction(self) -> None:
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            assert fetcher is not None

    @respx.mock
    async def test_get_signing_key_fetches_and_returns_rsa_key(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            key = await fetcher.get_signing_key(KID)
            assert key is not None

    @respx.mock
    async def test_get_signing_key_caches_within_ttl(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        route = respx.get(JWKS_URL).respond(json=jwks_response)
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            await fetcher.get_signing_key(KID)
            await fetcher.get_signing_key(KID)
            assert route.call_count == 1

    @respx.mock
    async def test_get_signing_key_refetches_after_ttl(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        route = respx.get(JWKS_URL).respond(json=jwks_response)
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)

            with patch("stack_auth._jwt.time.monotonic", return_value=1000.0):
                await fetcher.get_signing_key(KID)

            # Advance 301 seconds past TTL
            with patch("stack_auth._jwt.time.monotonic", return_value=1301.0):
                await fetcher.get_signing_key(KID)

            assert route.call_count == 2

    @respx.mock
    async def test_unknown_kid_force_refreshes_then_raises(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        route = respx.get(JWKS_URL).respond(json=jwks_response)
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            # Pre-populate cache
            await fetcher.get_signing_key(KID)
            assert route.call_count == 1

            with pytest.raises(ValueError, match="not found in JWKS"):
                await fetcher.get_signing_key("unknown-kid")

            # Should have force-refreshed once before raising
            assert route.call_count == 2


# ---------------------------------------------------------------------------
# SyncJWKSFetcher
# ---------------------------------------------------------------------------


class TestSyncJWKSFetcher:
    """Tests for the sync JWKS fetcher."""

    def test_construction(self) -> None:
        with httpx.Client() as client:
            fetcher = SyncJWKSFetcher(JWKS_URL, client)
            assert fetcher is not None

    @respx.mock
    def test_get_signing_key_fetches_and_returns_rsa_key(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        with httpx.Client() as client:
            fetcher = SyncJWKSFetcher(JWKS_URL, client)
            key = fetcher.get_signing_key(KID)
            assert key is not None

    @respx.mock
    def test_get_signing_key_caches_within_ttl(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        route = respx.get(JWKS_URL).respond(json=jwks_response)
        with httpx.Client() as client:
            fetcher = SyncJWKSFetcher(JWKS_URL, client)
            fetcher.get_signing_key(KID)
            fetcher.get_signing_key(KID)
            assert route.call_count == 1


# ---------------------------------------------------------------------------
# verify_token (async)
# ---------------------------------------------------------------------------


class TestAsyncVerifyToken:
    """Tests for async_verify_token."""

    @respx.mock
    async def test_valid_token_returns_claims(
        self,
        jwks_response: dict[str, Any],
        private_key_pem: bytes,
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        token = _make_token(private_key_pem)
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            claims = await async_verify_token(token, fetcher)
            assert claims["sub"] == "user-123"
            assert claims["iss"] == "stack-auth"

    @respx.mock
    async def test_expired_token_raises(
        self,
        jwks_response: dict[str, Any],
        private_key_pem: bytes,
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        token = _make_token(private_key_pem, exp=1)  # expired in 1970
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            with pytest.raises(pyjwt.ExpiredSignatureError):
                await async_verify_token(token, fetcher)

    @respx.mock
    async def test_invalid_signature_raises(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        # Sign with a DIFFERENT key
        other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        other_pem = other_key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption())
        token = _make_token(other_pem)
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            with pytest.raises(pyjwt.InvalidSignatureError):
                await async_verify_token(token, fetcher)

    @respx.mock
    async def test_missing_kid_raises(
        self,
        jwks_response: dict[str, Any],
        private_key_pem: bytes,
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        token = _make_token(private_key_pem, include_kid=False)
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            with pytest.raises(ValueError, match="missing 'kid'"):
                await async_verify_token(token, fetcher)

    @respx.mock
    async def test_hs256_token_rejected(
        self,
        jwks_response: dict[str, Any],
    ) -> None:
        """HS256-signed tokens must be rejected even if alg header says HS256 (CVE-2022-29217)."""
        respx.get(JWKS_URL).respond(json=jwks_response)
        # HS256 token signed with a symmetric key
        token = pyjwt.encode(
            {"sub": "user-123", "exp": int(time.time()) + 3600},
            "secret",
            algorithm="HS256",
            headers={"kid": KID},
        )
        async with httpx.AsyncClient() as client:
            fetcher = AsyncJWKSFetcher(JWKS_URL, client)
            with pytest.raises(pyjwt.InvalidAlgorithmError):
                await async_verify_token(token, fetcher)


# ---------------------------------------------------------------------------
# verify_token (sync)
# ---------------------------------------------------------------------------


class TestSyncVerifyToken:
    """Tests for sync_verify_token."""

    @respx.mock
    def test_valid_token_returns_claims(
        self,
        jwks_response: dict[str, Any],
        private_key_pem: bytes,
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        token = _make_token(private_key_pem)
        with httpx.Client() as client:
            fetcher = SyncJWKSFetcher(JWKS_URL, client)
            claims = sync_verify_token(token, fetcher)
            assert claims["sub"] == "user-123"

    @respx.mock
    def test_expired_token_raises(
        self,
        jwks_response: dict[str, Any],
        private_key_pem: bytes,
    ) -> None:
        respx.get(JWKS_URL).respond(json=jwks_response)
        token = _make_token(private_key_pem, exp=1)
        with httpx.Client() as client:
            fetcher = SyncJWKSFetcher(JWKS_URL, client)
            with pytest.raises(pyjwt.ExpiredSignatureError):
                sync_verify_token(token, fetcher)

"""Sync and async HTTP clients for the Stack Auth API.

Provides BaseAPIClient[T], SyncAPIClient, and AsyncAPIClient implementing the
full request pipeline: header construction, URL building, response processing
with x-stack-actual-status, error dispatch via x-stack-known-error, retry with
exponential backoff for idempotent methods, and rate limit handling.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Generic, TypeVar

import httpx

from stack_auth._constants import API_VERSION, DEFAULT_BASE_URL, SDK_NAME
from stack_auth._version import __version__
from stack_auth.errors import RateLimitError, StackAuthError

HttpxClientT = TypeVar("HttpxClientT", httpx.Client, httpx.AsyncClient)


class BaseAPIClient(Generic[HttpxClientT]):
    """Generic base class shared by sync and async clients.

    Handles header construction, URL building, response parsing, and retry
    policy.  Subclasses provide the concrete httpx transport.
    """

    IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})
    MAX_RETRIES = 5

    def __init__(
        self,
        *,
        base_url: str = DEFAULT_BASE_URL,
        project_id: str,
        secret_server_key: str,
        publishable_client_key: str | None = None,
    ) -> None:
        """Initialize the API client.

        Args:
            base_url: Stack Auth API base URL.
            project_id: The Stack Auth project identifier.
            secret_server_key: Server-side secret key for authentication.
            publishable_client_key: Optional publishable client key.
        """
        self._base_url = base_url.rstrip("/")
        self._project_id = project_id
        self._secret_server_key = secret_server_key
        self._publishable_client_key = publishable_client_key
        self._client: HttpxClientT | None = None

    # ------------------------------------------------------------------
    # Header / URL helpers
    # ------------------------------------------------------------------

    def _build_headers(self) -> dict[str, str]:
        """Build HTTP headers required for every Stack Auth API request."""
        headers = {
            "x-stack-project-id": self._project_id,
            "x-stack-access-type": "server",
            "x-stack-secret-server-key": self._secret_server_key,
            "x-stack-client-version": f"{SDK_NAME}@{__version__}",
            "x-stack-override-error-status": "true",
            "x-stack-random-nonce": str(uuid.uuid4()),
        }
        if self._publishable_client_key is not None:
            headers["x-stack-publishable-client-key"] = self._publishable_client_key
        return headers

    def _build_url(self, path: str) -> str:
        """Construct the full API URL for the given endpoint path."""
        return f"{self._base_url}/api/{API_VERSION}{path}"

    # ------------------------------------------------------------------
    # Response processing
    # ------------------------------------------------------------------

    def _parse_response(self, response: httpx.Response) -> tuple[int, dict[str, Any] | None]:
        """Parse an httpx response according to the Stack Auth protocol.

        Returns ``(actual_status, parsed_json)`` on success.
        Raises the appropriate :class:`StackAuthError` subclass on failure.
        """
        actual_status = self._get_actual_status(response)

        # Known-error dispatch
        known_error = response.headers.get("x-stack-known-error")
        if known_error:
            try:
                parsed = response.json()
                body = parsed if isinstance(parsed, dict) else {}
            except Exception:
                body = {}
            raise StackAuthError.from_response(
                code=known_error,
                message=body.get("message", "Unknown error"),
                details=body.get("details"),
            )

        # Success range
        if 200 <= actual_status < 300:
            if response.content:
                return actual_status, response.json()
            return actual_status, None

        # Rate limit (429 that exhausted retries)
        if actual_status == 429:
            raise RateLimitError(code="RATE_LIMIT_EXCEEDED", message="Rate limit exceeded after retries")

        # Unrecognised error
        raise StackAuthError(code="HTTP_ERROR", message=f"HTTP {actual_status}")

    # ------------------------------------------------------------------
    # Retry helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _get_actual_status(response: httpx.Response) -> int:
        """Extract the real HTTP status, preferring x-stack-actual-status header.

        Falls back to response.status_code if the header is absent or malformed.
        """
        header = response.headers.get("x-stack-actual-status")
        if header:
            try:
                return int(header)
            except ValueError:
                pass
        return response.status_code

    def _should_retry(self, method: str, attempt: int) -> bool:
        """Return True if the request method is idempotent and retries remain."""
        return method.upper() in self.IDEMPOTENT_METHODS and attempt < self.MAX_RETRIES

    @staticmethod
    def _get_retry_delay(attempt: int, response: httpx.Response | None = None) -> float:
        """Calculate retry delay using Retry-After header or exponential backoff."""
        if response is not None:
            actual_status = BaseAPIClient._get_actual_status(response)
            if actual_status == 429:
                retry_after = response.headers.get("Retry-After")
                if retry_after is not None:
                    try:
                        return float(retry_after)
                    except ValueError:
                        pass
        return 1.0 * (2 ** attempt)


class SyncAPIClient(BaseAPIClient[httpx.Client]):
    """Synchronous HTTP client using :class:`httpx.Client`."""

    def _get_client(self) -> httpx.Client:
        """Return the underlying httpx.Client, creating it lazily if needed."""
        if self._client is None:
            self._client = httpx.Client(timeout=httpx.Timeout(30.0))
        return self._client

    def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Send a synchronous HTTP request with retry and error handling.

        Args:
            method: HTTP method (GET, POST, PUT, PATCH, DELETE).
            path: API endpoint path (appended to the base URL).
            body: Optional JSON body for the request.
            params: Optional query parameters.

        Returns:
            Parsed JSON response dict, or None for empty responses.

        Raises:
            StackAuthError: On known API errors or non-2xx responses.
        """
        url = self._build_url(path)
        headers = self._build_headers()

        # POST/PUT/PATCH: always send a JSON body (default to {} if None)
        method_upper = method.upper()
        if method_upper in {"POST", "PUT", "PATCH"}:
            json_body = body if body is not None else {}
        else:
            json_body = body  # may be None → no body

        last_exc: BaseException | None = None
        for attempt in range(self.MAX_RETRIES + 1):
            try:
                resp = self._get_client().request(
                    method_upper,
                    url,
                    headers=headers,
                    json=json_body,
                    params=params,
                )

                # Check for 429 via x-stack-actual-status
                actual_status = self._get_actual_status(resp)

                # 429 retries apply to ALL methods (including POST/PATCH).
                # Unlike network errors, a 429 guarantees the server did NOT
                # process the request, so retrying is safe regardless of
                # idempotency. This matches the SDK spec and the behavior of
                # Stripe, Anthropic, and OpenAI SDKs.
                if actual_status == 429 and attempt < self.MAX_RETRIES:
                    delay = self._get_retry_delay(attempt, resp)
                    time.sleep(delay)
                    continue

                _status, data = self._parse_response(resp)
                return data

            except (httpx.HTTPError, httpx.TimeoutException) as exc:
                last_exc = exc
                if self._should_retry(method_upper, attempt):
                    delay = self._get_retry_delay(attempt, None)
                    time.sleep(delay)
                    continue
                raise

        # Exhausted retries
        if last_exc is not None:
            raise last_exc
        return None  # pragma: no cover

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def close(self) -> None:
        """Close the underlying HTTP client and release resources."""
        if self._client is not None:
            self._client.close()
            self._client = None

    def __enter__(self) -> SyncAPIClient:
        """Enter the context manager."""
        return self

    def __exit__(self, *_: Any) -> None:
        """Exit the context manager and close the client."""
        self.close()


class AsyncAPIClient(BaseAPIClient[httpx.AsyncClient]):
    """Asynchronous HTTP client using :class:`httpx.AsyncClient`."""

    def _get_client(self) -> httpx.AsyncClient:
        """Return the underlying httpx.AsyncClient, creating it lazily if needed."""
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
        return self._client

    async def request(
        self,
        method: str,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """Send an asynchronous HTTP request with retry and error handling.

        Args:
            method: HTTP method (GET, POST, PUT, PATCH, DELETE).
            path: API endpoint path (appended to the base URL).
            body: Optional JSON body for the request.
            params: Optional query parameters.

        Returns:
            Parsed JSON response dict, or None for empty responses.

        Raises:
            StackAuthError: On known API errors or non-2xx responses.
        """
        url = self._build_url(path)
        headers = self._build_headers()

        method_upper = method.upper()
        if method_upper in {"POST", "PUT", "PATCH"}:
            json_body = body if body is not None else {}
        else:
            json_body = body

        last_exc: BaseException | None = None
        for attempt in range(self.MAX_RETRIES + 1):
            try:
                resp = await self._get_client().request(
                    method_upper,
                    url,
                    headers=headers,
                    json=json_body,
                    params=params,
                )

                actual_status = self._get_actual_status(resp)

                # 429 retries apply to ALL methods (including POST/PATCH).
                # Unlike network errors, a 429 guarantees the server did NOT
                # process the request, so retrying is safe regardless of
                # idempotency. This matches the SDK spec and the behavior of
                # Stripe, Anthropic, and OpenAI SDKs.
                if actual_status == 429 and attempt < self.MAX_RETRIES:
                    delay = self._get_retry_delay(attempt, resp)
                    await asyncio.sleep(delay)
                    continue

                _status, data = self._parse_response(resp)
                return data

            except (httpx.HTTPError, httpx.TimeoutException) as exc:
                last_exc = exc
                if self._should_retry(method_upper, attempt):
                    delay = self._get_retry_delay(attempt, None)
                    await asyncio.sleep(delay)
                    continue
                raise

        if last_exc is not None:
            raise last_exc
        return None  # pragma: no cover

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def aclose(self) -> None:
        """Close the underlying async HTTP client and release resources."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> AsyncAPIClient:
        """Enter the async context manager."""
        return self

    async def __aexit__(self, *_: Any) -> None:
        """Exit the async context manager and close the client."""
        await self.aclose()

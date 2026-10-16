"""Data vault store classes for server-side key-value storage."""

from __future__ import annotations

from typing import Any

from stack_auth.errors import NotFoundError

# Only suppress key-not-found errors; store-not-found should propagate.
_KEY_NOT_FOUND_CODE = "DATA_VAULT_STORE_HASHED_KEY_DOES_NOT_EXIST"


def _is_key_not_found(err: NotFoundError) -> bool:
    """Return True if the error is specifically a missing key, not a missing store."""
    return getattr(err, "code", None) == _KEY_NOT_FOUND_CODE


class DataVaultStore:
    """Synchronous data vault store -- a server-side key-value store.

    Obtained via ``StackServerApp.get_data_vault_store(store_id)``.
    """

    def __init__(self, store_id: str, *, _client: Any) -> None:
        """Initialize a synchronous data vault store.

        Args:
            store_id: The data vault store identifier.
            _client: The internal HTTP client used for API requests.
        """
        self.id = store_id
        self._client = _client
        self._base_path = f"/data-vault/stores/{store_id}/items"

    def get(self, key: str) -> str | None:
        """Get the value for a key, or ``None`` if not found."""
        try:
            data = self._client.request("GET", f"{self._base_path}/{key}")
        except NotFoundError as err:
            if _is_key_not_found(err):
                return None
            raise
        if data is None:
            return None
        return data.get("value") if isinstance(data, dict) else data

    def set(self, key: str, value: str) -> None:
        """Set or update the value for a key."""
        self._client.request("PUT", f"{self._base_path}/{key}", body={"value": value})

    def delete(self, key: str) -> None:
        """Delete a key-value pair. No error if key doesn't exist."""
        try:
            self._client.request("DELETE", f"{self._base_path}/{key}")
        except NotFoundError as err:
            if _is_key_not_found(err):
                return
            raise

    def list_keys(self) -> list[str]:
        """Return all keys in the store."""
        data = self._client.request("GET", self._base_path)
        if data is None:
            return []
        # Response may be {"items": [...]} or a list directly
        if isinstance(data, dict):
            return data.get("items", [])
        return data


class AsyncDataVaultStore:
    """Asynchronous data vault store -- a server-side key-value store.

    Obtained via ``AsyncStackServerApp.get_data_vault_store(store_id)``.
    """

    def __init__(self, store_id: str, *, _client: Any) -> None:
        """Initialize an asynchronous data vault store.

        Args:
            store_id: The data vault store identifier.
            _client: The internal async HTTP client used for API requests.
        """
        self.id = store_id
        self._client = _client
        self._base_path = f"/data-vault/stores/{store_id}/items"

    async def get(self, key: str) -> str | None:
        """Get the value for a key, or ``None`` if not found."""
        try:
            data = await self._client.request("GET", f"{self._base_path}/{key}")
        except NotFoundError as err:
            if _is_key_not_found(err):
                return None
            raise
        if data is None:
            return None
        return data.get("value") if isinstance(data, dict) else data

    async def set(self, key: str, value: str) -> None:
        """Set or update the value for a key."""
        await self._client.request("PUT", f"{self._base_path}/{key}", body={"value": value})

    async def delete(self, key: str) -> None:
        """Delete a key-value pair. No error if key doesn't exist."""
        try:
            await self._client.request("DELETE", f"{self._base_path}/{key}")
        except NotFoundError as err:
            if _is_key_not_found(err):
                return
            raise

    async def list_keys(self) -> list[str]:
        """Return all keys in the store."""
        data = await self._client.request("GET", self._base_path)
        if data is None:
            return []
        # Response may be {"items": [...]} or a list directly
        if isinstance(data, dict):
            return data.get("items", [])
        return data

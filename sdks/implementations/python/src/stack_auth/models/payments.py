"""Payment models for Stack Auth."""

from __future__ import annotations

from typing import Any

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class Item(StackAuthModel):
    """A quantifiable item owned by a customer (user or team)."""

    display_name: str = Field(alias="displayName")
    quantity: int = 0
    non_negative_quantity: int = Field(0, alias="nonNegativeQuantity")


class Product(StackAuthModel):
    """A product associated with a customer."""

    id: str | None = None
    quantity: int = 0
    display_name: str = Field(alias="displayName")
    customer_type: str = Field(alias="customerType")
    is_server_only: bool = Field(False, alias="isServerOnly")
    stackable: bool = False
    type: str = "one_time"


class ServerItem:
    """Server-side item with methods to modify quantity.

    Wraps an :class:`Item` and provides ``increase_quantity``,
    ``decrease_quantity``, and ``try_decrease_quantity`` methods that
    communicate with the Stack Auth API via the HTTP client.
    """

    def __init__(
        self,
        item: Item,
        *,
        _client: Any,
        _customer_path: str,
        _item_id: str,
        _customer_id_field: str,
        _customer_id_value: str,
    ) -> None:
        """Initialize a server-side item from an Item model.

        Args:
            item: The underlying Item data model.
            _client: The internal HTTP client used for API requests.
            _customer_path: API path prefix for the customer.
            _item_id: The item identifier.
            _customer_id_field: Body field name for the customer ID.
            _customer_id_value: The customer ID value.
        """
        self.display_name = item.display_name
        self.quantity = item.quantity
        self.non_negative_quantity = item.non_negative_quantity
        self._client = _client
        self._customer_path = _customer_path
        self._item_id = _item_id
        self._customer_id_field = _customer_id_field
        self._customer_id_value = _customer_id_value

    def _quantity_body(self, quantity: int) -> dict[str, Any]:
        """Build the request body for a quantity change operation."""
        return {
            self._customer_id_field: self._customer_id_value,
            "item_id": self._item_id,
            "quantity": quantity,
        }

    def increase_quantity(self, amount: int) -> None:
        """Increase this item's quantity by *amount*."""
        self._client.request(
            "POST",
            "/internal/items/quantity-changes",
            body=self._quantity_body(amount),
        )

    def decrease_quantity(self, amount: int) -> None:
        """Decrease this item's quantity by *amount*."""
        self._client.request(
            "POST",
            "/internal/items/quantity-changes",
            body=self._quantity_body(-amount),
        )

    def try_decrease_quantity(self, amount: int) -> bool:
        """Try to decrease this item's quantity by *amount*.

        Returns ``True`` if the decrease succeeded, ``False`` otherwise.
        """
        data = self._client.request(
            "POST",
            "/internal/items/try-decrease",
            body={
                self._customer_id_field: self._customer_id_value,
                "item_id": self._item_id,
                "amount": amount,
            },
        )
        return bool(data.get("success", False)) if data else False


class AsyncServerItem:
    """Async server-side item with methods to modify quantity.

    Async counterpart of :class:`ServerItem`.
    """

    def __init__(
        self,
        item: Item,
        *,
        _client: Any,
        _customer_path: str,
        _item_id: str,
        _customer_id_field: str,
        _customer_id_value: str,
    ) -> None:
        """Initialize an async server-side item from an Item model.

        Args:
            item: The underlying Item data model.
            _client: The internal async HTTP client used for API requests.
            _customer_path: API path prefix for the customer.
            _item_id: The item identifier.
            _customer_id_field: Body field name for the customer ID.
            _customer_id_value: The customer ID value.
        """
        self.display_name = item.display_name
        self.quantity = item.quantity
        self.non_negative_quantity = item.non_negative_quantity
        self._client = _client
        self._customer_path = _customer_path
        self._item_id = _item_id
        self._customer_id_field = _customer_id_field
        self._customer_id_value = _customer_id_value

    def _quantity_body(self, quantity: int) -> dict[str, Any]:
        """Build the request body for a quantity change operation."""
        return {
            self._customer_id_field: self._customer_id_value,
            "item_id": self._item_id,
            "quantity": quantity,
        }

    async def increase_quantity(self, amount: int) -> None:
        """Increase this item's quantity by *amount*."""
        await self._client.request(
            "POST",
            "/internal/items/quantity-changes",
            body=self._quantity_body(amount),
        )

    async def decrease_quantity(self, amount: int) -> None:
        """Decrease this item's quantity by *amount*."""
        await self._client.request(
            "POST",
            "/internal/items/quantity-changes",
            body=self._quantity_body(-amount),
        )

    async def try_decrease_quantity(self, amount: int) -> bool:
        """Try to decrease this item's quantity by *amount*.

        Returns ``True`` if the decrease succeeded, ``False`` otherwise.
        """
        data = await self._client.request(
            "POST",
            "/internal/items/try-decrease",
            body={
                self._customer_id_field: self._customer_id_value,
                "item_id": self._item_id,
                "amount": amount,
            },
        )
        return bool(data.get("success", False)) if data else False

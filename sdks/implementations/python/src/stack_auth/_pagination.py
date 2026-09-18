"""Cursor-based pagination wrapper for Stack Auth list API responses."""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class _PaginationMeta(BaseModel):
    """Nested pagination metadata from API response."""

    next_cursor: str | None = None


class PaginatedResult(BaseModel, Generic[T]):
    """Cursor-based pagination wrapper for list API responses.

    Matches the Stack Auth API response shape:
    { "items": [...], "pagination": { "next_cursor": "..." } }

    Exposes .next_cursor and .has_next_page as top-level convenience properties.
    """

    items: list[T]
    pagination: _PaginationMeta = Field(default_factory=_PaginationMeta)

    @property
    def next_cursor(self) -> str | None:
        """The cursor for fetching the next page, or None if no more pages."""
        return self.pagination.next_cursor

    @property
    def has_next_page(self) -> bool:
        """Whether there are more pages available."""
        return self.pagination.next_cursor is not None

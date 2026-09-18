"""Base model for all Stack Auth Pydantic models."""

from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict


class StackAuthModel(BaseModel):
    """Base model with shared configuration for all Stack Auth models.

    Provides:
    - populate_by_name: Allow both alias and field name in input
    - extra="ignore": Silently drop unknown fields (forward-compat)
    - from_attributes: Allow ORM-style attribute access
    - _millis_to_datetime: Convert millisecond timestamps to datetime
    """

    model_config = ConfigDict(
        populate_by_name=True,
        extra="ignore",
        from_attributes=True,
    )

    @staticmethod
    def _millis_to_datetime(v: int | None) -> datetime | None:
        """Convert a millisecond Unix timestamp to a UTC datetime, or None."""
        if v is None:
            return None
        return datetime.fromtimestamp(v / 1000.0, tz=timezone.utc)

"""Session models for Stack Auth."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class GeoInfo(StackAuthModel):
    """Geographic information derived from IP address."""

    city: str | None = None
    region: str | None = None
    country: str | None = None
    country_name: str | None = Field(None, alias="countryName")
    latitude: float | None = None
    longitude: float | None = None


class ActiveSession(StackAuthModel):
    """Represents an active login session for a user."""

    id: str
    user_id: str = Field(alias="userId")
    created_at_millis: int = Field(alias="createdAtMillis")
    is_impersonation: bool = Field(False, alias="isImpersonation")
    last_used_at_millis: int | None = Field(None, alias="lastUsedAtMillis")
    is_current_session: bool = Field(False, alias="isCurrentSession")
    geo_info: GeoInfo | None = Field(None, alias="geoInfo")

    @property
    def created_at(self) -> datetime:
        """Convert created_at_millis to a UTC datetime."""
        return self._millis_to_datetime(self.created_at_millis)  # type: ignore[return-value]

    @property
    def last_used_at(self) -> datetime | None:
        """Convert last_used_at_millis to a UTC datetime, or None."""
        return self._millis_to_datetime(self.last_used_at_millis)

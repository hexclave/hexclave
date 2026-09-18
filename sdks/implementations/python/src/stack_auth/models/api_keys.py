"""API key models for Stack Auth."""

from __future__ import annotations

from datetime import datetime

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class ApiKey(StackAuthModel):
    """Base type for API keys."""

    id: str
    description: str = ""
    expires_at_millis: int | None = Field(None, alias="expiresAtMillis")
    created_at_millis: int = Field(alias="createdAtMillis")
    is_valid: bool = Field(True, alias="isValid")

    @property
    def expires_at(self) -> datetime | None:
        """Convert expires_at_millis to a UTC datetime, or None."""
        return self._millis_to_datetime(self.expires_at_millis)

    @property
    def created_at(self) -> datetime:
        """Convert created_at_millis to a UTC datetime."""
        return self._millis_to_datetime(self.created_at_millis)  # type: ignore[return-value]


class UserApiKey(ApiKey):
    """An API key owned by a user."""

    user_id: str = Field(alias="userId")
    team_id: str | None = Field(None, alias="teamId")


class UserApiKeyFirstView(UserApiKey):
    """Returned only when creating a new user API key. Contains the secret."""

    api_key: str = Field(alias="apiKey")


class TeamApiKey(ApiKey):
    """An API key owned by a team."""

    team_id: str = Field(alias="teamId")


class TeamApiKeyFirstView(TeamApiKey):
    """Returned only when creating a new team API key. Contains the secret."""

    api_key: str = Field(alias="apiKey")

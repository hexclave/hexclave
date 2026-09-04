"""Team models for Stack Auth."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class Team(StackAuthModel):
    """A team/organization that users can belong to."""

    id: str
    display_name: str = Field(alias="displayName")
    profile_image_url: str | None = Field(None, alias="profileImageUrl")
    client_metadata: dict[str, Any] | None = Field(None, alias="clientMetadata")
    client_read_only_metadata: dict[str, Any] | None = Field(
        None, alias="clientReadOnlyMetadata"
    )


class ServerTeam(Team):
    """Server-side team with additional management capabilities."""

    server_metadata: dict[str, Any] | None = Field(None, alias="serverMetadata")
    created_at_millis: int = Field(alias="createdAtMillis")

    @property
    def created_at(self) -> datetime:
        """Convert created_at_millis to a UTC datetime."""
        return self._millis_to_datetime(self.created_at_millis)  # type: ignore[return-value]


class TeamMemberProfile(StackAuthModel):
    """A user's profile within a specific team."""

    user_id: str = Field(alias="userId")
    display_name: str | None = Field(None, alias="displayName")
    profile_image_url: str | None = Field(None, alias="profileImageUrl")


class TeamInvitation(StackAuthModel):
    """An invitation to join a team."""

    id: str
    recipient_email: str | None = Field(None, alias="recipientEmail")
    expires_at_millis: int = Field(alias="expiresAtMillis")

    @property
    def expires_at(self) -> datetime:
        """Convert expires_at_millis to a UTC datetime."""
        return self._millis_to_datetime(self.expires_at_millis)  # type: ignore[return-value]

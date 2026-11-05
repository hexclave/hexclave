"""User models for Stack Auth."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class BaseUser(StackAuthModel):
    """Base user type with publicly safe properties.

    All fields use camelCase aliases matching the Stack Auth API JSON format.
    """

    id: str
    display_name: str | None = Field(None, alias="displayName")
    primary_email: str | None = Field(None, alias="primaryEmail")
    primary_email_verified: bool = Field(False, alias="primaryEmailVerified")
    profile_image_url: str | None = Field(None, alias="profileImageUrl")
    signed_up_at_millis: int = Field(alias="signedUpAtMillis")
    last_active_at_millis: int | None = Field(None, alias="lastActiveAtMillis")
    client_metadata: dict[str, Any] | None = Field(None, alias="clientMetadata")
    client_read_only_metadata: dict[str, Any] | None = Field(
        None, alias="clientReadOnlyMetadata"
    )
    has_password: bool = Field(False, alias="hasPassword")
    otp_auth_enabled: bool = Field(False, alias="otpAuthEnabled")
    passkey_auth_enabled: bool = Field(False, alias="passkeyAuthEnabled")
    is_multi_factor_required: bool = Field(False, alias="isMultiFactorRequired")
    is_anonymous: bool = Field(False, alias="isAnonymous")
    is_restricted: bool = Field(False, alias="isRestricted")
    restricted_reason: dict[str, Any] | None = Field(None, alias="restrictedReason")

    @property
    def signed_up_at(self) -> datetime:
        """Convert signed_up_at_millis to a UTC datetime."""
        return self._millis_to_datetime(self.signed_up_at_millis)  # type: ignore[return-value]

    @property
    def last_active_at(self) -> datetime | None:
        """Convert last_active_at_millis to a UTC datetime, or None."""
        return self._millis_to_datetime(self.last_active_at_millis)


class ServerUser(BaseUser):
    """Server-side user with full access to sensitive fields.

    Extends BaseUser with server-only metadata.
    """

    server_metadata: dict[str, Any] | None = Field(None, alias="serverMetadata")

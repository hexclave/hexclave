"""Contact channel models for Stack Auth."""

from __future__ import annotations

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class ContactChannel(StackAuthModel):
    """A contact channel (email address) associated with a user."""

    id: str
    value: str
    type: str = "email"
    is_primary: bool = Field(False, alias="isPrimary")
    is_verified: bool = Field(False, alias="isVerified")
    used_for_auth: bool = Field(False, alias="usedForAuth")

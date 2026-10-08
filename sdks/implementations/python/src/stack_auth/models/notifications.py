"""Notification models for Stack Auth."""

from __future__ import annotations

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class NotificationCategory(StackAuthModel):
    """A category of notifications users can subscribe to or unsubscribe from."""

    id: str
    display_name: str = Field(alias="displayName")
    description: str | None = None
    is_subscribed_by_default: bool = Field(True, alias="isSubscribedByDefault")
    is_user_subscribed: bool = Field(True, alias="isUserSubscribed")

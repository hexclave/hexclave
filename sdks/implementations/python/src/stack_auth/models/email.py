"""Email models for Stack Auth."""

from __future__ import annotations

from stack_auth.models._base import StackAuthModel


class EmailDeliveryInfo(StackAuthModel):
    """Email delivery statistics."""

    delivered: int = 0
    bounced: int = 0
    complained: int = 0
    total: int = 0

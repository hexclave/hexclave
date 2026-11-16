"""OAuth models for Stack Auth."""

from __future__ import annotations

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class OAuthConnection(StackAuthModel):
    """A connected OAuth account for accessing third-party APIs."""

    id: str


class OAuthProvider(StackAuthModel):
    """An OAuth provider linked to a user's account."""

    id: str
    type: str
    user_id: str = Field(alias="userId")
    account_id: str | None = Field(None, alias="accountId")
    email: str | None = None
    allow_sign_in: bool = Field(True, alias="allowSignIn")
    allow_connected_accounts: bool = Field(False, alias="allowConnectedAccounts")

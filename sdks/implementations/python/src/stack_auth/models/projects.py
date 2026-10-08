"""Project models for Stack Auth."""

from __future__ import annotations

from typing import Any

from pydantic import Field

from stack_auth.models._base import StackAuthModel


class OAuthProviderConfig(StackAuthModel):
    """Configuration for an OAuth provider."""

    id: str


class ProjectConfig(StackAuthModel):
    """Client-visible project configuration."""

    sign_up_enabled: bool = Field(True, alias="signUpEnabled")
    credential_enabled: bool = Field(True, alias="credentialEnabled")
    magic_link_enabled: bool = Field(False, alias="magicLinkEnabled")
    passkey_enabled: bool = Field(False, alias="passkeyEnabled")
    oauth_providers: list[OAuthProviderConfig] = Field(
        default_factory=list, alias="oauthProviders"
    )
    client_team_creation_enabled: bool = Field(False, alias="clientTeamCreationEnabled")
    client_user_deletion_enabled: bool = Field(False, alias="clientUserDeletionEnabled")
    allow_user_api_keys: bool = Field(False, alias="allowUserApiKeys")
    allow_team_api_keys: bool = Field(False, alias="allowTeamApiKeys")


class Project(StackAuthModel):
    """Basic project information."""

    id: str
    display_name: str = Field(alias="displayName")
    config: ProjectConfig

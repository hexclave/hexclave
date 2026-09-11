"""Permission models for Stack Auth."""

from __future__ import annotations

from stack_auth.models._base import StackAuthModel


class TeamPermission(StackAuthModel):
    """A permission granted to a user within a team."""

    id: str


class ProjectPermission(StackAuthModel):
    """A project-level permission granted to a user."""

    id: str

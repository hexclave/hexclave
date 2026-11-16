"""Tests for team models (Team, ServerTeam, TeamMemberProfile, TeamInvitation)."""

from datetime import datetime, timezone

import pytest


class TestTeam:
    """Tests for the Team model."""

    def test_parse_from_camel_case_json(self) -> None:
        from stack_auth.models.teams import Team

        data = {
            "id": "t1",
            "displayName": "Team A",
            "clientMetadata": {},
        }
        team = Team.model_validate(data)
        assert team.id == "t1"
        assert team.display_name == "Team A"
        assert team.client_metadata == {}

    def test_optional_fields(self) -> None:
        from stack_auth.models.teams import Team

        data = {
            "id": "t1",
            "displayName": "Team A",
            "profileImageUrl": "https://example.com/img.png",
            "clientMetadata": {"key": "val"},
            "clientReadOnlyMetadata": {"ro": True},
        }
        team = Team.model_validate(data)
        assert team.profile_image_url == "https://example.com/img.png"
        assert team.client_read_only_metadata == {"ro": True}


class TestServerTeam:
    """Tests for the ServerTeam model."""

    def test_inherits_team(self) -> None:
        from stack_auth.models.teams import ServerTeam, Team

        assert issubclass(ServerTeam, Team)

    def test_parse_with_server_fields(self) -> None:
        from stack_auth.models.teams import ServerTeam

        data = {
            "id": "t1",
            "displayName": "Team A",
            "clientMetadata": {},
            "serverMetadata": {"internal": True},
            "createdAtMillis": 1711296000000,
        }
        team = ServerTeam.model_validate(data)
        assert team.server_metadata == {"internal": True}
        assert team.created_at == datetime(2024, 3, 24, 16, 0, tzinfo=timezone.utc)


class TestTeamMemberProfile:
    """Tests for the TeamMemberProfile model."""

    def test_parse_from_camel_case(self) -> None:
        from stack_auth.models.teams import TeamMemberProfile

        data = {
            "userId": "user1",
            "displayName": "John",
            "profileImageUrl": "https://example.com/img.png",
        }
        profile = TeamMemberProfile.model_validate(data)
        assert profile.user_id == "user1"
        assert profile.display_name == "John"
        assert profile.profile_image_url == "https://example.com/img.png"

    def test_nullable_fields(self) -> None:
        from stack_auth.models.teams import TeamMemberProfile

        data = {"userId": "user1"}
        profile = TeamMemberProfile.model_validate(data)
        assert profile.display_name is None
        assert profile.profile_image_url is None


class TestTeamInvitation:
    """Tests for the TeamInvitation model."""

    def test_parse_invitation(self) -> None:
        from stack_auth.models.teams import TeamInvitation

        data = {
            "id": "inv1",
            "recipientEmail": "test@example.com",
            "expiresAtMillis": 1711296000000,
        }
        inv = TeamInvitation.model_validate(data)
        assert inv.id == "inv1"
        assert inv.recipient_email == "test@example.com"
        assert inv.expires_at == datetime(2024, 3, 24, 16, 0, tzinfo=timezone.utc)

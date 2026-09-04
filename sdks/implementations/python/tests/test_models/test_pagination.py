"""Tests for PaginatedResult[T] generic pagination wrapper."""

import pytest


class TestPaginatedResult:
    """Tests for PaginatedResult with nested pagination shape."""

    def test_parse_with_server_user(self) -> None:
        from stack_auth._pagination import PaginatedResult
        from stack_auth.models.users import ServerUser

        data = {
            "items": [
                {
                    "id": "u1",
                    "signedUpAtMillis": 1711296000000,
                    "hasPassword": True,
                    "otpAuthEnabled": False,
                    "passkeyAuthEnabled": False,
                    "isMultiFactorRequired": False,
                    "isAnonymous": False,
                    "isRestricted": False,
                }
            ],
            "pagination": {"next_cursor": "abc123"},
        }
        result = PaginatedResult[ServerUser].model_validate(data)
        assert len(result.items) == 1
        assert isinstance(result.items[0], ServerUser)
        assert result.items[0].id == "u1"
        assert result.next_cursor == "abc123"

    def test_no_next_cursor_means_no_next_page(self) -> None:
        from stack_auth._pagination import PaginatedResult
        from stack_auth.models.teams import Team

        data = {
            "items": [{"id": "t1", "displayName": "Team A"}],
            "pagination": {},
        }
        result = PaginatedResult[Team].model_validate(data)
        assert result.next_cursor is None
        assert result.has_next_page is False

    def test_next_cursor_present_means_has_next_page(self) -> None:
        from stack_auth._pagination import PaginatedResult
        from stack_auth.models.teams import Team

        data = {
            "items": [{"id": "t1", "displayName": "Team A"}],
            "pagination": {"next_cursor": "cursor123"},
        }
        result = PaginatedResult[Team].model_validate(data)
        assert result.has_next_page is True

    def test_empty_items_list(self) -> None:
        from stack_auth._pagination import PaginatedResult
        from stack_auth.models.users import BaseUser

        data = {"items": [], "pagination": {}}
        result = PaginatedResult[BaseUser].model_validate(data)
        assert len(result.items) == 0
        assert result.has_next_page is False

    def test_items_count(self) -> None:
        from stack_auth._pagination import PaginatedResult
        from stack_auth.models.teams import Team

        data = {
            "items": [
                {"id": "t1", "displayName": "Team A"},
                {"id": "t2", "displayName": "Team B"},
                {"id": "t3", "displayName": "Team C"},
            ],
            "pagination": {"next_cursor": "next"},
        }
        result = PaginatedResult[Team].model_validate(data)
        assert len(result.items) == 3

    def test_item_is_correct_type(self) -> None:
        from stack_auth._pagination import PaginatedResult
        from stack_auth.models.users import ServerUser

        data = {
            "items": [
                {
                    "id": "u1",
                    "signedUpAtMillis": 1711296000000,
                    "hasPassword": False,
                    "otpAuthEnabled": False,
                    "passkeyAuthEnabled": False,
                    "isMultiFactorRequired": False,
                    "isAnonymous": False,
                    "isRestricted": False,
                    "serverMetadata": {},
                }
            ],
            "pagination": {},
        }
        result = PaginatedResult[ServerUser].model_validate(data)
        assert isinstance(result.items[0], ServerUser)

    def test_pagination_absent_uses_default(self) -> None:
        """If pagination key is missing entirely, default to no next page."""
        from stack_auth._pagination import PaginatedResult
        from stack_auth.models.teams import Team

        data = {"items": [{"id": "t1", "displayName": "Team A"}]}
        result = PaginatedResult[Team].model_validate(data)
        assert result.next_cursor is None
        assert result.has_next_page is False

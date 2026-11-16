"""Tests for user models (BaseUser, ServerUser)."""

from datetime import datetime, timezone

import pytest


class TestBaseUser:
    """Tests for the BaseUser model."""

    def test_parse_from_camel_case_json(self) -> None:
        from stack_auth.models.users import BaseUser

        data = {
            "id": "u1",
            "displayName": "John",
            "primaryEmail": "j@e.com",
            "primaryEmailVerified": True,
            "signedUpAtMillis": 1711296000000,
            "hasPassword": True,
            "otpAuthEnabled": False,
            "passkeyAuthEnabled": False,
            "isMultiFactorRequired": False,
            "isAnonymous": False,
            "isRestricted": False,
        }
        user = BaseUser.model_validate(data)
        assert user.id == "u1"
        assert user.display_name == "John"
        assert user.primary_email == "j@e.com"
        assert user.primary_email_verified is True
        assert user.has_password is True
        assert user.otp_auth_enabled is False
        assert user.passkey_auth_enabled is False
        assert user.is_multi_factor_required is False
        assert user.is_anonymous is False
        assert user.is_restricted is False

    def test_signed_up_at_millis_converts_to_datetime(self) -> None:
        from stack_auth.models.users import BaseUser

        data = {
            "id": "u1",
            "signedUpAtMillis": 1711296000000,
            "hasPassword": True,
            "otpAuthEnabled": False,
            "passkeyAuthEnabled": False,
            "isMultiFactorRequired": False,
            "isAnonymous": False,
            "isRestricted": False,
        }
        user = BaseUser.model_validate(data)
        assert user.signed_up_at == datetime(2024, 3, 24, 16, 0, tzinfo=timezone.utc)

    def test_nullable_timestamp_returns_none(self) -> None:
        from stack_auth.models.users import BaseUser

        data = {
            "id": "u1",
            "signedUpAtMillis": 1711296000000,
            "hasPassword": True,
            "otpAuthEnabled": False,
            "passkeyAuthEnabled": False,
            "isMultiFactorRequired": False,
            "isAnonymous": False,
            "isRestricted": False,
        }
        user = BaseUser.model_validate(data)
        assert user.last_active_at is None

    def test_extra_fields_ignored(self) -> None:
        from stack_auth.models.users import BaseUser

        data = {
            "id": "u1",
            "signedUpAtMillis": 1711296000000,
            "hasPassword": True,
            "otpAuthEnabled": False,
            "passkeyAuthEnabled": False,
            "isMultiFactorRequired": False,
            "isAnonymous": False,
            "isRestricted": False,
            "futureField": 123,
            "anotherUnknown": "hello",
        }
        user = BaseUser.model_validate(data)
        assert user.id == "u1"

    def test_populate_by_name_snake_case(self) -> None:
        from stack_auth.models.users import BaseUser

        user = BaseUser(
            id="u1",
            display_name="John",
            signed_up_at_millis=1711296000000,
            has_password=True,
            otp_auth_enabled=False,
            passkey_auth_enabled=False,
            is_multi_factor_required=False,
            is_anonymous=False,
            is_restricted=False,
        )
        assert user.display_name == "John"

    def test_restricted_reason_parses(self) -> None:
        from stack_auth.models.users import BaseUser

        data = {
            "id": "u1",
            "signedUpAtMillis": 1711296000000,
            "hasPassword": False,
            "otpAuthEnabled": False,
            "passkeyAuthEnabled": False,
            "isMultiFactorRequired": False,
            "isAnonymous": False,
            "isRestricted": True,
            "restrictedReason": {"type": "email_not_verified"},
        }
        user = BaseUser.model_validate(data)
        assert user.is_restricted is True
        assert user.restricted_reason == {"type": "email_not_verified"}

    def test_millis_to_datetime_none(self) -> None:
        from stack_auth.models._base import StackAuthModel

        assert StackAuthModel._millis_to_datetime(None) is None


class TestServerUser:
    """Tests for the ServerUser model."""

    def test_inherits_base_user(self) -> None:
        from stack_auth.models.users import BaseUser, ServerUser

        assert issubclass(ServerUser, BaseUser)

    def test_parse_with_server_fields(self) -> None:
        from stack_auth.models.users import ServerUser

        data = {
            "id": "u1",
            "displayName": "John",
            "primaryEmail": "j@e.com",
            "primaryEmailVerified": True,
            "signedUpAtMillis": 1711296000000,
            "lastActiveAtMillis": 1711296000000,
            "hasPassword": True,
            "otpAuthEnabled": False,
            "passkeyAuthEnabled": False,
            "isMultiFactorRequired": False,
            "isAnonymous": False,
            "isRestricted": False,
            "serverMetadata": {"role": "admin"},
        }
        user = ServerUser.model_validate(data)
        assert user.server_metadata == {"role": "admin"}
        assert user.last_active_at == datetime(2024, 3, 24, 16, 0, tzinfo=timezone.utc)

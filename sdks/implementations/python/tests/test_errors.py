"""Tests for the Stack Auth error hierarchy and from_response() dispatch."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from stack_auth.errors import (
    AnalyticsError,
    ApiKeyError,
    AuthenticationError,
    CliError,
    ConflictError,
    EmailError,
    NotFoundError,
    OAuthError,
    PasskeyError,
    PaymentError,
    PermissionDeniedError,
    RateLimitError,
    StackAuthError,
    ValidationError,
)
from stack_auth.models._base import StackAuthModel


class TestStackAuthErrorBasics:
    """Test StackAuthError base class storage and string representation."""

    def test_stores_code_and_message(self) -> None:
        err = StackAuthError("CODE", "msg")
        assert err.code == "CODE"
        assert err.message == "msg"

    def test_str_contains_code_and_message(self) -> None:
        err = StackAuthError("CODE", "msg")
        s = str(err)
        assert "CODE" in s
        assert "msg" in s

    def test_stores_details(self) -> None:
        err = StackAuthError("CODE", "msg", {"key": "val"})
        assert err.details == {"key": "val"}

    def test_details_default_none(self) -> None:
        err = StackAuthError("CODE", "msg")
        assert err.details is None


class TestErrorSubclasses:
    """Test that all category subclasses exist and inherit from StackAuthError."""

    @pytest.mark.parametrize(
        "cls",
        [
            AuthenticationError,
            NotFoundError,
            ValidationError,
            PermissionDeniedError,
            ConflictError,
            OAuthError,
            PasskeyError,
            ApiKeyError,
            PaymentError,
            EmailError,
            RateLimitError,
            CliError,
            AnalyticsError,
        ],
    )
    def test_is_subclass_of_stack_auth_error(self, cls: type) -> None:
        assert issubclass(cls, StackAuthError)

    @pytest.mark.parametrize(
        "cls",
        [
            AuthenticationError,
            NotFoundError,
            ValidationError,
            PermissionDeniedError,
            ConflictError,
            OAuthError,
            PasskeyError,
            ApiKeyError,
            PaymentError,
            EmailError,
            RateLimitError,
            CliError,
            AnalyticsError,
        ],
    )
    def test_can_be_caught_with_except_stack_auth_error(self, cls: type) -> None:
        with pytest.raises(StackAuthError):
            raise cls("TEST_CODE", "test message")


class TestFromResponse:
    """Test from_response() factory dispatch for known and unknown codes."""

    def test_invalid_access_token_returns_authentication_error(self) -> None:
        err = StackAuthError.from_response("INVALID_ACCESS_TOKEN", "bad token")
        assert isinstance(err, AuthenticationError)
        assert err.code == "INVALID_ACCESS_TOKEN"
        assert err.message == "bad token"

    def test_user_not_found_returns_not_found_error(self) -> None:
        err = StackAuthError.from_response("USER_NOT_FOUND", "no user")
        assert isinstance(err, NotFoundError)

    def test_schema_error_returns_validation_error(self) -> None:
        err = StackAuthError.from_response("SCHEMA_ERROR", "bad schema")
        assert isinstance(err, ValidationError)

    def test_team_permission_required_returns_permission_error(self) -> None:
        err = StackAuthError.from_response("TEAM_PERMISSION_REQUIRED", "denied")
        assert isinstance(err, PermissionDeniedError)

    def test_team_already_exists_returns_conflict_error(self) -> None:
        err = StackAuthError.from_response("TEAM_ALREADY_EXISTS", "conflict")
        assert isinstance(err, ConflictError)

    def test_oauth_connection_not_connected_returns_oauth_error(self) -> None:
        err = StackAuthError.from_response("OAUTH_CONNECTION_NOT_CONNECTED_TO_USER", "no conn")
        assert isinstance(err, OAuthError)

    def test_passkey_authentication_failed_returns_passkey_error(self) -> None:
        err = StackAuthError.from_response("PASSKEY_AUTHENTICATION_FAILED", "failed")
        assert isinstance(err, PasskeyError)

    def test_api_key_not_valid_returns_api_key_error(self) -> None:
        err = StackAuthError.from_response("API_KEY_NOT_VALID", "invalid")
        assert isinstance(err, ApiKeyError)

    def test_product_already_granted_returns_payment_error(self) -> None:
        err = StackAuthError.from_response("PRODUCT_ALREADY_GRANTED", "granted")
        assert isinstance(err, PaymentError)

    def test_email_rendering_error_returns_email_error(self) -> None:
        err = StackAuthError.from_response("EMAIL_RENDERING_ERROR", "render fail")
        assert isinstance(err, EmailError)

    def test_unknown_code_returns_base_stack_auth_error(self) -> None:
        err = StackAuthError.from_response("TOTALLY_UNKNOWN_CODE", "surprise")
        assert type(err) is StackAuthError
        assert err.code == "TOTALLY_UNKNOWN_CODE"
        assert err.message == "surprise"

    def test_from_response_preserves_details(self) -> None:
        err = StackAuthError.from_response("USER_NOT_FOUND", "no user", {"user_id": "abc"})
        assert err.details == {"user_id": "abc"}

    def test_cli_auth_error_returns_cli_error(self) -> None:
        err = StackAuthError.from_response("CLI_AUTH_ERROR", "cli fail")
        assert isinstance(err, CliError)

    def test_analytics_query_timeout_returns_analytics_error(self) -> None:
        err = StackAuthError.from_response("ANALYTICS_QUERY_TIMEOUT", "timeout")
        assert isinstance(err, AnalyticsError)


class TestErrorCodeMapCoverage:
    """Test that the error code map has comprehensive coverage."""

    def test_error_code_map_has_at_least_90_entries(self) -> None:
        from stack_auth.errors import _ERROR_CODE_MAP

        assert len(_ERROR_CODE_MAP) >= 90, f"Expected >= 90 entries, got {len(_ERROR_CODE_MAP)}"


class TestStackAuthModel:
    """Test the StackAuthModel base class."""

    def test_model_config_populate_by_name(self) -> None:
        assert StackAuthModel.model_config.get("populate_by_name") is True

    def test_model_config_extra_ignore(self) -> None:
        assert StackAuthModel.model_config.get("extra") == "ignore"

    def test_millis_to_datetime_converts_correctly(self) -> None:
        result = StackAuthModel._millis_to_datetime(1711296000000)
        expected = datetime(2024, 3, 24, 16, 0, tzinfo=timezone.utc)
        assert result == expected

    def test_millis_to_datetime_none_returns_none(self) -> None:
        result = StackAuthModel._millis_to_datetime(None)
        assert result is None

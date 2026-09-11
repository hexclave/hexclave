"""Stack Auth error hierarchy with factory dispatch for all known error codes."""

from __future__ import annotations

from typing import Any


class StackAuthError(Exception):
    """Base error for all Stack Auth SDK errors.

    Attributes:
        code: The error code string from the Stack Auth API.
        message: Human-readable error description.
        details: Optional dictionary with additional error context.
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        """Initialize a StackAuthError.

        Args:
            code: The error code string from the Stack Auth API.
            message: Human-readable error description.
            details: Optional dictionary with additional error context.
        """
        self.code = code
        self.message = message
        self.details = details
        super().__init__(f"[{code}] {message}")

    @classmethod
    def from_response(
        cls,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> StackAuthError:
        """Create the appropriate error subclass for a given error code.

        Known error codes are dispatched to their category subclass.
        Unknown codes produce a base StackAuthError.
        """
        error_cls = _ERROR_CODE_MAP.get(code, StackAuthError)
        return error_cls(code, message, details)


class AuthenticationError(StackAuthError):
    """Authentication or authorization failure."""


class NotFoundError(StackAuthError):
    """Requested resource was not found."""


class ValidationError(StackAuthError):
    """Request validation or input error."""


class PermissionDeniedError(StackAuthError):
    """Insufficient permissions for the requested operation."""


class ConflictError(StackAuthError):
    """Resource conflict (duplicate, already exists, etc.)."""


class OAuthError(StackAuthError):
    """OAuth-specific error."""


class PasskeyError(StackAuthError):
    """Passkey/WebAuthn-specific error."""


class ApiKeyError(StackAuthError):
    """API key-related error."""


class PaymentError(StackAuthError):
    """Payment or billing error."""


class EmailError(StackAuthError):
    """Email-specific error."""


class RateLimitError(StackAuthError):
    """Rate limit exceeded."""


class CliError(StackAuthError):
    """CLI-specific error."""


class AnalyticsError(StackAuthError):
    """Analytics-specific error."""


# Complete mapping of all ~100 error codes from known-errors.tsx to category classes.
_ERROR_CODE_MAP: dict[str, type[StackAuthError]] = {
    # AuthenticationError - project authentication
    "PROJECT_AUTHENTICATION_ERROR": AuthenticationError,
    "INVALID_PROJECT_AUTHENTICATION": AuthenticationError,
    "PROJECT_KEY_WITHOUT_ACCESS_TYPE": AuthenticationError,
    "INVALID_ACCESS_TYPE": AuthenticationError,
    "ACCESS_TYPE_WITHOUT_PROJECT_ID": AuthenticationError,
    "ACCESS_TYPE_REQUIRED": AuthenticationError,
    "INSUFFICIENT_ACCESS_TYPE": AuthenticationError,
    "INVALID_PUBLISHABLE_CLIENT_KEY": AuthenticationError,
    "INVALID_SECRET_SERVER_KEY": AuthenticationError,
    "INVALID_SUPER_SECRET_ADMIN_KEY": AuthenticationError,
    "INVALID_ADMIN_ACCESS_TOKEN": AuthenticationError,
    "UNPARSABLE_ADMIN_ACCESS_TOKEN": AuthenticationError,
    "ADMIN_ACCESS_TOKEN_EXPIRED": AuthenticationError,
    "INVALID_PROJECT_FOR_ADMIN_ACCESS_TOKEN": AuthenticationError,
    "ADMIN_ACCESS_TOKEN_IS_NOT_ADMIN": AuthenticationError,
    "PROJECT_AUTHENTICATION_REQUIRED": AuthenticationError,
    "CLIENT_AUTHENTICATION_REQUIRED": AuthenticationError,
    "PUBLISHABLE_CLIENT_KEY_REQUIRED_FOR_PROJECT": AuthenticationError,
    "SERVER_AUTHENTICATION_REQUIRED": AuthenticationError,
    "CLIENT_OR_SERVER_AUTHENTICATION_REQUIRED": AuthenticationError,
    "CLIENT_OR_ADMIN_AUTHENTICATION_REQUIRED": AuthenticationError,
    "CLIENT_OR_SERVER_OR_ADMIN_AUTHENTICATION_REQUIRED": AuthenticationError,
    "ADMIN_AUTHENTICATION_REQUIRED": AuthenticationError,
    "EXPECTED_INTERNAL_PROJECT": AuthenticationError,
    # AuthenticationError - session authentication
    "SESSION_AUTHENTICATION_ERROR": AuthenticationError,
    "INVALID_SESSION_AUTHENTICATION": AuthenticationError,
    "INVALID_ACCESS_TOKEN": AuthenticationError,
    "UNPARSABLE_ACCESS_TOKEN": AuthenticationError,
    "ACCESS_TOKEN_EXPIRED": AuthenticationError,
    "INVALID_PROJECT_FOR_ACCESS_TOKEN": AuthenticationError,
    # AuthenticationError - refresh token
    "REFRESH_TOKEN_ERROR": AuthenticationError,
    "REFRESH_TOKEN_NOT_FOUND_OR_EXPIRED": AuthenticationError,
    "CANNOT_DELETE_CURRENT_SESSION": AuthenticationError,
    "PROVIDER_REJECTED": AuthenticationError,
    # AuthenticationError - user authentication
    "USER_AUTHENTICATION_REQUIRED": AuthenticationError,
    "CANNOT_GET_OWN_USER_WITHOUT_USER": AuthenticationError,
    # AuthenticationError - multi-factor
    "MULTI_FACTOR_AUTHENTICATION_REQUIRED": AuthenticationError,
    "INVALID_TOTP_CODE": AuthenticationError,
    # NotFoundError
    "USER_NOT_FOUND": NotFoundError,
    "USER_ID_DOES_NOT_EXIST": NotFoundError,
    "TEAM_NOT_FOUND": NotFoundError,
    "PROJECT_NOT_FOUND": NotFoundError,
    "CURRENT_PROJECT_NOT_FOUND": NotFoundError,
    "BRANCH_DOES_NOT_EXIST": NotFoundError,
    "PERMISSION_NOT_FOUND": NotFoundError,
    "TEAM_PERMISSION_NOT_FOUND": NotFoundError,
    "API_KEY_NOT_FOUND": NotFoundError,
    "ITEM_NOT_FOUND": NotFoundError,
    "CUSTOMER_DOES_NOT_EXIST": NotFoundError,
    "PRODUCT_DOES_NOT_EXIST": NotFoundError,
    "DATA_VAULT_STORE_DOES_NOT_EXIST": NotFoundError,
    "DATA_VAULT_STORE_HASHED_KEY_DOES_NOT_EXIST": NotFoundError,
    "SUBSCRIPTION_INVOICE_NOT_FOUND": NotFoundError,
    "ONE_TIME_PURCHASE_NOT_FOUND": NotFoundError,
    "STRIPE_ACCOUNT_INFO_NOT_FOUND": NotFoundError,
    # ValidationError
    "SCHEMA_ERROR": ValidationError,
    "BODY_PARSING_ERROR": ValidationError,
    "ALL_OVERLOADS_FAILED": ValidationError,
    "UNSUPPORTED_ERROR": ValidationError,
    "EMAIL_PASSWORD_MISMATCH": ValidationError,
    "PASSWORD_REQUIREMENTS_NOT_MET": ValidationError,
    "PASSWORD_TOO_SHORT": ValidationError,
    "PASSWORD_TOO_LONG": ValidationError,
    "PASSWORD_CONFIRMATION_MISMATCH": ValidationError,
    "USER_DOES_NOT_HAVE_PASSWORD": ValidationError,
    "USER_EMAIL_ALREADY_EXISTS": ValidationError,
    "EMAIL_NOT_VERIFIED": ValidationError,
    "EMAIL_ALREADY_VERIFIED": ValidationError,
    "EMAIL_NOT_ASSOCIATED_WITH_USER": ValidationError,
    "EMAIL_IS_NOT_PRIMARY_EMAIL": ValidationError,
    "RESTRICTED_USER_NOT_ALLOWED": ValidationError,
    "TEAM_INVITATION_RESTRICTED_USER_NOT_ALLOWED": ValidationError,
    "SIGN_UP_NOT_ENABLED": ValidationError,
    "SIGN_UP_REJECTED": ValidationError,
    "BOT_CHALLENGE_REQUIRED": ValidationError,
    "BOT_CHALLENGE_FAILED": ValidationError,
    "PASSWORD_AUTHENTICATION_NOT_ENABLED": ValidationError,
    "PASSKEY_AUTHENTICATION_NOT_ENABLED": ValidationError,
    "ANONYMOUS_ACCOUNTS_NOT_ENABLED": ValidationError,
    "ANONYMOUS_AUTHENTICATION_NOT_ALLOWED": ValidationError,
    "REDIRECT_URL_NOT_WHITELISTED": ValidationError,
    "VERIFICATION_ERROR": ValidationError,
    "VERIFICATION_CODE_NOT_FOUND": ValidationError,
    "VERIFICATION_CODE_EXPIRED": ValidationError,
    "VERIFICATION_CODE_ALREADY_USED": ValidationError,
    "VERIFICATION_CODE_MAX_ATTEMPTS_REACHED": ValidationError,
    # PermissionDeniedError
    "PROJECT_PERMISSION_REQUIRED": PermissionDeniedError,
    "TEAM_PERMISSION_REQUIRED": PermissionDeniedError,
    "WRONG_PERMISSION_SCOPE": PermissionDeniedError,
    "CONTAINED_PERMISSION_NOT_FOUND": PermissionDeniedError,
    "PERMISSION_ID_ALREADY_EXISTS": PermissionDeniedError,
    # ConflictError
    "TEAM_ALREADY_EXISTS": ConflictError,
    "TEAM_MEMBERSHIP_ALREADY_EXISTS": ConflictError,
    "TEAM_MEMBERSHIP_NOT_FOUND": NotFoundError,
    "EMAIL_TEMPLATE_ALREADY_EXISTS": ConflictError,
    "CONTACT_CHANNEL_ALREADY_USED_FOR_AUTH_BY_SOMEONE_ELSE": ConflictError,
    # OAuthError
    "OAUTH_CONNECTION_NOT_CONNECTED_TO_USER": OAuthError,
    "OAUTH_CONNECTION_ALREADY_CONNECTED_TO_ANOTHER_USER": OAuthError,
    "OAUTH_CONNECTION_DOES_NOT_HAVE_REQUIRED_SCOPE": OAuthError,
    "OAUTH_ACCESS_TOKEN_NOT_AVAILABLE": OAuthError,
    "OAUTH_EXTRA_SCOPE_NOT_AVAILABLE_WITH_SHARED_OAUTH_KEYS": OAuthError,
    "OAUTH_ACCESS_TOKEN_NOT_AVAILABLE_WITH_SHARED_OAUTH_KEYS": OAuthError,
    "INVALID_OAUTH_CLIENT_ID_OR_SECRET": OAuthError,
    "INVALID_SCOPE": OAuthError,
    "USER_ALREADY_CONNECTED_TO_ANOTHER_OAUTH_CONNECTION": OAuthError,
    "OUTER_OAUTH_TIMEOUT": OAuthError,
    "OAUTH_PROVIDER_NOT_FOUND_OR_NOT_ENABLED": OAuthError,
    "APPLE_BUNDLE_ID_NOT_CONFIGURED": OAuthError,
    "OAUTH_PROVIDER_ACCOUNT_ID_ALREADY_USED_FOR_SIGN_IN": OAuthError,
    "OAUTH_PROVIDER_ACCESS_DENIED": OAuthError,
    "INVALID_SHARED_OAUTH_PROVIDER_ID": OAuthError,
    "INVALID_STANDARD_OAUTH_PROVIDER_ID": OAuthError,
    "INVALID_AUTHORIZATION_CODE": OAuthError,
    "INVALID_APPLE_CREDENTIALS": OAuthError,
    # PasskeyError
    "PASSKEY_REGISTRATION_FAILED": PasskeyError,
    "PASSKEY_WEBAUTHN_ERROR": PasskeyError,
    "PASSKEY_AUTHENTICATION_FAILED": PasskeyError,
    # ApiKeyError
    "API_KEY_NOT_VALID": ApiKeyError,
    "API_KEY_EXPIRED": ApiKeyError,
    "API_KEY_REVOKED": ApiKeyError,
    "WRONG_API_KEY_TYPE": ApiKeyError,
    "PUBLIC_API_KEY_CANNOT_BE_REVOKED": ApiKeyError,
    # PaymentError
    "ITEM_CUSTOMER_TYPE_DOES_NOT_MATCH": PaymentError,
    "PRODUCT_CUSTOMER_TYPE_DOES_NOT_MATCH": PaymentError,
    "PRODUCT_ALREADY_GRANTED": PaymentError,
    "ITEM_QUANTITY_INSUFFICIENT_AMOUNT": PaymentError,
    "SUBSCRIPTION_ALREADY_REFUNDED": PaymentError,
    "ONE_TIME_PURCHASE_ALREADY_REFUNDED": PaymentError,
    "TEST_MODE_PURCHASE_NON_REFUNDABLE": PaymentError,
    "DEFAULT_PAYMENT_METHOD_REQUIRED": PaymentError,
    "NEW_PURCHASES_BLOCKED": PaymentError,
    # EmailError
    "EMAIL_RENDERING_ERROR": EmailError,
    "TEMPLATE_SOURCE_REWRITE_ERROR": EmailError,
    "REQUIRES_CUSTOM_EMAIL_SERVER": EmailError,
    "EMAIL_CAPACITY_BOOST_ALREADY_ACTIVE": EmailError,
    "EMAIL_NOT_EDITABLE": EmailError,
    # CliError
    "INVALID_POLLING_CODE": CliError,
    "CLI_AUTH_ERROR": CliError,
    "CLI_AUTH_EXPIRED_ERROR": CliError,
    "CLI_AUTH_USED_ERROR": CliError,
    # AnalyticsError
    "ANALYTICS_QUERY_TIMEOUT": AnalyticsError,
    "ANALYTICS_QUERY_ERROR": AnalyticsError,
    "ANALYTICS_NOT_ENABLED": AnalyticsError,
}

import Foundation

/// Base user properties visible to clients
/// Note: [String: Any] is not Sendable but we accept this for JSON data
public struct User: @unchecked Sendable {
    public let id: String
    public let displayName: String?
    public let primaryEmail: String?
    public let primaryEmailVerified: Bool
    public let profileImageUrl: String?
    public let signedUpAt: Date
    public let clientMetadata: [String: Any]
    public let clientReadOnlyMetadata: [String: Any]
    public let hasPassword: Bool
    public let emailAuthEnabled: Bool
    public let otpAuthEnabled: Bool
    public let passkeyAuthEnabled: Bool
    public let isMultiFactorRequired: Bool
    public let isAnonymous: Bool
    public let isRestricted: Bool
    public let restrictedReason: RestrictedReason?
    public let restrictedByAdmin: Bool
    public let restrictedByAdminReason: String?
    public let oauthProviders: [OAuthProviderInfo]
    
    public struct RestrictedReason: Sendable {
        public let type: String
    }
    
    public struct OAuthProviderInfo: Sendable {
        public let id: String
    }
}

// Make User Sendable by using a wrapper for the metadata
extension User {
    init(from json: [String: Any]) {
        self.id = json["id"] as? String ?? ""
        self.displayName = json["display_name"] as? String
        self.primaryEmail = json["primary_email"] as? String
        self.primaryEmailVerified = json["primary_email_verified"] as? Bool ?? false
        self.profileImageUrl = json["profile_image_url"] as? String
        
        let millis = json["signed_up_at_millis"] as? Int64 ?? 0
        self.signedUpAt = Date(timeIntervalSince1970: Double(millis) / 1000.0)
        
        // Note: These are not truly Sendable but we accept the risk for JSON data
        self.clientMetadata = json["client_metadata"] as? [String: Any] ?? [:]
        self.clientReadOnlyMetadata = json["client_read_only_metadata"] as? [String: Any] ?? [:]
        
        self.hasPassword = json["has_password"] as? Bool ?? false
        self.emailAuthEnabled = json["auth_with_email"] as? Bool ?? false
        self.otpAuthEnabled = json["otp_auth_enabled"] as? Bool ?? false
        self.passkeyAuthEnabled = json["passkey_auth_enabled"] as? Bool ?? false
        self.isMultiFactorRequired = json["requires_totp_mfa"] as? Bool ?? false
        self.isAnonymous = json["is_anonymous"] as? Bool ?? false
        self.isRestricted = json["is_restricted"] as? Bool ?? false
        
        if let reason = json["restricted_reason"] as? [String: Any],
           let type = reason["type"] as? String {
            self.restrictedReason = RestrictedReason(type: type)
        } else {
            self.restrictedReason = nil
        }
        
        self.restrictedByAdmin = json["restricted_by_admin"] as? Bool ?? false
        self.restrictedByAdminReason = json["restricted_by_admin_reason"] as? String
        
        if let providers = json["oauth_providers"] as? [[String: Any]] {
            self.oauthProviders = providers.map { OAuthProviderInfo(id: $0["id"] as? String ?? "") }
        } else {
            self.oauthProviders = []
        }
    }
}

/// Partial user info extracted from JWT token
public struct TokenPartialUser: Sendable {
    public let id: String
    public let displayName: String?
    public let primaryEmail: String?
    public let primaryEmailVerified: Bool
    /// Team id from the access token `selected_team_id` claim. Nil when the claim is absent or null.
    public let selectedTeamId: String?
    public let isAnonymous: Bool
    public let isMultiFactorRequired: Bool
    public let isRestricted: Bool
    public let restrictedReason: User.RestrictedReason?

    public init(
        id: String,
        displayName: String?,
        primaryEmail: String?,
        primaryEmailVerified: Bool,
        selectedTeamId: String? = nil,
        isAnonymous: Bool,
        isMultiFactorRequired: Bool,
        isRestricted: Bool,
        restrictedReason: User.RestrictedReason?
    ) {
        self.id = id
        self.displayName = displayName
        self.primaryEmail = primaryEmail
        self.primaryEmailVerified = primaryEmailVerified
        self.selectedTeamId = selectedTeamId
        self.isAnonymous = isAnonymous
        self.isMultiFactorRequired = isMultiFactorRequired
        self.isRestricted = isRestricted
        self.restrictedReason = restrictedReason
    }
}

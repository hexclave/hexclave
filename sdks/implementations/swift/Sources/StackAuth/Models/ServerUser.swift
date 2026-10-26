import Foundation

/// Server-side user with elevated access and server metadata
public actor ServerUser {
    private let client: APIClient
    
    public nonisolated let id: String
    public private(set) var displayName: String?
    public private(set) var primaryEmail: String?
    public private(set) var primaryEmailVerified: Bool
    public private(set) var profileImageUrl: String?
    public let signedUpAt: Date
    public private(set) var lastActiveAt: Date?
    public private(set) var clientMetadata: [String: Any]
    public private(set) var clientReadOnlyMetadata: [String: Any]
    public private(set) var serverMetadata: [String: Any]
    public private(set) var hasPassword: Bool
    public private(set) var emailAuthEnabled: Bool
    public private(set) var otpAuthEnabled: Bool
    public private(set) var passkeyAuthEnabled: Bool
    public private(set) var isMultiFactorRequired: Bool
    public let isAnonymous: Bool
    public let isRestricted: Bool
    public let restrictedReason: User.RestrictedReason?
    public let restrictedByAdmin: Bool
    public let restrictedByAdminReason: String?
    public let restrictedByAdminPrivateDetails: String?
    public let oauthProviders: [User.OAuthProviderInfo]
    
    init(client: APIClient, json: [String: Any]) {
        self.client = client
        self.id = json["id"] as? String ?? ""
        self.displayName = json["display_name"] as? String
        self.primaryEmail = json["primary_email"] as? String
        self.primaryEmailVerified = json["primary_email_verified"] as? Bool ?? false
        self.profileImageUrl = json["profile_image_url"] as? String
        
        let signedUpMillis = json["signed_up_at_millis"] as? Int64 ?? 0
        self.signedUpAt = Date(timeIntervalSince1970: Double(signedUpMillis) / 1000.0)
        
        if let lastActiveMillis = json["last_active_at_millis"] as? Int64 {
            self.lastActiveAt = Date(timeIntervalSince1970: Double(lastActiveMillis) / 1000.0)
        } else {
            self.lastActiveAt = nil
        }
        
        self.clientMetadata = json["client_metadata"] as? [String: Any] ?? [:]
        self.clientReadOnlyMetadata = json["client_read_only_metadata"] as? [String: Any] ?? [:]
        self.serverMetadata = json["server_metadata"] as? [String: Any] ?? [:]
        
        self.hasPassword = json["has_password"] as? Bool ?? false
        self.emailAuthEnabled = json["auth_with_email"] as? Bool ?? json["primary_email_auth_enabled"] as? Bool ?? false
        self.otpAuthEnabled = json["otp_auth_enabled"] as? Bool ?? false
        self.passkeyAuthEnabled = json["passkey_auth_enabled"] as? Bool ?? false
        self.isMultiFactorRequired = json["requires_totp_mfa"] as? Bool ?? false
        self.isAnonymous = json["is_anonymous"] as? Bool ?? false
        self.isRestricted = json["is_restricted"] as? Bool ?? false
        
        if let reason = json["restricted_reason"] as? [String: Any],
           let type = reason["type"] as? String {
            self.restrictedReason = User.RestrictedReason(type: type)
        } else {
            self.restrictedReason = nil
        }
        
        self.restrictedByAdmin = json["restricted_by_admin"] as? Bool ?? false
        self.restrictedByAdminReason = json["restricted_by_admin_reason"] as? String
        self.restrictedByAdminPrivateDetails = json["restricted_by_admin_private_details"] as? String
        
        if let providers = json["oauth_providers"] as? [[String: Any]] {
            self.oauthProviders = providers.map { User.OAuthProviderInfo(id: $0["id"] as? String ?? "") }
        } else {
            self.oauthProviders = []
        }
    }
    
    // MARK: - Update
    
    public func update(
        displayName: String? = nil,
        clientMetadata: [String: Any]? = nil,
        clientReadOnlyMetadata: [String: Any]? = nil,
        serverMetadata: [String: Any]? = nil,
        selectedTeamId: String? = nil,
        primaryEmail: String? = nil,
        primaryEmailAuthEnabled: Bool? = nil,
        primaryEmailVerified: Bool? = nil,
        profileImageUrl: String? = nil,
        password: String? = nil
    ) async throws {
        var body: [String: Any] = [:]
        if let displayName = displayName { body["display_name"] = displayName }
        if let clientMeta = clientMetadata { body["client_metadata"] = clientMeta }
        if let clientReadOnly = clientReadOnlyMetadata { body["client_read_only_metadata"] = clientReadOnly }
        if let serverMeta = serverMetadata { body["server_metadata"] = serverMeta }
        if let teamId = selectedTeamId { body["selected_team_id"] = teamId }
        if let email = primaryEmail { body["primary_email"] = email }
        if let authEnabled = primaryEmailAuthEnabled { body["primary_email_auth_enabled"] = authEnabled }
        if let verified = primaryEmailVerified { body["primary_email_verified"] = verified }
        if let url = profileImageUrl { body["profile_image_url"] = url }
        if let password = password { body["password"] = password }
        
        let (data, _) = try await client.sendRequest(
            path: "/users/\(id)",
            method: "PATCH",
            body: body,
            serverOnly: true
        )
        
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            self.displayName = json["display_name"] as? String
            self.primaryEmail = json["primary_email"] as? String
            self.primaryEmailVerified = json["primary_email_verified"] as? Bool ?? self.primaryEmailVerified
            self.profileImageUrl = json["profile_image_url"] as? String
            self.clientMetadata = json["client_metadata"] as? [String: Any] ?? self.clientMetadata
            self.clientReadOnlyMetadata = json["client_read_only_metadata"] as? [String: Any] ?? self.clientReadOnlyMetadata
            self.serverMetadata = json["server_metadata"] as? [String: Any] ?? self.serverMetadata
            self.hasPassword = json["has_password"] as? Bool ?? self.hasPassword
            self.emailAuthEnabled = json["auth_with_email"] as? Bool ?? json["primary_email_auth_enabled"] as? Bool ?? self.emailAuthEnabled
            self.otpAuthEnabled = json["otp_auth_enabled"] as? Bool ?? self.otpAuthEnabled
            self.passkeyAuthEnabled = json["passkey_auth_enabled"] as? Bool ?? self.passkeyAuthEnabled
            self.isMultiFactorRequired = json["requires_totp_mfa"] as? Bool ?? self.isMultiFactorRequired
        }
    }
    
    // MARK: - Delete
    
    public func delete() async throws {
        _ = try await client.sendRequest(
            path: "/users/\(id)",
            method: "DELETE",
            serverOnly: true
        )
    }
    
    // MARK: - Password
    
    /// Set a password for this user (server-side).
    /// Unlike client-side setPassword, this uses the user update endpoint.
    public func setPassword(_ password: String) async throws {
        try await update(password: password)
    }
    
    // MARK: - Teams
    
    /// Lists all of the user's teams. Fails if the user is in more than 500 teams; use `listTeamsPage` with a `limit` to
    /// page through them instead.
    public func listTeams() async throws -> [ServerTeam] {
        return try await listTeamsPage().items
    }
    
    /// Lists one page of the user's teams. `cursor` requires `limit`.
    public func listTeamsPage(
        limit: Int? = nil,
        cursor: String? = nil,
        query: String? = nil,
        orderBy: String? = nil,
        descending: Bool? = nil
    ) async throws -> TeamPage<ServerTeam> {
        let (data, _) = try await client.sendRequest(
            path: teamListPath(userId: id, limit: limit, cursor: cursor, query: query, orderBy: orderBy, descending: descending),
            method: "GET",
            serverOnly: true
        )
        return try parseTeamPage(data: data) { ServerTeam(client: client, json: $0) }
    }
    
    /// Returns the team if the user is a member of it, nil otherwise (unlike `StackServerApp.getTeam`, which returns
    /// any team). Filters the user's teams on the ID (`query` exact-matches team IDs), as the unfiltered list is capped.
    public func getTeam(id teamId: String) async throws -> ServerTeam? {
        let teams = try await listTeamsPage(query: teamId).items
        return teams.first { $0.id == teamId }
    }
    
    // MARK: - Contact Channels
    
    public func listContactChannels() async throws -> [ContactChannel] {
        let (data, _) = try await client.sendRequest(
            path: "/contact-channels?user_id=\(id)",
            method: "GET",
            serverOnly: true
        )
        
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["items"] as? [[String: Any]] else {
            return []
        }
        
        return items.map { ContactChannel(client: client, json: $0) }
    }
    
    // MARK: - Permissions
    
    public func grantPermission(id permissionId: String, teamId: String? = nil) async throws {
        var body: [String: Any] = [
            "user_id": id,
            "permission_id": permissionId
        ]
        if let teamId = teamId { body["team_id"] = teamId }
        
        _ = try await client.sendRequest(
            path: "/permissions/grant",
            method: "POST",
            body: body,
            serverOnly: true
        )
    }
    
    public func revokePermission(id permissionId: String, teamId: String? = nil) async throws {
        var body: [String: Any] = [
            "user_id": id,
            "permission_id": permissionId
        ]
        if let teamId = teamId { body["team_id"] = teamId }
        
        _ = try await client.sendRequest(
            path: "/permissions/revoke",
            method: "POST",
            body: body,
            serverOnly: true
        )
    }
    
    public func hasPermission(id permissionId: String, teamId: String? = nil) async throws -> Bool {
        var query = "user_id=\(id)&permission_id=\(permissionId)"
        if let teamId = teamId { query += "&team_id=\(teamId)" }
        
        let (data, _) = try await client.sendRequest(
            path: "/permissions/check?\(query)",
            method: "GET",
            serverOnly: true
        )
        
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return false
        }
        
        return json["has_permission"] as? Bool ?? false
    }
    
    public func listPermissions(teamId: String? = nil, recursive: Bool = true) async throws -> [TeamPermission] {
        var query = "user_id=\(id)&recursive=\(recursive)"
        if let teamId = teamId { query += "&team_id=\(teamId)" }
        
        let (data, _) = try await client.sendRequest(
            path: "/users/\(id)/permissions?\(query)",
            method: "GET",
            serverOnly: true
        )
        
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["items"] as? [[String: Any]] else {
            return []
        }
        
        return items.map { TeamPermission(id: $0["id"] as? String ?? "") }
    }
    
    // MARK: - Sessions
    
    public func getActiveSessions() async throws -> [ActiveSession] {
        let (data, _) = try await client.sendRequest(
            path: "/users/\(id)/sessions",
            method: "GET",
            serverOnly: true
        )
        
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let items = json["items"] as? [[String: Any]] else {
            return []
        }
        
        return items.map { ActiveSession(from: $0) }
    }
    
    public func revokeSession(id sessionId: String) async throws {
        _ = try await client.sendRequest(
            path: "/users/\(id)/sessions/\(sessionId)",
            method: "DELETE",
            serverOnly: true
        )
    }
}

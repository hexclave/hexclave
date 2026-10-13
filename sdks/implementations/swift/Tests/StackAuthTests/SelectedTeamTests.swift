import Foundation
import Testing
@testable import StackAuth

@Suite("Selected team")
struct SelectedTeamTests {
    private func client() -> APIClient {
        APIClient(
            baseUrl: "http://localhost",
            projectId: "internal",
            publishableClientKey: "key",
            tokenStore: MemoryTokenStore()
        )
    }

    private func unsignedJwt(_ payload: [String: Any]) throws -> String {
        let body = try JSONSerialization.data(withJSONObject: payload)
        func base64Url(_ data: Data) -> String {
            data.base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        let header = Data(#"{"alg":"none"}"#.utf8)
        return "\(base64Url(header)).\(base64Url(body)).sig"
    }

    @Test("Partial user reads selected_team_id from the access token")
    func partialUserReadsSelectedTeamId() async throws {
        let store = MemoryTokenStore()
        let app = TestConfig.createClientApp(tokenStore: .custom(store))
        let token = try unsignedJwt([
            "sub": "user-1",
            "email": "ada@example.com",
            "email_verified": true,
            "selected_team_id": "team-1",
            "exp": Date().timeIntervalSince1970 + 3600,
        ])
        await store.setTokens(accessToken: token, refreshToken: nil)

        let user = await app.getPartialUser()
        #expect(user?.id == "user-1")
        #expect(user?.selectedTeamId == "team-1")
    }

    @Test("Partial user treats a missing or null selected_team_id as nil")
    func partialUserWithoutSelectedTeam() async throws {
        let missingStore = MemoryTokenStore()
        let missingApp = TestConfig.createClientApp(tokenStore: .custom(missingStore))
        let missingToken = try unsignedJwt([
            "sub": "user-1",
            "exp": Date().timeIntervalSince1970 + 3600,
        ])
        await missingStore.setTokens(accessToken: missingToken, refreshToken: nil)
        let missing = await missingApp.getPartialUser()
        #expect(missing?.selectedTeamId == nil)

        let nullStore = MemoryTokenStore()
        let nullApp = TestConfig.createClientApp(tokenStore: .custom(nullStore))
        let nullToken = try unsignedJwt([
            "sub": "user-1",
            "selected_team_id": NSNull(),
            "exp": Date().timeIntervalSince1970 + 3600,
        ])
        await nullStore.setTokens(accessToken: nullToken, refreshToken: nil)
        let nullTeam = await nullApp.getPartialUser()
        #expect(nullTeam?.selectedTeamId == nil)
    }

    @Test("Server user exposes the selected team as a server team")
    func serverUserSelectedTeam() async {
        let selected = ServerUser(client: client(), json: [
            "id": "user-1",
            "selected_team": [
                "id": "team-1",
                "display_name": "Alpha",
                "created_at_millis": 0,
            ],
        ])
        let team = await selected.selectedTeam
        #expect(team?.id == "team-1")
        #expect(await team?.displayName == "Alpha")

        let none = ServerUser(client: client(), json: [
            "id": "user-1",
            "selected_team": NSNull(),
        ])
        #expect(await none.selectedTeam == nil)
    }
}

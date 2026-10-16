import Testing
import Foundation
@testable import StackAuth

@Suite("Team Tests - Client")
struct ClientTeamTests {
    
    // MARK: - Team Creation Tests
    
    @Test("Should create team with display name")
    func createTeamWithDisplayName() async throws {
        let app = TestConfig.createClientApp()
        let email = TestConfig.uniqueEmail()
        
        try await app.signUpWithCredential(email: email, password: TestConfig.testPassword)
        
        let user = try await app.getUser()
        #expect(user != nil)
        
        let teamName = TestConfig.uniqueTeamName()
        let team = try await user?.createTeam(displayName: teamName)
        
        #expect(team != nil)
        
        let displayName = await team?.displayName
        #expect(displayName == teamName)
    }
    
    @Test("Should create team with metadata")
    func createTeamWithMetadata() async throws {
        // Use server app for full control over team creation
        let serverApp = TestConfig.createServerApp()
        let teamName = TestConfig.uniqueTeamName()
        
        let team = try await serverApp.createTeam(
            displayName: teamName,
            clientMetadata: ["type": "test"]
        )
        
        let clientMetadata: [String: Any] = await team.clientMetadata
        let typeValue = clientMetadata["type"] as? String
        #expect(typeValue == "test")
        
        // Clean up
        try await team.delete()
    }
    
    @Test("Should add creator to team on creation")
    func creatorAddedToTeam() async throws {
        let app = TestConfig.createClientApp()
        let email = TestConfig.uniqueEmail()
        
        try await app.signUpWithCredential(email: email, password: TestConfig.testPassword)
        
        let user = try await app.getUser()
        let userId = await user?.id
        
        let team = try await user?.createTeam(displayName: TestConfig.uniqueTeamName())
        
        // List team users and verify creator is included
        let teamUsers = try await team?.listUsers() ?? []
        let creatorFound = teamUsers.contains { $0.id == userId }
        #expect(creatorFound)
    }
    
    // MARK: - Team Listing Tests
    
    @Test("Should list user's teams")
    func listUserTeams() async throws {
        let app = TestConfig.createClientApp()
        let email = TestConfig.uniqueEmail()
        
        try await app.signUpWithCredential(email: email, password: TestConfig.testPassword)
        
        let user = try await app.getUser()
        
        // Create multiple teams
        let team1 = try await user?.createTeam(displayName: "Team 1 \(UUID().uuidString.prefix(4))")
        let team2 = try await user?.createTeam(displayName: "Team 2 \(UUID().uuidString.prefix(4))")
        
        let teams = try await user?.listTeams() ?? []
        
        #expect(teams.count >= 2)
        #expect(teams.contains { $0.id == team1?.id })
        #expect(teams.contains { $0.id == team2?.id })
    }
    
    @Test("Should get team by ID")
    func getTeamById() async throws {
        let app = TestConfig.createClientApp()
        let email = TestConfig.uniqueEmail()
        
        try await app.signUpWithCredential(email: email, password: TestConfig.testPassword)
        
        let user = try await app.getUser()
        let teamName = TestConfig.uniqueTeamName()
        let createdTeam = try await user?.createTeam(displayName: teamName)
        let teamId = createdTeam?.id
        
        #expect(teamId != nil)
        
        let fetchedTeam = try await user?.getTeam(id: teamId!)
        
        #expect(fetchedTeam != nil)
        
        let fetchedName = await fetchedTeam?.displayName
        #expect(fetchedName == teamName)
    }
    
    @Test("Should return nil for non-member team")
    func getNonMemberTeam() async throws {
        let serverApp = TestConfig.createServerApp()
        
        // Create a team via server (user not a member)
        let team = try await serverApp.createTeam(displayName: TestConfig.uniqueTeamName())
        let teamId = team.id
        
        // Try to get it as a different user
        let clientApp = TestConfig.createClientApp()
        try await clientApp.signUpWithCredential(email: TestConfig.uniqueEmail(), password: TestConfig.testPassword)
        
        let user = try await clientApp.getUser()
        let fetchedTeam = try await user?.getTeam(id: teamId)
        
        // Should be nil since user is not a member
        #expect(fetchedTeam == nil)
        
        // Clean up
        try await team.delete()
    }
    
    // MARK: - Team Update Tests
    
    @Test("Should update team display name")
    func updateTeamDisplayName() async throws {
        let app = TestConfig.createClientApp()
        let email = TestConfig.uniqueEmail()
        
        try await app.signUpWithCredential(email: email, password: TestConfig.testPassword)
        
        let user = try await app.getUser()
        let team = try await user?.createTeam(displayName: "Original Name")
        
        let newName = "Updated Name \(UUID().uuidString.prefix(8))"
        try await team?.update(displayName: newName)
        
        let displayName = await team?.displayName
        #expect(displayName == newName)
    }
    
    @Test("Should update team profile image")
    func updateTeamProfileImage() async throws {
        // Use server app for updating team properties to avoid permission issues
        let serverApp = TestConfig.createServerApp()
        
        let team = try await serverApp.createTeam(displayName: TestConfig.uniqueTeamName())
        
        let newImageUrl = "https://example.com/new-image.png"
        try await team.update(profileImageUrl: newImageUrl)
        
        let profileImageUrl = await team.profileImageUrl
        #expect(profileImageUrl == newImageUrl)
        
        // Clean up
        try await team.delete()
    }
    
    @Test("Should update team client metadata")
    func updateTeamClientMetadata() async throws {
        let app = TestConfig.createClientApp()
        let email = TestConfig.uniqueEmail()
        
        try await app.signUpWithCredential(email: email, password: TestConfig.testPassword)
        
        let user = try await app.getUser()
        let team = try await user?.createTeam(displayName: TestConfig.uniqueTeamName())
        
        try await team?.update(clientMetadata: ["plan": "pro", "seats": 10])
        
        let clientMetadata: [String: Any]? = await team?.clientMetadata
        let planValue = clientMetadata?["plan"] as? String
        let seatsValue = clientMetadata?["seats"] as? Int
        #expect(planValue == "pro")
        #expect(seatsValue == 10)
    }
    
    // MARK: - Team Deletion Tests
    // Note: Client-side team deletion requires specific permissions
    // These tests are covered in the server-side team tests instead
    
    // MARK: - Team Members Tests
    
    @Test("Should list team members")
    func listTeamMembers() async throws {
        let app = TestConfig.createClientApp()
        let email = TestConfig.uniqueEmail()
        
        try await app.signUpWithCredential(email: email, password: TestConfig.testPassword)
        
        let user = try await app.getUser()
        let team = try await user?.createTeam(displayName: TestConfig.uniqueTeamName())
        
        let members = try await team?.listUsers() ?? []
        
        // Should have at least the creator
        #expect(!members.isEmpty)
    }
}

@Suite("Team Tests - Server")
struct ServerTeamTests {
    
    // MARK: - Team Creation Tests
    
    @Test("Should create team with server app")
    func createTeamWithServer() async throws {
        let app = TestConfig.createServerApp()
        let teamName = TestConfig.uniqueTeamName()
        
        let team = try await app.createTeam(displayName: teamName)
        
        let displayName = await team.displayName
        #expect(displayName == teamName)
        
        // Clean up
        try await team.delete()
    }
    
    @Test("Should create team with creator user")
    func createTeamWithCreator() async throws {
        let app = TestConfig.createServerApp()
        let email = TestConfig.uniqueEmail()
        
        let user = try await app.createUser(email: email)
        let userId = user.id
        
        let team = try await app.createTeam(
            displayName: TestConfig.uniqueTeamName(),
            creatorUserId: userId
        )
        
        // Verify user is in team
        let teamUsers = try await team.listUsers()
        let found = teamUsers.contains { $0.id == userId }
        #expect(found)
        
        // Clean up
        try await team.delete()
        try await user.delete()
    }
    
    @Test("Should create team with all options")
    func createTeamWithAllOptions() async throws {
        let app = TestConfig.createServerApp()
        
        let team = try await app.createTeam(
            displayName: TestConfig.uniqueTeamName(),
            profileImageUrl: "https://example.com/image.png",
            clientMetadata: ["tier": "enterprise"],
            serverMetadata: ["billing_id": "bill_123"]
        )
        
        let profileImageUrl = await team.profileImageUrl
        let clientMeta = await team.clientMetadata
        let serverMeta = await team.serverMetadata
        
        #expect(profileImageUrl == "https://example.com/image.png")
        #expect(clientMeta["tier"] as? String == "enterprise")
        #expect(serverMeta["billing_id"] as? String == "bill_123")
        
        // Clean up
        try await team.delete()
    }
    
    // MARK: - Team Listing Tests
    
    @Test("Should list all teams")
    func listAllTeams() async throws {
        let app = TestConfig.createServerApp()
        
        let team = try await app.createTeam(displayName: TestConfig.uniqueTeamName())
        
        // The test project is shared and can hold more than the 200 teams `listTeams()` returns, so search by ID.
        let teams = try await app.listTeamsPage(query: team.id).items
        
        let found = teams.contains { $0.id == team.id }
        #expect(found)
        
        // Clean up
        try await team.delete()
    }
    
    @Test("Should list teams for specific user")
    func listTeamsForUser() async throws {
        let app = TestConfig.createServerApp()
        let email = TestConfig.uniqueEmail()
        
        let user = try await app.createUser(email: email)
        let userId = user.id
        
        // Create team with user as member
        let team = try await app.createTeam(
            displayName: TestConfig.uniqueTeamName(),
            creatorUserId: userId
        )
        
        // List teams for this user
        let teams = try await app.listTeams(userId: userId)
        
        let found = teams.contains { $0.id == team.id }
        #expect(found)
        
        // Clean up
        try await team.delete()
        try await user.delete()
    }
    
    @Test("Should get team by ID")
    func getTeamById() async throws {
        let app = TestConfig.createServerApp()
        let teamName = TestConfig.uniqueTeamName()
        
        let createdTeam = try await app.createTeam(displayName: teamName)
        let teamId = createdTeam.id
        
        let fetchedTeam = try await app.getTeam(id: teamId)
        
        #expect(fetchedTeam != nil)
        
        let fetchedName = await fetchedTeam?.displayName
        #expect(fetchedName == teamName)
        
        // Clean up
        try await createdTeam.delete()
    }
    
    @Test("Should return nil for non-existent team")
    func getNonExistentTeam() async throws {
        let app = TestConfig.createServerApp()
        
        let fakeTeamId = UUID().uuidString
        let team = try await app.getTeam(id: fakeTeamId)
        
        #expect(team == nil)
    }
    
    // MARK: - Team Update Tests
    
    @Test("Should update team via server")
    func updateTeamViaServer() async throws {
        let app = TestConfig.createServerApp()
        
        let team = try await app.createTeam(displayName: "Original")
        
        try await team.update(
            displayName: "Updated",
            serverMetadata: ["status": "active"]
        )
        
        let displayName = await team.displayName
        let serverMeta = await team.serverMetadata
        
        #expect(displayName == "Updated")
        #expect(serverMeta["status"] as? String == "active")
        
        // Clean up
        try await team.delete()
    }
    
    // MARK: - Team Membership Tests
    
    @Test("Should add user to team")
    func addUserToTeam() async throws {
        let app = TestConfig.createServerApp()
        
        let user = try await app.createUser(email: TestConfig.uniqueEmail())
        let userId = user.id
        
        let team = try await app.createTeam(displayName: TestConfig.uniqueTeamName())
        
        try await team.addUser(id: userId)
        
        let teamUsers = try await team.listUsers()
        let found = teamUsers.contains { $0.id == userId }
        #expect(found)
        
        // Clean up
        try await team.delete()
        try await user.delete()
    }
    
    @Test("Should remove user from team")
    func removeUserFromTeam() async throws {
        let app = TestConfig.createServerApp()
        
        let user = try await app.createUser(email: TestConfig.uniqueEmail())
        let userId = user.id
        
        let team = try await app.createTeam(displayName: TestConfig.uniqueTeamName())
        
        // Add user
        try await team.addUser(id: userId)
        
        var teamUsers = try await team.listUsers()
        var found = teamUsers.contains { $0.id == userId }
        #expect(found)
        
        // Remove user
        try await team.removeUser(id: userId)
        
        teamUsers = try await team.listUsers()
        found = teamUsers.contains { $0.id == userId }
        #expect(!found)
        
        // Clean up
        try await team.delete()
        try await user.delete()
    }
    
    @Test("Should list team users")
    func listTeamUsers() async throws {
        let app = TestConfig.createServerApp()
        
        let user1 = try await app.createUser(email: TestConfig.uniqueEmail())
        let user2 = try await app.createUser(email: TestConfig.uniqueEmail())
        
        let team = try await app.createTeam(displayName: TestConfig.uniqueTeamName())
        
        try await team.addUser(id: user1.id)
        try await team.addUser(id: user2.id)
        
        let teamUsers = try await team.listUsers()
        
        #expect(teamUsers.count >= 2)
        #expect(teamUsers.contains { $0.id == user1.id })
        #expect(teamUsers.contains { $0.id == user2.id })
        
        // Clean up
        try await team.delete()
        try await user1.delete()
        try await user2.delete()
    }
    
    // MARK: - Team Deletion Tests
    
    @Test("Should delete team via server")
    func deleteTeamViaServer() async throws {
        let app = TestConfig.createServerApp()
        
        let team = try await app.createTeam(displayName: TestConfig.uniqueTeamName())
        let teamId = team.id
        
        try await team.delete()
        
        let deletedTeam = try await app.getTeam(id: teamId)
        #expect(deletedTeam == nil)
    }
}

@Suite("Team Tests - Pagination")
struct TeamPaginationTests {
    /// Creates `count` teams with `userId` as a member, 20 at a time, and returns their IDs in creation order.
    /// Creates `count` teams in batches of 20, in batch order. If any creation fails, the teams created so far are
    /// deleted before rethrowing, so a failed run doesn't leave them behind in the shared test project.
    private func createTeams(count: Int, creatorUserId: String, app: StackServerApp) async throws -> [ServerTeam] {
        var teams: [ServerTeam] = []
        for batchStart in stride(from: 0, to: count, by: 20) {
            let batch = await withTaskGroup(of: (Int, Result<ServerTeam, Error>).self) { group in
                for index in batchStart..<min(batchStart + 20, count) {
                    group.addTask {
                        do {
                            return (index, .success(try await app.createTeam(displayName: "Paged Team \(index)", creatorUserId: creatorUserId)))
                        } catch {
                            return (index, .failure(error))
                        }
                    }
                }
                var results: [(Int, Result<ServerTeam, Error>)] = []
                for await result in group { results.append(result) }
                return results
            }
            // Concurrent creation within a batch has no defined order, so we only rely on batch order below.
            var firstError: Error?
            for (_, result) in batch.sorted(by: { $0.0 < $1.0 }) {
                switch result {
                case .success(let team): teams.append(team)
                case .failure(let error): firstError = firstError ?? error
                }
            }
            if let firstError {
                try await deleteTeams(teams)
                throw firstError
            }
        }
        return teams
    }

    private func deleteTeams(_ teams: [ServerTeam]) async throws {
        for batchStart in stride(from: 0, to: teams.count, by: 20) {
            try await withThrowingTaskGroup(of: Void.self) { group in
                for team in teams[batchStart..<min(batchStart + 20, teams.count)] {
                    group.addTask { try await team.delete() }
                }
                try await group.waitForAll()
            }
        }
    }

    @Test("Should page through the current user's teams")
    func pageCurrentUserTeams() async throws {
        let app = TestConfig.createClientApp()
        try await app.signUpWithCredential(email: TestConfig.uniqueEmail(), password: TestConfig.testPassword)
        let user = try #require(try await app.getUser())

        // The test project may create a personal team on sign-up, so include whatever teams already exist.
        var expected = try await user.listTeams().map { $0.id }
        for index in 0..<(4 - expected.count) {
            expected.append(try await user.createTeam(displayName: "Page \(index)").id)
        }

        let page1 = try await user.listTeamsPage(limit: 3)
        #expect(page1.items.map { $0.id } == Array(expected[0..<3]))
        #expect(page1.nextCursor?.hasSuffix("_\(expected[2])") == true)

        let page2 = try await user.listTeamsPage(limit: 3, cursor: try #require(page1.nextCursor))
        #expect(page2.items.map { $0.id } == [expected[3]])
        #expect(page2.nextCursor == nil)

        let newestFirst = try await user.listTeamsPage(orderBy: "created_at", descending: true)
        #expect(newestFirst.items.map { $0.id } == expected.reversed())

        let all = try await user.listTeams()
        #expect(all.map { $0.id } == expected)
    }

    @Test("Should search teams with characters that need URL encoding")
    func searchWithSpecialCharacters() async throws {
        let app = TestConfig.createClientApp()
        try await app.signUpWithCredential(email: TestConfig.uniqueEmail(), password: TestConfig.testPassword)
        let user = try #require(try await app.getUser())

        let plus = try await user.createTeam(displayName: "R+D & Ops")
        _ = try await user.createTeam(displayName: "R D Ops")

        let found = try await user.listTeamsPage(query: "R+D & Ops").items
        #expect(found.map { $0.id } == [plus.id])
    }

    @Test("Should return nil from getTeam for teams the user is not a member of")
    func getTeamMembershipCheck() async throws {
        let serverApp = TestConfig.createServerApp()
        let app = TestConfig.createClientApp()
        try await app.signUpWithCredential(email: TestConfig.uniqueEmail(), password: TestConfig.testPassword)
        let user = try #require(try await app.getUser())
        let serverUser = try #require(try await serverApp.getUser(id: user.id))

        let myTeam = try await user.createTeam(displayName: TestConfig.uniqueTeamName())
        let otherTeam = try await serverApp.createTeam(displayName: TestConfig.uniqueTeamName())

        #expect(try await user.getTeam(id: myTeam.id)?.id == myTeam.id)
        #expect(try await user.getTeam(id: otherTeam.id) == nil)
        #expect(try await user.getTeam(id: "not-a-uuid") == nil)
        #expect(try await serverUser.getTeam(id: myTeam.id)?.id == myTeam.id)
        #expect(try await serverUser.getTeam(id: otherTeam.id) == nil)

        try await otherTeam.delete()
    }

    @Test("Should list a server user's teams")
    func listServerUserTeams() async throws {
        let serverApp = TestConfig.createServerApp()
        let user = try await serverApp.createUser(email: TestConfig.uniqueEmail())
        let team = try await serverApp.createTeam(displayName: TestConfig.uniqueTeamName(), creatorUserId: user.id)

        let teams = try await user.listTeams()
        #expect(teams.contains { $0.id == team.id })
        #expect(try await user.listTeamsPage(query: team.id).items.map { $0.id } == [team.id])

        try await team.delete()
        try await user.delete()
    }

    @Test("Should find a team past the first 200 with getTeam")
    func getTeamPastCap() async throws {
        let serverApp = TestConfig.createServerApp()
        let email = TestConfig.uniqueEmail()
        let serverUser = try await serverApp.createUser(email: email, password: TestConfig.testPassword, primaryEmailAuthEnabled: true)

        // Create the teams before signing in: creating 201 teams can outlive a dev access token.
        let teams: [ServerTeam]
        do {
            teams = try await createTeams(count: 201, creatorUserId: serverUser.id, app: serverApp)
        } catch {
            try await serverUser.delete()
            throw error
        }

        // TestConfig binds every test app to the shared `internal` project, so the 201 teams and the user are
        // deleted whether the assertions below pass or throw (`#require` throws on failure).
        do {
            let newestId = try #require(teams.last?.id)

            let app = TestConfig.createClientApp()
            try await app.signInWithCredential(email: email, password: TestConfig.testPassword)
            let user = try #require(try await app.getUser())

            let firstPage = try await user.listTeamsPage()
            #expect(firstPage.items.count == 200)
            #expect(!firstPage.items.contains { $0.id == newestId })
            let nextPage = try await user.listTeamsPage(limit: 200, cursor: try #require(firstPage.nextCursor))
            #expect(nextPage.items.last?.id == newestId)
            #expect(nextPage.nextCursor == nil)
            let total = firstPage.items.count + nextPage.items.count
            #expect(total >= 201)

            #expect(try await user.getTeam(id: newestId)?.id == newestId)
            #expect(try await serverUser.getTeam(id: newestId)?.id == newestId)
        } catch {
            try await deleteTeams(teams)
            try await serverUser.delete()
            throw error
        }
        try await deleteTeams(teams)
        try await serverUser.delete()
    }
}

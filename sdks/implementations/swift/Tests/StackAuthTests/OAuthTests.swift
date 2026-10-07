import Testing
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import StackAuth

@Suite("OAuth Tests")
struct OAuthTests {
    
    // Default test URLs (must be absolute URLs)
    let testRedirectUrl = "hexclave-mobile-oauth-url://success"
    let testErrorRedirectUrl = "hexclave-mobile-oauth-url://error"
    
    // MARK: - OAuth URL Generation Tests
    
    @Test("Should generate OAuth URL for Google")
    func generateOAuthUrlForGoogle() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result.url.absoluteString.contains("oauth/authorize/google"))
        #expect(!result.state.isEmpty)
        #expect(!result.codeVerifier.isEmpty)
    }
    
    @Test("Should generate OAuth URL for GitHub")
    func generateOAuthUrlForGitHub() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "github", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result.url.absoluteString.contains("oauth/authorize/github"))
        #expect(!result.state.isEmpty)
        #expect(!result.codeVerifier.isEmpty)
    }
    
    @Test("Should generate OAuth URL for Microsoft")
    func generateOAuthUrlForMicrosoft() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "microsoft", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result.url.absoluteString.contains("oauth/authorize/microsoft"))
        #expect(!result.state.isEmpty)
        #expect(!result.codeVerifier.isEmpty)
    }
    
    @Test("Should include project ID in OAuth URL")
    func oauthUrlIncludesProjectId() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result.url.absoluteString.contains("client_id=\(testProjectId)"))
    }

    @Test("Should use sentinel client_secret when publishable key is missing")
    func oauthUrlUsesSentinelWhenPublishableKeyMissing() async throws {
        let app = TestConfig.createClientApp(publishableClientKey: nil)
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result.url.absoluteString.contains("client_secret=\(publishableClientKeyNotNecessarySentinel)"))
    }

    @Test("Should use publishable key when available for OAuth client_secret")
    func oauthUrlUsesPublishableKeyWhenAvailable() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result.url.absoluteString.contains("client_secret=\(testPublishableClientKey)"))
    }

    @Test("Should resolve OAuth client secret from API client")
    func apiClientResolvesOAuthClientSecret() async throws {
        let appWithKey = TestConfig.createClientApp()
        let appWithoutKey = TestConfig.createClientApp(publishableClientKey: nil)
        
        let secretWithKey = await appWithKey.client.getOAuthClientSecret()
        let secretWithoutKey = await appWithoutKey.client.getOAuthClientSecret()
        
        #expect(secretWithKey == testPublishableClientKey)
        #expect(secretWithoutKey == publishableClientKeyNotNecessarySentinel)
    }
    
    @Test("Should include state in OAuth URL")
    func oauthUrlIncludesState() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        // URL should contain the state parameter
        #expect(result.url.absoluteString.contains("state="))
    }
    
    @Test("Should generate PKCE code verifier")
    func generatesPkceCodeVerifier() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        // Code verifier should be long enough for security (43-128 chars for PKCE)
        #expect(result.codeVerifier.count >= 43)
    }
    
    @Test("Should generate unique state for each call")
    func generatesUniqueState() async throws {
        let app = TestConfig.createClientApp()
        
        let result1 = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        let result2 = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result1.state != result2.state)
    }
    
    @Test("Should generate unique code verifier for each call")
    func generatesUniqueCodeVerifier() async throws {
        let app = TestConfig.createClientApp()
        
        let result1 = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        let result2 = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result1.codeVerifier != result2.codeVerifier)
    }
    
    @Test("Should handle case-insensitive provider name")
    func caseInsensitiveProvider() async throws {
        let app = TestConfig.createClientApp()
        
        let result1 = try await app.getOAuthUrl(provider: "Google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        let result2 = try await app.getOAuthUrl(provider: "GOOGLE", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        let result3 = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        // All should generate valid URLs with google provider
        #expect(result1.url.absoluteString.contains("oauth/authorize/google"))
        #expect(result2.url.absoluteString.contains("oauth/authorize/google"))
        #expect(result3.url.absoluteString.contains("oauth/authorize/google"))
    }
    
    @Test("Should include code challenge in URL")
    func includesCodeChallenge() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        // URL should contain PKCE code challenge
        #expect(result.url.absoluteString.contains("code_challenge="))
        #expect(result.url.absoluteString.contains("code_challenge_method=S256"))
    }
    
    // MARK: - Redirect URL Tests
    // Note: Invalid URL validation (missing scheme) now panics and cannot be tested
    
    @Test("Should return the exact redirect URL provided")
    func returnsExactRedirectUrl() async throws {
        let app = TestConfig.createClientApp()
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: testRedirectUrl, errorRedirectUrl: testErrorRedirectUrl)
        
        #expect(result.redirectUrl == testRedirectUrl)
    }
    
    @Test("Should accept https URLs")
    func acceptsHttpsUrls() async throws {
        let app = TestConfig.createClientApp()
        let httpsUrl = "https://myapp.com/callback"
        let httpsErrorUrl = "https://myapp.com/error"
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: httpsUrl, errorRedirectUrl: httpsErrorUrl)
        
        #expect(result.redirectUrl == httpsUrl)
    }
    
    @Test("Should accept custom scheme URLs")
    func acceptsCustomSchemeUrls() async throws {
        let app = TestConfig.createClientApp()
        let customUrl = "myapp://oauth/callback"
        let customErrorUrl = "myapp://error"
        
        let result = try await app.getOAuthUrl(provider: "google", redirectUrl: customUrl, errorRedirectUrl: customErrorUrl)
        
        #expect(result.redirectUrl == customUrl)
    }

    // MARK: - Token Exchange Error Tests

    @Test("Should surface the known error from a failed token exchange")
    func callOAuthCallbackSurfacesKnownError() async throws {
        let app = TestConfig.createClientApp()
        let callbackUrl = URL(string: "\(testRedirectUrl)?code=invalid-authorization-code")!

        do {
            try await app.callOAuthCallback(
                url: callbackUrl,
                codeVerifier: String(repeating: "a", count: 43),
                redirectUrl: testRedirectUrl
            )
            Issue.record("Expected INVALID_AUTHORIZATION_CODE error")
        } catch let error as StackAuthErrorProtocol {
            #expect(error.code == "INVALID_AUTHORIZATION_CODE")
        }
    }
}

@Suite("OAuth Token Exchange Error Parsing Tests")
struct OAuthTokenExchangeErrorParsingTests {
    private func makeResponse(status: Int, headers: [String: String] = [:]) -> HTTPURLResponse {
        HTTPURLResponse(
            url: URL(string: "http://localhost/api/v1/auth/oauth/token")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: headers
        )!
    }

    private func makeBody(_ json: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: json)
    }

    @Test("Should surface MULTI_FACTOR_AUTHENTICATION_REQUIRED with its attempt code")
    func mfaRequiredKnownError() throws {
        let response = makeResponse(status: 400, headers: [
            "x-stack-known-error": "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
            "x-hexclave-known-error": "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
        ])
        let data = try makeBody([
            "code": "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
            "error": "Multi-factor authentication is required for this user.",
            "details": ["attempt_code": "attempt-code-123"],
        ])

        let error = StackAuthError.fromHTTPErrorResponse(data: data, response: response)

        let mfaError = try #require(error as? MultiFactorAuthenticationRequiredError)
        #expect(mfaError.attemptCode == "attempt-code-123")
        #expect(mfaError.code == "MULTI_FACTOR_AUTHENTICATION_REQUIRED")
    }

    @Test("Should read the known error code from the legacy header alone")
    func mfaRequiredLegacyHeaderOnly() throws {
        let response = makeResponse(status: 400, headers: [
            "x-stack-known-error": "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
        ])
        let data = try makeBody([
            "code": "MULTI_FACTOR_AUTHENTICATION_REQUIRED",
            "error": "Multi-factor authentication is required for this user.",
            "details": ["attempt_code": "legacy-attempt"],
        ])

        let error = StackAuthError.fromHTTPErrorResponse(data: data, response: response)

        let mfaError = try #require(error as? MultiFactorAuthenticationRequiredError)
        #expect(mfaError.attemptCode == "legacy-attempt")
    }

    @Test("Should keep the code and message of other known errors")
    func otherKnownError() throws {
        let response = makeResponse(status: 400, headers: [
            "x-stack-known-error": "INVALID_AUTHORIZATION_CODE",
            "x-hexclave-known-error": "INVALID_AUTHORIZATION_CODE",
        ])
        let data = try makeBody([
            "code": "INVALID_AUTHORIZATION_CODE",
            "error": "The given authorization code is invalid.",
        ])

        let error = try #require(StackAuthError.fromHTTPErrorResponse(data: data, response: response))

        #expect(error is StackAuthError)
        #expect(error.code == "INVALID_AUTHORIZATION_CODE")
        #expect(error.message == "The given authorization code is invalid.")
    }

    @Test("Should map known errors with dedicated types")
    func typedKnownError() throws {
        let response = makeResponse(status: 400, headers: [
            "x-stack-known-error": "REDIRECT_URL_NOT_WHITELISTED",
        ])
        let data = try makeBody([
            "code": "REDIRECT_URL_NOT_WHITELISTED",
            "error": "Redirect URL not whitelisted.",
        ])

        let error = StackAuthError.fromHTTPErrorResponse(data: data, response: response)

        #expect(error is RedirectUrlNotWhitelistedError)
    }

    @Test("Should parse a plain OAuth error body as OAuthError")
    func plainOAuthError() throws {
        let response = makeResponse(status: 400)
        let data = try makeBody([
            "error": "invalid_request",
            "error_description": "Missing parameter: `code`",
        ])

        let error = try #require(StackAuthError.fromHTTPErrorResponse(data: data, response: response))

        #expect(error is OAuthError)
        #expect(error.code == "invalid_request")
        #expect(error.message == "Missing parameter: `code`")
    }

    @Test("Should return nil for error responses without error details")
    func unparseableErrorBody() throws {
        let response = makeResponse(status: 400)
        let data = Data("Invalid redirect URI.".utf8)

        #expect(StackAuthError.fromHTTPErrorResponse(data: data, response: response) == nil)
    }
}

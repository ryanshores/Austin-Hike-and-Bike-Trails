import AtlasShared
import XCTest
@testable import AtlasMobile

final class KeychainNativeSessionStoreTests: XCTestCase {
    private var store: KeychainNativeSessionStore!

    override func setUpWithError() throws {
        store = KeychainNativeSessionStore(service: "us.ryanshores.atlas.tests.\(UUID().uuidString)")
        try store.clear()
    }

    override func tearDownWithError() throws {
        try store.clear()
        store = nil
    }

    func testRoundTripsCompleteSession() throws {
        try store.save(session: NativeSession(
            accessToken: "access-one",
            refreshToken: "refresh-one",
            installationCredential: "installation-one",
            ownerId: "owner-one"
        ))

        let loaded = try XCTUnwrap(store.load().session)
        XCTAssertEqual(loaded.accessToken, "access-one")
        XCTAssertEqual(loaded.refreshToken, "refresh-one")
        XCTAssertEqual(loaded.installationCredential, "installation-one")
        XCTAssertEqual(loaded.ownerId, "owner-one")
    }

    func testSaveRotatesTokensWithoutDiscardingInstallationCredential() throws {
        try store.save(session: NativeSession(
            accessToken: "access-one",
            refreshToken: "refresh-one",
            installationCredential: "installation-one",
            ownerId: "owner-one"
        ))
        try store.save(session: NativeSession(
            accessToken: "access-two",
            refreshToken: "refresh-two",
            installationCredential: nil,
            ownerId: "owner-one"
        ))

        let loaded = try XCTUnwrap(store.load().session)
        XCTAssertEqual(loaded.accessToken, "access-two")
        XCTAssertEqual(loaded.refreshToken, "refresh-two")
        XCTAssertEqual(loaded.installationCredential, "installation-one")
    }

    func testSaveDoesNotCarryInstallationCredentialAcrossOwners() throws {
        try store.save(session: NativeSession(
            accessToken: "access-one",
            refreshToken: "refresh-one",
            installationCredential: "installation-one",
            ownerId: "owner-one"
        ))
        try store.save(session: NativeSession(
            accessToken: "access-two",
            refreshToken: "refresh-two",
            installationCredential: nil,
            ownerId: "owner-two"
        ))

        let loaded = try XCTUnwrap(store.load().session)
        XCTAssertEqual(loaded.ownerId, "owner-two")
        XCTAssertNil(loaded.installationCredential)
    }

    func testClearRemovesSessionAndIsIdempotent() throws {
        try store.save(session: NativeSession(
            accessToken: "access",
            refreshToken: "refresh",
            installationCredential: nil,
            ownerId: "owner-one"
        ))

        try store.clear()
        try store.clear()
        XCTAssertNil(try store.load().session)
    }

    func testRejectsIncompleteSession() throws {
        XCTAssertThrowsError(try store.save(session: NativeSession(
            accessToken: "",
            refreshToken: "refresh",
            installationCredential: nil,
            ownerId: "owner-one"
        ))) { error in
            XCTAssertEqual(error as? KeychainSessionError, .incompleteSession)
        }
        XCTAssertNil(try store.load().session)
    }
}

@MainActor
final class NativeSessionHostTests: XCTestCase {
    func testPrepareRefreshesAnExpiredAccessTokenAndVerifiesTheOwner() async throws {
        let store = MemoryNativeSessionStore(session: Self.session(access: "access-old", refresh: "refresh-old"))
        var requests: [URLRequest] = []
        let client = FakeNativeSessionClient { request in
            requests.append(request)
            switch request.url?.path {
            case "/api/mobile/v1/auth/me":
                if request.value(forHTTPHeaderField: "Authorization") == "Bearer access-old" {
                    return Self.response(status: 401)
                }
                return Self.response(status: 200, body: Self.user(id: "owner-one"))
            case "/api/mobile/v1/auth/refresh":
                XCTAssertEqual(request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["refreshToken"], "refresh-old")
                return Self.response(status: 200, body: #"{"accessToken":"access-new","refreshToken":"refresh-new"}"#)
            default:
                XCTFail("Unexpected request \(request)")
                return Self.response(status: 500)
            }
        }
        let host = NativeSessionHost(store: store, baseURL: URL(string: "https://atlas.example"), client: client)

        await host.prepare()

        XCTAssertEqual(host.state, NativeSessionHost.State.ready)
        XCTAssertEqual(host.session?.accessToken, "access-new")
        XCTAssertEqual(store.session?.refreshToken, "refresh-new")
        XCTAssertEqual(requests.map(\.url?.path), [
            "/api/mobile/v1/auth/me",
            "/api/mobile/v1/auth/refresh",
            "/api/mobile/v1/auth/me",
        ])
    }

    func testPrepareRestoresAnonymousInstallationAfterRejectedSession() async throws {
        let store = MemoryNativeSessionStore(session: Self.session(access: "access-old", refresh: "refresh-old"))
        var requests: [URLRequest] = []
        let client = FakeNativeSessionClient { request in
            requests.append(request)
            switch request.url?.path {
            case "/api/mobile/v1/auth/me":
                return Self.response(status: 401)
            case "/api/mobile/v1/auth/refresh":
                XCTAssertEqual(request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["refreshToken"], "refresh-old")
                return Self.response(status: 401)
            case "/api/mobile/v1/auth/installation/restore":
                XCTAssertEqual(request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["installationCredential"], "installation-one")
                return Self.response(status: 200, body: #"{"user":{"id":"owner-one","accountType":"anonymous","email":null,"displayName":null},"accessToken":"access-restored","refreshToken":"refresh-restored"}"#)
            default:
                XCTFail("Unexpected request \(request)")
                return Self.response(status: 500)
            }
        }
        let host = NativeSessionHost(store: store, baseURL: URL(string: "https://atlas.example"), client: client)

        await host.prepare()

        XCTAssertEqual(host.state, NativeSessionHost.State.ready)
        XCTAssertEqual(host.session?.ownerId, "owner-one")
        XCTAssertEqual(host.session?.accessToken, "access-restored")
        XCTAssertEqual(store.session?.refreshToken, "refresh-restored")
        XCTAssertEqual(store.session?.installationCredential, "installation-one")
        XCTAssertEqual(requests.map(\.url?.path), [
            "/api/mobile/v1/auth/me",
            "/api/mobile/v1/auth/refresh",
            "/api/mobile/v1/auth/installation/restore",
        ])
    }

    func testLoginPersistsTheReturnedSession() async throws {
        let store = MemoryNativeSessionStore()
        let client = FakeNativeSessionClient { request in
            XCTAssertEqual(request.url?.path, "/api/mobile/v1/auth/login")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return Self.response(status: 200, body: #"{"user":{"id":"owner-two","accountType":"registered","email":"rider@example.test","displayName":"Rider"},"accessToken":"access-two","refreshToken":"refresh-two"}"#)
        }
        let host = NativeSessionHost(store: store, baseURL: URL(string: "https://atlas.example"), client: client)

        let loggedIn = await host.login(email: "rider@example.test", password: "correct horse battery staple")
        XCTAssertTrue(loggedIn)

        XCTAssertEqual(host.session?.ownerId, "owner-two")
        XCTAssertEqual(store.session?.accessToken, "access-two")
        XCTAssertEqual(host.state, NativeSessionHost.State.ready)
    }

    func testLoginDoesNotCarryAnAnonymousInstallationCredentialToAnotherOwner() async throws {
        let store = MemoryNativeSessionStore(session: Self.session(access: "access-one", refresh: "refresh-one"))
        let client = FakeNativeSessionClient { request in
            XCTAssertEqual(request.url?.path, "/api/mobile/v1/auth/login")
            return Self.response(status: 200, body: #"{"user":{"id":"owner-two","accountType":"registered","email":"rider@example.test","displayName":"Rider"},"accessToken":"access-two","refreshToken":"refresh-two"}"#)
        }
        let host = NativeSessionHost(store: store, baseURL: URL(string: "https://atlas.example"), client: client)

        let loggedIn = await host.login(email: "rider@example.test", password: "correct horse battery staple")
        XCTAssertTrue(loggedIn)

        XCTAssertEqual(store.session?.ownerId, "owner-two")
        XCTAssertNil(store.session?.installationCredential)
    }

    func testLogoutRevokesTheBearerSessionBeforeClearingKeychain() async throws {
        let store = MemoryNativeSessionStore(session: Self.session(access: "access-one", refresh: "refresh-one"))
        let client = FakeNativeSessionClient { request in
            switch request.url?.path {
            case "/api/mobile/v1/auth/me":
                return Self.response(status: 200, body: Self.user(id: "owner-one"))
            case "/api/mobile/v1/auth/logout":
                XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-one")
                return Self.response(status: 204)
            default:
                XCTFail("Unexpected request \(request)")
                return Self.response(status: 500)
            }
        }
        let host = NativeSessionHost(store: store, baseURL: URL(string: "https://atlas.example"), client: client)
        await host.prepare()

        let loggedOut = await host.logout()
        XCTAssertTrue(loggedOut)

        XCTAssertNil(store.session)
        XCTAssertNil(host.session)
        XCTAssertEqual(host.state, NativeSessionHost.State.unavailable)
    }

    func testLogoutRetainsRotatedCredentialsWhenPostRefreshLogoutFails() async throws {
        let store = MemoryNativeSessionStore(session: Self.session(access: "access-one", refresh: "refresh-one"))
        var logoutTokens: [String?] = []
        var refreshed = false
        let client = FakeNativeSessionClient { request in
            switch request.url?.path {
            case "/api/mobile/v1/auth/me":
                return Self.response(status: 200, body: Self.user(id: "owner-one"))
            case "/api/mobile/v1/auth/refresh":
                XCTAssertEqual(request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] }?["refreshToken"], "refresh-one")
                refreshed = true
                return Self.response(status: 200, body: #"{"accessToken":"access-two","refreshToken":"refresh-two"}"#)
            case "/api/mobile/v1/auth/logout":
                let token = request.value(forHTTPHeaderField: "Authorization")
                logoutTokens.append(token)
                if token == "Bearer access-one" { return Self.response(status: 401) }
                if !refreshed { return Self.response(status: 500) }
                if logoutTokens.count == 2 { return Self.response(status: 500) }
                return Self.response(status: 204)
            default:
                XCTFail("Unexpected request \(request)")
                return Self.response(status: 500)
            }
        }
        let host = NativeSessionHost(store: store, baseURL: URL(string: "https://atlas.example"), client: client)
        await host.prepare()

        let firstLogout = await host.logout()
        XCTAssertFalse(firstLogout)
        XCTAssertEqual(host.session?.accessToken, "access-two")
        XCTAssertEqual(host.session?.refreshToken, "refresh-two")
        XCTAssertEqual(store.session?.accessToken, "access-two")
        let retriedLogout = await host.logout()
        XCTAssertTrue(retriedLogout)
        XCTAssertEqual(logoutTokens, ["Bearer access-one", "Bearer access-two", "Bearer access-two"])
    }

    private static func session(access: String, refresh: String) -> NativeSession {
        NativeSession(accessToken: access, refreshToken: refresh, installationCredential: "installation-one", ownerId: "owner-one")
    }

    private static func user(id: String) -> String {
        #"{"user":{"id":"\#(id)","accountType":"anonymous","email":null,"displayName":null}}"#
    }

    private static func response(status: Int, body: String = "") -> (HTTPURLResponse, Data) {
        (HTTPURLResponse(url: URL(string: "https://atlas.example")!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, Data(body.utf8))
    }
}

private final class MemoryNativeSessionStore: NativeSessionStoring {
    var session: NativeSession?

    init(session: NativeSession? = nil) {
        self.session = session
    }

    func load() throws -> NativeSessionLoadResult {
        NativeSessionLoadResult(session: session)
    }

    func save(session: NativeSession) throws {
        self.session = session
    }

    func clear() throws {
        session = nil
    }
}

private final class FakeNativeSessionClient: NativeSessionRequesting {
    private let handler: (URLRequest) -> (HTTPURLResponse, Data)

    init(handler: @escaping (URLRequest) -> (HTTPURLResponse, Data)) {
        self.handler = handler
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let (response, data) = handler(request)
        return (data, response)
    }
}

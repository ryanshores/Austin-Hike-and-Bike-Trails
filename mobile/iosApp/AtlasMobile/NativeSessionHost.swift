import AtlasShared
import Foundation

@MainActor
final class NativeSessionHost: ObservableObject {
    enum State: Equatable { case loading, ready, unavailable }

    @Published private(set) var state: State = .loading
    @Published private(set) var session: NativeSession?

    private let store: NativeSessionStoring
    private let baseURL: URL?
    private let client: any NativeSessionRequesting

    init(
        store: NativeSessionStoring = KeychainNativeSessionStore(),
        baseURL: URL? = URL(string: Bundle.main.object(forInfoDictionaryKey: "AtlasApiBaseURL") as? String ?? ""),
        client: any NativeSessionRequesting = URLSession.shared
    ) {
        self.store = store
        self.baseURL = baseURL
        self.client = client
    }

    func prepare() async {
        do {
            if let stored = try store.load().session {
                do {
                    if let validated = try await validateOrRefresh(stored) {
                        try apply(validated)
                        return
                    }
                } catch let error as NativeSessionHostError where error.statusCode != nil {
                    // A rejected credential cannot become valid through retry; remove it before bootstrapping.
                } catch {
                    state = .unavailable
                    return
                }
                try store.clear()
            }
        } catch {
            state = .unavailable
            return
        }
        do {
            try apply(try await bootstrapAnonymousSession())
        } catch { state = .unavailable }
    }

    /// Authenticates a registered account and atomically replaces the Keychain session on success.
    @discardableResult
    func login(email: String, password: String) async -> Bool {
        do {
            let wire: SessionEnvelope = try await send(
                path: "login",
                method: "POST",
                body: LoginRequest(email: email, password: password),
                expectedStatus: 200
            )
            let previousInstallationCredential = session?.installationCredential
                ?? (try store.load().session?.installationCredential)
            try apply(NativeSession(
                accessToken: wire.accessToken,
                refreshToken: wire.refreshToken,
                installationCredential: previousInstallationCredential,
                ownerId: wire.user.id
            ))
            return true
        } catch { return false }
    }

    /// Returns the verified current user, refreshing the short-lived access token when needed.
    func currentUser() async -> NativeUser? {
        guard let current = session else { return nil }
        do {
            guard let validated = try await validateOrRefresh(current) else {
                try store.clear()
                session = nil
                state = .unavailable
                return nil
            }
            try apply(validated)
            return try await fetchCurrentUser(accessToken: validated.accessToken)
        } catch {
            if let error = error as? NativeSessionHostError, error.statusCode != nil {
                try? store.clear()
                session = nil
            }
            state = .unavailable
            return nil
        }
    }

    /// Revokes the remote session before removing native credentials from Keychain.
    @discardableResult
    func logout() async -> Bool {
        guard let current = session else { return true }
        do {
            var active = current
            do {
                try await sendNoContent(path: "logout", accessToken: active.accessToken)
            } catch let error as NativeSessionHostError where error.statusCode == 401 {
                guard let refreshed = try await refresh(active) else { throw error }
                active = refreshed
                try await sendNoContent(path: "logout", accessToken: active.accessToken)
            }
            try store.clear()
            session = nil
            state = .unavailable
            return true
        } catch {
            return false
        }
    }

    private func validateOrRefresh(_ current: NativeSession) async throws -> NativeSession? {
        do {
            let user = try await fetchCurrentUser(accessToken: current.accessToken)
            return user.id == current.ownerId ? current : nil
        } catch let error as NativeSessionHostError where error.statusCode == 401 {
            guard let refreshed = try await refresh(current) else { return nil }
            let user = try await fetchCurrentUser(accessToken: refreshed.accessToken)
            return user.id == refreshed.ownerId ? refreshed : nil
        }
    }

    private func refresh(_ current: NativeSession) async throws -> NativeSession? {
        let wire: RefreshEnvelope = try await send(
            path: "refresh",
            method: "POST",
            body: RefreshRequest(refreshToken: current.refreshToken),
            expectedStatus: 200
        )
        let refreshed = NativeSession(
            accessToken: wire.accessToken,
            refreshToken: wire.refreshToken,
            installationCredential: current.installationCredential,
            ownerId: current.ownerId
        )
        try store.save(session: refreshed)
        return refreshed
    }

    private func bootstrapAnonymousSession() async throws -> NativeSession {
        let wire: AnonymousSession = try await send(
            path: "anonymous",
            method: "POST",
            body: EmptyRequest(),
            expectedStatus: 201
        )
        return NativeSession(
            accessToken: wire.accessToken,
            refreshToken: wire.refreshToken,
            installationCredential: wire.installationCredential,
            ownerId: wire.user.id
        )
    }

    private func fetchCurrentUser(accessToken: String) async throws -> NativeUser {
        let envelope: CurrentUserEnvelope = try await send(
            path: "me",
            method: "GET",
            accessToken: accessToken,
            expectedStatus: 200
        )
        return envelope.user
    }

    private func apply(_ replacement: NativeSession) throws {
        try store.save(session: replacement)
        session = replacement
        state = .ready
    }

    private func send<T: Decodable, Body: Encodable>(
        path: String,
        method: String,
        body: Body? = nil,
        accessToken: String? = nil,
        expectedStatus: Int
    ) async throws -> T {
        let data = try await request(
            path: path,
            method: method,
            body: try body.map { try JSONEncoder().encode($0) },
            accessToken: accessToken,
            expectedStatus: expectedStatus
        )
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func sendNoContent(path: String, accessToken: String) async throws {
        _ = try await request(
            path: path, method: "POST", accessToken: accessToken, expectedStatus: 204
        )
    }

    private func request(
        path: String,
        method: String,
        body: Data? = nil,
        accessToken: String? = nil,
        expectedStatus: Int
    ) async throws -> Data {
        guard let baseURL else { throw NativeSessionHostError.unavailable }
        var request = URLRequest(url: baseURL.appendingPathComponent("api/mobile/v1/auth/").appendingPathComponent(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let accessToken { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body
        let (data, response) = try await client.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw NativeSessionHostError.unavailable }
        guard response.statusCode == expectedStatus else { throw NativeSessionHostError(statusCode: response.statusCode) }
        return data
    }

    struct NativeUser: Decodable, Equatable {
        let id: String
        let accountType: String
        let email: String?
        let displayName: String?
    }

    private struct EmptyRequest: Encodable {}
    private struct LoginRequest: Encodable { let email: String; let password: String }
    private struct RefreshRequest: Encodable { let refreshToken: String }
    private struct CurrentUserEnvelope: Decodable { let user: NativeUser }
    private struct RefreshEnvelope: Decodable { let accessToken: String; let refreshToken: String }
    private struct SessionEnvelope: Decodable { let user: NativeUser; let accessToken: String; let refreshToken: String }
    private struct AnonymousSession: Decodable { let user: NativeUser; let accessToken: String; let refreshToken: String; let installationCredential: String }

    private struct NativeSessionHostError: Error {
        let statusCode: Int?
        init(statusCode: Int? = nil) { self.statusCode = statusCode }
        static let unavailable = NativeSessionHostError()
    }
}

protocol NativeSessionRequesting {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: NativeSessionRequesting {}

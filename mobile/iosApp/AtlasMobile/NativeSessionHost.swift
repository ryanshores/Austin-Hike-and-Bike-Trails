import AtlasShared
import Foundation

@MainActor
final class NativeSessionHost: ObservableObject {
    enum State: Equatable { case loading, ready, unavailable }

    @Published private(set) var state: State = .loading
    @Published private(set) var session: NativeSession?

    private let store: NativeSessionStoring
    private let baseURL: URL?

    init(store: NativeSessionStoring = KeychainNativeSessionStore(), baseURL: URL? = URL(string: Bundle.main.object(forInfoDictionaryKey: "AtlasApiBaseURL") as? String ?? "")) {
        self.store = store
        self.baseURL = baseURL
    }

    func prepare() async {
        if let stored = try? store.load().session { session = stored; state = .ready; return }
        guard let baseURL else { state = .unavailable; return }
        do {
            var request = URLRequest(url: baseURL.appendingPathComponent("api/mobile/v1/auth/anonymous"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = Data("{}".utf8)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 201 else { throw URLError(.badServerResponse) }
            let wire = try JSONDecoder().decode(AnonymousSession.self, from: data)
            let session = NativeSession(accessToken: wire.accessToken, refreshToken: wire.refreshToken, installationCredential: wire.installationCredential, ownerId: wire.user.id)
            try store.save(session: session)
            self.session = session
            state = .ready
        } catch { state = .unavailable }
    }

    private struct AnonymousSession: Decodable {
        let accessToken: String; let refreshToken: String; let installationCredential: String; let user: User
        struct User: Decodable { let id: String }
    }
}

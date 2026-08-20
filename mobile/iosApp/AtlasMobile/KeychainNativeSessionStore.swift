import AtlasShared
import Foundation
import Security

protocol NativeSessionStoring {
    func load() throws -> NativeSession?
    func save(_ session: NativeSession) throws
    func clear() throws
}

enum KeychainSessionError: Error, Equatable {
    case incompleteSession
    case invalidStoredSession
    case unexpectedStatus(OSStatus)
}

final class KeychainNativeSessionStore: NativeSessionStoring {
    private struct StoredSession: Codable {
        let accessToken: String
        let refreshToken: String
        let installationCredential: String?
    }

    private let service: String
    private let account = "native-session-v1"

    init(service: String = "\(Bundle.main.bundleIdentifier ?? "us.ryanshores.atlas.mobile").native-session") {
        self.service = service
    }

    func load() throws -> NativeSession? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainSessionError.unexpectedStatus(status)
        }
        guard
            let data = result as? Data,
            let stored = try? JSONDecoder().decode(StoredSession.self, from: data),
            !stored.accessToken.isEmpty,
            !stored.refreshToken.isEmpty
        else {
            throw KeychainSessionError.invalidStoredSession
        }
        return NativeSession(
            accessToken: stored.accessToken,
            refreshToken: stored.refreshToken,
            installationCredential: stored.installationCredential
        )
    }

    func save(_ session: NativeSession) throws {
        guard session.isComplete() else {
            throw KeychainSessionError.incompleteSession
        }
        let data = try JSONEncoder().encode(StoredSession(
            accessToken: session.accessToken,
            refreshToken: session.refreshToken,
            installationCredential: session.installationCredential
        ))
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw KeychainSessionError.unexpectedStatus(updateStatus)
        }

        var item = baseQuery
        attributes.forEach { item[$0.key] = $0.value }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw KeychainSessionError.unexpectedStatus(addStatus)
        }
    }

    func clear() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainSessionError.unexpectedStatus(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}

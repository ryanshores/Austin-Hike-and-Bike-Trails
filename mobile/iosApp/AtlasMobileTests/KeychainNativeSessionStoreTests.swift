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

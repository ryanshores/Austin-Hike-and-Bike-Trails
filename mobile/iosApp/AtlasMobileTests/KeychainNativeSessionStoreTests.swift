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
        try store.save(NativeSession(
            accessToken: "access-one",
            refreshToken: "refresh-one",
            installationCredential: "installation-one"
        ))

        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.accessToken, "access-one")
        XCTAssertEqual(loaded.refreshToken, "refresh-one")
        XCTAssertEqual(loaded.installationCredential, "installation-one")
    }

    func testSaveReplacesRotatedCredentialsAtomically() throws {
        try store.save(NativeSession(
            accessToken: "access-one",
            refreshToken: "refresh-one",
            installationCredential: "installation-one"
        ))
        try store.save(NativeSession(
            accessToken: "access-two",
            refreshToken: "refresh-two",
            installationCredential: nil
        ))

        let loaded = try XCTUnwrap(store.load())
        XCTAssertEqual(loaded.accessToken, "access-two")
        XCTAssertEqual(loaded.refreshToken, "refresh-two")
        XCTAssertNil(loaded.installationCredential)
    }

    func testClearRemovesSessionAndIsIdempotent() throws {
        try store.save(NativeSession(
            accessToken: "access",
            refreshToken: "refresh",
            installationCredential: nil
        ))

        try store.clear()
        try store.clear()
        XCTAssertNil(try store.load())
    }

    func testRejectsIncompleteSession() throws {
        XCTAssertThrowsError(try store.save(NativeSession(
            accessToken: "",
            refreshToken: "refresh",
            installationCredential: nil
        ))) { error in
            XCTAssertEqual(error as? KeychainSessionError, .incompleteSession)
        }
        XCTAssertNil(try store.load())
    }
}

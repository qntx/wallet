import CloudKit
import XCTest

@testable import WalletNativeCloud

/// An in-memory `CloudKitDatabase`: `failures` is a queue of errors consumed one per call, the
/// zone can be deleted underneath the store, and a saved record's asset bytes are copied out —
/// the way a real upload reads the temp file once.
final class FakeDatabase: CloudKitDatabase {
  var zoneExists = true
  var failures: [Error] = []
  var savedZones = 0
  var saves = 0
  private var records: [String: Data] = [:]

  private func drain() throws {
    if !failures.isEmpty {
      throw failures.removeFirst()
    }
  }

  func recordNames() async throws -> [String] {
    try drain()
    if !zoneExists { throw CKError(.zoneNotFound) }
    return records.keys.sorted()
  }

  func record(withID id: CKRecord.ID) async throws -> CKRecord {
    try drain()
    if !zoneExists { throw CKError(.zoneNotFound) }
    guard let data = records[id.recordName] else { throw CKError(.unknownItem) }
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("qntx-fake-asset-\(UUID().uuidString)")
    try data.write(to: url)
    let record = CKRecord(recordType: "Backup", recordID: id)
    record["envelope"] = CKAsset(fileURL: url)
    return record
  }

  func save(_ record: CKRecord) async throws -> CKRecord {
    try drain()
    if !zoneExists { throw CKError(.zoneNotFound) }
    guard let asset = record["envelope"] as? CKAsset,
      let url = asset.fileURL,
      let data = try? Data(contentsOf: url)
    else {
      throw CKError(.internalError)
    }
    records[record.recordID.recordName] = data
    saves += 1
    return record
  }

  func deleteRecord(withID id: CKRecord.ID) async throws {
    try drain()
    if !zoneExists { throw CKError(.zoneNotFound) }
    if records.removeValue(forKey: id.recordName) == nil { throw CKError(.unknownItem) }
  }

  func saveZone(_: CKRecordZone) async throws {
    try drain()
    zoneExists = true
    savedZones += 1
  }

  func seed(_ name: String, _ text: String) throws {
    records[name] = Data(text.utf8)
  }

  func seed(_ name: String, bytes: Data) {
    records[name] = bytes
  }
}

final class CloudKitEnvelopeStoreTests: XCTestCase {
  private let zoneID = CKRecordZone.ID(
    zoneName: CloudKitEnvelopeStore.zoneName, ownerName: CKCurrentUserDefaultName)

  private func tempFiles() -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: NSTemporaryDirectory()))?
      .filter { $0.hasPrefix("qntx-backup-") } ?? []
  }

  private func code(_ error: Error) -> String? {
    (error as? CloudStoreFailure)?.description.components(separatedBy: "]").first.map {
      String($0.dropFirst("[qntx-cloud:".count))
    }
  }

  private func expectCode(_ want: String, _ block: () async throws -> Void) async {
    do {
      _ = try await block()
      XCTFail("expected [qntx-cloud:\(want)]")
    } catch {
      XCTAssertEqual(code(error), want, "\(error)")
    }
  }

  func testRoundTripOverwriteAndList() async throws {
    let db = FakeDatabase()
    try await CloudKitEnvelopeStore.write(database: db, name: "a", text: "one", zoneID: zoneID)
    try await CloudKitEnvelopeStore.write(database: db, name: "b", text: "two", zoneID: zoneID)
    try await CloudKitEnvelopeStore.write(database: db, name: "a", text: "three", zoneID: zoneID)
    let names = try await CloudKitEnvelopeStore.list(database: db)
    XCTAssertEqual(names.sorted(), ["a", "b"])
    let text = try await CloudKitEnvelopeStore.read(database: db, name: "a", zoneID: zoneID)
    XCTAssertEqual(text, "three")
  }

  func testReadAndDeleteMissing() async throws {
    let db = FakeDatabase()
    let missing = try await CloudKitEnvelopeStore.read(database: db, name: "gone", zoneID: zoneID)
    XCTAssertNil(missing)
    try await CloudKitEnvelopeStore.remove(database: db, name: "gone", zoneID: zoneID)
  }

  func testWriteRecreatesAZoneDeletedUnderneath() async throws {
    for code in [CKError.Code.zoneNotFound, .userDeletedZone] {
      let db = FakeDatabase()
      db.zoneExists = false
      db.failures = [CKError(code)]
      try await CloudKitEnvelopeStore.write(database: db, name: "a", text: "v", zoneID: zoneID)
      XCTAssertEqual(db.savedZones, 1)
      XCTAssertEqual(db.saves, 1)
      let text = try await CloudKitEnvelopeStore.read(database: db, name: "a", zoneID: zoneID)
      XCTAssertEqual(text, "v")
    }
  }

  func testMissingZoneReadsAsEmptyOnListAndRead() async throws {
    let db = FakeDatabase()
    db.zoneExists = false
    let names = try await CloudKitEnvelopeStore.list(database: db)
    XCTAssertEqual(names, [])
    let text = try await CloudKitEnvelopeStore.read(database: db, name: "a", zoneID: zoneID)
    XCTAssertNil(text)
    try await CloudKitEnvelopeStore.remove(database: db, name: "a", zoneID: zoneID)
  }

  func testPartialFailureUnwrapsToTheItemError() async throws {
    let db = FakeDatabase()
    let id = CloudKitEnvelopeStore.recordID(name: "a", zoneID: zoneID)
    db.failures = [
      CKError(
        .partialFailure,
        userInfo: [CKPartialErrorsByItemIDKey: [id: CKError(.quotaExceeded)]])
    ]
    await expectCode("quota") {
      try await CloudKitEnvelopeStore.write(database: db, name: "a", text: "v", zoneID: zoneID)
    }
  }

  func testErrorCodeMapping() async {
    let cases: [(CKError.Code, String)] = [
      (.quotaExceeded, "quota"),
      (.permissionFailure, "failed"),
      (.notAuthenticated, "unavailable"),
      (.accountTemporarilyUnavailable, "unavailable"),
      (.networkUnavailable, "unavailable"),
      (.networkFailure, "unavailable"),
      (.serviceUnavailable, "unavailable"),
      (.requestRateLimited, "unavailable"),
      (.zoneBusy, "unavailable"),
      (.managedAccountRestricted, "unavailable"),
      (.serverResponseLost, "failed"),
      (.internalError, "failed"),
    ]
    for (ckCode, want) in cases {
      let db = FakeDatabase()
      db.failures = [CKError(ckCode)]
      await expectCode(want) {
        _ = try await CloudKitEnvelopeStore.list(database: db)
      }
    }
    let urlError = FakeDatabase()
    urlError.failures = [
      NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
    ]
    await expectCode("unavailable") {
      _ = try await CloudKitEnvelopeStore.list(database: urlError)
    }
  }

  func testInvalidUTF8ReadsAsFailed() async throws {
    let db = FakeDatabase()
    db.seed("bad", bytes: Data([0xff, 0xfe]))
    await expectCode("failed") {
      _ = try await CloudKitEnvelopeStore.read(database: db, name: "bad", zoneID: zoneID)
    }
  }

  func testTempAssetRemovedOnSuccessAndFailure() async throws {
    XCTAssertEqual(tempFiles(), [])
    let ok = FakeDatabase()
    try await CloudKitEnvelopeStore.write(database: ok, name: "a", text: "v", zoneID: zoneID)
    XCTAssertEqual(tempFiles(), [])
    let failing = FakeDatabase()
    failing.failures = [CKError(.internalError)]
    await expectCode("failed") {
      try await CloudKitEnvelopeStore.write(
        database: failing, name: "a", text: "v", zoneID: zoneID)
    }
    XCTAssertEqual(tempFiles(), [])
  }
}

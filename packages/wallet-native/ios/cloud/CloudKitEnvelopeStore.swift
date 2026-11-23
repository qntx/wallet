import CloudKit
import Foundation

/// The adapter-facing half of the CloudKit backup transport: every method is one forward into
/// `CKDatabase` (or a paging loop the adapter owns — `CKServerChangeToken` cannot be faked, so
/// token paging never reaches this type). All interpretation — per-item results, error mapping,
/// asset temp files, strict UTF-8 — lives here so a fake database exercises the real logic.
protocol CloudKitDatabase {
  /// Every record name in the backup zone — the adapter folds all `recordZoneChanges` pages.
  func recordNames() async throws -> [String]
  func record(withID id: CKRecord.ID) async throws -> CKRecord
  func save(_ record: CKRecord) async throws -> CKRecord
  func deleteRecord(withID id: CKRecord.ID) async throws
  func saveZone(_ zone: CKRecordZone) async throws
}

/// `[qntx-cloud:<code>]` — the JS side decodes the token; the detail never names an account or
/// carries file contents.
struct CloudStoreFailure: Error, CustomStringConvertible, Equatable {
  let code: String
  let detail: String

  var description: String { "[qntx-cloud:\(code)] \(detail)" }
}

enum CloudKitEnvelopeStore {
  static let zoneName = "QntxWalletBackup"
  static let recordType = "Backup"
  static let field = "envelope"

  static func recordID(name: String, zoneID: CKRecordZone.ID) -> CKRecord.ID {
    CKRecord.ID(recordName: name, zoneID: zoneID)
  }

  static func list(database: CloudKitDatabase) async throws -> [String] {
    do {
      return try await database.recordNames()
    } catch {
      let mapped = try map(error, itemHint: nil)
      if mapped == .deletedZone { return [] }
      throw mapped.failure
    }
  }

  static func read(database: CloudKitDatabase, name: String, zoneID: CKRecordZone.ID)
    async throws -> String?
  {
    do {
      let record = try await database.record(withID: recordID(name: name, zoneID: zoneID))
      guard let asset = record[Self.field] as? CKAsset, let fileURL = asset.fileURL else {
        throw CloudStoreFailure(code: "failed", detail: "record holds no envelope asset")
      }
      let data = try Data(contentsOf: fileURL)
      guard let text = String(data: data, encoding: .utf8) else {
        throw CloudStoreFailure(code: "failed", detail: "envelope is not valid UTF-8")
      }
      return text
    } catch {
      let mapped = try map(error, itemHint: recordID(name: name, zoneID: zoneID))
      if mapped == .deletedZone || mapped == .unknownItem { return nil }
      throw mapped.failure
    }
  }

  static func write(database: CloudKitDatabase, name: String, text: String, zoneID: CKRecordZone.ID)
    async throws
  {
    let record = CKRecord(recordType: Self.recordType, recordID: recordID(name: name, zoneID: zoneID))
    // The text lands in a uniquely named temp file for the asset; it is removed on every path.
    let tempURL = FileManager.default.temporaryDirectory
      .appendingPathComponent("qntx-backup-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: tempURL) }
    do {
      try Data(text.utf8).write(to: tempURL, options: .atomic)
      record[Self.field] = CKAsset(fileURL: tempURL)
      _ = try await database.save(record)
    } catch {
      let mapped = try map(error, itemHint: record.recordID)
      if mapped == .deletedZone {
        try await recreateZone(database: database, zoneID: zoneID)
        do {
          _ = try await database.save(record)
        } catch {
          let retried = try map(error, itemHint: record.recordID)
          throw retried == .deletedZone
            ? CloudStoreFailure(code: "failed", detail: "zone gone")
            : retried.failure
        }
        return
      }
      if mapped == .unknownItem {
        // A missing record on save is not a thing CloudKit reports — treat as a hard failure.
        throw CloudStoreFailure(code: "failed", detail: "save rejected")
      }
      throw mapped.failure
    }
  }

  static func remove(database: CloudKitDatabase, name: String, zoneID: CKRecordZone.ID) async throws {
    do {
      try await database.deleteRecord(withID: recordID(name: name, zoneID: zoneID))
    } catch {
      let mapped = try map(error, itemHint: recordID(name: name, zoneID: zoneID))
      if mapped == .deletedZone || mapped == .unknownItem { return }
      throw mapped.failure
    }
  }

  private static func recreateZone(database: CloudKitDatabase, zoneID: CKRecordZone.ID) async throws {
    do {
      try await database.saveZone(CKRecordZone(zoneID: zoneID))
    } catch {
      throw try map(error, itemHint: nil).failure
    }
  }

  // MARK: - Error mapping

  private enum Mapped: Equatable {
    case typed(CloudStoreFailure)
    case deletedZone
    case unknownItem

    /// The error that actually escapes — the JS decoder reads the `[qntx-cloud:]` token.
    var failure: CloudStoreFailure {
      switch self {
      case .typed(let failure): return failure
      case .deletedZone: return CloudStoreFailure(code: "failed", detail: "zone deleted")
      case .unknownItem: return CloudStoreFailure(code: "failed", detail: "record missing")
      }
    }
  }

  /// Unwraps `partialFailure` to the failing item's error, then maps the CloudKit/URL layer to a
  /// store code. `.deletedZone` and `.unknownItem` stay symbolic so each op applies its own rule.
  private static func map(_ error: Error, itemHint: CKRecord.ID?) throws -> Mapped {
    if let failure = error as? CloudStoreFailure { return .typed(failure) }
    let ck: NSError = error as NSError
    if ck.domain == CKError.errorDomain, let code = CKError.Code(rawValue: ck.code) {
      if code == .partialFailure,
        let partial = ck.userInfo[CKPartialErrorsByItemIDKey] as? [AnyHashable: NSError],
        let item = firstItemError(partial, hint: itemHint)
      {
        return try map(item, itemHint: itemHint)
      }
      switch code {
      case .zoneNotFound, .userDeletedZone:
        return .deletedZone
      case .unknownItem:
        return .unknownItem
      case .quotaExceeded:
        return .typed(CloudStoreFailure(code: "quota", detail: "icloud storage full"))
      case .notAuthenticated, .accountTemporarilyUnavailable, .networkUnavailable,
        .networkFailure, .serviceUnavailable, .requestRateLimited, .zoneBusy,
        .managedAccountRestricted:
        return .typed(CloudStoreFailure(code: "unavailable", detail: "icloud \(code)"))
      case .permissionFailure:
        // iOS offers no interactive consent flow for the app to surface, so this is
        // a hard failure rather than auth-required.
        return .typed(CloudStoreFailure(code: "failed", detail: "icloud permission"))
      default:
        return .typed(CloudStoreFailure(code: "failed", detail: "icloud \(code)"))
      }
    }
    if ck.domain == NSURLErrorDomain {
      return .typed(CloudStoreFailure(code: "unavailable", detail: "network \(ck.code)"))
    }
    return .typed(CloudStoreFailure(code: "failed", detail: "icloud error"))
  }

  private static func firstItemError(
    _ partial: [AnyHashable: NSError], hint: CKRecord.ID?
  ) -> NSError? {
    if let hint, let hit = partial.first(where: { ($0.key as? CKRecord.ID) == hint }) {
      return hit.value
    }
    return partial.values.first
  }
}

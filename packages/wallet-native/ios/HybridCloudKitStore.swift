import CloudKit
import Foundation
import NitroModules

/// The real `CloudKitDatabase`: forwards each call onto `CKDatabase` inside the custom
/// `QntxWalletBackup` zone and owns the `recordZoneChanges` paging (a `CKServerChangeToken`
/// cannot be faked, so paging lives here rather than in the pure core). All request-level
/// interpretation happens in `CloudKitEnvelopeStore`.
private final class PrivateCloudDatabase: CloudKitDatabase {
  let database: CKDatabase
  let zoneID: CKRecordZone.ID

  init(container: String) {
    database = CKContainer(identifier: container).privateCloudDatabase
    zoneID = CKRecordZone.ID(
      zoneName: CloudKitEnvelopeStore.zoneName,
      ownerName: CKCurrentUserDefaultName
    )
  }

  private func configure(_ operation: CKDatabaseOperation) {
    let configuration = CKOperation.Configuration()
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 120
    configuration.qualityOfService = .userInitiated
    operation.configuration = configuration
  }

  func recordNames() async throws -> [String] {
    // desiredKeys [] fetches names only; the token pages until the zone is fully enumerated.
    var names: [String] = []
    var token: CKServerChangeToken? = nil
    var moreComing = true
    while moreComing {
      let page = try await database.recordZoneChanges(
        inZoneWith: zoneID, since: token, desiredKeys: [])
      token = page.changeToken
      moreComing = page.moreComing
      for (id, result) in page.modificationResultsByID {
        if case .success = result {
          names.append(id.recordName)
        }
      }
    }
    return names
  }

  func record(withID id: CKRecord.ID) async throws -> CKRecord {
    try await withCheckedThrowingContinuation { continuation in
      let operation = CKFetchRecordsOperation(recordIDs: [id])
      configure(operation)
      operation.desiredKeys = [CloudKitEnvelopeStore.field]
      operation.perRecordResultBlock = { _, result in
        switch result {
        case .success(let record):
          continuation.resume(returning: record)
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
      database.add(operation)
    }
  }

  func save(_ record: CKRecord) async throws -> CKRecord {
    try await modify(recordsToSave: [record], recordIDsToDelete: nil)
    return record
  }

  func deleteRecord(withID id: CKRecord.ID) async throws {
    _ = try await modify(recordsToSave: nil, recordIDsToDelete: [id])
  }

  func saveZone(_ zone: CKRecordZone) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let operation = CKModifyRecordZonesOperation(
        recordZonesToSave: [zone], recordZoneIDsToDelete: nil)
      configure(operation)
      operation.modifyRecordZonesResultBlock = { result in
        switch result {
        case .success:
          continuation.resume()
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
      database.add(operation)
    }
  }

  private func modify(recordsToSave: [CKRecord]?, recordIDsToDelete: [CKRecord.ID]?) async throws
    -> Void
  {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let operation = CKModifyRecordsOperation(
        recordsToSave: recordsToSave, recordIDsToDelete: recordIDsToDelete)
      configure(operation)
      operation.savePolicy = .allKeys
      operation.isAtomic = true
      operation.modifyRecordsResultBlock = { result in
        switch result {
        case .success:
          continuation.resume()
        case .failure(let error):
          continuation.resume(throwing: error)
        }
      }
      database.add(operation)
    }
  }
}

/// The CloudKitStore HybridObject: one private-database adapter per container plus a
/// `CKAccountChanged` observer that fans out to the registered JS listener. All payload
/// interpretation lives in `CloudKitEnvelopeStore` — this class only forwards.
class HybridCloudKitStore: HybridCloudKitStoreSpec {
  private var databases: [String: PrivateCloudDatabase] = [:]
  private var accountObserver: NSObjectProtocol?
  private var accountListener: (() -> Void)?

  private func database(for container: String) -> PrivateCloudDatabase {
    if let cached = databases[container] {
      return cached
    }
    let created = PrivateCloudDatabase(container: container)
    databases[container] = created
    return created
  }

  func list(container: String) throws -> Promise<[String]> {
    Promise.async {
      try await CloudKitEnvelopeStore.list(database: self.database(for: container))
    }
  }

  func read(container: String, name: String) throws -> Promise<String?> {
    Promise.async {
      let database = self.database(for: container)
      return try await CloudKitEnvelopeStore.read(
        database: database, name: name, zoneID: database.zoneID)
    }
  }

  func write(container: String, name: String, text: String) throws -> Promise<Void> {
    Promise.async {
      let database = self.database(for: container)
      try await CloudKitEnvelopeStore.write(
        database: database, name: name, text: text, zoneID: database.zoneID)
    }
  }

  func remove(container: String, name: String) throws -> Promise<Void> {
    Promise.async {
      let database = self.database(for: container)
      try await CloudKitEnvelopeStore.remove(
        database: database, name: name, zoneID: database.zoneID)
    }
  }

  func setAccountListener(listener: @escaping () -> Void) throws {
    accountListener = listener
    guard accountObserver == nil else {
      return
    }
    accountObserver = NotificationCenter.default.addObserver(
      forName: NSNotification.Name.CKAccountChanged,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      self?.accountListener?()
    }
  }
}

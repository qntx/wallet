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

  /// The async CKDatabase APIs run under this configuration; unlike the callback
  /// operations they always resume the awaiting task, failure or not.
  private func configured<R>(_ body: (CKDatabase) async throws -> R) async rethrows -> R {
    let configuration = CKOperation.Configuration()
    configuration.timeoutIntervalForRequest = 60
    configuration.timeoutIntervalForResource = 120
    configuration.qualityOfService = .userInitiated
    return try await database.configuredWith(configuration: configuration, body: body)
  }

  func recordNames() async throws -> [String] {
    // desiredKeys [] fetches names only; the token pages until the zone is fully enumerated.
    var names: [String] = []
    var token: CKServerChangeToken? = nil
    var moreComing = true
    while moreComing {
      let page = try await configured { database in
        try await database.recordZoneChanges(
          inZoneWith: zoneID, since: token, desiredKeys: [])
      }
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
    let results = try await configured { database in
      try await database.records(for: [id], desiredKeys: [CloudKitEnvelopeStore.field])
    }
    guard let result = results[id] else {
      throw CKError(.unknownItem)
    }
    return try result.get()
  }

  func save(_ record: CKRecord) async throws -> CKRecord {
    let outcome = try await configured { database in
      try await database.modifyRecords(
        saving: [record], deleting: [], savePolicy: .allKeys, atomically: true)
    }
    guard let result = outcome.saveResults[record.recordID] else {
      throw CKError(.unknownItem)
    }
    _ = try result.get()
    return record
  }

  func deleteRecord(withID id: CKRecord.ID) async throws {
    let outcome = try await configured { database in
      try await database.modifyRecords(
        saving: [], deleting: [id], savePolicy: .allKeys, atomically: true)
    }
    guard let result = outcome.deleteResults[id] else {
      throw CKError(.unknownItem)
    }
    try result.get()
  }

  func saveZone(_ zone: CKRecordZone) async throws {
    let outcome = try await configured { database in
      try await database.modifyRecordZones(saving: [zone], deleting: [])
    }
    guard let result = outcome.saveResults[zone.zoneID] else {
      throw CKError(.unknownItem)
    }
    _ = try result.get()
  }
}

/// The CloudKitStore HybridObject: one private-database adapter per container plus a
/// `CKAccountChanged` observer that fans out to the registered JS listener. All payload
/// interpretation lives in `CloudKitEnvelopeStore` — this class only forwards.
class HybridCloudKitStore: HybridCloudKitStoreSpec {
  private let databasesLock = NSLock()
  private var databases: [String: PrivateCloudDatabase] = [:]
  private var accountObserver: NSObjectProtocol?
  private var accountListener: (() -> Void)?

  private func database(for container: String) -> PrivateCloudDatabase {
    databasesLock.lock()
    defer { databasesLock.unlock() }
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

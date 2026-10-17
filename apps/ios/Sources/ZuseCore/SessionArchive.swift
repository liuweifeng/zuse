import CryptoKit
import Foundation

public struct PendingMessage: Codable, Identifiable, Sendable, Equatable {
  public enum Delivery: String, Codable, Sendable { case queued, uncertain }
  public let id: String
  public let messageID: String
  public let sessionID: String
  public let text: String
  public let input: JSONValue?
  public let createdAt: Date
  public var delivery: Delivery

  public init(sessionID: String, text: String, input: JSONValue? = nil) {
    id = UUID().uuidString
    messageID = UUID().uuidString
    self.sessionID = sessionID
    self.text = text
    self.input = input
    createdAt = Date()
    delivery = .queued
  }
  public var payload: [String: JSONValue] {
    var value: [String: JSONValue] = [
      "sessionId": .string(sessionID), "commandId": .string(id),
      "clientMessageId": .string(messageID),
    ]
    if let input { value["input"] = input } else { value["text"] = .string(text) }
    return value
  }
}

public struct SessionArchive: Codable, Sendable {
  public var attachments: [JSONValue]?
  public var metadata: JSONValue?
  public var responses: [String: String]?
  public var draft = ""
  public var messages: [ChatMessage] = []
  public var pending: [PendingMessage] = []
  public var savedAt = Date()
  public init() {}
}

/// Encrypted, atomic per-session files; callers provide an account-scoped key.
public actor ArchiveStore {
  private let directory: URL
  private let key: SymmetricKey
  private var retired = false
  private var records: [String: SessionArchive] = [:]
  private var recent: [String] = []
  public init(directory: URL, key: Data) throws {
    guard key.count == 32 else { throw ClientError("Invalid archive encryption key.") }
    self.directory = directory
    self.key = SymmetricKey(data: key)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }
  public static func storageID(_ identity: String) -> String {
    SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private func file(_ sessionID: String) -> URL {
    directory.appendingPathComponent(Self.storageID(sessionID)).appendingPathExtension("sealed")
  }
  public func load(_ sessionID: String) throws -> SessionArchive {
    guard !retired else { throw ClientError("This account archive is closed.") }
    if let record = records[sessionID] {
      cache(record, sessionID: sessionID)
      return record
    }
    let url = file(sessionID)
    guard FileManager.default.fileExists(atPath: url.path) else { return SessionArchive() }
    let encrypted = try Data(contentsOf: url)
    let plaintext = try AES.GCM.open(
      AES.GCM.SealedBox(combined: encrypted), using: key, authenticating: Data(sessionID.utf8))
    var record = try JSONDecoder().decode(SessionArchive.self, from: plaintext)
    let history = file(sessionID).appendingPathExtension("history")
    if FileManager.default.fileExists(atPath: history.path) {
      let bytes = try AES.GCM.open(
        AES.GCM.SealedBox(combined: Data(contentsOf: history)), using: key,
        authenticating: Data((sessionID + "|history").utf8))
      record.messages = try JSONDecoder().decode([ChatMessage].self, from: bytes)
    }
    cache(record, sessionID: sessionID)
    return record
  }
  private func save(_ record: SessionArchive, sessionID: String) throws {
    guard !retired else { throw ClientError("This account archive is closed.") }
    var record = record
    record.savedAt = Date()
    if !record.messages.isEmpty,
      !FileManager.default.fileExists(
        atPath: file(sessionID).appendingPathExtension("history").path)
    {
      try saveHistory(record.messages, sessionID: sessionID)
    }
    var metadata = record
    metadata.messages = []
    let plaintext = try JSONEncoder().encode(metadata)
    guard
      let encrypted = try AES.GCM.seal(plaintext, using: key, authenticating: Data(sessionID.utf8))
        .combined
    else { throw ClientError("Could not encrypt the session archive.") }
    #if os(iOS)
      try encrypted.write(
        to: file(sessionID),
        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try encrypted.write(to: file(sessionID), options: .atomic)
    #endif
    cache(record, sessionID: sessionID)
  }
  private func cache(_ record: SessionArchive, sessionID: String) {
    records[sessionID] = record
    recent.removeAll { $0 == sessionID }
    recent.append(sessionID)
    while recent.count > 4 { records.removeValue(forKey: recent.removeFirst()) }
  }
  public func saveMetadata(_ metadata: JSONValue, sessionID: String) throws {
    var record = try load(sessionID)
    record.metadata = metadata
    try save(record, sessionID: sessionID)
  }
  public func saveAttachments(_ attachments: [JSONValue], sessionID: String) throws {
    var record = try load(sessionID)
    record.attachments = attachments
    try save(record, sessionID: sessionID)
  }
  public func saveDraft(_ draft: String, sessionID: String) throws {
    var record = try load(sessionID)
    record.draft = draft
    try save(record, sessionID: sessionID)
  }
  public func saveMessages(_ messages: [ChatMessage], sessionID: String) throws {
    var record = try load(sessionID)
    record.messages = messages
    try saveHistory(messages, sessionID: sessionID)
    let observed = Set(messages.map(\.id))
    record.pending.removeAll { observed.contains($0.messageID) }
    try save(record, sessionID: sessionID)
  }
  private func saveHistory(_ messages: [ChatMessage], sessionID: String) throws {
    let plaintext = try JSONEncoder().encode(messages)
    guard
      let ciphertext = try AES.GCM.seal(
        plaintext, using: key, authenticating: Data((sessionID + "|history").utf8)
      ).combined
    else { throw ClientError("Could not encrypt history.") }
    #if os(iOS)
      try ciphertext.write(
        to: file(sessionID).appendingPathExtension("history"),
        options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    #else
      try ciphertext.write(to: file(sessionID).appendingPathExtension("history"), options: .atomic)
    #endif
  }
  public func enqueue(_ message: PendingMessage, responseTo: String? = nil) throws {
    var record = try load(message.sessionID)
    if let responseTo, record.responses?[responseTo] != nil {
      throw ClientError("A response to this form is already queued or sent.")
    }
    guard !record.pending.contains(where: { $0.id == message.id }) else { return }
    guard record.pending.count < 100 else {
      throw ClientError("The offline queue is full. Send or remove queued messages first.")
    }
    record.pending.append(message)
    if let responseTo {
      if record.responses == nil { record.responses = [:] }
      record.responses?[responseTo] = message.id
    } else {
      record.draft = ""
      record.attachments = []
    }
    try save(record, sessionID: message.sessionID)
  }
  public func markAttempted(_ commandID: String, sessionID: String) throws -> PendingMessage {
    var record = try load(sessionID)
    guard let index = record.pending.firstIndex(where: { $0.id == commandID }) else {
      throw ClientError("This queued message is no longer available.")
    }
    record.pending[index].delivery = .uncertain
    try save(record, sessionID: sessionID)
    return record.pending[index]
  }
  public func remove(_ commandID: String, sessionID: String) throws {
    var record = try load(sessionID)
    record.pending.removeAll { $0.id == commandID }
    try save(record, sessionID: sessionID)
  }
  public func releaseMemory() {
    records = [:]
    recent = []
  }
  public func erase() throws {
    retired = true
    records = [:]
    recent = []
    if FileManager.default.fileExists(atPath: directory.path) {
      try FileManager.default.removeItem(at: directory)
    }
  }
}

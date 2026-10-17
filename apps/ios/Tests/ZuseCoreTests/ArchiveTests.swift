import Foundation
import Testing

@testable import ZuseCore

struct ArchiveTests {
  func directory() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  }
  let key = Data(repeating: 42, count: 32)

  @Test func restartPreservesDraftAndExactCommandIdentity() async throws {
    let directory = directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = try ArchiveStore(directory: directory, key: key)
    let message = PendingMessage(sessionID: "session", text: "Do the work")
    try await first.enqueue(message)
    _ = try await first.markAttempted(message.id, sessionID: "session")
    try await first.saveDraft("Next message", sessionID: "session")
    let restarted = try ArchiveStore(directory: directory, key: key)
    let restored = try await restarted.load("session")
    #expect(restored.draft == "Next message")
    #expect(restored.pending.first?.id == message.id)
    #expect(restored.pending.first?.messageID == message.messageID)
    #expect(restored.pending.first?.delivery == .uncertain)
  }
  @Test func wrongKeyCannotReadArchive() async throws {
    let directory = directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let first = try ArchiveStore(directory: directory, key: key)
    try await first.saveDraft("private content", sessionID: "session")
    let other = try ArchiveStore(directory: directory, key: Data(repeating: 43, count: 32))
    await #expect(throws: (any Error).self) { _ = try await other.load("session") }
    let bytes = try Data(
      contentsOf: #require(
        FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
          .first))
    #expect(!String(decoding: bytes, as: UTF8.self).contains("private content"))
  }
  @Test func observedMessageSettlesUncertainOutboxEntry() async throws {
    let directory = directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try ArchiveStore(directory: directory, key: key)
    let pending = PendingMessage(sessionID: "session", text: "Hello")
    try await store.enqueue(pending)
    let message = ChatMessage(
      id: pending.messageID, sessionId: "session", role: "user",
      content: .object(["_tag": .string("user"), "text": .string("Hello")]), createdAt: "now")
    try await store.saveMessages([message], sessionID: "session")
    #expect(try await store.load("session").pending.isEmpty)
  }
  @Test func erasedArchiveCannotBeResurrectedByAnOldTask() async throws {
    let directory = directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try ArchiveStore(directory: directory, key: key)
    try await store.saveDraft("private", sessionID: "session")
    try await store.erase()
    await #expect(throws: ClientError.self) {
      try await store.saveDraft("stale", sessionID: "session")
    }
    #expect(!FileManager.default.fileExists(atPath: directory.path))
  }
  @Test func formResponsesAreDurableAndPreserveComposerDraft() async throws {
    let directory = directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try ArchiveStore(directory: directory, key: key)
    try await store.saveDraft("My draft", sessionID: "session")
    let message = PendingMessage(sessionID: "session", text: "answer")
    try await store.enqueue(message, responseTo: "form")
    let reopened = try ArchiveStore(directory: directory, key: key)
    #expect(try await reopened.load("session").draft == "My draft")
    await #expect(throws: ClientError.self) {
      try await reopened.enqueue(
        PendingMessage(sessionID: "session", text: "another answer"), responseTo: "form")
    }
  }
  @Test func editingDraftDoesNotRewriteLargeHistory() async throws {
    let directory = directory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let store = try ArchiveStore(directory: directory, key: key)
    let messages = (0..<10_000).map { index in
      ChatMessage(
        id: String(index), sessionId: "session", role: "assistant",
        content: .object(["_tag": .string("assistant"), "text": .string("Message \(index)")]),
        createdAt: "now")
    }
    try await store.saveMessages(messages, sessionID: "session")
    let history = directory.appendingPathComponent(
      ArchiveStore.storageID("session") + ".sealed.history")
    let before = try Data(contentsOf: history)
    try await store.saveDraft("Next prompt", sessionID: "session")
    #expect(try Data(contentsOf: history) == before)
    let metadata = try Data(
      contentsOf: directory.appendingPathComponent(ArchiveStore.storageID("session") + ".sealed"))
    #expect(metadata.count < 1024)
    let restarted = try ArchiveStore(directory: directory, key: key)
    #expect(try await restarted.load("session").messages.count == 10_000)
    #expect(try await restarted.load("session").draft == "Next prompt")
  }
}

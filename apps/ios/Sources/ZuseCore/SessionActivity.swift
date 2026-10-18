import Foundation

/// Work belongs to a restored session, and a late completion must not change another session.
public struct SessionActivity: Sendable {
  public enum Operation: Hashable, Sendable { case send, enqueue, upload, page }
  public struct Lease: Sendable {
    public let generation: UUID
    fileprivate let operation: Operation
    fileprivate let id: UUID
  }
  public private(set) var generation = UUID()
  public private(set) var isReady = false
  public private(set) var restorationError: String?
  private var operations: [Operation: UUID] = [:]
  public init() {}

  public mutating func restart() {
    generation = UUID()
    isReady = false
    restorationError = nil
    operations = [:]
  }
  public mutating func restored(generation: UUID) {
    guard generation == self.generation else { return }
    isReady = true
    restorationError = nil
  }
  public mutating func failedRestoration(_ message: String, generation: UUID) {
    guard generation == self.generation else { return }
    isReady = false
    restorationError = message
  }
  public func isActive(_ operation: Operation) -> Bool { operations[operation] != nil }
  public mutating func begin(_ operation: Operation) -> Lease? {
    guard isReady, operations[operation] == nil else { return nil }
    let id = UUID()
    operations[operation] = id
    return Lease(generation: generation, operation: operation, id: id)
  }
  public mutating func end(_ lease: Lease) {
    guard lease.generation == generation, operations[lease.operation] == lease.id else { return }
    operations.removeValue(forKey: lease.operation)
  }
}

import Foundation

/// Effect JSON RPC transport. Each connection owns its requests; mutations are never replayed.
public actor RPCClient {
  private let ownedSession: URLSession?
  private let socket: URLSessionWebSocketTask
  private var reader: Task<Void, Never>?
  private var pending: [String: AsyncThrowingStream<JSONValue, Error>.Continuation] = [:]
  private var timers: [String: Task<Void, Never>] = [:]
  private var closed = false
  private var available: Bool
  private var readiness: CheckedContinuation<Void, Error>?
  private var readinessTimer: Task<Void, Never>?

  public init(
    url: URL, protocols: [String] = [], session: URLSession = .shared, ownsSession: Bool = false
  ) throws {
    guard url.scheme == "wss" || url.scheme == "ws", url.host != nil else {
      throw ClientError("Enter a valid WebSocket address.")
    }
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw ClientError("Invalid connection address.")
    }
    var query = (components.queryItems ?? []).filter { $0.name != "wireVersion" }
    query.append(URLQueryItem(name: "wireVersion", value: "7"))
    components.queryItems = query
    guard let address = components.url else { throw ClientError("Invalid connection address.") }
    ownedSession = ownsSession ? session : nil
    socket = session.webSocketTask(with: address, protocols: protocols)
    // Attachment reads carry base64 for files up to the shared 100 MB limit.
    socket.maximumMessageSize = Attachments.maximumBytes * 4 / 3 + 1024 * 1024
    available = !protocols.contains("zuse-workspace-v3")
  }

  public func connect() async throws {
    guard reader == nil, !closed else { throw ClientError("This connection is already in use.") }
    socket.resume()
    reader = Task { [weak self, socket] in
      do {
        while !Task.isCancelled {
          let message = try await socket.receive()
          let data: Data
          switch message {
          case .data(let bytes): data = bytes
          case .string(let text): data = Data(text.utf8)
          @unknown default: continue
          }
          let value = try JSONDecoder().decode(JSONValue.self, from: data)
          if case .array(let frames) = value {
            for frame in frames { try await self?.receive(frame) }
          } else {
            try await self?.receive(value)
          }
        }
      } catch { await self?.close(error: error) }
    }
    if !available {
      try await withTaskCancellationHandler {
        try await withCheckedThrowingContinuation { continuation in
          readiness = continuation
          readinessTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(45))
            guard !Task.isCancelled else { return }
            await self?.close(
              error: ClientError("The cloud runtime is not ready. Try reconnecting."))
          }
        }
      } onCancel: {
        Task { await self.close() }
      }
    }
    let welcome = try await call("connect.handshake", ["protocolVersion": .number(7)])
    guard welcome["protocolVersion"].int == 7 else {
      close()
      throw ClientError("Update the app and runtime to compatible versions.")
    }
  }

  public func call(_ method: String, _ payload: [String: JSONValue] = [:]) async throws -> JSONValue
  {
    let stream = try await request(method, payload, timeout: 30)
    var result: JSONValue = .null
    for try await value in stream { result = value }
    return result
  }
  public func stream(_ method: String, _ payload: [String: JSONValue] = [:]) async throws
    -> AsyncThrowingStream<JSONValue, Error>
  {
    try await request(method, payload, timeout: nil)
  }
  private func request(_ method: String, _ payload: [String: JSONValue], timeout: Int?) async throws
    -> AsyncThrowingStream<JSONValue, Error>
  {
    try Task.checkCancellation()
    guard !closed, available else { throw ClientError("The connection is unavailable.") }
    let id = UUID().uuidString
    let (stream, continuation) = AsyncThrowingStream<JSONValue, Error>.makeStream(
      bufferingPolicy: .bufferingOldest(512))
    pending[id] = continuation
    continuation.onTermination = { [weak self] _ in Task { await self?.cancel(id) } }
    if let timeout {
      timers[id] = Task { [weak self] in
        try? await Task.sleep(for: .seconds(timeout))
        guard !Task.isCancelled else { return }
        await self?.fail(
          id,
          error: ClientError(
            "The request timed out. Its outcome may be unknown; reconnect before retrying."))
      }
    }
    do {
      try await send(
        .object([
          "_tag": .string("Request"), "id": .string(id), "tag": .string(method),
          "payload": .object(payload), "headers": .array([]),
        ]))
    } catch {
      fail(id, error: error)
      throw error
    }
    return stream
  }
  private func receive(_ frame: JSONValue) async throws {
    if frame["_zuseGateway"].string == "availability" {
      if frame["reset"].bool || (available && frame["state"].string != "available") {
        throw ClientError("The workspace runtime changed. Reconnect to continue.")
      }
      if frame["state"].string == "available" {
        available = true
        readinessTimer?.cancel()
        readiness?.resume()
        readiness = nil
      }
      return
    }
    if frame["_tag"].string == "Ping" {
      try await send(.object(["_tag": .string("Pong")]))
      return
    }
    if frame["_tag"].string == "Pong" { return }
    if frame["_tag"].string == "Defect" {
      throw ClientError("The runtime rejected the connection.")
    }
    guard let id = frame["requestId"].string, let continuation = pending[id] else { return }
    switch frame["_tag"].string {
    case "Chunk":
      for value in frame["values"].array {
        if case .dropped = continuation.yield(value) {
          throw ClientError("Transcript updates exceeded the buffer. Reconnecting is required.")
        }
      }
      try await send(.object(["_tag": .string("Ack"), "requestId": .string(id)]))
    case "Exit":
      pending[id] = nil
      timers.removeValue(forKey: id)?.cancel()
      if frame["exit"]["_tag"].string == "Success" {
        if frame["exit"]["value"] != .null { continuation.yield(frame["exit"]["value"]) }
        continuation.finish()
      } else {
        let error = frame["exit"]["cause"].array.first?["error"] ?? .null
        continuation.finish(
          throwing: ClientError(
            error["message"].string ?? error["_tag"].string ?? "The runtime rejected the request."))
      }
    default: break
    }
  }
  private func send(_ frame: JSONValue) async throws {
    try await socket.send(.data(JSONEncoder().encode(frame)))
  }
  private func fail(_ id: String, error: Error) {
    timers.removeValue(forKey: id)?.cancel()
    pending.removeValue(forKey: id)?.finish(throwing: error)
  }
  private func cancel(_ id: String) async {
    guard pending.removeValue(forKey: id) != nil else { return }
    timers.removeValue(forKey: id)?.cancel()
    try? await send(.object(["_tag": .string("Interrupt"), "requestId": .string(id)]))
  }
  public func close(error: Error = CancellationError()) {
    guard !closed else { return }
    closed = true
    reader?.cancel()
    reader = nil
    readinessTimer?.cancel()
    readiness?.resume(throwing: error)
    readiness = nil
    let continuations = pending.values
    pending = [:]
    for continuation in continuations { continuation.finish(throwing: error) }
    for timer in timers.values { timer.cancel() }
    timers = [:]
    socket.cancel(with: .goingAway, reason: nil)
    ownedSession?.invalidateAndCancel()
  }
}

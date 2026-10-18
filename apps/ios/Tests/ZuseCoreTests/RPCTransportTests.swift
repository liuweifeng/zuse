import Foundation
import Testing

@testable import ZuseCore

/// Only socket I/O is replaced. Production serialization, request routing, cancellation,
/// timers, gateway handling, backpressure and attachment code all run unchanged.
private struct MemoryRPC: Sendable {
  let incoming = AsyncThrowingStream<Data, Error>.makeStream()
  let outgoing = AsyncStream<JSONValue>.makeStream()
  var handshakeVersion = RPCClient.wireVersion
  var transport: RPCTransport {
    let incoming = incoming
    let outgoing = outgoing
    let version = handshakeVersion
    return RPCTransport(
      start: {},
      receive: {
        var iterator = incoming.stream.makeAsyncIterator()
        guard let bytes = try await iterator.next() else { throw CancellationError() }
        return bytes
      },
      send: { bytes in
        try Task.checkCancellation()
        let frame = try JSONDecoder().decode(JSONValue.self, from: bytes)
        outgoing.continuation.yield(frame)
        if frame["tag"].string == "connect.handshake" {
          incoming.continuation.yield(
            try JSONEncoder().encode(
              Self.success(
                frame,
                value: .object([
                  "protocolVersion": .number(Double(version))
                ]))))
        }
      },
      close: {
        incoming.continuation.finish()
        outgoing.continuation.yield(.object(["_tag": .string("TransportClosed")]))
      })
  }
  static func success(_ request: JSONValue, value: JSONValue = .null) -> JSONValue {
    .object([
      "_tag": .string("Exit"), "requestId": request["id"],
      "exit": .object(["_tag": .string("Success"), "value": value]),
    ])
  }
  func push(_ frame: JSONValue) throws {
    incoming.continuation.yield(try JSONEncoder().encode(frame))
  }
  func next(tag: String) async throws -> JSONValue {
    for await frame in outgoing.stream {
      if frame["tag"].string == tag || frame["_tag"].string == tag { return frame }
    }
    throw ClientError("The test socket ended before receiving " + tag)
  }
}

@Suite(.timeLimit(.minutes(1)))
struct RPCTransportTests {
  @Test func requestsRequireAnOpenedConnection() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport)
    await #expect(throws: ClientError.self) { _ = try await client.call("messages.send") }
    try await client.connect()
    await client.close()
  }

  @Test func socketFailureSettlesEveryOutstandingRequest() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport)
    try await client.connect()
    let first = Task { try await client.call("first") }
    _ = try await fixture.next(tag: "first")
    let second = Task { try await client.call("second") }
    _ = try await fixture.next(tag: "second")
    fixture.incoming.continuation.finish(throwing: URLError(.networkConnectionLost))
    await #expect(throws: URLError.self) { _ = try await first.value }
    await #expect(throws: URLError.self) { _ = try await second.value }
    await #expect(throws: ClientError.self) { _ = try await client.call("next") }
  }

  @Test func aStalledSocketWriteCannotOutliveTheRequestTimeout() async throws {
    let fixture = MemoryRPC()
    let base = fixture.transport
    let transport = RPCTransport(
      start: base.start, receive: base.receive,
      send: { bytes in
        let frame = try JSONDecoder().decode(JSONValue.self, from: bytes)
        if frame["tag"].string == "stalled" {
          fixture.outgoing.continuation.yield(frame)
          try await Task.sleep(for: .seconds(60))
        } else {
          try await base.send(bytes)
        }
      }, close: base.close)
    let client = RPCClient(transport: transport, requestTimeout: .milliseconds(250))
    try await client.connect()
    let request = Task { try await client.call("stalled", ["commandId": .string("original")]) }
    _ = try await fixture.next(tag: "stalled")
    await #expect(throws: ClientError.self) { _ = try await request.value }
    _ = try await fixture.next(tag: "TransportClosed")
    await #expect(throws: ClientError.self) { _ = try await client.call("next") }
  }

  @Test func concurrentRequestsRouteOutOfOrderRepliesWithoutMixingResults() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport)
    try await client.connect()
    let first = Task { try await client.call("first", ["commandId": .string("one")]) }
    let firstRequest = try await fixture.next(tag: "first")
    let second = Task { try await client.call("second", ["commandId": .string("two")]) }
    let secondRequest = try await fixture.next(tag: "second")
    try fixture.push(
      .array([
        MemoryRPC.success(secondRequest, value: .string("second result")),
        MemoryRPC.success(firstRequest, value: .string("first result")),
      ]))
    #expect(try await first.value == .string("first result"))
    #expect(try await second.value == .string("second result"))
    await client.close()
  }

  @Test func cancellingAConsumerInterruptsItsRequestWithoutClosingTheConnection() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport)
    try await client.connect()
    let stream = try await client.stream("events")
    let request = try await fixture.next(tag: "events")
    let consumer = Task {
      for try await _ in stream {}
    }
    consumer.cancel()
    _ = try? await consumer.value
    let interrupt = try await fixture.next(tag: "Interrupt")
    #expect(interrupt["requestId"] == request["id"])
    let next = Task { try await client.call("next") }
    let nextRequest = try await fixture.next(tag: "next")
    try fixture.push(MemoryRPC.success(nextRequest, value: .string("still connected")))
    #expect(try await next.value == .string("still connected"))
    await client.close()
  }

  @Test func timedOutMutationsAreInterruptedAndKeepTheirOutcomeUnknown() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport, requestTimeout: .milliseconds(250))
    try await client.connect()
    let call = Task { try await client.call("messages.send", ["commandId": .string("original")]) }
    let request = try await fixture.next(tag: "messages.send")
    do {
      _ = try await call.value
      Issue.record("Expected the request to time out")
    } catch let error as ClientError {
      #expect(error.message.contains("outcome may be unknown"))
    }
    let interrupt = try await fixture.next(tag: "Interrupt")
    #expect(interrupt["requestId"] == request["id"])
    #expect(request["payload"]["commandId"].string == "original")
    await client.close()
  }

  @Test func aStreamThatNeverStartsTimesOutAndReleasesItsServerRequest() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport, requestTimeout: .milliseconds(250))
    try await client.connect()
    let stream = try await client.stream("events")
    let request = try await fixture.next(tag: "events")
    await #expect(throws: ClientError.self) {
      for try await _ in stream {}
    }
    let interrupt = try await fixture.next(tag: "Interrupt")
    #expect(interrupt["requestId"] == request["id"])
    await client.close()
  }

  @Test func establishedStreamsKeepRunningBeyondTheInitialReplyDeadline() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport, requestTimeout: .milliseconds(100))
    try await client.connect()
    let stream = try await client.stream("events")
    let request = try await fixture.next(tag: "events")
    try fixture.push(
      .object([
        "_tag": .string("Chunk"), "requestId": request["id"], "values": .array([.number(1)]),
      ]))
    _ = try await fixture.next(tag: "Ack")
    try await Task.sleep(for: .milliseconds(200))
    try fixture.push(MemoryRPC.success(request, value: .number(2)))
    var values: [Int] = []
    for try await value in stream { if let number = value.int { values.append(number) } }
    #expect(values == [1, 2])
    await client.close()
  }

  @Test func finalStreamValueCannotSilentlyOverflowTheTranscriptBuffer() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport)
    try await client.connect()
    let stream = try await client.stream("events")
    let request = try await fixture.next(tag: "events")
    try fixture.push(
      .array([
        .object([
          "_tag": .string("Chunk"), "requestId": request["id"],
          "values": .array((0..<512).map { .number(Double($0)) }),
        ]),
        MemoryRPC.success(request, value: .number(512)),
      ]))
    _ = try await fixture.next(tag: "TransportClosed")
    var count = 0
    do {
      for try await _ in stream { count += 1 }
      Issue.record("Expected a buffer overflow error")
    } catch let error as ClientError {
      #expect(error.message.contains("exceeded the buffer"))
    }
    #expect(count == 512)
    await #expect(throws: ClientError.self) { _ = try await client.call("next") }
  }

  @Test func gatewayResetFailsPendingRequestsAndRequiresANewConnection() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport, waitsForGateway: true)
    let connection = Task { try await client.connect() }
    try fixture.push(
      .object([
        "_zuseGateway": .string("availability"), "state": .string("available"),
      ]))
    try await connection.value
    let request = Task { try await client.call("pending") }
    _ = try await fixture.next(tag: "pending")
    try fixture.push(
      .object([
        "_zuseGateway": .string("availability"), "state": .string("starting"), "reset": .bool(true),
      ]))
    await #expect(throws: ClientError.self) { _ = try await request.value }
    await #expect(throws: ClientError.self) { _ = try await client.call("next") }
  }

  @Test func unavailableGatewayTimesOutWithoutSendingAnRPCMutation() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(
      transport: fixture.transport, waitsForGateway: true, readinessTimeout: .milliseconds(100))
    await #expect(throws: ClientError.self) { try await client.connect() }
    // No handshake is sent until availability is confirmed.
    let first = try await fixture.next(tag: "TransportClosed")
    #expect(first["_tag"].string == "TransportClosed")
    await #expect(throws: ClientError.self) { _ = try await client.call("messages.send") }
  }

  @Test func incompatibleHandshakeRetiresTheConnection() async throws {
    var fixture = MemoryRPC()
    fixture.handshakeVersion = RPCClient.wireVersion - 1
    let client = RPCClient(transport: fixture.transport)
    do {
      try await client.connect()
      Issue.record("Expected an incompatible handshake error")
    } catch let error as ClientError {
      #expect(error.code == "protocol-incompatible")
    }
    await #expect(throws: ClientError.self) { _ = try await client.call("messages.send") }
  }

  @Test func attachmentChunksRoundTripThroughTheRealWireClient() async throws {
    let fixture = MemoryRPC()
    let client = RPCClient(transport: fixture.transport)
    try await client.connect()
    let bytes = Data((0..<(Attachments.chunkBytes + 37)).map { UInt8($0 % 251) })
    let upload = Task {
      try await Attachments.upload(
        bytes, name: "example.bin", mimeType: "application/octet-stream", sessionID: "session",
        rpc: client)
    }
    var uploaded = Data()
    var uploadID: String?
    for index in 0..<2 {
      let request = try await fixture.next(tag: "attachments.uploadChunk")
      let payload = request["payload"]
      #expect(payload["offset"].int == uploaded.count)
      #expect(payload["totalBytes"].int == bytes.count)
      #expect(payload["sessionId"].string == "session")
      if let uploadID { #expect(payload["uploadId"].string == uploadID) }
      uploadID = payload["uploadId"].string
      let encoded = try #require(payload["bytes"].string)
      uploaded.append(try #require(Data(base64Encoded: encoded)))
      try fixture.push(
        MemoryRPC.success(
          request,
          value: index == 0
            ? .null
            : .object([
              "id": .string("attachment"), "mimeType": .string("application/octet-stream"),
            ])))
    }
    let reference = try await upload.value
    #expect(uploaded == bytes)
    #expect(reference["id"].string == "attachment")
    let read = Task { try await Attachments.read("attachment", sessionID: "session", rpc: client) }
    let request = try await fixture.next(tag: "attachments.read")
    try fixture.push(
      MemoryRPC.success(
        request,
        value: .object([
          "bytes": .string(uploaded.base64EncodedString()), "originalName": .string("example.bin"),
          "mimeType": .string("application/octet-stream"),
        ])))
    let (downloaded, _, name) = try await read.value
    #expect(downloaded == bytes)
    #expect(name == "example.bin")
    await client.close()
  }
}

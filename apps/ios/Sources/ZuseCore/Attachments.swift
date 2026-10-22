import Foundation

public enum Attachments {
  public static let maximumBytes = 100 * 1024 * 1024
  public static let chunkBytes = 2 * 1024 * 1024
  public static func upload(
    _ data: Data, name: String, mimeType: String, sessionID: String, rpc: RPCClient
  ) async throws -> JSONValue {
    guard data.count <= maximumBytes else {
      throw ClientError("Attachments must be 100 MB or smaller.")
    }
    let base: [String: JSONValue] = [
      "sessionId": .string(sessionID), "mimeType": .string(mimeType), "originalName": .string(name),
    ]
    var result: JSONValue = .null
    if data.count <= chunkBytes {
      var payload = base
      payload["bytes"] = .string(data.base64EncodedString())
      result = try await rpc.call("attachments.upload", payload)
    } else {
      let uploadID = UUID().uuidString
      for offset in stride(from: 0, to: data.count, by: chunkBytes) {
        try Task.checkCancellation()
        let end = min(offset + chunkBytes, data.count)
        var payload = base
        payload["bytes"] = .string(data.subdata(in: offset..<end).base64EncodedString())
        payload["uploadId"] = .string(uploadID)
        payload["offset"] = .number(Double(offset))
        payload["totalBytes"] = .number(Double(data.count))
        result = try await rpc.call("attachments.uploadChunk", payload)
        guard (end == data.count) == (result != .null) else {
          throw ClientError("The upload did not complete. Please attach the file again.")
        }
      }
    }
    guard let id = result["id"].string, let mime = result["mimeType"].string else {
      throw ClientError("Invalid attachment response.")
    }
    return .object(["id": .string(id), "mimeType": .string(mime), "originalName": .string(name)])
  }
  public static func read(_ id: String, sessionID: String, rpc: RPCClient) async throws -> (
    Data, String, String
  ) {
    let result = try await rpc.call(
      "attachments.read", ["id": .string(id), "sessionId": .string(sessionID)])
    guard let encoded = result["bytes"].string, encoded.utf8.count <= maximumBytes * 4 / 3 + 8,
      let data = Data(base64Encoded: encoded), data.count <= maximumBytes
    else { throw ClientError("This attachment could not be read.") }
    return (
      data, result["mimeType"].string ?? "application/octet-stream",
      result["originalName"].string ?? "Attachment"
    )
  }
}

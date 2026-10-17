import Foundation

public struct PairingLink: Sendable, Equatable {
  public let httpURL: URL
  public let webSocketURL: URL
  public let code: String
  public static func isPrivateHost(_ value: String) -> Bool {
    let host = value.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
      .trimmingCharacters(in: CharacterSet(charactersIn: "."))
    if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local")
      || host == "::1"
    {
      return true
    }
    let components = host.split(separator: ".")
    if components.count == 4 {
      let values = components.compactMap { Int($0) }
      guard values.count == 4, values.allSatisfy({ (0...255).contains($0) }) else { return false }
      return values == [127, 0, 0, 1] || values[0] == 10 || (values[0] == 192 && values[1] == 168)
        || (values[0] == 172 && (16...31).contains(values[1]))
        || (values[0] == 169 && values[1] == 254)
    }
    return host.hasPrefix("fe80:")
      || ((host.hasPrefix("fc") || host.hasPrefix("fd")) && host.contains(":"))
  }
  public static func validate(_ url: URL, webSocket: Bool) throws {
    let secure = webSocket ? "wss" : "https"
    let local = webSocket ? "ws" : "http"
    guard let host = url.host, !host.isEmpty, url.user == nil, url.password == nil,
      url.scheme == secure || (url.scheme == local && isPrivateHost(host)),
      url.port.map({ (1...65535).contains($0) }) ?? true
    else {
      throw ClientError("Use HTTPS for public servers, or a private local network address.")
    }
  }
  public static func parse(_ value: String) throws -> PairingLink {
    guard let outer = URLComponents(string: value.trimmingCharacters(in: .whitespacesAndNewlines))
    else { throw ClientError("Invalid pairing link.") }
    var endpoint: URLComponents
    let code: String
    let fragments =
      URLComponents(string: "https://local/?" + (outer.percentEncodedFragment ?? ""))?.queryItems
      ?? []
    if outer.scheme == "http" || outer.scheme == "https" {
      guard let pair = fragments.first(where: { $0.name == "pair" })?.value, !pair.isEmpty else {
        throw ClientError("The pairing link is missing its code.")
      }
      code = pair
      endpoint = outer
      endpoint.scheme = outer.scheme == "https" ? "wss" : "ws"
      endpoint.path = "/rpc"
      endpoint.query = nil
      endpoint.fragment = nil
    } else if outer.scheme == "zuse" || outer.scheme == "memoize" {
      guard let address = outer.queryItems?.first(where: { $0.name == "pairingUrl" })?.value,
        let parsed = URLComponents(string: address),
        let token = fragments.first(where: { $0.name == "token" })?.value, !token.isEmpty
      else { throw ClientError("The pairing link is incomplete.") }
      endpoint = parsed
      code = token
      if endpoint.path.isEmpty || endpoint.path == "/" { endpoint.path = "/rpc" }
    } else {
      throw ClientError("This is not a Zuse pairing link.")
    }
    guard let ws = endpoint.url, endpoint.query == nil, endpoint.fragment == nil else {
      throw ClientError("Invalid pairing endpoint.")
    }
    try validate(ws, webSocket: true)
    endpoint.scheme = ws.scheme == "wss" ? "https" : "http"
    endpoint.path = ""
    guard let http = endpoint.url else { throw ClientError("Invalid pairing endpoint.") }
    return PairingLink(httpURL: http, webSocketURL: ws, code: code)
  }
}

/// Redirects are rejected so a one-time code cannot be forwarded to another server.
public final class PairingHTTPDelegate: NSObject, URLSessionTaskDelegate, Sendable {
  public func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) { completionHandler(nil) }
}

public enum PairingClient {
  public static func redeem(
    _ link: PairingLink, deviceID: String, label: String, certificatePin: String? = nil
  ) async throws
    -> JSONValue
  {
    let session =
      try certificatePin.map { try PinnedConnection.session(pin: $0) }
      ?? URLSession(
        configuration: .ephemeral, delegate: PairingHTTPDelegate(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    var request = URLRequest(url: link.httpURL.appendingPathComponent("pair"))
    request.httpMethod = "POST"
    request.timeoutInterval = 15
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONEncoder().encode([
      "code": link.code, "deviceId": deviceID, "deviceLabel": label,
    ])
    let (data, response) = try await session.data(for: request)
    guard let response = response as? HTTPURLResponse else {
      throw ClientError("Invalid pairing response.")
    }
    guard response.statusCode == 200 else {
      throw ClientError(
        response.statusCode == 410
          ? "This pairing code expired. Generate a new code on your computer."
          : "Pairing failed. Check the address and pairing code.")
    }
    let result = try JSONDecoder().decode(JSONValue.self, from: data)
    guard let token = result["token"].string, token.hasPrefix("zt_") else {
      throw ClientError("The computer did not return a valid connection token.")
    }
    return result
  }
}

import Foundation

public struct CloudChat: Codable, Identifiable, Sendable {
  public let workspaceId: String
  public let projectId: String
  public let chatId: String
  public let initialSessionId: String
  public let activeSessionId: String?
  public let title: String
  public let repositoryDisplayName: String
  public let state: String
  public let runtimeState: String
  public var id: String { workspaceId + ":" + chatId }
  public var sessionID: String { activeSessionId ?? initialSessionId }
}

public struct CloudClient: Sendable {
  private static let session = URLSession(
    configuration: .ephemeral, delegate: PairingHTTPDelegate(), delegateQueue: nil)
  public let baseURL: URL
  private let token: @Sendable () async throws -> String
  public init(baseURL: URL, token: @escaping @Sendable () async throws -> String) {
    self.baseURL = baseURL
    self.token = token
  }
  public func request(
    _ path: String, method: String = "GET", body: JSONValue? = nil, proof: DeviceProof? = nil,
    deviceToken: String? = nil
  ) async throws
    -> JSONValue
  {
    guard baseURL.scheme == "https", let url = URL(string: path, relativeTo: baseURL)?.absoluteURL,
      url.host == baseURL.host, url.port == baseURL.port, url.user == nil, url.password == nil,
      url.scheme == "https"
    else { throw ClientError("Cloud connections require HTTPS.") }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 30
    if let deviceToken {
      request.setValue("DPoP \(deviceToken)", forHTTPHeaderField: "Authorization")
    } else {
      request.setValue("Bearer \(try await token())", forHTTPHeaderField: "Authorization")
    }
    if let proof {
      request.setValue(try proof.sign(method: method, url: url), forHTTPHeaderField: "DPoP")
    }
    if let body {
      request.httpBody = try JSONEncoder().encode(body)
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await Self.session.data(for: request)
    guard let response = response as? HTTPURLResponse else {
      throw ClientError("Invalid cloud response.")
    }
    guard (200..<300).contains(response.statusCode) else {
      if response.statusCode == 401 { throw ClientError("Your session expired. Sign in again.") }
      let detail = try? JSONDecoder().decode(JSONValue.self, from: data)
      let reason =
        detail?["message"].string ?? detail?["error"]["message"].string ?? detail?["reason"].string
      throw ClientError(
        reason.map { String($0.prefix(500)) } ?? "Cloud request failed (\(response.statusCode)).")
    }
    if data.isEmpty { return .null }
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }
  public func chats() async throws -> [CloudChat] {
    try await request("/v1/cloud/chats?scope=active")["chats"].decode([CloudChat].self)
  }
  public func connect(workspaceID: String) async throws -> RPCClient {
    let id = workspaceID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    let ticket = try await request(
      "/v1/cloud/workspaces/\(id)/gateway/ticket", method: "POST",
      body: .object(["protocol": .string("zuse-workspace-v3")]))
    guard let address = ticket["wsUrl"].string, let url = URL(string: address), url.scheme == "wss",
      let credential = ticket["credential"].string, let protocolName = ticket["protocol"].string
    else { throw ClientError("Invalid cloud connection ticket.") }
    let rpc = try RPCClient(url: url, protocols: [protocolName, credential])
    do {
      try await rpc.connect()
      return rpc
    } catch {
      await rpc.close()
      throw error
    }
  }
}

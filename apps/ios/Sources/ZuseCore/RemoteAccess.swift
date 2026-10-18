import Foundation

#if canImport(CryptoKit)
  import CryptoKit
#else
  import Crypto
#endif
#if canImport(FoundationNetworking)
  import FoundationNetworking
#endif

public struct RemoteEnvironment: Codable, Identifiable, Sendable {
  public let environmentId: String
  public let label: String?
  public let providerKind: String
  public var id: String { environmentId }
}

public struct DeviceProof: Sendable {
  private let key: P256.Signing.PrivateKey
  public init(rawKey: Data) throws { key = try P256.Signing.PrivateKey(rawRepresentation: rawKey) }
  public static func generateKey() -> Data { P256.Signing.PrivateKey().rawRepresentation }
  public func sign(method: String, url: URL, now: Date = Date(), nonce: String = UUID().uuidString)
    throws -> String
  {
    guard var target = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
      throw ClientError("Invalid proof URL.")
    }
    target.query = nil
    target.fragment = nil
    guard let address = target.url else { throw ClientError("Invalid proof URL.") }
    let point = key.publicKey.x963Representation
    let header: JSONValue = .object([
      "alg": .string("ES256"), "typ": .string("dpop+jwt"),
      "jwk": .object([
        "kty": .string("EC"), "crv": .string("P-256"),
        "x": .string(Self.encode(point.subdata(in: 1..<33))),
        "y": .string(Self.encode(point.subdata(in: 33..<65))),
      ]),
    ])
    let payload: JSONValue = .object([
      "htm": .string(method.uppercased()), "htu": .string(address.absoluteString),
      "iat": .number(floor(now.timeIntervalSince1970)), "jti": .string(nonce),
    ])
    let input =
      try Self.encode(JSONEncoder().encode(header)) + "."
      + Self.encode(JSONEncoder().encode(payload))
    return try input + "." + Self.encode(key.signature(for: Data(input.utf8)).rawRepresentation)
  }
  private static func encode(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(
      of: "/", with: "_"
    ).replacingOccurrences(of: "=", with: "")
  }
}

extension CloudClient {
  public func environments() async throws -> [RemoteEnvironment] {
    try await request("/v1/environments")["environments"].decode([RemoteEnvironment].self)
  }
  public func connectEnvironment(_ id: String, proof: DeviceProof) async throws -> RPCClient {
    let grant = try await request("/v1/client/dpop-token", method: "POST", proof: proof)
    guard let access = grant["accessToken"].string else {
      throw ClientError("Invalid device grant.")
    }
    let encoded = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    let connection = try await request(
      "/v1/environments/\(encoded)/connect", method: "POST", proof: proof, deviceToken: access)
    guard let address = connection["endpoint"]["wsBaseUrl"].string,
      var url = URLComponents(string: address), url.scheme == "wss",
      let token = connection["connectToken"].string
    else { throw ClientError("The computer did not return a secure endpoint.") }
    url.queryItems =
      (url.queryItems ?? []).filter { $0.name != "token" } + [
        URLQueryItem(name: "token", value: token)
      ]
    guard let endpoint = url.url else { throw ClientError("Invalid computer endpoint.") }
    let rpc = try RPCClient(url: endpoint)
    do {
      try await rpc.connect()
      let descriptor = try await rpc.call("connect.describe")
      guard descriptor["environmentId"].string == id else {
        throw ClientError(
          "The connected computer does not match the selected account device.",
          code: "identity-changed")
      }
      return rpc
    } catch {
      await rpc.close()
      throw error
    }
  }
}

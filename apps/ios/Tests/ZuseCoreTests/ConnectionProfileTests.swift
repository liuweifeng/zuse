import Foundation
import Testing

@testable import ZuseCore

@Test func savedComputersKeepDistinctTransportsAndReplaceRotatedTokens() throws {
  let old = RemoteConnection(address: "wss://mac.example/rpc", token: "old")
  let rotated = RemoteConnection(address: old.address, token: "new", label: "Studio")
  let local = RemoteConnection(address: "ws://192.168.1.5:4859/rpc", token: "local")
  let profiles = ConnectionProfiles.saving(rotated, in: [local, old])
  #expect(profiles.count == 2)
  #expect(profiles[0].token == "new")
  #expect(profiles[0].displayName == "Studio")
  #expect(profiles[1].transportName == "Local network")
  #expect(!profiles[0].id.contains("new"))
  #expect(
    RemoteConnection(address: "wss://studio.tail.ts.net/rpc", token: "").transportName
      == "Tailscale")
}

@Test func manualComputersValidateBeforeReplacingTheActiveConnection() throws {
  #expect(throws: ClientError.self) {
    _ = try RemoteConnection(address: "ws://public.example/rpc", token: "secret").validated()
  }
  #expect(throws: ClientError.self) {
    _ = try RemoteConnection(address: "wss://mac.example/rpc?token=secret", token: "").validated()
  }
  #expect(throws: ClientError.self) {
    _ = try RemoteConnection(address: "ws://localhost:4859/rpc", token: "", certificatePin: "pin")
      .validated()
  }
  _ = try RemoteConnection(address: "ws://127.0.0.1:4859/rpc", token: "").validated()
  _ = try RemoteConnection(address: "wss://mac.tail.ts.net/rpc", token: "secret").validated()
}

@Test func existingSingleComputerCredentialsRemainDecodable() throws {
  let data = Data(#"{"address":"wss://mac.example/rpc","token":"zt_old"}"#.utf8)
  let computer = try JSONDecoder().decode(RemoteConnection.self, from: data)
  #expect(computer.label == nil)
  #expect(computer.environmentID == nil)
  #expect(computer.displayName == "mac.example")
}

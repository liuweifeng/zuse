import Foundation

public struct GitBranch: Codable, Identifiable, Sendable {
  public let name: String
  public let current: Bool
  public let remote: String?
  public let kind: String
  public var id: String { kind + ":" + (remote ?? "") + ":" + name }
  public var worktreeSource: JSONValue {
    .object([
      "_tag": .string("branch"), "branch": .string(name),
      "remote": remote.map(JSONValue.string) ?? .null,
    ])
  }
}

/// One payload builder for every native new-chat entry point.
public struct ChatCreation: Codable, Sendable, Equatable {
  public let operationID: String
  public let chatID: String
  public let sessionID: String
  public var projectID: String
  public var providerID: String
  public var model: String
  public var runtimeMode: String
  public var permissionMode: String
  public var freshWorktree: Bool
  public var worktreeID: String?

  public init(
    projectID: String, providerID: String, model: String,
    runtimeMode: String = "approval-required", permissionMode: String = "default",
    freshWorktree: Bool = false, worktreeID: String? = nil
  ) {
    operationID = UUID().uuidString
    chatID = UUID().uuidString
    sessionID = UUID().uuidString
    self.projectID = projectID
    self.providerID = providerID
    self.model = model
    self.runtimeMode = runtimeMode
    self.permissionMode = permissionMode
    self.freshWorktree = freshWorktree
    self.worktreeID = worktreeID
  }
  public var payload: [String: JSONValue] {
    let policy: JSONValue
    if let worktreeID {
      policy = .object(["_tag": .string("existing"), "worktreeId": .string(worktreeID)])
    } else {
      policy = .object(["_tag": .string(freshWorktree ? "fresh" : "main")])
    }
    return [
      "operationId": .string(operationID), "chatId": .string(chatID),
      "initialSessionId": .string(sessionID), "projectId": .string(projectID),
      "providerId": .string(providerID), "model": .string(model),
      "runtimeMode": .string(runtimeMode), "permissionMode": .string(permissionMode),
      "workspacePolicy": policy,
    ]
  }
}

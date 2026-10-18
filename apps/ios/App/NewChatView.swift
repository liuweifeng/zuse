import SwiftUI
import ZuseCore

struct NewChatView: View {
  let workspace: WorkspaceModel
  @Environment(\.dismiss) private var dismiss
  @State private var project = ""
  @State private var provider = ""
  @State private var model = ""
  @State private var mode = "main"
  @State private var branch = ""
  @State private var worktree = ""
  @State private var runtimeMode = "approval-required"
  @State private var permissionMode = "default"
  @State private var catalog: [ModelProvider] = []
  @State private var branches: [GitBranch] = []
  @State private var worktrees: [JSONValue] = []
  @State private var failure: String?
  @State private var sourceFailure: String?
  @State private var creating = false
  @State private var loadingSources = false
  @State private var scope: String?
  @State private var intent: ChatCreation?
  @State private var uncertainBranch = false
  @State private var switchingDevice = false
  private var selectedProvider: ModelProvider? { catalog.first { $0.id == provider } }
  private var intentKey: String? {
    scope.map { "create-chat:" + ArchiveStore.storageID($0) }
  }
  private var connected: Bool {
    scope == workspace.operationScope && workspace.connectionState == "Connected"
  }
  var body: some View {
    NavigationStack {
      Form {
        if let failure { Section { Text(failure).foregroundStyle(.red) } }
        Section("Computer & project") {
          Menu {
            ForEach(workspace.savedConnections) { connection in
              Button(connection.displayName) {
                switchingDevice = true
                workspace.openRemote(connection)
                scope = workspace.operationScope
              }
            }
            ForEach(workspace.environments) { environment in
              Button(environment.label ?? "Computer") {
                switchingDevice = true
                workspace.openEnvironment(environment)
                scope = workspace.operationScope
              }
            }
          } label: {
            LabeledContent(
              "Computer", value: workspace.connectedComputer ?? workspace.connectionState)
          }
          .disabled(workspace.savedConnections.isEmpty && workspace.environments.isEmpty)
          if switchingDevice {
            Text(workspace.connectionProblem ?? workspace.connectionState).font(.caption)
              .foregroundStyle(.secondary)
          }
          Picker("Project", selection: $project) {
            Text("Choose a project").tag("")
            ForEach(workspace.projects) { Text($0.name).tag($0.id) }
          }
        }
        .disabled(intent != nil)
        Section("Workspace") {
          Picker("Work in", selection: $mode) {
            Text("Main checkout").tag("main")
            Text("New worktree").tag("fresh")
            Text("Existing branch").tag("branch")
            Text("Existing worktree").tag("existing")
          }
          if mode == "branch" {
            Picker("Branch", selection: $branch) {
              Text("Choose a branch").tag("")
              ForEach(branches.filter { !$0.current }) { Text($0.name).tag($0.id) }
            }
          } else if mode == "existing" {
            Picker("Worktree", selection: $worktree) {
              Text("Choose a worktree").tag("")
              ForEach(worktrees, id: \.["id"].string) { row in
                Text(row["branch"].string ?? row["name"].string ?? "Worktree")
                  .tag(row["id"].string ?? "")
              }
            }
          }
          if loadingSources { ProgressView("Loading branches…") }
          if let sourceFailure {
            Text(sourceFailure).font(.caption).foregroundStyle(.secondary)
            Button("Reload branches") { Task { await loadSources() } }
          }
        }
        .disabled(intent != nil)
        Section("Agent") {
          if catalog.isEmpty {
            Text("No available agents. Check this computer's provider settings.").foregroundStyle(
              .secondary)
          }
          Picker("Agent", selection: $provider) {
            ForEach(catalog) { Text($0.name).tag($0.id) }
          }.onChange(of: provider) {
            if intent == nil { model = selectedProvider?.defaultModel ?? "" }
          }
          Picker("Model", selection: $model) {
            ForEach(selectedProvider?.models ?? []) { Text($0.label).tag($0.id) }
          }
          Picker("Permissions", selection: $runtimeMode) {
            Text("Ask before changes").tag("approval-required")
            Text("Allow edits").tag("auto-accept-edits")
            Text("Allow edits & commands").tag("auto-accept-edits-and-bash")
            Text("Full access").tag("full-access")
          }
          Toggle(
            "Start in plan mode",
            isOn: Binding(
              get: { permissionMode == "plan" }, set: { permissionMode = $0 ? "plan" : "default" }))
        }
        .disabled(intent != nil)
        Section {
          Button(creating ? "Creating…" : intent == nil ? "Create chat" : "Retry same chat") {
            Task { await create() }
          }
          .accessibilityIdentifier("new-chat-create")
          .disabled(!canCreate)
          if intent != nil {
            Text(
              "A creation request is saved. Retry uses the same identity to prevent duplicate chats."
            )
            .font(.caption).foregroundStyle(.secondary)
            Button("Discard saved request", role: .destructive) {
              do {
                if let intentKey { try Vault.write(nil, key: intentKey) }
                intent = nil
              } catch { failure = error.localizedDescription }
            }
          }
        }
      }
      .formStyle(.grouped)
      .disabled(creating)
      .navigationTitle("New chat").compactNavigationTitle()
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
      .task { await load() }
      .task(id: project) { await loadSources() }
      .interactiveDismissDisabled(creating)
      .onChange(of: workspace.operationScope) { _, _ in
        if !switchingDevice { dismiss() }
      }
      .onChange(of: workspace.connectionState) { _, state in
        if switchingDevice && state == "Connected" {
          Task {
            await load()
            switchingDevice = false
          }
        }
      }
    }.nativeSheetSize(width: 440, height: 520)
  }
  private var canCreate: Bool {
    connected && !creating && !project.isEmpty && !model.isEmpty && !provider.isEmpty
      && (intent != nil
        || ((mode != "branch" || (!branch.isEmpty && !uncertainBranch))
          && (mode != "existing" || !worktree.isEmpty)))
  }
  private func load() async {
    failure = nil
    catalog = []
    scope = workspace.operationScope
    project = workspace.selectedProject?.id ?? workspace.projects.first?.id ?? ""
    let requestedScope = scope
    do {
      guard let rpc = workspace.rpc else { throw ClientError("Connect to a computer first.") }
      let loaded = try await ModelProvider.load(rpc)
      guard workspace.operationScope == requestedScope, !Task.isCancelled else { return }
      catalog = loaded
      provider = catalog.first?.id ?? ""
      model = selectedProvider?.defaultModel ?? ""
      if let intentKey, let data = try Vault.read(intentKey) {
        intent = try JSONDecoder().decode(ChatCreation.self, from: data)
        if let intent {
          project = intent.projectID
          provider = intent.providerID
          model = intent.model
          runtimeMode = intent.runtimeMode
          permissionMode = intent.permissionMode
          mode = intent.freshWorktree ? "fresh" : intent.worktreeID == nil ? "main" : "existing"
          worktree = intent.worktreeID ?? ""
        }
      }
    } catch {
      if workspace.operationScope == requestedScope && !Task.isCancelled {
        failure = error.localizedDescription
      }
    }
  }
  private func loadSources() async {
    branches = []
    worktrees = []
    if intent == nil { worktree = "" }
    branch = ""
    sourceFailure = nil
    guard !project.isEmpty, let rpc = workspace.rpc else { return }
    let requested = project
    let requestedScope = scope
    loadingSources = true
    defer { if project == requested { loadingSources = false } }
    do {
      async let branchRows = rpc.call("git.branches", ["folderId": .string(requested)])
      async let treeRows = rpc.call("worktree.list", ["projectId": .string(requested)])
      let (b, t) = try await (branchRows, treeRows)
      guard project == requested, scope == requestedScope, !Task.isCancelled else { return }
      branches = try b.decode([GitBranch].self)
      worktrees = t.array
    } catch {
      if !Task.isCancelled && project == requested { sourceFailure = error.localizedDescription }
    }
  }
  private func create() async {
    guard canCreate, let rpc = workspace.rpc, let intentKey else { return }
    creating = true
    failure = nil
    defer { creating = false }
    do {
      if intent == nil {
        var treeID = mode == "existing" ? worktree : nil
        if mode == "branch" {
          guard let selected = branches.first(where: { $0.id == branch }) else { return }
          // This legacy mutation has no idempotency key: never replay an uncertain result.
          uncertainBranch = true
          let result = try await rpc.call(
            "worktree.create", ["projectId": .string(project), "source": selected.worktreeSource])
          guard connected else { throw CancellationError() }
          guard let id = result["id"].string else {
            throw ClientError(
              "The computer did not return a worktree. Reload worktrees before retrying.")
          }
          treeID = id
          mode = "existing"
          worktree = id
          worktrees.insert(result, at: 0)
          uncertainBranch = false
        }
        let creation = ChatCreation(
          projectID: project, providerID: provider, model: model,
          runtimeMode: runtimeMode, permissionMode: permissionMode,
          freshWorktree: mode == "fresh", worktreeID: treeID)
        try Vault.write(JSONEncoder().encode(creation), key: intentKey)
        intent = creation
      }
      guard let intent else { return }
      try await workspace.createChat(intent)
      try Vault.write(nil, key: intentKey)
      dismiss()
    } catch {
      failure =
        uncertainBranch
        ? "The branch checkout result is unconfirmed. Reload and choose its existing worktree before creating a chat."
        : error.localizedDescription
    }
  }
}

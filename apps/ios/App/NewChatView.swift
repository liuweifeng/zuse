import SwiftUI
import ZuseCore

struct NewChatView: View {
  let workspace: WorkspaceModel
  var embedded = false
  var destination: AnyView? = nil
  var prompt: Binding<String> = .constant("")
  var busyChanged: (Bool) -> Void = { _ in }
  @Environment(\.dismiss) private var dismiss
  @State private var project = ""
  @State private var provider = ""
  @State private var model = ""
  @State private var modelOptions: [String: String] = [:]
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
  @State private var showProject = false
  @State private var showOptions = false
  private var selectedProvider: ModelProvider? { catalog.first { $0.id == provider } }
  private var intentKey: String? {
    scope.map { "create-chat:" + ArchiveStore.storageID($0) }
  }
  private var connected: Bool {
    scope == workspace.operationScope && workspace.connectionState == "Connected"
  }
  var body: some View {
    Group {
      if embedded { content } else { NavigationStack { content } }
    }.nativeSheetSize(width: 480, height: 600)
  }
  private var content: some View {
    Color.clear
      .background(AppTheme.surface)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(alignment: .leading, spacing: 2) {
          if let failure { Text(failure).font(.caption).foregroundStyle(.red).padding(.bottom, 8) }
          if let destination { destination }
          Menu {
            Picker("Project", selection: $project) {
              Text("Choose a project").tag("")
              ForEach(workspace.projects) { Text($0.name).tag($0.id) }
            }
            Button("Add a project", systemImage: "folder.badge.plus") { showProject = true }
          } label: {
            SetupSelectorLabel(
              icon: "folder",
              title: workspace.projects.first { $0.id == project }?.name ?? "Choose a project")
          }.disabled(intent != nil || creating)
          Menu {
            Picker("Work in", selection: $mode) {
              Text("Main checkout").tag("main")
              Text("New worktree").tag("fresh")
              Text("Existing branch").tag("branch")
              Text("Existing worktree").tag("existing")
            }
          } label: {
            SetupSelectorLabel(icon: "desktopcomputer", title: workspaceLabel)
          }
          .disabled(intent != nil || creating)
          Menu {
            if mode == "existing" {
              Picker("Worktree", selection: $worktree) {
                Text("Choose a worktree").tag("")
                ForEach(worktrees, id: \.["id"].string) { row in
                  Text(row["branch"].string ?? row["name"].string ?? "Worktree").tag(
                    row["id"].string ?? "")
                }
              }
            } else {
              Picker("Branch", selection: $branch) {
                Text("Choose a branch").tag("")
                ForEach(branches.filter { !$0.current }) { Text($0.name).tag($0.id) }
              }
            }
          } label: {
            SetupSelectorLabel(icon: "arrow.triangle.branch", title: branchLabel)
          }
          .disabled(
            intent != nil || creating || loadingSources || mode == "main" || mode == "fresh")
          if loadingSources { ProgressView().controlSize(.mini).padding(.leading, 6) }
          if let sourceFailure {
            HStack {
              Text(sourceFailure).lineLimit(2)
              Button("Retry") { Task { await loadSources() } }
            }.font(.caption).foregroundStyle(.secondary)
          }
          if intent != nil {
            HStack {
              Text("A saved chat request is ready to retry.")
              Button("Discard", role: .destructive) {
                do {
                  if let intentKey { try Vault.write(nil, key: intentKey) }
                  intent = nil
                } catch { failure = error.localizedDescription }
              }
            }.font(.caption).padding(.vertical, 4)
          }
          NewChatDraftComposer(
            text: prompt, enabled: canCreate, busy: creating, editable: intent == nil,
            options: AnyView(
              Button("Chat options", systemImage: "slider.horizontal.3") { showOptions = true }),
            models: AnyView(modelMenu)
          ) { Task { await create() } }
          .padding(.top, 10)
        }.frame(maxWidth: 720).frame(maxWidth: .infinity)
          .padding(.horizontal, 16).padding(.bottom, 12).padding(.top, 12)
          .background { ComposerFade().padding(.top, -40) }
      }
      .navigationTitle("New chat").compactNavigationTitle()
      .toolbar {
        if !embedded {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
        }
      }
      .sheet(isPresented: $showProject) { AddProjectView(workspace: workspace) }
      .sheet(isPresented: $showOptions) { options }
      .onChange(of: creating) { _, value in busyChanged(value) }
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
  }
  private var workspaceLabel: String {
    switch mode {
    case "fresh": "New worktree"
    case "branch": "Existing branch"
    case "existing": "Existing worktree"
    default: "Main checkout"
    }
  }
  private var branchLabel: String {
    if mode == "existing" {
      return worktrees.first { $0["id"].string == worktree }?["branch"].string
        ?? "Choose a worktree"
    }
    if mode == "branch" { return branches.first { $0.id == branch }?.name ?? "Choose a branch" }
    return branches.first { $0.current }?.name ?? "Current branch"
  }
  private var modelMenu: some View {
    ModelPickerButton(
      catalog: catalog, providerID: provider, modelID: model, modelOptions: $modelOptions
    ) {
      providerID, modelID in
      provider = providerID
      model = modelID
    }.disabled(intent != nil || creating || catalog.isEmpty)
  }
  private var options: some View {
    NavigationStack {
      Form {
        Picker("Permissions", selection: $runtimeMode) {
          Text("Ask before changes").tag("approval-required")
          Text("Allow edits").tag("auto-accept-edits")
          Text("Allow edits & commands").tag("auto-accept-edits-and-bash")
          Text("Full access").tag("full-access")
        }
        Toggle(
          "Plan mode",
          isOn: Binding(
            get: { permissionMode == "plan" }, set: { permissionMode = $0 ? "plan" : "default" }))
      }.disabled(intent != nil).navigationTitle("Chat options").compactNavigationTitle()
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { showOptions = false } }
        }
    }.nativeSheetSize(width: 400, height: 320)
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
          prompt.wrappedValue = intent.initialPrompt ?? ""
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
          freshWorktree: mode == "fresh", worktreeID: treeID,
          initialPrompt: prompt.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines),
          modelOptions: modelOptions)
        try Vault.write(JSONEncoder().encode(creation), key: intentKey)
        intent = creation
      }
      guard let intent else { return }
      try await workspace.createChat(intent)
      try Vault.write(nil, key: intentKey)
      prompt.wrappedValue = ""
      dismiss()
    } catch {
      failure =
        uncertainBranch
        ? "The branch checkout result is unconfirmed. Reload and choose its existing worktree before creating a chat."
        : error.localizedDescription
    }
  }
}

struct NewChatSetupView: View {
  @Bindable var workspace: WorkspaceModel
  init(workspace: WorkspaceModel, initialCloud: Bool = false) {
    self.workspace = workspace
    _cloud = State(initialValue: initialCloud)
  }
  @Environment(\.dismiss) private var dismiss
  @State private var cloud = false
  @State private var draft = ""
  @State private var busy = false
  @State private var method: ConnectionMethod?
  @State private var sampleModel = "sample-balanced"
  @State private var sampleModelOptions: [String: String] = [:]
  private var machineLabel: String {
    cloud ? "Cloud" : workspace.connectedComputer ?? "Choose computer"
  }
  private var destinationMenu: some View {
    Menu {
      Section("Run on") {
        Button("Computer", systemImage: "laptopcomputer") { cloud = false }
        Button("Cloud", systemImage: "cloud") { cloud = true }
      }
      if !workspace.savedConnections.isEmpty {
        Section("Saved computers") {
          ForEach(workspace.savedConnections) { connection in
            Button(connection.displayName) {
              cloud = false
              workspace.openRemote(connection)
            }
          }
        }
      }
      if !workspace.environments.isEmpty {
        Section("Remote computers") {
          ForEach(workspace.environments) { environment in
            Button(environment.label ?? "Computer") {
              cloud = false
              workspace.openEnvironment(environment)
            }
          }
        }
      }
      Section {
        Button("Find a nearby computer", systemImage: "wifi") {
          cloud = false
          method = .nearby
        }
        Button("Scan a pairing code", systemImage: "qrcode.viewfinder") {
          cloud = false
          method = .pairing
        }
        Button("Add manually", systemImage: "plus") {
          cloud = false
          method = .manual
        }
      }
    } label: {
      SetupSelectorLabel(icon: cloud ? "cloud" : "laptopcomputer", title: machineLabel)
    }
    .accessibilityIdentifier("new-chat-destination").accessibilityLabel("Run on: " + machineLabel)
    .disabled(busy).menuOrder(.fixed)
  }
  @ViewBuilder private var fallbackModelPicker: some View {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--native-preview"),
        let catalog = try? WorkspaceModel.previewModelCatalog()
      {
        ModelPickerButton(
          catalog: catalog,
          providerID: catalog.first { $0.models.contains { $0.id == sampleModel } }?.id
            ?? "Preview",
          modelID: sampleModel, sample: true, modelOptions: $sampleModelOptions
        ) { _, model in sampleModel = model }
      } else {
        Text("Choose agent").font(.caption).foregroundStyle(.tertiary)
      }
    #else
      Text("Choose agent").font(.caption).foregroundStyle(.tertiary)
    #endif
  }
  var body: some View {
    NavigationStack {
      Group {
        if cloud && workspace.account.signedIn {
          CloudLaunchView(
            workspace: workspace, embedded: true, prompt: $draft,
            destination: AnyView(destinationMenu), busyChanged: { busy = $0 })
        } else if !cloud && workspace.rpc != nil {
          NewChatView(
            workspace: workspace, embedded: true,
            destination: AnyView(destinationMenu), prompt: $draft, busyChanged: { busy = $0 }
          )
          .id(workspace.operationScope)
        } else {
          Color.clear.safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(alignment: .leading, spacing: 3) {
              destinationMenu
              if cloud {
                Button {
                  Task {
                    do { try await workspace.signIn() } catch {
                      workspace.error = error.localizedDescription
                    }
                  }
                } label: {
                  SetupSelectorLabel(
                    icon: "person.crop.circle", title: "Sign in to choose a repository")
                }
                .accessibilityLabel("Sign in to Zuse")
              } else {
                Button {
                  method = .nearby
                } label: {
                  SetupSelectorLabel(icon: "folder", title: "Connect to choose a project")
                }
              }
              if workspace.loading {
                ProgressView("Connecting…").font(.caption).padding(.vertical, 6)
              }
              if let problem = workspace.connectionProblem {
                Text(problem).font(.caption).foregroundStyle(.secondary)
              }
              NewChatDraftComposer(
                text: $draft, enabled: false, busy: false,
                options: AnyView(
                  Menu {
                    Button("Find a nearby computer") { method = .nearby }
                    Button("Add manually") { method = .manual }
                  } label: {
                    Image(systemName: "plus").frame(width: 36, height: 40)
                  }),
                models: AnyView(fallbackModelPicker)
              ) {}
              .padding(.top, 10)
            }.frame(maxWidth: 720).frame(maxWidth: .infinity)
              .padding(.horizontal, 16).padding(.bottom, 12).padding(.top, 12)
              .background { ComposerFade().padding(.top, -40) }
          }
        }
      }.background(AppTheme.surface)
        .navigationTitle("New chat").compactNavigationTitle()
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Cancel", systemImage: "chevron.left") { dismiss() }.labelStyle(.iconOnly)
              .disabled(busy)
          }
        }
        .interactiveDismissDisabled(busy)
        .sheet(item: $method) { ConnectionView(workspace: workspace, method: $0) }
    }.nativeSheetSize(width: 500, height: 640)
  }
}

struct SetupSelectorLabel: View {
  let icon: String
  let title: String
  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: icon).font(.system(size: 14)).foregroundStyle(.secondary).frame(width: 18)
      Text(title).font(.system(size: 14)).lineLimit(1).foregroundStyle(.primary)
      Image(systemName: "chevron.down").font(.system(size: 9, weight: .medium)).foregroundStyle(
        .secondary)
      Spacer(minLength: 0)
    }.frame(minHeight: 32).padding(.horizontal, 4).contentShape(Rectangle())
  }
}

struct NewChatDraftComposer: View {
  @FocusState private var focused: Bool
  @Binding var text: String
  let enabled: Bool
  let busy: Bool
  var editable = true
  let options: AnyView
  let models: AnyView
  let submit: () -> Void
  var body: some View {
    VStack(spacing: 0) {
      TextField("Ask Zuse", text: $text, axis: .vertical)
        .focused($focused).font(.callout).lineLimit(2...6).padding(.horizontal, 6).padding(.top, 8)
        .padding(.bottom, 4).disabled(busy || !editable).accessibilityIdentifier("new-chat-prompt")
      HStack(spacing: 6) {
        options.buttonStyle(.plain).font(.system(size: 16)).frame(minWidth: 36, minHeight: 40)
          .foregroundStyle(.secondary).accessibilityLabel("Chat options")
        Spacer(minLength: 4)
        models
        Button {
          focused = false
          submit()
        } label: {
          Group {
            if busy {
              ProgressView().tint(.white)
            } else {
              Image(systemName: "arrow.up").font(.system(size: 13, weight: .semibold))
            }
          }.foregroundStyle(.white).frame(width: 29, height: 29)
            .background(
              enabled ? AppTheme.accent : Color.secondary.opacity(0.2),
              in: RoundedRectangle(cornerRadius: 8)
            )
            .frame(width: 40, height: 40).contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!enabled || busy)
          .accessibilityIdentifier("new-chat-create").accessibilityLabel("Create chat")
      }
    }.padding(8).composerGlass()
  }
}

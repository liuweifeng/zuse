import SwiftUI
import ZuseCore

struct CloudLaunchView: View {
  let workspace: WorkspaceModel
  let embedded: Bool
  let prompt: Binding<String>
  let destination: AnyView?
  var busyChanged: (Bool) -> Void
  private let client: CloudClient
  private let accountGeneration: UUID
  private let accountIdentity: String?
  init(
    workspace: WorkspaceModel, embedded: Bool = false,
    prompt: Binding<String> = .constant(""), destination: AnyView? = nil,
    busyChanged: @escaping (Bool) -> Void = { _ in }
  ) {
    self.embedded = embedded
    self.prompt = prompt
    self.destination = destination
    self.busyChanged = busyChanged
    self.workspace = workspace
    client = workspace.cloud
    accountGeneration = workspace.account.generation
    accountIdentity = workspace.account.archiveIdentity
  }
  @Environment(\.dismiss) private var dismiss
  @State private var projects: [JSONValue] = []
  @State private var providers: [JSONValue] = []
  @State private var agents: [ModelProvider] = []
  @State private var project = ""
  @State private var provider = ""
  @State private var size = ""
  @State private var agent = ""
  @State private var model = ""
  @State private var repository = ""
  @State private var branch = "main"
  @State private var baseRef = ""
  @State private var isPrivate = true
  @State private var busy = false
  @State private var failure: String?
  @State private var pendingIntent: CloudIntent?
  @State private var showOptions = false
  private var selectedAgent: ModelProvider? { agents.first { $0.id == agent } }
  private var sizes: [JSONValue] {
    providers.first { $0["providerId"].string == provider }?["sizes"].array ?? []
  }
  var body: some View {
    Group {
      if embedded { content } else { NavigationStack { content } }
    }.nativeSheetSize(width: 480, height: 600)
  }
  private var content: some View {
    Color.clear.background(AppTheme.surface)
      .safeAreaInset(edge: .bottom, spacing: 0) {
        VStack(alignment: .leading, spacing: 2) {
          if let failure { Text(failure).font(.caption).foregroundStyle(.red).padding(.bottom, 6) }
          if let destination { destination }
          Menu {
            Picker("Repository", selection: $project) {
              Text("Choose a repository").tag("")
              ForEach(projects, id: \.["projectId"].string) { row in
                Text(row["displayName"].string ?? "Repository").tag(row["projectId"].string ?? "")
              }
            }
            Button("Connect a repository") { showOptions = true }
          } label: {
            SetupSelectorLabel(
              icon: "folder",
              title: projects.first { $0["projectId"].string == project }?["displayName"].string
                ?? "Choose a repository")
          }.disabled(pendingIntent != nil || busy)
          Menu {
            Picker("Provider", selection: $provider) {
              ForEach(providers, id: \.["providerId"].string) { row in
                Text(row["displayName"].string ?? "Provider").tag(row["providerId"].string ?? "")
              }
            }
            if !sizes.isEmpty {
              Picker("Size", selection: $size) {
                Text("Default size").tag("")
                ForEach(sizes, id: \.["sizeId"].string) { row in
                  Text(row["displayName"].string ?? "Size").tag(row["sizeId"].string ?? "")
                }
              }
            }
          } label: {
            SetupSelectorLabel(
              icon: "server.rack",
              title: providers.first { $0["providerId"].string == provider }?["displayName"].string
                ?? "Choose cloud computer")
          }.disabled(pendingIntent != nil || busy)
          Button {
            showOptions = true
          } label: {
            SetupSelectorLabel(
              icon: "arrow.triangle.branch", title: baseRef.isEmpty ? "Default branch" : baseRef)
          }.disabled(pendingIntent != nil || busy)
          if pendingIntent != nil {
            HStack {
              Text("A saved workspace request is ready to retry.")
              Button("Discard", role: .destructive) {
                do {
                  if let account = accountIdentity {
                    try Vault.write(
                      nil, key: CloudIntent.key(account: account, operation: "launch"))
                  }
                  pendingIntent = nil
                } catch { failure = error.localizedDescription }
              }
            }.font(.caption).padding(.vertical, 4)
          }
          NewChatDraftComposer(
            text: prompt,
            enabled: !busy && !project.isEmpty && !provider.isEmpty && !agent.isEmpty
              && !model.isEmpty,
            busy: busy, editable: pendingIntent == nil,
            options: AnyView(
              Button("Cloud options", systemImage: "slider.horizontal.3") { showOptions = true }),
            models: AnyView(modelMenu)
          ) { Task { await launch() } }.padding(.top, 10)
        }.frame(maxWidth: 720).frame(maxWidth: .infinity)
          .padding(.horizontal, 16).padding(.bottom, 12).padding(.top, 12)
          .background { ComposerFade().padding(.top, -40) }
      }
      .navigationTitle("New chat").compactNavigationTitle()
      .toolbar {
        if !embedded {
          ToolbarItem(placement: .cancellationAction) {
            Button("Close") { dismiss() }.disabled(busy)
          }
        }
      }
      .sheet(isPresented: $showOptions) { options }
      .onChange(of: project) {
        guard pendingIntent == nil else { return }
        baseRef =
          "origin/"
          + (projects.first { $0["projectId"].string == project }?["defaultBranch"].string ?? "main")
      }
      .onChange(of: provider) { if pendingIntent == nil { size = "" } }
      .onChange(of: busy) { _, value in busyChanged(value) }
      .task { await load() }.interactiveDismissDisabled(busy)
  }
  private var modelMenu: some View {
    ModelPickerButton(
      catalog: agents, providerID: agent, modelID: model, allowsReasoning: false
    ) { providerID, modelID in
      agent = providerID
      model = modelID
    }.disabled(pendingIntent != nil || busy || agents.isEmpty)
  }
  private var options: some View {
    NavigationStack {
      Form {
        Section("Workspace") {
          TextField("Base branch", text: $baseRef).verbatimInput().autocorrectionDisabled()
          Text("Starting a workspace uses your cloud plan or connected provider account.").font(
            .caption
          ).foregroundStyle(.secondary)
        }
        Section("Connect a repository") {
          TextField("Repository URL", text: $repository).verbatimInput().autocorrectionDisabled()
          TextField("Default branch", text: $branch).verbatimInput().autocorrectionDisabled()
          Toggle("Private repository", isOn: $isPrivate)
          Button("Connect repository") { Task { await connectRepository() } }.disabled(
            busy || repository.isEmpty || branch.isEmpty)
        }
      }.disabled(pendingIntent != nil).navigationTitle("Cloud options").compactNavigationTitle()
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { showOptions = false } }
        }
    }.nativeSheetSize(width: 420, height: 440)
  }
  private func load() async {
    guard accountGeneration == workspace.account.generation else { return }
    busy = true
    defer { busy = false }
    do {
      async let projectRows = client.request("/v1/cloud/projects")
      async let providerRows = client.request("/v1/cloud/providers")
      async let auth = client.request("/v1/cloud/auth")
      let (p, c, a) = try await (projectRows, providerRows, auth)
      guard accountGeneration == workspace.account.generation, !Task.isCancelled else { return }
      projects = p["projects"].array
      providers = c["providers"].array
      provider = providers.first?["providerId"].string ?? ""
      guard let url = Bundle.main.url(forResource: "ModelCatalog", withExtension: "json") else {
        throw ClientError("The model catalog is missing.")
      }
      let catalog = try ModelProvider.parse(
        JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)))
      let connected = Set(
        a["providers"].array.filter { $0["state"].string == "connected" }.compactMap {
          $0["providerId"].string
        })
      agents = catalog.filter { connected.contains($0.id) }
      agent = agents.first?.id ?? ""
      model = selectedAgent?.defaultModel ?? ""
      if let account = accountIdentity,
        let pending = try CloudIntent.load(
          key: CloudIntent.key(account: account, operation: "launch"))
      {
        pendingIntent = pending
        prompt.wrappedValue = pending.body["firstMessage"].string ?? ""
        project = pending.body["projectId"].string ?? ""
        provider = pending.body["providerId"].string ?? provider
        size = pending.body["sizeId"].string ?? ""
        agent = pending.body["agent"].string ?? agent
        model = pending.body["model"].string ?? model
        baseRef = pending.body["baseRef"].string ?? ""
      }
    } catch { failure = error.localizedDescription }
  }
  private func connectRepository() async {
    guard accountGeneration == workspace.account.generation else { return }
    busy = true
    failure = nil
    defer { busy = false }
    let body: JSONValue = .object([
      "repositoryUrl": .string(repository), "defaultBranch": .string(branch),
      "visibility": .string(isPrivate ? "private" : "public"),
    ])
    do {
      guard let account = accountIdentity else {
        throw ClientError("Sign in first.")
      }
      let key = CloudIntent.key(account: account, operation: "repository")
      let connectIntent = try CloudIntent.prepare(body, key: key)
      let row = try await client.request(
        "/v1/cloud/projects", method: "POST",
        body: connectIntent.requestBody())
      let result = try await client.request("/v1/cloud/projects")
      guard accountGeneration == workspace.account.generation, !Task.isCancelled else { return }
      projects = result["projects"].array
      project = row["projectId"].string ?? row["project"]["projectId"].string ?? ""
      repository = ""
      try Vault.write(nil, key: key)
    } catch { failure = error.localizedDescription }
  }
  private func launch() async {
    guard accountGeneration == workspace.account.generation else { return }
    guard let selected = projects.first(where: { $0["projectId"].string == project }) else {
      return
    }
    var fields: [String: JSONValue] = [
      "projectId": .string(project), "providerId": .string(provider),
      "baseRef": .string(
        baseRef.isEmpty ? "origin/" + (selected["defaultBranch"].string ?? "main") : baseRef),
      "agent": .string(agent), "model": .string(model), "runtimeMode": .string("approval-required"),
    ]
    if !size.isEmpty { fields["sizeId"] = .string(size) }
    if !prompt.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      fields["firstMessage"] = .string(prompt.wrappedValue)
    }
    let body = JSONValue.object(fields)
    busy = true
    failure = nil
    defer { busy = false }
    let generation = accountGeneration
    do {
      guard let account = accountIdentity else {
        throw ClientError("Sign in first.")
      }
      let key = CloudIntent.key(account: account, operation: "launch")
      let intent = try pendingIntent ?? CloudIntent.prepare(body, key: key)
      pendingIntent = intent
      let result = try await client.request(
        "/v1/cloud/workspaces", method: "POST",
        body: intent.requestBody())
      guard workspace.account.generation == generation else { return }
      guard let workspaceID = result["workspace"]["workspaceId"].string,
        let sessionID = result["initialSessionId"].string
      else {
        throw ClientError(
          "The workspace response was incomplete. Refresh your cloud list before trying again.")
      }
      try Vault.write(nil, key: key)
      workspace.openCloud(workspaceID: workspaceID, sessionID: sessionID)
      await workspace.refreshCloud()
      prompt.wrappedValue = ""
      dismiss()
    } catch { failure = error.localizedDescription }
  }
}

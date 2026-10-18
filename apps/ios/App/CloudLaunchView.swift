import SwiftUI
import ZuseCore

struct CloudLaunchView: View {
  let workspace: WorkspaceModel
  private let client: CloudClient
  private let accountGeneration: UUID
  private let accountIdentity: String?
  init(workspace: WorkspaceModel) {
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
  private var selectedAgent: ModelProvider? { agents.first { $0.id == agent } }
  private var sizes: [JSONValue] {
    providers.first { $0["providerId"].string == provider }?["sizes"].array ?? []
  }
  var body: some View {
    NavigationStack {
      Form {
        if let failure { Section { Text(failure).foregroundStyle(.red) } }
        Section("Repository") {
          Picker("Project", selection: $project) {
            Text("Choose a repository").tag("")
            ForEach(projects, id: \.["projectId"].string) { row in
              Text(row["displayName"].string ?? "Repository").tag(row["projectId"].string ?? "")
            }
          }
          .onChange(of: project) {
            guard pendingIntent == nil else { return }
            baseRef =
              "origin/"
              + (projects.first { $0["projectId"].string == project }?["defaultBranch"].string
                ?? "main")
          }
          TextField("Base branch", text: $baseRef).verbatimInput().autocorrectionDisabled().frame(
            height: 28)
          DisclosureGroup("Connect a repository") {
            TextField("Repository URL", text: $repository)
              .verbatimInput().autocorrectionDisabled()
            TextField("Default branch", text: $branch).verbatimInput()
              .autocorrectionDisabled()
            Toggle("Private repository", isOn: $isPrivate)
            Button("Connect repository") { Task { await connectRepository() } }.disabled(
              busy || repository.isEmpty || branch.isEmpty)
          }
        }
        .disabled(pendingIntent != nil)
        Section("Cloud computer") {
          Picker("Provider", selection: $provider) {
            ForEach(providers, id: \.["providerId"].string) { row in
              Text(row["displayName"].string ?? "Provider").tag(row["providerId"].string ?? "")
            }
          }.onChange(of: provider) { if pendingIntent == nil { size = "" } }
          if !sizes.isEmpty {
            Picker("Size", selection: $size) {
              Text("Default size").tag("")
              ForEach(sizes, id: \.["sizeId"].string) { row in
                Text(row["displayName"].string ?? "Size").tag(row["sizeId"].string ?? "")
              }
            }
          }
          Text("Starting a workspace uses your cloud plan or connected provider account.").font(
            .caption
          ).foregroundStyle(.secondary)
        }
        .disabled(pendingIntent != nil)
        Section("Agent") {
          Picker("Agent", selection: $agent) {
            ForEach(agents) { Text($0.name).tag($0.id) }
          }.onChange(of: agent) {
            if pendingIntent == nil { model = selectedAgent?.defaultModel ?? "" }
          }
          Picker("Model", selection: $model) {
            ForEach(selectedAgent?.models ?? []) { Text($0.label).tag($0.id) }
          }
          if agents.isEmpty {
            Text("Connect an agent in Cloud settings before starting a workspace.").foregroundStyle(
              .secondary)
          }
        }
        .disabled(pendingIntent != nil)
        Section {
          if pendingIntent != nil {
            Text(
              "A saved workspace request is ready to retry. Reusing it prevents duplicate workspaces."
            )
            .font(.caption).foregroundStyle(.secondary)
            Button("Discard saved request", role: .destructive) {
              do {
                if let account = accountIdentity {
                  try Vault.write(nil, key: CloudIntent.key(account: account, operation: "launch"))
                  pendingIntent = nil
                }
              } catch { failure = error.localizedDescription }
            }
          }
          Button(pendingIntent == nil ? "Start cloud workspace" : "Retry workspace request") {
            Task { await launch() }
          }
          .disabled(busy || project.isEmpty || provider.isEmpty || agent.isEmpty || model.isEmpty)
          if busy { ProgressView() }
        }
      }.formStyle(.grouped).navigationTitle("New cloud chat").compactNavigationTitle()
        .toolbar {
          ToolbarItem(placement: .cancellationAction) {
            Button("Close") { dismiss() }.disabled(busy)
          }
        }
        .task { await load() }
        .interactiveDismissDisabled(busy)
    }.nativeSheetSize(width: 480, height: 600)
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
      dismiss()
    } catch { failure = error.localizedDescription }
  }
}

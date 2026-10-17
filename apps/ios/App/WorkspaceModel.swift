import CryptoKit
import Network
import SwiftUI
import ZuseCore

struct SessionRow: Codable, Identifiable, Hashable {
  let id: String
  let projectId: String
  let title: String
  let providerId: String
  let model: String
  let worktreeId: String?
}
struct ProjectRow: Codable, Identifiable, Hashable {
  let id: String
  let name: String
}
struct RemoteConnection: Codable {
  var address: String
  var token: String
  var certificatePin: String?
  var environmentID: String?
}

@MainActor @Observable final class WorkspaceModel {
  let account = Account()
  var cloudChats: [CloudChat] = []
  var environments: [RemoteEnvironment] = []
  var projects: [ProjectRow] = []
  var sessions: [SessionRow] = []
  var selectedProject: ProjectRow?
  var selectedSession: SessionRow?
  var transcript = Transcript()
  var error: String?
  var connectionState = "Not connected"
  var connectionProblem: String?
  var loading = false
  var clearingAccount = false
  var sending = false
  private var enqueueing = false
  var paging = false
  var draft = ""
  private(set) var rpc: RPCClient?
  private var connectionTask: Task<Void, Never>?
  private var timelineTask: Task<Void, Never>?
  private var selection = UUID()
  private var source: Source?
  var attachments: [JSONValue] = []
  var uploading = false
  var outbox: [PendingMessage] = []
  private var archive: ArchiveStore?
  private var archives: [String: ArchiveStore] = [:]
  private var catalogRequest = UUID()
  private var hydratedCatalog: String?
  private var draftTask: Task<Void, Never>?
  private var checkpointTask: Task<Void, Never>?
  private var recoveryTask: Task<Void, Never>?
  private var heartbeatTask: Task<Void, Never>?
  private var hydrationTask: Task<Void, Never>?
  private var sessionGeneration = UUID()
  private var retryCount = 0
  private var foreground = true
  private var networkAvailable = true
  private let network = NWPathMonitor()
  private var drafts: [String: String] = [:]
  enum Source {
    case cloud(String)
    case environment(String)
    case remote(RemoteConnection)
  }

  init() {
    network.pathUpdateHandler = { [weak self] path in
      let available = path.status == .satisfied
      Task { @MainActor in
        guard let self else { return }
        let recovered = available && !self.networkAvailable
        self.networkAvailable = available
        if recovered && self.foreground && self.source != nil { self.reconnect() }
      }
    }
    network.start(queue: DispatchQueue(label: "sh.zuse.native.network"))
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--rpc-fixture"),
        let address = ProcessInfo.processInfo.environment["ZUSE_IOS_FIXTURE_URL"],
        let url = URL(string: address), url.host == "127.0.0.1"
      {
        openRemote(RemoteConnection(address: address, token: ""))
      }
      if ProcessInfo.processInfo.arguments.contains("--native-preview") {
        do { try loadPreview() } catch { self.error = error.localizedDescription }
      }
    #endif
  }
  var cloud: CloudClient {
    CloudClient(baseURL: account.apiURL) { [account] in try await account.token() }
  }
  func refreshCloud() async {
    guard account.signedIn else {
      cloudChats = []
      return
    }
    let request = UUID()
    catalogRequest = request
    let accountURL = account.apiURL
    let accountGeneration = account.generation
    var catalog: ArchiveStore?
    do {
      let store = try makeArchive(for: .cloud("__catalog"))
      catalog = store
      if hydratedCatalog != account.archiveIdentity {
        let cached = try await store.load("catalog").metadata
        guard account.generation == accountGeneration, catalogRequest == request else { return }
        if let cached {
          cloudChats = (try? cached["chats"].decode([CloudChat].self)) ?? []
          environments = (try? cached["environments"].decode([RemoteEnvironment].self)) ?? []
        }
        hydratedCatalog = account.archiveIdentity
      }
    } catch { self.error = error.localizedDescription }
    let client = cloud
    let chatsTask = Task { try await client.chats() }
    let computersTask = Task { try await client.environments() }
    let (chatsResult, computersResult) = await (chatsTask.result, computersTask.result)
    guard account.signedIn, account.generation == accountGeneration, account.apiURL == accountURL,
      catalogRequest == request
    else { return }
    switch chatsResult {
    case .success(let rows): cloudChats = rows
    case .failure(let failure): error = failure.localizedDescription
    }
    switch computersResult {
    case .success(let rows): environments = rows
    case .failure(let failure): error = failure.localizedDescription
    }
    if let catalog {
      do {
        let chats = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(cloudChats))
        let computers = try JSONDecoder().decode(
          JSONValue.self, from: JSONEncoder().encode(environments))
        try await catalog.saveMetadata(
          .object(["chats": chats, "environments": computers]), sessionID: "catalog")
      } catch { if catalogRequest == request { self.error = error.localizedDescription } }
    }
  }

  func resumeCloud(_ chat: CloudChat) async {
    let accountGeneration = account.generation
    do {
      let id = chat.workspaceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
      _ = try await cloud.request(
        "/v1/cloud/workspaces/\(id)/resume", method: "POST",
        body: .object([
          "workspaceId": .string(chat.workspaceId), "commandId": .string(UUID().uuidString),
        ]))
      guard account.generation == accountGeneration else { return }
      await refreshCloud()
      openCloud(chat)
    } catch {
      if account.generation == accountGeneration { self.error = error.localizedDescription }
    }
  }
  func openCloud(workspaceID: String, sessionID: String) {
    startConnection(.cloud(workspaceID), sessionID: sessionID)
  }
  func openCloud(_ chat: CloudChat) {
    startConnection(.cloud(chat.workspaceId), sessionID: chat.sessionID)
  }
  func openEnvironment(_ environment: RemoteEnvironment) {
    startConnection(.environment(environment.id), sessionID: nil)
  }
  private func deviceProof() throws -> DeviceProof {
    let key = try Vault.read("dpop-key") ?? DeviceProof.generateKey()
    try Vault.write(key, key: "dpop-key")
    return try DeviceProof(rawKey: key)
  }
  func openRemote(_ connection: RemoteConnection) {
    startConnection(.remote(connection), sessionID: nil)
  }
  func pair(_ value: String, certificatePin: String? = nil) async throws {
    let link = try PairingLink.parse(value)
    let deviceID: String
    if let data = try Vault.read("device-id"), let existing = String(data: data, encoding: .utf8) {
      deviceID = existing
    } else {
      deviceID = UUID().uuidString
      try Vault.write(Data(deviceID.utf8), key: "device-id")
    }
    let grant = try await PairingClient.redeem(
      link, deviceID: deviceID, label: UIDevice.current.name, certificatePin: certificatePin)
    guard let token = grant["token"].string else { throw ClientError("Missing connection token.") }
    if let certificatePin, let returned = grant["transportCertificatePin"].string,
      returned != certificatePin
    {
      throw ClientError(
        "The computer identity changed during pairing. Generate a new code and try again.")
    }
    openRemote(
      RemoteConnection(
        address: link.webSocketURL.absoluteString, token: token,
        certificatePin: certificatePin,
        environmentID: grant["environmentId"].string))
  }
  func restoreRemote() {
    do {
      if let data = try Vault.read("remote"),
        let connection = try? JSONDecoder().decode(RemoteConnection.self, from: data)
      {
        openRemote(connection)
      }
    } catch { self.error = error.localizedDescription }
  }
  private func startConnection(_ source: Source, sessionID: String?, preserving: Bool = false) {
    let retainedSession = preserving ? selectedSession : nil
    let retainedTranscript = transcript
    let retainedDraft = draft
    persistDraft(immediate: true)
    if let session = selectedSession { drafts[session.id] = draft }
    disconnect()
    self.source = source
    if let retainedSession {
      selectedSession = retainedSession
      transcript = retainedTranscript
      draft = retainedDraft
    }
    let current = selection
    loading = true
    connectionState = "Connecting…"
    connectionProblem = nil
    connectionTask = Task {
      var pendingClient: RPCClient?
      do {
        let store = try makeArchive(for: source)
        archive = store
        let restoredID: String?
        if let sessionID {
          restoredID = sessionID
        } else {
          restoredID = try await store.load("__last-session").metadata?["id"].string
        }
        if let sessionID = restoredID, !preserving {
          let cached = try await store.load(sessionID)
          guard current == selection, !Task.isCancelled else { return }
          if let metadata = cached.metadata, let session = try? metadata.decode(SessionRow.self) {
            selectedSession = session
            transcript = Transcript(cached: cached.messages)
            draft = cached.draft
            outbox = cached.pending
            attachments = cached.attachments ?? []
          }
        }
        let client: RPCClient
        switch source {
        case .cloud(let id): client = try await cloud.connect(workspaceID: id)
        case .environment(let id):
          client = try await cloud.connectEnvironment(id, proof: deviceProof())
        case .remote(let connection):
          guard var url = URLComponents(string: connection.address), let endpoint = url.url else {
            throw ClientError("Invalid connection address.")
          }
          try PairingLink.validate(endpoint, webSocket: true)
          var items = (url.queryItems ?? []).filter { $0.name != "token" }
          if !connection.token.isEmpty {
            items.append(URLQueryItem(name: "token", value: connection.token))
          }
          url.queryItems = items
          guard let address = url.url else { throw ClientError("Invalid remote address.") }
          if let pin = connection.certificatePin, address.scheme == "wss" {
            client = try RPCClient(
              url: address, session: PinnedConnection.session(pin: pin), ownsSession: true)
          } else {
            client = try RPCClient(url: address)
          }
          pendingClient = client
          do { try await client.connect() } catch {
            await client.close()
            throw error
          }
          if let id = connection.environmentID {
            let descriptor = try await client.call("connect.describe")
            guard descriptor["environmentId"].string == id else {
              await client.close()
              throw ClientError("The paired computer identity no longer matches.")
            }
          }
          guard current == selection, !Task.isCancelled else {
            await client.close()
            return
          }
          if !ProcessInfo.processInfo.arguments.contains("--rpc-fixture") {
            try Vault.write(JSONEncoder().encode(connection), key: "remote")
          }
        }
        pendingClient = client
        guard current == selection, !Task.isCancelled else {
          await client.close()
          return
        }
        rpc = client
        connectionState = "Synchronizing…"
        let loadedProjects = try await client.call("workspace.list").decode([ProjectRow].self)
        guard current == selection, !Task.isCancelled else {
          await client.close()
          return
        }
        projects = loadedProjects
        if let sessionID = restoredID {
          let session = try await client.call("session.get", ["sessionId": .string(sessionID)])
            .decode(SessionRow.self)
          guard current == selection, !Task.isCancelled else {
            await client.close()
            return
          }
          selectedProject = projects.first { $0.id == session.projectId }
          await loadSessions()
          guard !Task.isCancelled else { return }
          selectSession(session)
        } else if let project = projects.first {
          selectedProject = project
          await loadSessions()
        }
      } catch {
        if let pendingClient { await pendingClient.close() }
        guard current == selection, !Task.isCancelled else { return }
        connectionState = "Offline · reconnecting"
        connectionProblem = error.localizedDescription
        if let rpc { await rpc.close() }
        rpc = nil
        scheduleRecovery()
      }
      if current == selection { loading = false }
    }
  }
  func loadSessions() async {
    guard let rpc, let project = selectedProject else { return }
    let current = selection
    do {
      let rows = try await rpc.call("session.list", ["projectId": .string(project.id)]).decode(
        [SessionRow].self)
      guard selection == current, selectedProject?.id == project.id else { return }
      sessions = rows
    } catch { self.error = error.localizedDescription }
  }
  func selectSession(_ session: SessionRow) {
    #if DEBUG
      if ProcessInfo.processInfo.arguments.contains("--native-preview") {
        do { try loadPreview(selected: session) } catch { self.error = error.localizedDescription }
        return
      }
    #endif
    persistDraft(immediate: true)
    if let old = selectedSession { drafts[old.id] = draft }
    timelineTask?.cancel()
    hydrationTask?.cancel()
    checkpointTask?.cancel()
    checkpointTask = nil
    heartbeatTask?.cancel()
    sessionGeneration = UUID()
    let generation = sessionGeneration
    let sameSession = selectedSession?.id == session.id
    selectedSession = session
    if !sameSession {
      transcript = Transcript()
      draft = drafts[session.id] ?? ""
      outbox = []
    }
    sending = false
    hydrationTask = Task {
      do {
        if let archive {
          let record = try await archive.load(session.id)
          guard generation == sessionGeneration, !Task.isCancelled else { return }
          if !sameSession {
            transcript = Transcript(cached: record.messages)
            draft = record.draft
          }
          outbox = record.pending
          attachments = record.attachments ?? []
          let metadata = try JSONDecoder().decode(
            JSONValue.self, from: JSONEncoder().encode(session))
          try await archive.saveMetadata(metadata, sessionID: session.id)
          try await archive.saveMetadata(metadata, sessionID: "__last-session")
        }
        guard generation == sessionGeneration, !Task.isCancelled else { return }
        subscribe(session.id)
      } catch { self.error = error.localizedDescription }
    }
  }
  private func subscribe(_ sessionID: String) {
    guard let rpc else { return }
    let generation = sessionGeneration
    timelineTask = Task {
      do {
        let stream = try await rpc.stream(
          "session.events", ["sessionId": .string(sessionID), "includeRuntime": .bool(true)])
        for try await frame in stream {
          try Task.checkCancellation()
          guard generation == sessionGeneration, selectedSession?.id == sessionID else { return }
          try transcript.apply(frame, sessionID: sessionID)
          checkpointTranscript()
          if frame["kind"].string == "synchronized" {
            retryCount = 0
            connectionState = "Connected"
            startHeartbeat(sessionID: sessionID, generation: generation)
            Task { await flushOutbox() }
          }
        }
        if !Task.isCancelled {
          throw ClientError("The transcript connection ended. Reconnect to continue.")
        }
      } catch {
        guard !Task.isCancelled, generation == sessionGeneration, selectedSession?.id == sessionID
        else { return }
        connectionState = "Offline · reconnecting"
        connectionProblem = error.localizedDescription
        scheduleRecovery()
      }
    }
  }
  func reconnect() {
    guard let source else { return }
    let sessionID = selectedSession?.id
    if let session = selectedSession { drafts[session.id] = draft }
    startConnection(source, sessionID: sessionID, preserving: true)
  }
  func loadOlder() async {
    guard !paging, let before = transcript.olderSequence, let session = selectedSession, let rpc
    else { return }
    let generation = sessionGeneration
    paging = true
    defer { if generation == sessionGeneration { paging = false } }
    do {
      let page = try await rpc.call(
        "session.messages.page",
        [
          "sessionId": .string(session.id), "beforeSequence": .number(Double(before)),
          "limit": .number(100),
        ])
      guard generation == sessionGeneration else { return }
      try transcript.prependPage(page)
      checkpointTranscript()
    } catch { if generation == sessionGeneration { self.error = error.localizedDescription } }
  }
  var canSend: Bool {
    selectedSession != nil && archive != nil && !sending && !enqueueing && !uploading
  }
  func send() async {
    guard canSend, let session = selectedSession, let archive else { return }
    draftTask?.cancel()
    let originalDraft = draft
    let submittedAttachments = attachments
    let text = originalDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty || !attachments.isEmpty else { return }
    let generation = sessionGeneration
    enqueueing = true
    defer { if generation == sessionGeneration { enqueueing = false } }
    do {
      let input: JSONValue? =
        submittedAttachments.isEmpty
        ? nil
        : .object([
          "text": .string(text), "attachments": .array(submittedAttachments),
          "fileRefs": .array([]),
          "skillRefs": .array([]), "annotations": .array([]),
        ])
      let pending = PendingMessage(sessionID: session.id, text: text, input: input)
      try await archive.enqueue(pending)
      guard generation == sessionGeneration else { return }
      if draft == originalDraft { draft = "" }
      attachments.removeAll { submittedAttachments.contains($0) }
      try await archive.saveDraft(draft, sessionID: session.id)
      try await archive.saveAttachments(attachments, sessionID: session.id)
      outbox = try await archive.load(session.id).pending
      await flushOutbox()
    } catch { self.error = error.localizedDescription }
  }
  func respondToUI(_ message: ChatMessage, text: String) async throws {
    guard let archive, selectedSession?.id == message.sessionId else {
      throw ClientError("Open this chat to respond.")
    }
    let generation = sessionGeneration
    try await archive.enqueue(
      PendingMessage(sessionID: message.sessionId, text: text), responseTo: message.id)
    guard generation == sessionGeneration else { return }
    outbox = try await archive.load(message.sessionId).pending
    await flushOutbox()
  }
  func flushOutbox(retryID: String? = nil) async {
    guard !sending, connectionState == "Connected", let session = selectedSession, let rpc,
      let archive
    else { return }
    let generation = sessionGeneration
    sending = true
    defer { if generation == sessionGeneration { sending = false } }
    do {
      let queued = try await archive.load(session.id).pending
      for message in queued {
        guard generation == sessionGeneration, connectionState == "Connected" else { return }
        guard message.delivery == .queued || message.id == retryID else { continue }
        let attempt = try await archive.markAttempted(message.id, sessionID: session.id)
        _ = try await rpc.call("messages.send", attempt.payload)
        try await archive.remove(message.id, sessionID: session.id)
      }
    } catch {
      if generation == sessionGeneration { self.error = error.localizedDescription }
    }
    if generation == sessionGeneration {
      outbox = (try? await archive.load(session.id).pending) ?? outbox
    }
  }
  func removePending(_ message: PendingMessage) async {
    guard let archive, !sending else { return }
    let generation = sessionGeneration
    do {
      try await archive.remove(message.id, sessionID: message.sessionID)
      let pending = try await archive.load(message.sessionID).pending
      if generation == sessionGeneration { outbox = pending }
    } catch { self.error = error.localizedDescription }
  }
  func stop() async {
    guard let session = selectedSession, let turn = transcript.activeTurnID, let rpc else { return }
    do {
      _ = try await rpc.call(
        "messages.interrupt",
        [
          "sessionId": .string(session.id), "commandId": .string(UUID().uuidString),
          "expectedTurnId": .string(turn),
        ])
    } catch { self.error = error.localizedDescription }
  }
  func createChat(provider: String, model: String) async {
    guard let rpc, let project = selectedProject else {
      error = "Connect to a project before creating a chat."
      return
    }
    let generation = selection
    error = nil
    do {
      let response = try await rpc.call(
        "chat.create",
        [
          "projectId": .string(project.id), "providerId": .string(provider),
          "model": .string(model), "runtimeMode": .string("approval-required"),
        ])
      let session = try response["initialSession"].decode(SessionRow.self)
      guard generation == selection else { return }
      await loadSessions()
      guard !Task.isCancelled, generation == selection else { return }
      selectSession(session)
    } catch { self.error = error.localizedDescription }
  }
  func attach(_ data: Data, name: String, mimeType: String) async {
    guard !uploading, let rpc, let session = selectedSession, connectionState == "Connected" else {
      return
    }
    let generation = sessionGeneration
    uploading = true
    defer { if generation == sessionGeneration { uploading = false } }
    do {
      let ref = try await Attachments.upload(
        data, name: name, mimeType: mimeType, sessionID: session.id, rpc: rpc)
      guard generation == sessionGeneration else { return }
      attachments.append(ref)
      try await archive?.saveAttachments(attachments, sessionID: session.id)
    } catch { if generation == sessionGeneration { self.error = error.localizedDescription } }
  }
  func removeAttachment(_ id: String) {
    attachments.removeAll { $0["id"].string == id }
    guard let archive, let session = selectedSession else { return }
    let refs = attachments
    Task {
      do { try await archive.saveAttachments(refs, sessionID: session.id) } catch {
        self.error = error.localizedDescription
      }
    }
  }
  func answerQuestion(_ itemID: String, answers: [JSONValue]) async throws {
    guard let session = selectedSession, let rpc, connectionState == "Connected" else {
      throw ClientError("Reconnect before answering this question.")
    }
    _ = try await rpc.call(
      "session.answerQuestion",
      [
        "commandId": .string(UUID().uuidString), "sessionId": .string(session.id),
        "itemId": .string(itemID), "answers": .array(answers),
      ])
  }
  func cancelQuestion(_ itemID: String) async throws {
    guard let session = selectedSession, let rpc else {
      throw ClientError("Reconnect before cancelling this question.")
    }
    _ = try await rpc.call(
      "session.cancelQuestion", ["sessionId": .string(session.id), "itemId": .string(itemID)])
  }
  func respondToPlan(_ itemID: String, outcome: String, feedback: String) async throws {
    guard let session = selectedSession, let rpc, connectionState == "Connected" else {
      throw ClientError("Reconnect before responding to this plan.")
    }
    var payload: [String: JSONValue] = [
      "commandId": .string(UUID().uuidString), "sessionId": .string(session.id),
      "toolCallId": .string(itemID), "outcome": .string(outcome),
    ]
    if !feedback.isEmpty { payload["feedback"] = .string(feedback) }
    _ = try await rpc.call("session.plan.respond", payload)
  }
  func decidePermission(_ id: String, allow: Bool) async {
    guard let rpc else { return }
    do {
      _ = try await rpc.call(
        "permission.decide",
        [
          "requestId": .string(id),
          "decision": .object(["_tag": .string(allow ? "AllowOnce" : "Deny")]),
        ])
    } catch { self.error = error.localizedDescription }
  }
  func disconnect() {
    selection = UUID()
    sessionGeneration = UUID()
    recoveryTask?.cancel()
    heartbeatTask?.cancel()
    hydrationTask?.cancel()
    checkpointTask?.cancel()
    checkpointTask = nil
    connectionTask?.cancel()
    timelineTask?.cancel()
    if let rpc { Task { await rpc.close() } }
    rpc = nil
    source = nil
    if let archive { Task { await archive.releaseMemory() } }
    archive = nil
    attachments = []
    outbox = []
    projects = []
    sessions = []
    selectedSession = nil
    selectedProject = nil
    transcript = Transcript()
    connectionState = "Not connected"
    loading = false
    sending = false
    enqueueing = false
    paging = false
    uploading = false
  }
  func signOut() async {
    clearingAccount = true
    catalogRequest = UUID()
    hydratedCatalog = nil
    defer { clearingAccount = false }
    let accountDirectory = account.archiveIdentity.map {
      archiveRoot.appendingPathComponent(ArchiveStore.storageID($0))
    }
    let retiredArchives = Array(archives.values)
    archives = [:]
    draftTask?.cancel()
    checkpointTask?.cancel()
    disconnect()
    cloudChats = []
    environments = []
    drafts = [:]
    draft = ""
    outbox = []
    do {
      try account.signOut()
      for store in retiredArchives { try await store.erase() }
      if let accountDirectory, FileManager.default.fileExists(atPath: accountDirectory.path) {
        try FileManager.default.removeItem(at: accountDirectory)
      }
    } catch { self.error = error.localizedDescription }
  }
  private var archiveRoot: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("NativeArchives")
  }
  private func makeArchive(for source: Source) throws -> ArchiveStore {
    let identity: String
    switch source {
    case .cloud(let workspaceID):
      guard let accountID = account.archiveIdentity else {
        throw ClientError("Sign in again to open this account's offline storage.")
      }
      identity = "cloud|\(accountID)|\(workspaceID)"
    case .environment(let id):
      guard let accountID = account.archiveIdentity else {
        throw ClientError("Sign in to access this computer.")
      }
      identity = "environment|\(accountID)|\(id)"
    case .remote(let remote): identity = "remote|\(remote.address)"
    }
    let scope = ArchiveStore.storageID(identity)
    if let existing = archives[scope] { return existing }
    let keyName = "archive-key-" + scope
    let key: Data
    if let stored = try Vault.read(keyName) {
      key = stored
    } else {
      key = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
      try Vault.write(key, key: keyName)
    }
    let owner: String
    switch source {
    case .remote: owner = "remote"
    case .cloud, .environment: owner = ArchiveStore.storageID(account.archiveIdentity ?? "")
    }
    let directory = archiveRoot.appendingPathComponent(owner).appendingPathComponent(scope)
    let store = try ArchiveStore(directory: directory, key: key)
    archives[scope] = store
    return store
  }
  func persistDraft(immediate: Bool = false) {
    draftTask?.cancel()
    guard let session = selectedSession, let archive else { return }
    let value = draft
    draftTask = Task {
      if !immediate { try? await Task.sleep(for: .milliseconds(250)) }
      guard !Task.isCancelled else { return }
      do { try await archive.saveDraft(value, sessionID: session.id) } catch {
        self.error = error.localizedDescription
      }
    }
  }
  private func checkpointTranscript() {
    guard checkpointTask == nil, let session = selectedSession, let archive else { return }
    let generation = sessionGeneration
    checkpointTask = Task {
      try? await Task.sleep(for: .milliseconds(500))
      guard !Task.isCancelled, generation == sessionGeneration else { return }
      checkpointTask = nil
      let messages = transcript.messages
      do {
        try await archive.saveMessages(messages, sessionID: session.id)
        if generation == sessionGeneration { outbox = try await archive.load(session.id).pending }
      } catch { self.error = error.localizedDescription }
    }
  }
  private func scheduleRecovery() {
    recoveryTask?.cancel()
    heartbeatTask?.cancel()
    guard foreground, networkAvailable, source != nil else { return }
    let delay = min(30.0, pow(2.0, Double(min(retryCount, 5)))) + Double.random(in: 0...0.5)
    retryCount += 1
    recoveryTask = Task {
      try? await Task.sleep(for: .seconds(delay))
      guard !Task.isCancelled else { return }
      reconnect()
    }
  }
  private func startHeartbeat(sessionID: String, generation: UUID) {
    heartbeatTask?.cancel()
    guard let rpc else { return }
    heartbeatTask = Task {
      while !Task.isCancelled {
        do {
          try await Task.sleep(for: .seconds(15))
          let head = try await rpc.call("session.events.head", ["sessionId": .string(sessionID)])
          guard generation == sessionGeneration else { return }
          if let epoch = head["streamEpoch"].string, let current = transcript.epoch,
            epoch != current
          {
            scheduleRecovery()
            return
          }
          if (head["throughVersion"].int ?? 0) > transcript.version {
            try await Task.sleep(for: .seconds(2))
            guard generation == sessionGeneration else { return }
            if (head["throughVersion"].int ?? 0) > transcript.version {
              scheduleRecovery()
              return
            }
          }
        } catch {
          guard !Task.isCancelled, generation == sessionGeneration else { return }
          connectionState = "Offline · reconnecting"
          connectionProblem = error.localizedDescription
          scheduleRecovery()
          return
        }
      }
    }
  }
  func sceneChanged(active: Bool) {
    foreground = active
    if active {
      if source != nil { reconnect() }
      Task { await refreshCloud() }
    } else {
      persistDraft(immediate: true)
      recoveryTask?.cancel()
      heartbeatTask?.cancel()
    }
  }

}

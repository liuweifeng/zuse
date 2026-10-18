import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import ZuseCore

#if os(iOS)
  import VisionKit
#endif

@main struct ZuseApp: App {
  @State private var workspace = WorkspaceModel()
  @AppStorage("native.appearance") private var appearance = "system"
  var body: some Scene {
    WindowGroup {
      WorkspaceView(workspace: workspace).tint(AppTheme.accent)
        .preferredColorScheme(appearance == "dark" ? .dark : appearance == "light" ? .light : nil)
        .nativeWindowMinimum()
    }
    #if os(macOS)
      .defaultSize(width: 1120, height: 760)
      .commands {
        CommandGroup(replacing: .newItem) {
          Button("New Chat") { NotificationCenter.default.post(name: .nativeNewChat, object: nil) }
          .keyboardShortcut("n")
          Button("New Cloud Chat") {
            NotificationCenter.default.post(name: .nativeNewCloudChat, object: nil)
          }
          .keyboardShortcut("n", modifiers: [.command, .shift])
        }
        CommandGroup(replacing: .appSettings) {
          Button("Settings…") {
            NotificationCenter.default.post(name: .nativeSettings, object: nil)
          }.keyboardShortcut(",")
        }
      }
    #endif
  }
}

struct WorkspaceView: View {
  @Bindable var workspace: WorkspaceModel
  @State private var photo: PhotosPickerItem?
  @State private var showFilePicker = false
  @State private var attachmentTarget: UUID?
  @State private var showConnection = false
  @State private var showDiff = false
  @State private var showNewChat = false
  @State private var showCloudLaunch = false
  @State private var showSettings = false
  @State private var showProject = false
  @State private var modelCatalog: [ModelProvider] = []
  @State private var branchName: String?
  @FocusState private var composerFocused: Bool
  @State private var selection: SessionRow?
  @State private var preferredColumn: NavigationSplitViewColumn = .sidebar
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    presentedWorkspace
      .alert(
        "Something needs attention",
        isPresented: errorPresented
      ) {
        Button("OK") { workspace.error = nil }
      } message: {
        Text(workspace.error ?? "")
      }
  }
  private var errorPresented: Binding<Bool> {
    Binding(get: { workspace.error != nil }, set: { if !$0 { workspace.error = nil } })
  }
  private var presentedWorkspace: some View {
    interactiveWorkspace
      .sheet(isPresented: $showConnection) {
        ConnectionView(workspace: workspace).nativeSheetSize()
      }
      .sheet(isPresented: $showProject) { AddProjectView(workspace: workspace) }
      .inspector(isPresented: $showDiff) {
        if let session = workspace.selectedSession, let rpc = workspace.rpc {
          DiffView(rpc: rpc, session: session).inspectorColumnWidth(min: 320, ideal: 440, max: 680)
        }
      }
      .sheet(isPresented: $showSettings) { SettingsView(workspace: workspace) }
      .sheet(isPresented: $showCloudLaunch) { CloudLaunchView(workspace: workspace) }
      .sheet(isPresented: $showNewChat) { NewChatView(workspace: workspace) }
  }
  private var interactiveWorkspace: some View {
    navigation
      .onReceive(NotificationCenter.default.publisher(for: .nativeNewChat)) { _ in
        showNewChat = true
      }
      .onReceive(NotificationCenter.default.publisher(for: .nativeNewCloudChat)) { _ in
        showCloudLaunch = true
      }
      .onReceive(NotificationCenter.default.publisher(for: .nativeSettings)) { _ in
        showSettings = true
      }
      .task(id: workspace.connectionState + (workspace.selectedSession?.id ?? "")) {
        modelCatalog = []
        branchName = nil
        if workspace.connectionState == "Connected", let rpc = workspace.rpc {
          do {
            let models = try await ModelProvider.load(rpc)
            try Task.checkCancellation()
            modelCatalog = models
            if let session = workspace.selectedSession {
              var payload: [String: JSONValue] = ["folderId": .string(session.projectId)]
              if let worktree = session.worktreeId { payload["worktreeId"] = .string(worktree) }
              let status = try await rpc.call("git.status", payload)
              try Task.checkCancellation()
              branchName = status["branch"].string
            }
          } catch {
            // The session's current model remains visible when discovery is unavailable.
          }
        }
      }
      .onChange(of: workspace.selectedSession) { _, session in
        selection = session
        if session != nil { preferredColumn = .detail }
      }
      .onChange(of: selection) {
        if let selection, selection.id != workspace.selectedSession?.id {
          workspace.selectSession(selection)
        }
      }
      .onChange(of: scenePhase) { _, phase in workspace.sceneChanged(active: phase == .active) }
      .onChange(of: workspace.account.generation) {
        showSettings = false
        showCloudLaunch = false
        showNewChat = false
        showConnection = false
        showProject = false
        showDiff = false
      }
      .onChange(of: workspace.draft) { workspace.persistDraft() }
      .onChange(of: workspace.connectionState) { _, state in
        if state != "Connected" { showDiff = false }
      }
      .task {
        await workspace.refreshCloud()
        workspace.restoreWorkspace()
        if workspace.selectedSession != nil { preferredColumn = .detail }
      }
      .fileImporter(
        isPresented: $showFilePicker, allowedContentTypes: [.item], onCompletion: importFile
      )
      .onChange(of: photo) { _, value in importPhoto(value) }
  }
  private func importFile(_ result: Result<URL, Error>) {
    Task {
      do {
        let url = try result.get()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let resources = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        guard (resources.fileSize ?? 0) <= Attachments.maximumBytes else {
          throw ClientError("Attachments must be 100 MB or smaller.")
        }
        let data = try await Task.detached(priority: .userInitiated) {
          let file = try FileHandle(forReadingFrom: url)
          defer { try? file.close() }
          return try file.read(upToCount: Attachments.maximumBytes + 1) ?? Data()
        }.value
        guard attachmentTarget == workspace.sessionSelection else { return }
        await workspace.attach(
          data, name: url.lastPathComponent,
          mimeType: resources.contentType?.preferredMIMEType ?? "application/octet-stream")
      } catch { workspace.error = error.localizedDescription }
    }
  }
  private func importPhoto(_ value: PhotosPickerItem?) {
    guard let value else { return }
    let target = workspace.sessionSelection
    Task {
      do {
        if let data = try await value.loadTransferable(type: Data.self) {
          guard target == workspace.sessionSelection else { return }
          let type = value.supportedContentTypes.first ?? .image
          await workspace.attach(
            data, name: "Photo." + (type.preferredFilenameExtension ?? "jpg"),
            mimeType: type.preferredMIMEType ?? "image/jpeg")
        }
      } catch { workspace.error = error.localizedDescription }
      photo = nil
    }
  }

  private var navigation: some View {
    NavigationSplitView(preferredCompactColumn: $preferredColumn) {
      HomeView(
        workspace: workspace, selection: $selection,
        settings: { showSettings = true }, connect: { showConnection = true },
        newChat: { showNewChat = true }, newCloudChat: { showCloudLaunch = true },
        addProject: { showProject = true }
      )
      .disabled(workspace.clearingAccount)
      .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 340)
    } detail: {
      if let session = workspace.selectedSession {
        VStack(spacing: 0) {
          HStack {
            Menu {
              ForEach(workspace.savedConnections) { connection in
                Button(connection.displayName) { workspace.openRemote(connection) }
              }
              ForEach(workspace.environments) { environment in
                Button(environment.label ?? "Computer") { workspace.openEnvironment(environment) }
              }
              Button("Connect a computer…") { showConnection = true }
            } label: {
              Label(workspace.connectedComputer ?? "Computer", systemImage: "laptopcomputer")
                .font(.caption).lineLimit(1)
            }.menuStyle(.automatic)
            if let branchName {
              Label(branchName, systemImage: "arrow.triangle.branch").font(.caption).lineLimit(1)
                .foregroundStyle(.secondary)
            }
            Circle().fill(workspace.connectionState == "Connected" ? .green : .orange).frame(
              width: 6, height: 6)
            Text(workspace.connectionState).font(.caption).foregroundStyle(.secondary)
            Spacer()
            if workspace.connectionState != "Connected"
              && workspace.connectionState != "Preview · offline"
            {
              Button("Reconnect") { workspace.reconnect() }.font(.caption)
            }
            if workspace.transcript.status != "idle" {
              Text(workspace.transcript.status.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.caption).foregroundStyle(.secondary)
            }
          }.padding(.horizontal, 20).padding(.vertical, 6)
          if let failure = workspace.sessionRestorationError {
            HStack {
              Text(failure).font(.caption).foregroundStyle(.secondary)
              Spacer()
              Button("Retry restoring chat") { workspace.retrySessionRestoration() }
                .font(.caption)
            }.padding(.horizontal, 20).padding(.vertical, 6)
          } else if !workspace.sessionReady && workspace.connectionState != "Preview · offline" {
            ProgressView("Restoring chat…").font(.caption).padding(6)
          }
          if workspace.transcript.olderSequence != nil {
            Button(workspace.paging ? "Loading…" : "Load earlier messages") {
              Task { await workspace.loadOlder() }
            }
            .font(.caption).disabled(workspace.paging || !workspace.sessionReady).padding(6)
          }
          TranscriptView(
            messages: workspace.transcript.messages, sessionID: session.id, rpc: workspace.rpc,
            respond: { message, text in try await workspace.respondToUI(message, text: text) })
          if !workspace.outbox.isEmpty {
            ScrollView(.horizontal) {
              HStack {
                ForEach(workspace.outbox) { message in
                  VStack(alignment: .leading, spacing: 5) {
                    Text(message.text).lineLimit(2)
                    HStack {
                      Text(message.delivery == .queued ? "Queued" : "Delivery unconfirmed")
                        .foregroundStyle(.secondary)
                      if message.delivery == .uncertain {
                        Button("Retry") {
                          Task { await workspace.flushOutbox(retryID: message.id) }
                        }
                      }
                      Button("Remove", role: .destructive) {
                        Task { await workspace.removePending(message) }
                      }
                    }
                  }.font(.caption).padding(10).frame(maxWidth: 280).background(
                    .quaternary, in: RoundedRectangle(cornerRadius: 12))
                }
              }.padding(.horizontal)
            }.frame(maxHeight: 100)
          }
          if !workspace.transcript.interactions.isEmpty {
            ForEach(workspace.transcript.interactions, id: \.interactionIdentity) { interaction in
              if interaction["_tag"].string == "Permission", let id = interaction["id"].string {
                PermissionView(
                  request: interaction["request"], enabled: workspace.connectionState == "Connected"
                ) { allow in
                  await workspace.decidePermission(id, allow: allow)
                }
              } else {
                InteractionView(interaction: interaction, workspace: workspace)
              }
            }
          }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .navigationTitle(session.title.isEmpty ? "Chat" : session.title)
        .compactNavigationTitle()
        .toolbar {
          ToolbarItem(placement: .primaryAction) {
            Button("Changes", systemImage: "chevron.left.forwardslash.chevron.right") {
              showDiff = true
            }.disabled(workspace.connectionState != "Connected")
          }
        }
      } else {
        ContentUnavailableView {
          Label("Your work, wherever you are", systemImage: "bubble.left.and.bubble.right")
        } description: {
          Text("Open a cloud chat or connect your computer to continue.")
        }
        .overlay {
          if workspace.loading {
            ProgressView().padding().background(.regularMaterial, in: Capsule())
          }
        }
      }
    }
    .navigationSplitViewStyle(.balanced)
  }
  private var composer: some View {
    VStack(spacing: 8) {
      if !workspace.attachments.isEmpty {
        ScrollView(.horizontal) {
          HStack {
            ForEach(Array(workspace.attachments.enumerated()), id: \.offset) { _, ref in
              HStack {
                Label(ref["originalName"].string ?? "Attachment", systemImage: "paperclip")
                  .lineLimit(1)
                Button("Remove", systemImage: "xmark.circle.fill") {
                  workspace.removeAttachment(ref["id"].string ?? "")
                }.labelStyle(.iconOnly)
              }.font(.caption).padding(8).background(.quaternary, in: Capsule())
            }
          }
        }
      }
      VStack(spacing: 0) {
        TextField("Ask Zuse", text: $workspace.draft, axis: .vertical)
          .disabled(!workspace.composerEditable && workspace.connectionState != "Preview · offline")
          .focused($composerFocused)
          .accessibilityIdentifier("chat-composer")
          .font(.callout).lineLimit(1...6)
          .padding(.horizontal, 14).padding(.top, 13).padding(.bottom, 4)
        HStack(spacing: 4) {
          Menu {
            PhotosPicker(selection: $photo, matching: .images) {
              Label("Photo library", systemImage: "photo")
            }
            Button("Choose file", systemImage: "doc") {
              attachmentTarget = workspace.sessionSelection
              showFilePicker = true
            }
          } label: {
            Group {
              if workspace.uploading {
                ProgressView()
              } else {
                Image(systemName: "plus").font(.system(size: 18))
              }
            }.frame(width: 44, height: 44).contentShape(Rectangle())
          }
          .foregroundStyle(.secondary).accessibilityLabel("Add attachment")
          .disabled(
            !workspace.composerEditable || workspace.uploading
              || workspace.connectionState != "Connected")
          Spacer(minLength: 4)
          if let session = workspace.selectedSession {
            Menu {
              ForEach(modelCatalog.first { $0.id == session.providerId }?.models ?? []) { model in
                Button(model.label) { Task { await workspace.setModel(model.id) } }
              }
            } label: {
              HStack(spacing: 4) {
                Text(session.model == "preview" ? "Preview" : session.model).lineLimit(1)
                  .truncationMode(.middle)
                Image(systemName: "chevron.down").font(.system(size: 9))
              }.font(.caption.weight(.medium)).foregroundStyle(.secondary)
            }
            .accessibilityLabel("Current model: \(session.model)")
            .disabled(
              !workspace.sessionReady || workspace.connectionState != "Connected"
                || workspace.transcript.activeTurnID != nil
                || modelCatalog.isEmpty)
          }
          Button {
            Task {
              if workspace.transcript.activeTurnID != nil {
                await workspace.stop()
              } else {
                await workspace.send()
              }
            }
          } label: {
            Group {
              if workspace.sending {
                ProgressView().tint(.white)
              } else {
                Image(
                  systemName: workspace.transcript.activeTurnID != nil ? "stop.fill" : "arrow.up"
                )
                .font(.system(size: 14, weight: .semibold))
              }
            }
            .foregroundStyle(.white).frame(width: 30, height: 30)
            .background(
              sendDisabled ? Color.secondary.opacity(0.25) : AppTheme.accent,
              in: RoundedRectangle(cornerRadius: 8)
            )
            .frame(width: 44, height: 44).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityLabel(
            workspace.transcript.activeTurnID != nil ? "Stop response" : "Send message"
          )
          .disabled(sendDisabled)
          .keyboardShortcut(.return, modifiers: [.command])
        }.padding(.horizontal, 3)
      }
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
    }.frame(maxWidth: 900).frame(maxWidth: .infinity)
      .padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
      .background(AppTheme.surface)
  }
  private var sendDisabled: Bool {
    if workspace.transcript.activeTurnID != nil {
      return workspace.sending || workspace.connectionState != "Connected"
    }
    return !workspace.canSend || workspace.sending
      || (workspace.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && workspace.attachments.isEmpty)

  }
}

struct ConnectionView: View {
  let workspace: WorkspaceModel
  @Environment(\.dismiss) private var dismiss
  @State private var address = ""
  @State private var token = ""
  @State private var link = ""
  @State private var scanning = false
  @State private var pairing = false
  @State private var pairingTask: Task<Void, Never>?
  @State private var pairRequest = UUID()
  @State private var nearby = NearbyBrowser()
  @State private var nearbySelection: NearbyBrowser.Computer?
  @State private var nearbyCode = ""
  @State private var error: String?
  var body: some View {
    NavigationStack {
      Form {
        Section("Nearby computers") {
          ForEach(nearby.computers) { computer in
            Button(computer.name, systemImage: "laptopcomputer") { nearbySelection = computer }
              .disabled(pairing)
          }
          if nearby.computers.isEmpty {
            Text(nearby.error ?? "Looking for computers on your network…").font(.caption)
              .foregroundStyle(.secondary)
          }
          if let computer = nearbySelection {
            Text("Pair with " + computer.name).font(.subheadline)
            TextField("Pairing code from your computer", text: $nearbyCode)
              .verbatimInput().autocorrectionDisabled().frame(height: 28)
            Button("Pair nearby computer") {
              var url = URLComponents(url: computer.url, resolvingAgainstBaseURL: false)
              var fragment = URLComponents()
              fragment.queryItems = [URLQueryItem(name: "pair", value: nearbyCode)]
              url?.percentEncodedFragment = fragment.percentEncodedQuery
              if let value = url?.url?.absoluteString {
                link = value
                pair(pin: computer.pin)
              }
            }.disabled(pairing || nearbyCode.isEmpty)
          }
        }
        .disabled(pairing)
        Section("Pair with your computer") {
          TextField("Paste a Zuse pairing link", text: $link).verbatimInput()
            .autocorrectionDisabled().frame(height: 28)
          Button(pairing ? "Pairing…" : "Pair") { pair() }.disabled(link.isEmpty || pairing)
          #if os(iOS)
            if DataScannerViewController.isSupported {
              Button("Scan QR code", systemImage: "qrcode.viewfinder") {
                Task {
                  if await AVCaptureDevice.requestAccess(for: .video),
                    DataScannerViewController.isAvailable
                  {
                    scanning = true
                  } else {
                    error = "Camera access is unavailable. You can paste the pairing link instead."
                  }
                }
              }
              .disabled(pairing)
            }
          #endif
        }
        Section {
          TextField("wss://your-computer.example/rpc", text: $address).verbatimInput()
            .autocorrectionDisabled()
          SecureField("Connection token", text: $token).frame(height: 28)
          Button("Connect") {
            workspace.openRemote(
              RemoteConnection(
                address: address.trimmingCharacters(in: .whitespacesAndNewlines), token: token))
            dismiss()
          }.disabled(address.isEmpty || pairing)
        } header: {
          Text("Manual connection")
        } footer: {
          Text(
            "Use a secure remote address or a private local address. Credentials stay in this device’s Keychain."
          )
        }
        Button("Reconnect saved computer") {
          workspace.restoreRemote()
          dismiss()
        }.disabled(pairing)
        if let error { Text(error).foregroundStyle(.red) }
      }.navigationTitle("Connect").compactNavigationTitle()
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        #if os(iOS)
          .sheet(isPresented: $scanning) {
            NavigationStack {
              QRScanner(
                scanned: { value in
                  link = value
                  scanning = false
                  pair()
                },
                onError: { message in
                  scanning = false
                  error = message
                }
              ).ignoresSafeArea(edges: .bottom)
              .navigationTitle("Scan pairing code").toolbar {
                ToolbarItem(placement: .cancellationAction) {
                  Button("Cancel") { scanning = false }
                }
              }
            }
          }
        #endif
    }.task { nearby.start() }.onDisappear {
      nearby.stop()
      pairRequest = UUID()
      pairingTask?.cancel()
      pairingTask = nil
      pairing = false
      token = ""
      link = ""
      nearbyCode = ""
    }
  }
  private func pair(pin: String? = nil) {
    guard !pairing else { return }
    let submittedLink = link
    let request = UUID()
    pairRequest = request
    pairing = true
    error = nil
    pairingTask = Task {
      defer {
        if pairRequest == request {
          pairing = false
          pairingTask = nil
        }
      }
      do {
        try await workspace.pair(submittedLink, certificatePin: pin)
        guard pairRequest == request, !Task.isCancelled else { return }
        dismiss()
      } catch is CancellationError {} catch {
        if pairRequest == request { self.error = error.localizedDescription }
      }
    }
  }
}

struct PermissionView: View {
  let request: JSONValue
  let enabled: Bool
  let decide: (Bool) async -> Void
  @State private var submitting = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Label("Approval required", systemImage: "hand.raised").font(.subheadline.weight(.semibold))
      ScrollView {
        Text(request["kind"].pretty).font(.system(.caption, design: .monospaced)).textSelection(
          .enabled)
      }.frame(maxHeight: 130)
      HStack {
        Button("Deny", role: .destructive) { submit(false) }
        Spacer()
        Button("Allow once") { submit(true) }.buttonStyle(.borderedProminent)
      }.disabled(!enabled || submitting || request["recoveryState"].string == "expired")
    }.padding(16).background(.regularMaterial)
  }
  private func submit(_ allow: Bool) {
    submitting = true
    Task {
      await decide(allow)
      submitting = false
    }
  }
}

extension JSONValue {
  fileprivate var interactionIdentity: String {
    (self["_tag"].string ?? "") + ":" + (self["id"].string ?? "")
  }
}

import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import VisionKit
import ZuseCore

@main struct ZuseApp: App {
  @State private var workspace = WorkspaceModel()
  var body: some Scene {
    WindowGroup { WorkspaceView(workspace: workspace).tint(AppTheme.accent) }
  }
}

struct WorkspaceView: View {
  @Bindable var workspace: WorkspaceModel
  @State private var photo: PhotosPickerItem?
  @State private var showFilePicker = false
  @State private var attachmentTarget: String?
  @State private var showConnection = false
  @State private var showDiff = false
  @State private var showNewChat = false
  @State private var showCloudLaunch = false
  @State private var showSettings = false
  @State private var selection: SessionRow?
  @State private var preferredColumn: NavigationSplitViewColumn = .sidebar
  @Environment(\.scenePhase) private var scenePhase
  var body: some View {
    NavigationSplitView(preferredCompactColumn: $preferredColumn) {
      HomeView(
        workspace: workspace, selection: $selection,
        settings: { showSettings = true }, connect: { showConnection = true },
        newChat: { showNewChat = true }, newCloudChat: { showCloudLaunch = true }
      )
      .disabled(workspace.clearingAccount)
    } detail: {
      if let session = workspace.selectedSession {
        VStack(spacing: 0) {
          HStack {
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
              Text(workspace.transcript.status).font(.caption).foregroundStyle(.secondary)
            }
          }.padding(.horizontal, 20).padding(.vertical, 6)
          if workspace.transcript.olderSequence != nil {
            Button(workspace.paging ? "Loading…" : "Load earlier messages") {
              Task { await workspace.loadOlder() }
            }
            .font(.caption).disabled(workspace.paging).padding(6)
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
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .primaryAction) {
            Button("Changes", systemImage: "chevron.left.forwardslash.chevron.right") {
              showDiff = true
            }
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
    .onChange(of: workspace.selectedSession) { _, session in
      if session != nil { preferredColumn = .detail }
    }
    .onChange(of: selection) { if let selection { workspace.selectSession(selection) } }
    .onChange(of: scenePhase) { _, phase in workspace.sceneChanged(active: phase == .active) }
    .onChange(of: workspace.draft) { workspace.persistDraft() }
    .task {
      await workspace.refreshCloud()
      if workspace.selectedSession != nil { preferredColumn = .detail }
    }
    .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.item]) { result in
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
          guard attachmentTarget == workspace.selectedSession?.id else { return }
          await workspace.attach(
            data, name: url.lastPathComponent,
            mimeType: resources.contentType?.preferredMIMEType ?? "application/octet-stream")
        } catch { workspace.error = error.localizedDescription }
      }
    }
    .onChange(of: photo) { _, value in
      guard let value else { return }
      let target = workspace.selectedSession?.id
      Task {
        do {
          if let data = try await value.loadTransferable(type: Data.self) {
            guard target == workspace.selectedSession?.id else { return }
            let type = value.supportedContentTypes.first ?? .image
            await workspace.attach(
              data, name: "Photo." + (type.preferredFilenameExtension ?? "jpg"),
              mimeType: type.preferredMIMEType ?? "image/jpeg")
          }
        } catch { workspace.error = error.localizedDescription }
        photo = nil
      }
    }
    .sheet(isPresented: $showConnection) { ConnectionView(workspace: workspace) }
    .sheet(isPresented: $showDiff) {
      if let session = workspace.selectedSession, let rpc = workspace.rpc {
        DiffView(rpc: rpc, session: session)
      }
    }
    .sheet(isPresented: $showSettings) { SettingsView(workspace: workspace) }
    .sheet(isPresented: $showCloudLaunch) { CloudLaunchView(workspace: workspace) }
    .sheet(isPresented: $showNewChat) { NewChatView(workspace: workspace) }
    .alert(
      "Something needs attention",
      isPresented: Binding(
        get: { workspace.error != nil }, set: { if !$0 { workspace.error = nil } })
    ) {
      Button("OK") { workspace.error = nil }
    } message: {
      Text(workspace.error ?? "")
    }
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
          .accessibilityIdentifier("chat-composer")
          .font(.callout).lineLimit(1...6)
          .padding(.horizontal, 14).padding(.top, 13).padding(.bottom, 4)
        HStack(spacing: 4) {
          Menu {
            PhotosPicker(selection: $photo, matching: .images) {
              Label("Photo library", systemImage: "photo")
            }
            Button("Choose file", systemImage: "doc") {
              attachmentTarget = workspace.selectedSession?.id
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
          .disabled(workspace.uploading || workspace.connectionState != "Connected")
          Spacer(minLength: 4)
          if let session = workspace.selectedSession {
            Text(session.model == "preview" ? "Preview" : session.model)
              .font(.caption.weight(.medium)).foregroundStyle(.secondary)
              .lineLimit(1).truncationMode(.middle)
              .accessibilityLabel("Current model: \(session.model)")
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
        }.padding(.horizontal, 3)
      }
      .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22))
    }.padding(.horizontal, 12).padding(.top, 6).padding(.bottom, 8)
      .background(Color(uiColor: AppTheme.background))
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
          }
          if nearby.computers.isEmpty {
            Text(nearby.error ?? "Looking for computers on your network…").font(.caption)
              .foregroundStyle(.secondary)
          }
          if let computer = nearbySelection {
            Text("Pair with " + computer.name).font(.subheadline)
            TextField("Pairing code from your computer", text: $nearbyCode)
              .textInputAutocapitalization(.characters).autocorrectionDisabled()
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
        Section("Pair with your computer") {
          TextField("Paste a Zuse pairing link", text: $link).textInputAutocapitalization(.never)
            .autocorrectionDisabled().keyboardType(.URL)
          Button(pairing ? "Pairing…" : "Pair") { pair() }.disabled(link.isEmpty || pairing)
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
          }
        }
        Section {
          TextField("wss://your-computer.example/rpc", text: $address).textInputAutocapitalization(
            .never
          ).autocorrectionDisabled().keyboardType(.URL)
          SecureField("Connection token", text: $token)
          Button("Connect") {
            workspace.openRemote(
              RemoteConnection(
                address: address.trimmingCharacters(in: .whitespacesAndNewlines), token: token))
            dismiss()
          }.disabled(address.isEmpty)
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
        }
        if let error { Text(error).foregroundStyle(.red) }
      }.navigationTitle("Connect").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
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
    }.task { nearby.start() }.onDisappear { nearby.stop() }
  }
  private func pair(pin: String? = nil) {
    pairing = true
    error = nil
    Task {
      defer { pairing = false }
      do {
        try await workspace.pair(link, certificatePin: pin)
        dismiss()
      } catch { self.error = error.localizedDescription }
    }
  }
}

struct NewChatView: View {
  let workspace: WorkspaceModel
  @Environment(\.dismiss) private var dismiss
  @State private var provider = ""
  @State private var model = ""
  @State private var catalog: [ModelProvider] = []
  @State private var failure: String?
  @State private var creating = false
  private var selectedProvider: ModelProvider? { catalog.first { $0.id == provider } }
  var body: some View {
    NavigationStack {
      Form {
        if let failure { Text(failure).foregroundStyle(.red) }
        if catalog.isEmpty && failure == nil { ProgressView("Loading models…") }
        Picker("Agent", selection: $provider) {
          ForEach(catalog) { Text($0.name).tag($0.id) }
        }.onChange(of: provider) { model = selectedProvider?.defaultModel ?? "" }
        Picker("Model", selection: $model) {
          ForEach(selectedProvider?.models ?? []) { Text($0.label).tag($0.id) }
        }
        Button(creating ? "Creating…" : "Create chat") {
          creating = true
          Task {
            await workspace.createChat(provider: provider, model: model)
            creating = false
            if workspace.error == nil { dismiss() }
          }
        }.disabled(creating || model.isEmpty || provider.isEmpty)
      }.navigationTitle("New chat").navigationBarTitleDisplayMode(.inline)
        .task {
          do {
            guard let rpc = workspace.rpc else { throw ClientError("Connect to a computer first.") }
            catalog = try await ModelProvider.load(rpc)
            provider = catalog.first?.id ?? ""
            model = selectedProvider?.defaultModel ?? ""
          } catch { failure = error.localizedDescription }
        }
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
    }.presentationDetents([.medium, .large])
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

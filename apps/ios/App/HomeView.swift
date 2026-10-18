import SwiftUI
import ZuseCore

struct HomeView: View {
  @Bindable var workspace: WorkspaceModel
  @Binding var selection: SessionRow?
  let settings: () -> Void
  let connect: () -> Void
  let newChat: () -> Void
  let newCloudChat: () -> Void
  var addProject: () -> Void = {}
  private var isTablet: Bool {
    #if os(iOS)
      UIDevice.current.userInterfaceIdiom == .pad
    #else
      false
    #endif
  }
  @State private var search = ""
  @State private var collapsed: Set<String> = []
  @State private var showArchivedCloud = false
  @State private var cloudConfirmation: CloudActionSelection?
  private struct CloudActionSelection {
    let chat: CloudChat
    let action: CloudWorkspaceAction
  }

  var body: some View {
    let grouped = Dictionary(
      grouping: workspace.sessions.filter { matches($0.title) }, by: \.projectId)
    let visibleCloud = workspace.cloudChats.filter {
      $0.isArchived == showArchivedCloud && matches($0.title)
    }
    List(selection: $selection) {
      if let problem = workspace.catalogProblem {
        Label(problem, systemImage: "arrow.clockwise").font(.caption).foregroundStyle(.secondary)
      }
      if let problem = workspace.cloudCatalogProblem {
        Label(problem, systemImage: "cloud.bolt").font(.caption).foregroundStyle(.secondary)
      }
      if !workspace.cloudChats.isEmpty {
        Section {
          if visibleCloud.isEmpty {
            Text(showArchivedCloud ? "No archived cloud chats" : "No active cloud chats")
              .font(.caption).foregroundStyle(.secondary).listRowSeparator(.hidden)
          }
          ForEach(visibleCloud) { chat in
            Button {
              if let pending = workspace.pendingCloudActions[chat.workspaceId] {
                requestCloudAction(chat, action: pending)
              } else if chat.isArchived {
                requestCloudAction(chat, action: .unarchive)
              } else {
                workspace.openCloud(chat)
              }
            } label: {
              HStack(spacing: 9) {
                if workspace.cloudRequestsBusy.contains(chat.workspaceId) {
                  ProgressView().controlSize(.small)
                } else {
                  Image(systemName: chat.isArchived ? "archivebox" : "cloud").foregroundStyle(
                    .secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                  Text(chat.title.isEmpty ? "Untitled chat" : chat.title).lineLimit(1)
                  Text(
                    chat.repositoryDisplayName + " · "
                      + (workspace.pendingCloudActions[chat.workspaceId].map {
                        $0.title + " pending"
                      } ?? chat.statusLabel)
                  ).font(.caption)
                    .foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 4)
              }.foregroundStyle(.primary).padding(.vertical, 3)
            }
            .disabled(workspace.cloudRequestsBusy.contains(chat.workspaceId))
            .listRowSeparator(.hidden).listRowBackground(Color.clear)
            .contextMenu { cloudActions(chat) }
            .swipeActions { cloudActions(chat) }
          }
        } header: {
          HStack {
            Label(
              showArchivedCloud ? "Archived" : "Cloud",
              systemImage: showArchivedCloud ? "archivebox" : "cloud"
            ).textCase(nil)
            Spacer()
            Menu {
              Button("Active cloud chats") { showArchivedCloud = false }
              Button("Archived cloud chats") { showArchivedCloud = true }
            } label: {
              Image(systemName: "line.3.horizontal.decrease")
            }
            .accessibilityLabel("Filter cloud chats")
          }
        }
      }
      ForEach(workspace.projects) { project in
        Section {
          if !collapsed.contains(project.id) {
            ForEach(grouped[project.id] ?? []) {
              session in
              SessionListRow(workspace: workspace, session: session)
            }
            if grouped[project.id] == nil && workspace.catalogProblem != nil && search.isEmpty {
              Button("Retry loading chats") {
                workspace.selectedProject = project
                Task { await workspace.loadSessions() }
              }.font(.subheadline)
            }
          }
        } header: {
          Button {
            if collapsed.contains(project.id) {
              collapsed.remove(project.id)
            } else {
              collapsed.insert(project.id)
            }
          } label: {
            HStack(spacing: 10) {
              Text(String(project.name.prefix(1)).uppercased())
                .font(.system(size: 11, weight: .semibold)).frame(width: 22, height: 22)
                .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
              Text(project.name).font(.footnote.weight(.semibold))
              Spacer()
              Image(systemName: collapsed.contains(project.id) ? "chevron.right" : "chevron.down")
                .font(.caption).foregroundStyle(.secondary)
            }.foregroundStyle(Color.primary).textCase(nil).padding(.vertical, 2)
          }.buttonStyle(.plain).accessibilityLabel("\(project.name), toggle chats")
        }
      }
      if workspace.projects.isEmpty && workspace.cloudChats.isEmpty {
        ContentUnavailableView {
          Label("Your chats live here", systemImage: "bubble.left.and.bubble.right")
        } description: {
          Text("Connect a computer or start a cloud chat to pick up your work.")
        } actions: {
          Button("Get started", action: settings).buttonStyle(.borderedProminent)
        }.listRowBackground(Color.clear)
      }
      if !search.isEmpty && !workspace.sessions.contains(where: { matches($0.title) })
        && visibleCloud.isEmpty
      {
        ContentUnavailableView.search(text: search)
      }
    }
    .listStyle(.plain)
    .environment(\.defaultMinListRowHeight, 38)
    .compactListSections()
    .contentMargins(.top, isTablet ? 8 : 16, for: .scrollContent)
    .listRowSeparator(.hidden)
    .scrollContentBackground(.hidden)
    .background(AppTheme.surface)
    .navigationTitle("Zuse")
    .compactNavigationTitle()
    .toolbar {
      if !isTablet {
        ToolbarItemGroup(placement: .primaryAction) {
          Button("Pair with desktop", systemImage: "qrcode.viewfinder", action: connect)
          Button("Open settings", systemImage: "gearshape", action: settings)
        }
      }
    }
    .safeAreaInset(edge: .bottom) {
      HStack(spacing: 8) {
        if isTablet {
          Button("Open settings", systemImage: "gearshape", action: settings)
            .labelStyle(.iconOnly).font(.system(size: 15))
            .frame(width: 36, height: 36).contentShape(Circle())
            .contextMenu {
              Button("Pair with desktop", systemImage: "qrcode.viewfinder", action: connect)
            }
        }
        HStack(spacing: 8) {
          Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
          TextField("Search", text: $search).accessibilityLabel("Search chats")
          if !search.isEmpty {
            Button("Clear search", systemImage: "xmark.circle.fill") { search = "" }
              .labelStyle(.iconOnly).foregroundStyle(.secondary)
          }
        }.font(.system(size: isTablet ? 13 : 15))
          .padding(.horizontal, 12).frame(height: isTablet ? 36 : 46)
          .floatingGlass(radius: isTablet ? 18 : 23)
        Button(action: newChat) {
          Image(systemName: "square.and.pencil").font(
            .system(size: isTablet ? 16 : 18, weight: .medium)
          )
          .frame(width: isTablet ? 36 : 46, height: isTablet ? 36 : 46)
          .contentShape(Circle()).floatingGlass(radius: isTablet ? 18 : 23)
        }.buttonStyle(.plain).accessibilityLabel("New chat")
      }.frame(maxWidth: 560).frame(maxWidth: .infinity).padding(.horizontal, 16).padding(
        .vertical, isTablet ? 8 : 10
      )
      .foregroundStyle(.secondary).tint(.primary)
    }
    .task(id: workspace.account.generation) {
      var delay = 5.0
      while !Task.isCancelled && workspace.account.signedIn {
        do { try await Task.sleep(for: .seconds(delay)) } catch { return }
        if workspace.shouldPollCloudCatalog {
          await workspace.refreshCloud(reportErrors: false)
          delay = workspace.cloudCatalogProblem == nil ? 5 : min(30, delay * 2)
        }
      }
    }
    .confirmationDialog(
      cloudConfirmation?.action == .archive ? "Archive cloud workspace?" : "Pause cloud workspace?",
      isPresented: Binding(
        get: { cloudConfirmation != nil }, set: { if !$0 { cloudConfirmation = nil } })
    ) {
      if let selection = cloudConfirmation {
        Button(selection.action.title, role: selection.action == .archive ? .destructive : nil) {
          cloudConfirmation = nil
          Task { await workspace.controlCloud(selection.chat, action: selection.action) }
        }
      }
    } message: {
      Text(
        cloudConfirmation?.action == .archive
          ? "The workspace will stop and move to Archived. Available archives can be restored later."
          : "Active agent and terminal work may be interrupted. You can wake this workspace later.")
    }
    .refreshable {
      await workspace.refreshCloud()
      await workspace.refreshSessionCatalog()
    }
  }
  @ViewBuilder private func cloudActions(_ chat: CloudChat) -> some View {
    if let pending = workspace.pendingCloudActions[chat.workspaceId] {
      Button("Retry " + pending.title.lowercased() + " request", systemImage: "arrow.clockwise") {
        requestCloudAction(chat, action: pending)
      }.disabled(workspace.cloudRequestsBusy.contains(chat.workspaceId))
    } else {
      ForEach(chat.availableActions, id: \.rawValue) { action in
        Button(role: action == .archive ? .destructive : nil) {
          requestCloudAction(chat, action: action)
        } label: {
          Label(action.title, systemImage: action.symbol)
        }
        .disabled(workspace.cloudRequestsBusy.contains(chat.workspaceId))
      }
    }
  }
  private func requestCloudAction(_ chat: CloudChat, action: CloudWorkspaceAction) {
    if action.stopsWork {
      cloudConfirmation = CloudActionSelection(chat: chat, action: action)
    } else {
      Task {
        if await workspace.controlCloud(chat, action: action), action == .unarchive {
          showArchivedCloud = false
        }
      }
    }
  }
  private func matches(_ title: String) -> Bool {
    search.isEmpty || title.localizedCaseInsensitiveContains(search)
  }
}

struct SettingsView: View {
  @Bindable var workspace: WorkspaceModel
  @Environment(\.dismiss) private var dismiss
  @AppStorage("native.appearance") private var appearance = "system"
  @State private var showCloud = false
  @State private var showCloudPreferences = false
  var body: some View {
    NavigationStack {
      List {
        Section {
          if workspace.account.signedIn {
            NavigationLink {
              accountSettings
            } label: {
              SettingsRow(
                title: "Account", subtitle: "Cloud chats and remote access",
                icon: "person.crop.circle")
            }
          } else {
            Button {
              Task {
                do { try await workspace.signIn() } catch {
                  workspace.error = error.localizedDescription
                }
              }
            } label: {
              SettingsRow(
                title: "Sign in to Zuse", subtitle: "Cloud chats and remote access",
                icon: "person.crop.circle")
            }.foregroundStyle(.primary).accessibilityLabel("Sign in to Zuse")
          }
        }
        Section {
          NavigationLink {
            ComputerConnectionsView(workspace: workspace)
          } label: {
            SettingsRow(
              title: "Computers", subtitle: "Connections and remote access", icon: "desktopcomputer"
            )
          }
          NavigationLink {
            Form {
              Picker("Theme", selection: $appearance) {
                Text("System").tag("system")
                Text("Light").tag("light")
                Text("Dark").tag("dark")
              }.pickerStyle(.inline)
            }.navigationTitle("Appearance").compactNavigationTitle()
          } label: {
            SettingsRow(
              title: "Appearance", subtitle: appearance.capitalized, icon: "circle.lefthalf.filled")
          }
        }
        if workspace.account.signedIn {
          Section {
            NavigationLink {
              CloudInfrastructureView(workspace: workspace)
            } label: {
              SettingsRow(title: "Cloud providers", icon: "cloud")
            }
            NavigationLink {
              RegisteredDevicesView(workspace: workspace)
            } label: {
              SettingsRow(title: "Registered devices", icon: "desktopcomputer.and.iphone")
            }
          }
        }
      }
      .environment(\.defaultMinListRowHeight, 44)
      .listSectionSpacing(12)
      .contentMargins(.top, 12)
      .scrollContentBackground(.hidden).background(AppTheme.surface)
      .navigationTitle("Settings").compactNavigationTitle()
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .disabled(workspace.clearingAccount)
    }.nativeSheetSize(width: 440, height: 520).tint(.primary)
      .sheet(isPresented: $showCloud) { CloudSettingsView(workspace: workspace).nativeSheetSize() }
      .sheet(isPresented: $showCloudPreferences) {
        RuntimeSettingsView(cloud: workspace.cloud).nativeSheetSize()
      }
  }
  private var accountSettings: some View {
    List {
      if workspace.account.reauthenticationRequired {
        Button("Sign in again") {
          Task {
            do { try await workspace.signIn() } catch {
              workspace.error = error.localizedDescription
            }
          }
        }
      }
      Button {
        showCloudPreferences = true
      } label: {
        SettingsRow(title: "Cloud preferences", icon: "slider.horizontal.3")
      }
      Button {
        showCloud = true
      } label: {
        SettingsRow(title: "Agent sign-in", icon: "key")
      }
      Button("Sign out", role: .destructive) { Task { await workspace.signOut() } }
    }.navigationTitle("Account").compactNavigationTitle()
  }
}

struct SettingsRow: View {
  let title: String
  var subtitle: String? = nil
  let icon: String
  var body: some View {
    HStack(spacing: 9) {
      Image(systemName: icon).font(.system(size: 14)).foregroundStyle(.secondary).frame(width: 18)
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(.primary)
        if let subtitle {
          Text(subtitle).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(2)
        }
      }
    }.frame(minHeight: 32, alignment: .leading)
      .listRowInsets(EdgeInsets(top: 5, leading: 14, bottom: 5, trailing: 14))
  }
}

struct ComputerConnectionsView: View {
  @Bindable var workspace: WorkspaceModel
  @State private var method: ConnectionMethod?
  @State private var forgetting: RemoteConnection?
  @State private var showRuntime = false
  var body: some View {
    List {
      Section {
        Button {
          method = .nearby
        } label: {
          SettingsRow(
            title: "Connect to a nearby computer", subtitle: "Find it automatically over Wi-Fi",
            icon: "wifi")
        }
        Button {
          method = .pairing
        } label: {
          SettingsRow(
            title: "Scan a pairing code", subtitle: "Pair using a QR code or link",
            icon: "qrcode.viewfinder")
        }
        Button {
          method = .manual
        } label: {
          SettingsRow(title: "Add manually", icon: "plus")
        }
      } header: {
        Text("Connections")
      } footer: {
        Text("Pair over your local network. No account needed.")
      }
      if !workspace.savedConnections.isEmpty {
        Section("Saved computers") {
          ForEach(workspace.savedConnections) { connection in
            Button {
              workspace.openRemote(connection)
            } label: {
              SettingsRow(
                title: connection.displayName,
                subtitle: workspace.connectedComputer == connection.displayName
                  ? workspace.connectionState : connection.transportName,
                icon: "laptopcomputer")
            }.contextMenu {
              Button("Forget computer", role: .destructive) { forgetting = connection }
            }
            .swipeActions { Button("Forget") { forgetting = connection }.tint(.red) }
          }
        }
      }
      if !workspace.environments.isEmpty {
        Section("Account computers") {
          ForEach(workspace.environments) { environment in
            Button {
              workspace.openEnvironment(environment)
            } label: {
              SettingsRow(
                title: environment.label ?? "Computer", subtitle: "Remote access",
                icon: "desktopcomputer")
            }
          }
        }
      }
      if let name = workspace.connectedComputer {
        Section(name) {
          if let rpc = workspace.rpc {
            Button {
              showRuntime = true
            } label: {
              SettingsRow(title: "Computer settings", icon: "slider.horizontal.3")
            }.disabled(workspace.connectionState != "Connected")
            NavigationLink {
              ComputerAccessView(rpc: rpc)
            } label: {
              SettingsRow(title: "Device access", icon: "ipad.and.iphone")
            }.disabled(workspace.connectionState != "Connected")
          }
          Button("Disconnect", role: .destructive) {
            workspace.persistDraft(immediate: true)
            workspace.disconnect(clearSaved: true)
          }
        }
      }
      Section {
        NavigationLink {
          ServeSettingsView(workspace: workspace)
        } label: {
          SettingsRow(
            title: "Remote network", subtitle: "Zuse Serve and Tailscale", icon: "network")
        }
      }
    }.environment(\.defaultMinListRowHeight, 44)
      .listSectionSpacing(12).scrollContentBackground(.hidden).background(AppTheme.surface)
      .navigationTitle("Computers").compactNavigationTitle()
      .sheet(item: $method) { ConnectionView(workspace: workspace, method: $0) }
      .sheet(isPresented: $showRuntime) {
        if let rpc = workspace.rpc { RuntimeSettingsView(rpc: rpc).nativeSheetSize() }
      }
      .confirmationDialog(
        "Forget this computer?",
        isPresented: Binding(get: { forgetting != nil }, set: { if !$0 { forgetting = nil } })
      ) {
        Button("Forget computer", role: .destructive) {
          if let connection = forgetting { workspace.forgetComputer(connection) }
          forgetting = nil
        }
      }
  }
}

struct GitStatusGlyph: View {
  let info: JSONValue
  private var color: Color {
    if info["checks"].string == "failure" || info["mergeable"].string == "conflicting" {
      return .red
    }
    switch info["state"].string {
    case "merged": return .purple
    case "open": return info["isDraft"].bool ? .secondary : .green
    case "closed": return .red
    default: return .secondary
    }
  }
  var body: some View {
    GitBranchShape(pullRequest: info["number"].int != nil, merged: info["state"].string == "merged")
      .stroke(color, style: StrokeStyle(lineWidth: 1.35, lineCap: .round, lineJoin: .round))
      .frame(width: 16, height: 16)
      .accessibilityLabel(
        info["number"].int.map { "Pull request #\($0), " + (info["state"].string ?? "") }
          ?? "Git branch")
  }
}
private struct GitBranchShape: Shape {
  let pullRequest: Bool
  let merged: Bool
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.addEllipse(in: CGRect(x: 1, y: 1, width: 4, height: 4))
    p.addEllipse(in: CGRect(x: 1, y: 11, width: 4, height: 4))
    p.move(to: CGPoint(x: 3, y: 5))
    p.addLine(to: CGPoint(x: 3, y: 11))
    p.addEllipse(in: CGRect(x: 11, y: pullRequest ? 11 : 1, width: 4, height: 4))
    p.move(to: CGPoint(x: 13, y: pullRequest ? 11 : 5))
    if pullRequest && !merged {
      p.addLine(to: CGPoint(x: 13, y: 5))
      p.addQuadCurve(to: CGPoint(x: 8, y: 2), control: CGPoint(x: 13, y: 2))
    } else {
      p.addQuadCurve(to: CGPoint(x: 3, y: 9), control: CGPoint(x: 13, y: 9))
    }
    return p
  }
}

private struct SessionListRow: View {
  let workspace: WorkspaceModel
  let session: SessionRow
  private var context: String {
    (workspace.operationScope ?? "") + workspace.connectionState
      + workspace.account.generation.uuidString
  }
  var body: some View {
    let info = workspace.gitState(for: session)
    NavigationLink(value: session) {
      HStack(spacing: 9) {
        GitStatusGlyph(info: info).accessibilityIdentifier("git-status-\(session.id)")
        Text(session.title.isEmpty ? "New chat" : session.title).font(.subheadline).lineLimit(1)
        Spacer(minLength: 4)
        if let number = info["number"].int {
          Text("#\(number)").font(.caption2).foregroundStyle(.secondary)
        }
      }.padding(.vertical, 2)
    }
    .task(id: context) {
      workspace.requestGitState(session)
      while !Task.isCancelled && workspace.connectionState == "Connected" {
        do { try await Task.sleep(for: .seconds(60)) } catch { return }
        workspace.requestGitState(session, refresh: true)
      }
    }
    .contextMenu {
      if let value = info["url"].string, let url = URL(string: value), url.scheme == "https" {
        Link("Open pull request", destination: url)
      }
    }
    .listRowSeparator(.hidden).listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 14))
  }
}

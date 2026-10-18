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
      if let problem = workspace.connectionProblem {
        Label(problem, systemImage: "wifi.exclamationmark")
          .font(.caption).foregroundStyle(.secondary)
      }
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
              NavigationLink(value: session) {
                HStack(spacing: 9) {
                  Image(systemName: "bubble.left").font(.subheadline).foregroundStyle(.secondary)
                  Text(session.title.isEmpty ? "New chat" : session.title).font(.subheadline)
                    .lineLimit(1)
                  Spacer(minLength: 4)
                }.padding(.vertical, 2)
              }
              .listRowSeparator(.hidden)
              .listRowBackground(Color.clear)
              .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 14))
            }
            if workspace.selectedProject != project {
              Button("Load chats") {
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
    .environment(\.defaultMinListRowHeight, 40)
    .compactListSections()
    .listRowSeparator(.hidden)
    .scrollContentBackground(.hidden)
    .background(AppTheme.surface)
    .navigationTitle("Zuse")
    .compactNavigationTitle()
    .toolbar {
      ToolbarItemGroup(placement: .primaryAction) {
        Button("Add project", systemImage: "folder.badge.plus", action: addProject)
          .disabled(workspace.rpc == nil)
        Button("Pair with desktop", systemImage: "qrcode.viewfinder", action: connect)
        Button("Open settings", systemImage: "gearshape", action: settings)
      }
    }
    .safeAreaInset(edge: .bottom) {
      HStack(spacing: 9) {
        HStack(spacing: 9) {
          Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
          TextField("Search", text: $search).accessibilityLabel("Search chats")
          if !search.isEmpty {
            Button("Clear search", systemImage: "xmark.circle.fill") { search = "" }
              .labelStyle(.iconOnly).foregroundStyle(.secondary)
          }
        }.padding(.horizontal, 16).frame(height: 48).background(.regularMaterial, in: Capsule())
        Menu {
          Button("On your computer", systemImage: "laptopcomputer", action: newChat)
            .disabled(workspace.rpc == nil)
          Button("In the cloud", systemImage: "cloud", action: newCloudChat)
            .disabled(!workspace.account.signedIn)
          if workspace.rpc == nil && !workspace.account.signedIn {
            Button("Connect to get started", action: settings)
          }
        } label: {
          Image(systemName: "square.and.pencil").font(.title3)
            .frame(width: 48, height: 48).background(.regularMaterial, in: Circle())
        }.accessibilityLabel("New chat")
      }.padding(.horizontal, 16).padding(.vertical, 8)
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
  @State private var showConnection = false
  @State private var showCloud = false
  @State private var showRuntime = false
  @State private var showCloudPreferences = false
  @AppStorage("native.appearance") private var appearance = "system"
  var body: some View {
    NavigationStack {
      List {
        Section("Account") {
          if workspace.account.signedIn {
            if workspace.account.reauthenticationRequired {
              Button("Sign in again", systemImage: "person.crop.circle.badge.exclamationmark") {
                Task {
                  do { try await workspace.signIn() } catch {
                    workspace.error = error.localizedDescription
                  }
                }
              }.frame(height: 28)
            }

            Button {
              showCloudPreferences = true
            } label: {
              Label("Cloud preferences", systemImage: "slider.horizontal.3")
            }
            NavigationLink {
              CloudInfrastructureView(workspace: workspace)
            } label: {
              Label("Cloud provider accounts", systemImage: "cloud")
            }
            NavigationLink {
              RegisteredDevicesView(workspace: workspace)
            } label: {
              Label("Registered devices", systemImage: "desktopcomputer.and.iphone")
            }
            Button {
              showCloud = true
            } label: {
              Label("Cloud agent sign-in", systemImage: "person.crop.circle")
            }
          } else {
            Button {
              Task {
                do {
                  try await workspace.signIn()
                } catch { workspace.error = error.localizedDescription }
              }
            } label: {
              Label("Sign in to Zuse", systemImage: "person.crop.circle")
            }
          }
        }
        Section("Appearance") {
          Picker("Theme", selection: $appearance) {
            Text("System").tag("system")
            Text("Light").tag("light")
            Text("Dark").tag("dark")
          }.frame(height: 28)
        }
        if let name = workspace.connectedComputer {
          Section("Connected computer") {
            LabeledContent(name, value: workspace.connectionState)
            Button("Computer settings", systemImage: "slider.horizontal.3") { showRuntime = true }
              .disabled(workspace.connectionState != "Connected")
            if let rpc = workspace.rpc {
              NavigationLink {
                ComputerAccessView(rpc: rpc)
              } label: {
                Label("Computer access", systemImage: "ipad.and.iphone")
              }.disabled(workspace.connectionState != "Connected")
            }
            Button("Disconnect") {
              workspace.persistDraft(immediate: true)
              workspace.disconnect(clearSaved: true)
            }
          }
        }
        Section("Computers") {
          Button {
            showConnection = true
          } label: {
            Label("Connect a computer", systemImage: "qrcode.viewfinder")
          }
          ForEach(workspace.savedConnections) { connection in
            HStack {
              Button {
                workspace.openRemote(connection)
                dismiss()
              } label: {
                VStack(alignment: .leading, spacing: 2) {
                  Label(connection.displayName, systemImage: "laptopcomputer")
                  Text(connection.transportName).font(.caption).foregroundStyle(.secondary)
                }
              }
              Spacer()
              Menu {
                Button("Forget saved connection", role: .destructive) {
                  workspace.forgetComputer(connection)
                }
              } label: {
                Image(systemName: "ellipsis")
              }.buttonStyle(.plain)
            }
          }
          ForEach(workspace.environments) { environment in
            Button(environment.label ?? "Computer", systemImage: "laptopcomputer") {
              workspace.openEnvironment(environment)
              dismiss()
            }
          }
        }
        Section("Connections") {
          NavigationLink {
            ServeSettingsView(workspace: workspace)
          } label: {
            Label("Zuse Serve & Tailscale", systemImage: "network")
          }
        }
        if workspace.account.signedIn {
          Section {
            Button("Sign out", role: .destructive) { Task { await workspace.signOut() } }
          }
        }
      }
      .environment(\.defaultMinListRowHeight, 36).controlSize(.small)
      .scrollContentBackground(.hidden).background(AppTheme.surface)
      .navigationTitle("Settings").compactNavigationTitle()
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .disabled(workspace.clearingAccount)
    }.nativeSheetSize().tint(AppTheme.accent)
      .sheet(isPresented: $showConnection) { ConnectionView(workspace: workspace) }
      .sheet(isPresented: $showCloud) { CloudSettingsView(workspace: workspace).nativeSheetSize() }
      .sheet(isPresented: $showCloudPreferences) {
        RuntimeSettingsView(cloud: workspace.cloud).nativeSheetSize().id(
          workspace.account.generation)
      }
      .sheet(isPresented: $showRuntime) {
        if let rpc = workspace.rpc { RuntimeSettingsView(rpc: rpc).nativeSheetSize() }
      }
  }
}

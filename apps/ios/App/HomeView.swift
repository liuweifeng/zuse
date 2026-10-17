import SwiftUI
import ZuseCore

enum AppTheme {
  static let background = UIColor { traits in
    traits.userInterfaceStyle == .dark
      ? UIColor(white: 0.06, alpha: 1)
      : UIColor(red: 247 / 255, green: 247 / 255, blue: 245 / 255, alpha: 1)
  }
  static let accent = Color(
    uiColor: UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(red: 0.55, green: 0.79, blue: 0.13, alpha: 1)
        : UIColor(red: 0.28, green: 0.41, blue: 0, alpha: 1)
    })
}

struct HomeView: View {
  @Bindable var workspace: WorkspaceModel
  @Binding var selection: SessionRow?
  let settings: () -> Void
  let connect: () -> Void
  let newChat: () -> Void
  let newCloudChat: () -> Void
  @State private var search = ""
  @State private var collapsed: Set<String> = []

  var body: some View {
    List(selection: $selection) {
      if let problem = workspace.connectionProblem {
        Label(problem, systemImage: "wifi.exclamationmark")
          .font(.caption).foregroundStyle(.secondary)
      }
      if !workspace.cloudChats.isEmpty {
        Section {
          ForEach(workspace.cloudChats.filter { matches($0.title) }) { chat in
            Button {
              workspace.openCloud(chat)
            } label: {
              HStack(spacing: 9) {
                Image(systemName: "cloud").foregroundStyle(.secondary)
                Text(chat.title.isEmpty ? "Untitled chat" : chat.title).lineLimit(1)
                Spacer()
                Text(chat.repositoryDisplayName).font(.caption).foregroundStyle(.secondary)
                  .lineLimit(1)
              }.foregroundStyle(.primary).padding(.vertical, 5)
            }
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
            .swipeActions {
              Button("Wake", systemImage: "power") { Task { await workspace.resumeCloud(chat) } }
            }
          }
        } header: {
          Label("Cloud", systemImage: "cloud").textCase(nil)
        }
      }
      ForEach(workspace.projects) { project in
        Section {
          if !collapsed.contains(project.id) {
            ForEach(workspace.sessions.filter { $0.projectId == project.id && matches($0.title) }) {
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
        && !workspace.cloudChats.contains(where: { matches($0.title) })
      {
        ContentUnavailableView.search(text: search)
      }
    }
    .listStyle(.plain)
    .environment(\.defaultMinListRowHeight, 40)
    .listSectionSpacing(8)
    .listRowSeparator(.hidden)
    .scrollContentBackground(.hidden)
    .background(Color(uiColor: AppTheme.background))
    .navigationTitle("Zuse")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
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
    .refreshable {
      await workspace.refreshCloud()
      await workspace.loadSessions()
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
  var body: some View {
    NavigationStack {
      List {
        Section("Account") {
          if workspace.account.signedIn {
            Button {
              showCloud = true
            } label: {
              Label("Cloud & providers", systemImage: "person.crop.circle")
            }
          } else {
            Button {
              Task {
                do {
                  try await workspace.account.signIn()
                  await workspace.refreshCloud()
                } catch { workspace.error = error.localizedDescription }
              }
            } label: {
              Label("Sign in to Zuse", systemImage: "person.crop.circle")
            }
          }
        }
        Section("Computers") {
          Button {
            showConnection = true
          } label: {
            Label("Connect a computer", systemImage: "qrcode.viewfinder")
          }
          ForEach(workspace.environments) { environment in
            Button(environment.label ?? "Computer", systemImage: "laptopcomputer") {
              workspace.openEnvironment(environment)
              dismiss()
            }
          }
        }
        if workspace.account.signedIn {
          Section {
            Button("Sign out", role: .destructive) { Task { await workspace.signOut() } }
          }
        }
      }
      .scrollContentBackground(.hidden).background(Color(uiColor: AppTheme.background))
      .navigationTitle("Settings").navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
      .disabled(workspace.clearingAccount)
    }.tint(AppTheme.accent)
      .sheet(isPresented: $showConnection) { ConnectionView(workspace: workspace) }
      .sheet(isPresented: $showCloud) { CloudSettingsView(workspace: workspace) }
  }
}

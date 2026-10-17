import SwiftUI
import ZuseCore

struct DiffView: View {
  let rpc: RPCClient
  let session: SessionRow
  @Environment(\.dismiss) private var dismiss
  @State private var scope = "unstaged"
  @State private var patches: [Patch] = []
  @State private var error: String?
  @State private var loading = false
  @State private var file: Patch?
  struct Patch: Identifiable {
    let id: String
    let lines: [DiffLine]
    let mode: String
    let truncated: Bool
    let error: String?
  }
  var body: some View {
    NavigationStack {
      List {
        Picker("Changes", selection: $scope) {
          Text("Working tree").tag("unstaged")
          Text("Staged").tag("staged")
          Text("Branch").tag("branch")
        }.pickerStyle(.segmented)
        if loading { ProgressView("Loading changes…") }
        if let error {
          Text(error).foregroundStyle(.red)
          Button("Retry") { Task { await load() } }
        }
        if !loading && patches.isEmpty && error == nil {
          ContentUnavailableView("No changes", systemImage: "checkmark.circle")
        }
        ForEach(patches) { patch in
          Section(patch.id) {
            if let error = patch.error {
              Text(error).foregroundStyle(.red)
            } else if patch.mode == "binary" {
              Label("Binary file changed", systemImage: "doc")
            } else {
              ScrollView(.horizontal) {
                LazyVStack(alignment: .leading, spacing: 0) {
                  ForEach(patch.lines) { line in
                    HStack(alignment: .top, spacing: 8) {
                      Text(line.oldLine.map(String.init) ?? "").foregroundStyle(.secondary).frame(
                        width: 36, alignment: .trailing)
                      Text(line.newLine.map(String.init) ?? "").foregroundStyle(.secondary).frame(
                        width: 36, alignment: .trailing)
                      Text(line.text).textSelection(.enabled).fixedSize(
                        horizontal: true, vertical: false)
                    }
                    .font(.system(.caption, design: .monospaced)).padding(.vertical, 2).padding(
                      .trailing, 12
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                      line.kind == .addition
                        ? Color.green.opacity(0.12)
                        : line.kind == .deletion ? Color.red.opacity(0.12) : .clear)
                  }
                }
              }
              Button("View working-copy file", systemImage: "doc.text") { file = patch }
              if patch.truncated {
                Label("The server truncated this patch.", systemImage: "exclamationmark.triangle")
                  .font(.caption).foregroundStyle(.orange)
              }
            }
          }
        }
      }.listStyle(.plain).navigationTitle("Changes").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task(id: scope) { await load() }
        .sheet(item: $file) { patch in FileContentsView(rpc: rpc, session: session, path: patch.id)
        }
    }
  }
  private func load() async {
    patches = []
    error = nil
    loading = true
    let requestedScope = scope
    do {
      var payload: [String: JSONValue] = [
        "folderId": .string(session.projectId), "scope": .string(requestedScope),
      ]
      if let worktree = session.worktreeId { payload["worktreeId"] = .string(worktree) }
      let stream = try await rpc.stream("git.reviewPatches", payload)
      for try await item in stream {
        try Task.checkCancellation()
        guard requestedScope == scope else { return }
        let result = item["result"]
        let patch = result["patch"].string ?? ""
        let lines = await Task.detached(priority: .userInitiated) { DiffLine.parse(patch) }.value
        guard requestedScope == scope, !Task.isCancelled else { return }
        patches.append(
          Patch(
            id: item["path"].string ?? UUID().uuidString, lines: lines,
            mode: result["mode"].string ?? "", truncated: result["truncated"].bool,
            error: item["error"].string))
      }
    } catch {
      if !Task.isCancelled && requestedScope == scope { self.error = error.localizedDescription }
    }
    if requestedScope == scope { loading = false }
  }
}

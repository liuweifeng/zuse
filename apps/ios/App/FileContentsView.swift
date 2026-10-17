import SwiftUI
import ZuseCore

struct FileContentsView: View {
  let rpc: RPCClient
  let session: SessionRow
  let path: String
  @Environment(\.dismiss) private var dismiss
  @State private var lines: [String] = []
  @State private var error: String?
  @State private var loading = true
  var body: some View {
    NavigationStack {
      Group {
        if loading {
          ProgressView("Loading file…")
        } else if let error {
          ContentUnavailableView(
            "Cannot open file", systemImage: "doc.badge.ellipsis", description: Text(error))
        } else {
          List(Array(lines.enumerated()), id: \.offset) { index, line in
            HStack(alignment: .top, spacing: 12) {
              Text(String(index + 1)).foregroundStyle(.secondary).frame(
                width: 40, alignment: .trailing)
              Text(line.isEmpty ? " " : line).textSelection(.enabled).frame(
                maxWidth: .infinity, alignment: .leading)
            }.font(.system(.caption, design: .monospaced)).listRowSeparator(.hidden)
          }.listStyle(.plain)
        }
      }.navigationTitle(path).navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        .task {
          do {
            var payload: [String: JSONValue] = [
              "folderId": .string(session.projectId), "path": .string(path),
            ]
            if let id = session.worktreeId { payload["worktreeId"] = .string(id) }
            let result = try await rpc.call("git.reviewFileContents", payload)
            guard let text = result["newContent"].string else {
              throw ClientError("This file was removed or has no text content.")
            }
            let parsed = await Task.detached(priority: .userInitiated) {
              text.components(separatedBy: "\n")
            }.value
            try Task.checkCancellation()
            lines = parsed
          } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
          loading = false
        }
    }
  }
}

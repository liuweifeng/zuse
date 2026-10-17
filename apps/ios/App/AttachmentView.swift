import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import ZuseCore

struct AttachmentView: View {
  let reference: JSONValue
  let sessionID: String
  let rpc: RPCClient?
  @State private var preview: PreviewFile?
  @State private var loading = false
  @State private var error: String?
  private struct PreviewFile: Identifiable {
    let id = UUID()
    let url: URL
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Button {
        Task { await open() }
      } label: {
        HStack {
          if loading {
            ProgressView()
          } else {
            Image(
              systemName: reference["mimeType"].string?.hasPrefix("image/") == true
                ? "photo" : "doc")
          }
          Text(reference["originalName"].string ?? "Attachment").lineLimit(2)
          Spacer()
          Image(systemName: "arrow.up.right")
        }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
      }.buttonStyle(.plain).disabled(loading || rpc == nil)
      if let error { Text(error).font(.caption).foregroundStyle(.red) }
    }
    .sheet(item: $preview, onDismiss: cleanup) { file in
      NavigationStack {
        FilePreview(url: file.url).ignoresSafeArea(edges: .bottom)
          .navigationTitle(reference["originalName"].string ?? "Attachment")
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            ToolbarItem(placement: .primaryAction) { ShareLink(item: file.url) }
            ToolbarItem(placement: .cancellationAction) { Button("Done") { preview = nil } }
          }
      }
    }
  }
  @State private var temporaryDirectory: URL?
  private func open() async {
    guard let rpc, let id = reference["id"].string else { return }
    loading = true
    error = nil
    defer { loading = false }
    do {
      let (data, mime, _) = try await Attachments.read(id, sessionID: sessionID, rpc: rpc)
      let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
        UUID().uuidString)
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      let file = directory.appendingPathComponent("Attachment").appendingPathExtension(
        UTType(mimeType: mime)?.preferredFilenameExtension ?? "bin")
      try data.write(to: file, options: [.atomic, .completeFileProtection])
      cleanup()
      temporaryDirectory = directory
      preview = PreviewFile(url: file)
    } catch { self.error = error.localizedDescription }
  }
  private func cleanup() {
    if let temporaryDirectory { try? FileManager.default.removeItem(at: temporaryDirectory) }
    temporaryDirectory = nil
  }
}

private struct FilePreview: UIViewControllerRepresentable {
  let url: URL
  func makeCoordinator() -> Coordinator { Coordinator(url) }
  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }
  func updateUIViewController(_ controller: QLPreviewController, context: Context) {}
  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let url: URL
    init(_ url: URL) { self.url = url }
    func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
    func previewController(_ controller: QLPreviewController, previewItemAt index: Int)
      -> QLPreviewItem
    { url as NSURL }
  }
}

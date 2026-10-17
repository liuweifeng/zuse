import SwiftUI
import Textual
import WebKit
import ZuseCore

struct ChatMarkdown: View {
  let text: String
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(MarkdownBlock.parse(text)) { block in
        if block.kind == .diagram {
          DiagramView(source: block.content)
        } else {
          StructuredText(markdown: block.content, syntaxExtensions: [.math]).textual.textSelection(
            .enabled)
        }
      }
    }
  }
}

private struct DiagramView: View {
  let source: String
  @State private var fullScreen = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      DiagramWebView(source: source).frame(height: 280)
      HStack {
        Button("Expand diagram", systemImage: "arrow.up.left.and.arrow.down.right") {
          fullScreen = true
        }
        Spacer()
        Button("Copy source", systemImage: "doc.on.doc") { UIPasteboard.general.string = source }
      }.font(.caption)
    }.sheet(isPresented: $fullScreen) {
      NavigationStack {
        DiagramWebView(source: source).navigationTitle("Diagram").navigationBarTitleDisplayMode(
          .inline
        )
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { fullScreen = false } }
        }
      }
    }
  }
}

private struct DiagramWebView: UIViewRepresentable {
  let source: String
  func makeCoordinator() -> Coordinator { Coordinator(source) }
  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.backgroundColor = .clear
    if let file = Bundle.main.url(forResource: "Diagram", withExtension: "html") {
      view.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
    }
    return view
  }
  func updateUIView(_ view: WKWebView, context: Context) {
    if context.coordinator.source != source {
      context.coordinator.source = source
      context.coordinator.render(view)
    }
  }
  static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
    view.stopLoading()
    view.navigationDelegate = nil
  }
  final class Coordinator: NSObject, WKNavigationDelegate {
    var source: String
    init(_ source: String) { self.source = source }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { render(webView) }
    func webView(
      _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
      decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
      decisionHandler(
        navigationAction.navigationType == .other && navigationAction.request.url?.isFileURL == true
          ? .allow : .cancel)
    }
    func render(_ view: WKWebView) {
      let value = source
      Task { @MainActor in
        _ = try? await view.callAsyncJavaScript(
          "try { await renderDiagram(source) } catch { document.body.textContent = source }",
          arguments: ["source": value], in: nil, contentWorld: .page)
      }
    }
  }
}

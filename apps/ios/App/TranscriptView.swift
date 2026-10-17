import SwiftUI
import Textual
import UIKit
import ZuseCore

/// UIKit owns recycling and scroll position; SwiftUI only renders visible message cells.
struct TranscriptView: UIViewControllerRepresentable {
  let messages: [ChatMessage]
  let sessionID: String
  let rpc: RPCClient?
  var respond: ((ChatMessage, String) async throws -> Void)?
  func makeUIViewController(context: Context) -> TranscriptController { TranscriptController() }
  func updateUIViewController(_ controller: TranscriptController, context: Context) {
    controller.respond = respond
    controller.setConnection(rpc)
    controller.update(messages, sessionID: sessionID)
  }
}

@MainActor final class TranscriptController: UIViewController {
  var respond: ((ChatMessage, String) async throws -> Void)?
  private var rpc: RPCClient?
  private var connectionChanged = false
  func setConnection(_ value: RPCClient?) {
    if rpc !== value {
      rpc = value
      connectionChanged = true
    }
  }
  private var collection: UICollectionView!
  private var dataSource: UICollectionViewDiffableDataSource<Int, String>!
  private var rows: [String: ChatMessage] = [:]
  private var sessionID = ""
  private var applying = false
  private var queued: ([ChatMessage], String)?
  override func viewDidLoad() {
    super.viewDidLoad()
    var configuration = UICollectionLayoutListConfiguration(appearance: .plain)
    configuration.showsSeparators = false
    configuration.backgroundColor = .clear
    collection = UICollectionView(
      frame: .zero,
      collectionViewLayout: UICollectionViewCompositionalLayout.list(using: configuration))
    collection.accessibilityIdentifier = "chat-transcript"
    collection.backgroundColor = AppTheme.background
    collection.keyboardDismissMode = .interactive
    collection.allowsSelection = false
    collection.alwaysBounceVertical = true
    collection.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(collection)
    NSLayoutConstraint.activate([
      collection.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      collection.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      collection.topAnchor.constraint(equalTo: view.topAnchor),
      collection.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
    let registration = UICollectionView.CellRegistration<UICollectionViewListCell, String> {
      [weak self] cell, _, id in
      guard let row = self?.rows[id] else { return }
      cell.contentConfiguration = UIHostingConfiguration {
        MessageCell(
          message: row, rpc: self?.rpc,
          respond: self?.respond.map { callback in { text in try await callback(row, text) } })
      }.margins(
        .all, 0
      ).minSize(width: 0, height: 0)
      cell.backgroundConfiguration = .clear()
    }
    dataSource = UICollectionViewDiffableDataSource<Int, String>(collectionView: collection) {
      view, index, id in
      view.dequeueConfiguredReusableCell(using: registration, for: index, item: id)
    }
  }
  func update(_ messages: [ChatMessage], sessionID: String) {
    loadViewIfNeeded()
    if applying {
      queued = (messages, sessionID)
      return
    }
    let changedSession = self.sessionID != sessionID
    let prior = dataSource.snapshot().itemIdentifiers
    let incoming = messages.map(\.id)
    let changed = messages.filter { connectionChanged || rows[$0.id] != $0 }.map(\.id)
    connectionChanged = false
    guard changedSession || incoming != prior || !changed.isEmpty else { return }
    let atBottom =
      collection.contentSize.height - collection.bounds.maxY
      + collection.adjustedContentInset.bottom < 100
    let anchor = collection.indexPathsForVisibleItems.sorted().first
    let anchorID = anchor.flatMap { dataSource.itemIdentifier(for: $0) }
    let offset = anchor.flatMap { collection.layoutAttributesForItem(at: $0)?.frame.minY }.map {
      $0 - collection.contentOffset.y
    }
    self.sessionID = sessionID
    rows = Dictionary(uniqueKeysWithValues: messages.map { ($0.id, $0) })
    var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
    snapshot.appendSections([0])
    snapshot.appendItems(incoming)
    let existing = Set(prior)
    snapshot.reconfigureItems(changed.filter { existing.contains($0) })
    applying = true
    dataSource.apply(snapshot, animatingDifferences: false) { [weak self] in
      guard let self else { return }
      collection.layoutIfNeeded()
      if changedSession || atBottom, !incoming.isEmpty {
        scrollToLatest(sessionID: sessionID, remainingPasses: 3)
      } else if let anchorID, let offset, let path = dataSource.indexPath(for: anchorID),
        let attributes = collection.layoutAttributesForItem(at: path)
      {
        collection.contentOffset.y = attributes.frame.minY - offset
      }
      applying = false
      if let queued {
        self.queued = nil
        update(queued.0, sessionID: queued.1)
      }
    }
  }
  private func scrollToLatest(sessionID: String, remainingPasses: Int) {
    guard self.sessionID == sessionID, let last = dataSource.snapshot().itemIdentifiers.last,
      let path = dataSource.indexPath(for: last), !collection.isDragging, !collection.isDecelerating
    else { return }
    collection.layoutIfNeeded()
    collection.scrollToItem(at: path, at: .bottom, animated: false)
    if remainingPasses > 0 {
      DispatchQueue.main.async { [weak self] in
        self?.scrollToLatest(sessionID: sessionID, remainingPasses: remainingPasses - 1)
      }
    }
  }
}

struct MessageCell: View {
  let message: ChatMessage
  let rpc: RPCClient?
  var respond: ((String) async throws -> Void)?
  private var isUser: Bool { message.role == "user" }
  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      if ["assistant", "user", "user_rich"].contains(message.kind) {
        ChatMarkdown(text: message.text)
          .frame(maxWidth: .infinity, alignment: .leading)
        if message.kind == "user_rich", !message.content["attachments"].array.isEmpty {
          ForEach(Array(message.content["attachments"].array.enumerated()), id: \.offset) {
            _, reference in
            AttachmentView(reference: reference, sessionID: message.sessionId, rpc: rpc)
          }
        }
      } else {
        MessageDetails(message: message, respond: respond)
          .disclosureGroupStyle(TranscriptDisclosureStyle())
      }
    }
    .font(.subheadline)
    .padding(isUser ? 12 : 0)
    .background(
      isUser ? Color.secondary.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 16)
    )
    .padding(.horizontal, 16).padding(.vertical, isUser ? 8 : (message.kind == "assistant" ? 8 : 4))
    .contextMenu {
      Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
      ShareLink(item: message.text)
    }
  }
  private var title: String {
    message.content["tool"].string
      ?? message.kind.replacingOccurrences(of: "_", with: " ").capitalized
  }
  private var icon: String {
    message.kind == "thinking"
      ? "brain" : message.kind == "error" ? "exclamationmark.triangle" : "terminal"
  }
}

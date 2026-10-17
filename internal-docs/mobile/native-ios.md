# Native iPhone and iPad client

Open `apps/ios/Zuse.xcodeproj` and select the shared `Zuse` scheme. The new Swift app targets iOS/iPadOS 18+, uses `sh.zuse.native`, and disables Catalyst and running on Mac. The Electron desktop app and existing mobile app are independent.

## Implemented scope

- Home follows the existing mobile layout: compact header, project-grouped chats, bottom search/compose, and warm adaptive surfaces. Account, cloud providers, and computer management live in a dedicated Settings sheet.
- Adaptive SwiftUI navigation, searchable project/chat lists, native composer, interactive keyboard dismissal, selection, copying, sharing, Dynamic Type, photo/file pickers, camera QR scanning, and Quick Look attachment previews.
- A recycling UIKit collection view with stable message identities, selective cell updates, visible-row anchoring, bottom-follow behavior, and 100-message history pages. Tests exercise 10,000 messages on iPhone and iPad simulators.
- Textual 0.5.0 renders Markdown, code, tables, and math. Dedicated presentations cover reasoning, tools/results, errors, model changes, subagents, token/context usage, compaction, questions, and answers. Unknown content remains readable.
- Generated UI messages use the **shared** validated parser from `packages/utils/src/generative-ui.ts`, bundled into a private JavaScriptCore context. Rendering uses SwiftUI and Swift Charts, including forms, controls, charts, tables, flows, steps, and expandable tab sections. Explicit form submissions go through the durable outbox and retain duplicate-response protection across restarts.
- Mermaid diagrams use the repository's existing pinned library in an isolated, nonpersistent WebKit view. CSP blocks network requests; diagram text is passed as an argument, never evaluated as JavaScript. Strict library security, disabled navigation, size limits, source copying, and fullscreen expansion are enabled. Other chat UI does not use a WebView.
- AuthenticationServices WorkOS PKCE, state validation, coalesced token refresh, account-generation guards, and device-only Keychain credentials.
- Cloud chat catalog, workspace wake, gateway tickets/readiness, repository connection, workspace provisioning from provider/size catalogs, native agent sign-in and encrypted credential setup. Provisioning and repository retry identities survive process termination. Cloud model choices come from the shared catalog; connected runtimes supply their live model inventory.
- Account-linked computer discovery with P-256 DPoP proofs and a fresh connection grant on reconnect. Pairing links, QR codes, nearby Bonjour discovery, certificate pinning for nearby paired TLS connections, computer identity checks, and manual secure/private-network endpoints.
- Encrypted account-scoped catalog/history, drafts, attachment references, and outbox. Draft writes do not rewrite history. The archive keeps at most four decoded session records per workspace and releases inactive workspace caches. Sign-out retires open archive handles and removes account cache files.
- Exponential reconnect backoff, network/foreground recovery, durable-head heartbeat checks, epoch/gap detection, and visible connection errors. Queued messages send after synchronization; delivery-uncertain mutations require an explicit retry with the original command/message IDs.
- Chunked attachments use the shared 100 MB maximum and 2 MB chunk size. WebSocket frame limits accommodate the authenticated base64 attachment-read contract.
- Streamed working-tree, staged, and branch diffs show line numbers, binary changes, truncation, and per-file errors. Full working-copy text opens in a separate native sheet.

The `ZuseCore` package's macOS platform declaration enables host-side tests; it does not create a Mac app.

## Live configuration and verification boundaries

The WorkOS application must allow `zuse-native://auth` before live native sign-in can succeed. Public API/client configuration comes from `packages/contracts/src/deployment-profiles.json`. No credentials from the installed desktop/mobile apps are read.

Local tests do **not** establish production account access, provider execution, billing/provisioning success, camera operation, or physical-device LAN/peer connectivity. Those require an authenticated account and real hardware. App Store signing, entitlements, distribution, and push notification delivery are outside the validated simulator build. This project is not a published replacement for the existing app.

Nearby discovery enables peer-to-peer Bonjour, but direct hostname/TLS reachability on Apple peer interfaces still needs physical-device validation. Account-linked secure remote access and pairing links remain separate connection paths.

## Build and checks

```sh
# Swift behavior + local WebSocket integration (starts and cleans up its fixture)
bash apps/ios/scripts/test-rpc.sh

# Full simulator suite with local RPC fixture and ad-hoc signing
bash apps/ios/scripts/test-simulator.sh \
  'platform=iOS Simulator,name=iPhone 17 Pro'
bash apps/ios/scripts/test-simulator.sh \
  'platform=iOS Simulator,name=iPad Pro 13-inch (M5)'

swift format lint --strict --recursive \
  apps/ios/App apps/ios/Sources apps/ios/Tests apps/ios/UITests apps/ios/Package.swift
bunx biome check apps/ios/scripts packages/utils/src/generative-ui.ts \
  packages/utils/test/unit/generative-ui.test.ts
bun run --cwd packages/utils check-types
bun run --cwd packages/utils test:unit

xcodebuild -project apps/ios/Zuse.xcodeproj -scheme Zuse \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath apps/ios/DerivedData build
```

Use normal simulator ad-hoc signing for connected tests: `CODE_SIGNING_ALLOWED=NO` permits visual previews but prevents Keychain access in this environment. Simulator signing does not imply a signed physical-device or TestFlight build.

The UI suite covers project search and separate Settings navigation, expanding tool inputs/results, sending through a local RPC fixture, streamed diff review, generated charts/steps, offline Mermaid rendering, and scrolling the 10,000-message transcript. It does not measure FPS, sustained streaming throughput, or a physical-device memory budget.

Use `--native-preview --home-preview` to preview the project chat list with clearly labeled sample data.

The `--native-preview --conversation-preview` fixture includes user/assistant messages, reasoning, read/edit/run tool calls, expandable results, and the compact composer. Its tool output is sample data, not an executed agent run.

Debug preview arguments are `--native-preview --large-transcript`, `--native-preview --visual-preview`, and `--native-preview --diagram-preview`. They ignore saved account credentials and make no agent requests. The localhost-only `--rpc-fixture` launch path is compiled only in Debug.

## Reproducible project generation

With workspace dependencies installed, Bun and Ruby's `xcodeproj` gem (validated with 1.27.0):

```sh
ruby apps/ios/scripts/generate-project.rb
```

Generation copies the canonical model catalog, builds the shared UI parser, copies the existing Mermaid distribution/license, and includes native source/resources/tests. The generated Xcode project, resources, and Swift package lockfile are retained so Xcode can build without Bun/Ruby. Biome excludes generated bundles and native build output; hand-authored scripts and shared parser changes remain checked.

## Library decisions

[Textual](https://github.com/gonzalezreal/textual) provides native structured text, selection, math, and code rendering. [ChatLayout](https://github.com/ekazaev/ChatLayout) was evaluated; UIKit's compositional list layout currently owns recycling and anchoring. Hardware profiling should determine whether a specialized layout is warranted. Generated visuals reuse the repository's OpenUI grammar and Mermaid dependency instead of introducing competing message formats.

# Native Apple clients

`apps/ios/Zuse.xcodeproj` contains the new Swift clients for macOS 15+ and iOS/iPadOS 18+. Choose **ZuseMac** for the Mac app or **Zuse** for iPhone/iPad. Both install as **Zuse Native**, independently of the existing Electron and React Native apps. Shared client behavior lives in `ZuseCore`; the existing Zuse server remains the execution engine.

## Implementation

- Shared compact SwiftUI navigation, warm adaptive surfaces, project-grouped chats, and a rounded composer with attachments, model selection, and send/stop controls. macOS adds native window sizing, app menus, keyboard shortcuts, clipboard, authentication windows, and Quick Look. iPad keeps its sidebar and constrains conversation width; changes open in an inspector alongside the conversation on wider layouts.
- iPhone/iPad transcripts use a recycling UIKit collection view with stable identities, selective updates, reading-position anchoring, and bottom following. macOS uses a recycling AppKit table with SwiftUI message cells, reading-position anchoring, and bottom following. History loads in 100-message pages. Cached and streamed duplicate IDs resolve to one row with the latest content.
- Textual 0.5.0 renders Markdown, code, tables, and math. Dedicated native views handle reasoning, tools/results, errors, model changes, subagents, usage, compaction, questions, and approvals. Unknown content remains readable. Generated UI reuses the shared validated parser in JavaScriptCore and renders with SwiftUI/Charts. Mermaid uses the existing pinned library in an isolated nonpersistent WebKit view; ordinary chat does not use a WebView.
- Project catalogs load with at most three concurrent requests. A failed project load preserves its existing rows. New chat selects a saved/account-linked computer, project, agent, model, permission/plan mode, and main checkout, fresh worktree, existing branch, or existing worktree. Projects can be added by browsing the connected computer's filesystem.
- Chat creation persists operation/chat/session identities in Keychain. Retries reuse the original payload. A branch checkout with an uncertain result requires choosing its existing worktree, because the legacy checkout API has no idempotency key. Cloud launch retries likewise preserve and lock their saved payload.
- WorkOS authentication uses AuthenticationServices, PKCE/state validation, coalesced token refresh, and account-generation guards. Account-linked connections use P-256 DPoP grants and verify the connected environment identity. Manual and paired computers support secure remote endpoints, local/private endpoints, Bonjour, QR pairing on iOS, certificate pinning, multiple saved profiles, and forgetting a profile. Credentials stay in device Keychain.
- Composer readiness and send/upload/history operations share session ownership in `ZuseCore`. Switching chats resets busy state and hides the previous attachments before restoration. Late completions cannot unlock or overwrite the next chat. File/photo selection binds to the exact selection, including leaving and returning to the same chat. Failed restoration exposes a retry and keeps send disabled.
- Computer access settings use the existing pairing APIs to generate fresh one-time links and native QR codes, list active paired devices, and revoke their access with confirmation. Invitations expire in the UI and leave memory when the screen closes. Account registrations remain a separate account-level list. Cancelling pairing or changing the active computer prevents a late redemption from switching connections; stopped Bonjour searches cannot repopulate the nearby list.
- Question answers and plan approvals persist their exact command/payload in separate encrypted records. Reopening an unresolved interaction restores its selected response; an unconfirmed delivery exposes an explicit retry of the original decision. Confirmed responses do not resend, and editing drafts does not rewrite the response records.
- Workspace restoration stores a saved-profile reference rather than a second copy of remote credentials. Forgetting an active saved connection disconnects it and clears matching restoration and legacy credential records. Earlier restoration records migrate to references.
- RPC requests return a bounded result stream before writing to the socket, so stalled writes cannot escape cancellation or timeout. Timed-out requests interrupt server work when the write completed; a stuck write retires the connection. Streams have a startup deadline that ends at their first chunk, preserving long-lived conversations. Buffer overflow fails explicitly, including a final reply that would exceed capacity.
- The last verified workspace and session restore after restart. Account-scoped encrypted catalogs/history, drafts, attachments, and outbox retain command identities and delivery uncertainty. Sign-out retires account archives. Reconnect uses bounded exponential backoff, foreground/network recovery, durable-head checks, and stream gap/epoch detection. Missing last-opened sessions return to the catalog. Identity, access, authentication, and protocol failures require user action.
- Cloud support includes active and archived catalogs, pause/resume/archive/restore actions with durable command identities, gateway readiness, repository connection, provider/size selection, base branches, provisioning, agent sign-in, provider-account credentials, registered-device management, and cloud workspace preferences. Automatic reconnect respects a paused workspace; only an explicit open can request a wake. Transitional catalog entries refresh with bounded retry delays. Availability, provisioning, usage, and billing remain governed by the existing backend.
- Cloud agent settings derive supported agents, credential methods, and interactive login providers from shared contracts. They support custom HTTPS endpoints, cloud agent disconnect, saved in-progress device login, and retry after transient polling failures. Clients and saved operations bind to the account generation that opened their view, preventing stale screens from submitting with a replacement account.
- Settings reuse a generated schema from `SettingsPatch` and `WorkspaceSettingsValues`, including nested native editors, custom ACP provider entries, optional override removal, and editable provider IDs alongside built-in choices. Computer writes send changed top-level fields and check for intervening changes; cloud writes use the server's revision check. Cloud fields can return to their inherited defaults. Device appearance remains local.
- macOS Serve settings run the installed `zuse` executable using literal process arguments, with bounded output, cancellation, and a deadline that covers ignored termination and inherited output pipes. The runner uses direct child-process status rather than waiting for output EOF; only the launched command is terminated, and unrelated app descriptors are excluded from inheritance. It exposes status/start/stop, LAN and Tailscale options, and pairing from the running service's reported data directory. Startup preserves the existing CLI-owned host, port, account and SSH options unless the user explicitly changes local sharing. Commands target the reported data directory, and configuration/bootstrap reads are bounded and do not rewrite those files. No runtime database is initialized or moved by the native client. The CLI remains a prerequisite for local execution; cloud and remote usage do not require it. Mobile shows the corresponding host setup commands and accepts its pairing link.
- Attachments retain the shared 100 MB limit and 2 MB chunks. Working-tree, staged, and branch diffs include line numbers, binary/truncated results, errors, and native working-copy file viewing. Diff source lines are individual recycled rows rather than a single oversized patch view.

## Validation status

**Mac and iOS native builds passed on Xcode 26.6 on 2026-10-18. All 92 Apple core/WebSocket tests and all eight iPhone simulator UI tests passed. All eight iPad simulator UI tests passed; Mac UI validation is in progress; live account/device workflows, visual comparison, and sustained performance remain pending.** Mac access has resumed.

Cloud checks run the real portable Swift sources and tests, including large-history ordering/deduplication, stream gaps, structured RPC errors, bounded catalog concurrency, saved connections, creation identities, settings patches, and encrypted archive recovery. On Linux, the archive tests use Apple's pinned Swift Crypto 4.0.0 implementation; the shipping Apple app uses system CryptoKit. HTTP fixtures also verify explicit paused-workspace wake, reconnect that respects pause, lifecycle command identity, archived catalog selection, ready-workspace reads, actionable access errors, retired-account request rejection, and credential origin checks. Authorization tests validate PKCE parameters and reject mismatched, ambiguous, and malformed callbacks. Session-operation tests cover stale restoration and completion ownership. Archive tests cover composer separation after restart, cancellation before obsolete draft/checkpoint writes, and a transcript confirmation racing an offline-queue send. Background transcript checkpoints remain cancellable until their writes finish and coalesce changes received during an in-flight save. Portable subprocess tests execute harmless fixture commands to verify literal arguments, bounded capture, redacted failures, descriptor isolation, timeout escalation, cancellation, and inherited-pipe handling. They do not start, stop, or validate an installed Zuse service. Pairing models verify expiry/code consistency, secure link handling, and revocation metadata; native QR rendering and real device redemption still need Apple validation. These are mocked API responses, not production cloud execution. The portable harness runs the real RPC actor against deterministic in-memory socket I/O. It verifies out-of-order request routing, consumer cancellation and server interruption, unknown mutation outcomes on timeout, stalled socket writes, initial stream deadlines, established long-lived streams, gateway reset/readiness, incompatible handshakes, buffer overflow, socket failure, and chunked attachment round trips. Production serialization, timers, buffering, and request ownership run unchanged; the fixture replaces only socket I/O. The subsequent Mac run passed real URLSessionWebSocketTask round trips as part of the 92-test Apple suite.

Shared TypeScript utility behavior tests and type checking, native script type checking, Biome, Swift formatting, generated-schema freshness, and Xcode source/resource membership checks are separate from Apple UI validation. The 2026-10-17 cloud run passed 86 portable Swift tests and 131 shared utility tests (one utility test skipped), plus the applicable type, formatting, Biome, schema, architecture, and project checks. Test fixtures are Debug-only, use ephemeral archives, and skip saved credentials and automatic workspace restoration.

Native sign-in reuses the existing mobile callback `zuse://auth` through AuthenticationServices; no global URL handler is registered by the native targets. [Apple documents that only the initiating session receives its callback even when another app registers the same scheme](https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession). A public, unauthenticated authorization probe on 2026-10-17 confirmed that production WorkOS accepts this callback and redirects to AuthKit; the originally proposed `zuse-native://auth` was rejected and is no longer used. This verifies callback configuration only: interactive sign-in and token exchange still need authenticated Apple validation. Public client/API configuration is copied from `packages/contracts/src/deployment-profiles.json`. Production account access, provider execution/billing, camera access, LAN/peer reachability, and Tailscale access need an authenticated account and appropriate hardware. No credentials from the installed desktop or mobile app are imported. Distribution entitlements, signing, TestFlight/App Store submission, and push notifications require separate release work.

## Checks and builds

For the complete automated Mac/iPhone/iPad run with preserved logs and UI result bundles, use `bash apps/ios/scripts/validate-apple.sh` on macOS. The [acceptance audit](native-apple-validation.md) separates current implementation evidence from the Apple, live-account/device, visual, and performance gates that are still open.

```sh
# Applicable checks for the current platform, including script types.
# Linux requires Swift 6+, Ruby with xcodeproj, Bun, and a C++ toolchain for Swift Crypto.
bash apps/ios/scripts/check.sh
bun run --cwd apps/ios check-types
bun run --cwd packages/utils check-types
bun run --cwd packages/utils test:unit

# macOS: full CryptoKit/core tests and local WebSocket integration
bash apps/ios/scripts/test-rpc.sh

# macOS: native Mac UI tests with ad-hoc signing
xcodebuild -project apps/ios/Zuse.xcodeproj -scheme ZuseMac \
  -destination 'platform=macOS' -derivedDataPath apps/ios/DerivedData \
  CODE_SIGNING_ALLOWED=YES test

# macOS: iPhone and iPad UI suites, each with a local RPC fixture
bash apps/ios/scripts/test-simulator.sh \
  'platform=iOS Simulator,name=iPhone 17 Pro'
bash apps/ios/scripts/test-simulator.sh \
  'platform=iOS Simulator,name=iPad Pro 13-inch (M5)'
```

`check.sh` performs unsigned Mac and generic iOS simulator builds on macOS; Linux runs both syntax parsers and the portable behavior suite. Signed UI tests are separate: `CODE_SIGNING_ALLOWED=NO` is suitable for compilation but does not validate Keychain access.

The UI suites cover compact composition, project search, Settings navigation, tool expansion, the 10,000-message transcript, generated visuals, offline diagrams, fixture send/diffs, native chat creation, and Mac keyboard navigation. They do not establish sustained throughput, FPS, physical-device memory budgets, or live cloud execution.

## Project generation and previews

With workspace dependencies, Bun, Ruby, and `xcodeproj` installed:

```sh
ruby apps/ios/scripts/generate-project.rb
# Source membership only, retaining committed parser/catalog/diagram/schema resources:
ruby apps/ios/scripts/generate-project.rb --use-bundled-resources
```

Generation copies the shared model catalog, builds the shared generated-UI parser, derives native settings metadata from the RPC schemas, copies the existing Mermaid distribution/license, and creates both app/UI-test targets and schemes. The committed Xcode project, bundles, schema, and Swift package lockfile let Xcode build without Bun or Ruby. Biome excludes generated bundles and native build output; authored scripts remain checked.

Debug launch arguments: `--native-preview --home-preview`, `--native-preview --conversation-preview`, `--native-preview --large-transcript`, `--native-preview --visual-preview`, and `--native-preview --diagram-preview`. They are offline fixtures, not executed agent work. `--rpc-fixture` accepts only a localhost fixture endpoint and is compiled only in Debug.

## Library research

[Textual](https://github.com/gonzalezreal/textual) supplies native structured text, selection, math, and code rendering. [Zeron's iOS transcript](https://github.com/zeronsh/zeron/blob/main/apps/ios/Zeron/Transcript/TranscriptListView.swift) was inspected: it realizes reusable viewport rows and explicitly tracks anchoring and bottom following over a Rust layout engine. Zuse retains its own server protocol and existing recycler rather than importing that engine. [ChatLayout](https://github.com/ekazaev/ChatLayout) and [SwiftStreamingMarkdown](https://github.com/microsoft/SwiftStreamingMarkdown) are reference candidates for later hardware profiling; no additional production rendering dependency was added without measurements.

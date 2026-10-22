# Native Apple acceptance audit

The implementation is on `swarajbachu/zuse-swift-rewrite`, imported from `combee` and extended in `apps/ios`. This audit preserves the original feature scope. Source wiring and portable tests establish implementation evidence; they do not establish Apple build, UI, or production workflow acceptance.

Mac access resumed on 2026-10-18. Xcode 26.6 successfully built both native targets. All 92 Apple core/WebSocket tests and all eight iPhone simulator UI tests passed. Mac UI automation is now enabled with user approval; All eight iPad simulator UI tests also passed; Mac UI acceptance is in progress. Live account workflows, service integration, physical-device connectivity, visual comparison, and sustained performance remain open.

## Requirement evidence

| Requirement | Current evidence | Evidence still required |
| --- | --- | --- |
| Native macOS, iPhone, and iPad project | `Zuse` and `ZuseMac` targets, shared `ZuseCore`, project/resource membership checks | Mac and iOS builds passed; finish Mac/iPad UI acceptance and physical-device launch |
| Native integration works cleanly | AppKit/UIKit clipboard, image/attachment previews, AuthenticationServices, PhotosPicker, file import, camera/Bonjour integration, Mac menus and shortcuts | Run each integration, including denied permissions, cancellation, background/foreground, and window resizing |
| Large chat histories render correctly and smoothly | UIKit recycler; AppKit table; stable transcript IDs; 10,000-message portable fixtures; pagination and stream-gap tests; UI suites authored | Execute both native recyclers, check reading-position retention and bottom following, and measure sustained streaming, frame pacing, and memory on target hardware |
| Existing compact visual language and composer | Shared composer, rounded surfaces, model/attachment/send-stop controls, 28-point settings controls | Side-by-side comparison with the existing app; light/dark appearance, long draft, multiline text, keyboard, attachment and error states |
| Cloud support and recovery | Contract-backed launch/catalog/lifecycle/provider settings, account-bound clients, saved operation IDs, mocked HTTP recovery tests | WorkOS sign-in/token refresh, real provisioning, agent authentication/execution, pause/resume/archive/restore, account switch, and restart/reconnect on an existing workspace |
| Remote and local computers | Saved profiles, DPoP account grants, validated endpoints, certificate pinning, restoration references | Real account-linked connection, manual connection, identity mismatch, token revocation, offline recovery, and switching computers during in-flight work |
| Diffs | Working-tree/staged/branch patch streams; recycled source rows; line-number parser tests; file viewer | Real repository changes, renamed/deleted/binary/truncated files, large patches, switching scopes, and file-viewer behavior |
| Device/project/branch selection and new chat | Native selectors, bounded catalog requests, durable creation IDs, branch/worktree policies; fixture UI flows authored | Execute every selection path, multi-project catalog failures, uncertain branch checkout, and relaunch during creation without duplicate chats |
| Settings and connected devices | Generated settings metadata; custom ACP entries; nested override removal; cloud preferences; account registrations; paired-device list/revoke and fresh QR invitations | Save/reload from real servers, concurrent-edit conflicts, required/optional values, device revocation, and QR expiry/redeem on another device |
| Zuse Serve and Tailscale | CLI status/start/stop; literal subprocess arguments; cancellation/deadline tests; existing CLI options/data directory retained; bounded read-only bootstrap/configuration access | Installed CLI/service lifecycle, browser account authorization, LAN and tailnet routing, actual service data preservation, and service failures on macOS |
| Dedicated clean iPad layout | Balanced split view, readable conversation width, changes inspector, adaptive compact navigation | iPad portrait/landscape, split-screen widths, sidebar/inspector coexistence, hardware/software keyboards, and touch targets |
| Shared behavior and failure predictability | Shared contracts, model catalog, generated parser/settings resources; 86 portable Swift tests and 131 shared utility tests passed (one utility test skipped) | 92 Apple core/socket tests and eight signed iPhone UI tests passed; Mac/iPad UI, hardware performance, and production recovery remain open |

The portable RPC suite runs the actual RPC actor with in-memory socket I/O. It proves request ownership, cancellation, timeouts, gateway transitions, backpressure, and attachment chunk behavior in that environment. A separate Apple run passed all 92 core tests, including CryptoKit/Security coverage and real URLSession WebSocket round trips. Production service interoperability still needs live validation.

## Current Mac regression

The original SwiftUI List failed the 10,000-message latest-row assertion and reached roughly 2 GB during broad accessibility snapshots. The replacement AppKit table builds successfully, estimates offscreen heights, measures hosted rows on demand, and preserves a reading anchor. Settings passed in subsequent runs. The large-history test still failed with the original whole-app text query; a scoped last-row query now also asserts visibility. Its final retry is unconfirmed because the Mac command connection stopped responding. Do not consider Mac chat acceptance complete. Artifacts from this investigation are under `.context/apple-validation/` on the Mac; `mac-ui-6.xcresult` is the latest confirmed failure, and `mac-ui-7` may have started but its launch/result must be checked before retrying.

## Automated Mac run

On the Mac, from the repository root, with workspace Bun dependencies, full Xcode selected, installed iOS 18+ iPhone/iPad simulators, and Ruby's `xcodeproj` gem:

```sh
bash apps/ios/scripts/validate-apple.sh
```

This runs formatting, generated metadata/project checks, native script types/Biome, real Apple core/socket tests, unsigned Mac/iOS builds, and signed Mac/iPhone/iPad UI suites. It stops on the first failure and preserves command logs and each UI `.xcresult` under `.context/native-apple-validation/<run>/`. Open those bundles in Xcode to inspect UI screenshots and failures. The script selects available simulators; override destinations with `ZUSE_IPHONE_DESTINATION` and `ZUSE_IPAD_DESTINATION` when needed. `ZUSE_APPLE_VALIDATION_DIR` selects a different result directory; use a fresh directory for each run.

A passing automated run does not close the live-device, visual-fidelity, or performance gates below. Do not replace a failing Apple gate with Linux syntax parsing or preview screenshots.

## Live validation pass

Use existing accounts and a computer with an existing repository and chat history. Preserve its server data and existing service configuration.

1. Sign in, cancel sign-in, relaunch, refresh expired credentials, and switch accounts. Verify no previous-account catalog, credential submission, draft, or archive appears in the new account.
2. Connect an account-linked computer and a separately paired computer. Generate a QR invitation, redeem it on iPhone/iPad, check expiry, revoke the resulting device, and verify access is removed after reconnect. Repeat with manual local and Tailscale endpoints and with Local Network/camera access denied.
3. Start/stop/refresh Serve using the installed CLI. Verify the reported data directory and existing chats stay intact, existing host/port/account choices survive, explicit LAN changes take effect, and failed/slow commands leave an actionable state. Test actual tailnet HTTPS routing from the mobile device.
4. Create chats in the main checkout, a fresh worktree, an existing branch, and an existing worktree. Choose different agents/models and projects. Interrupt connectivity during creation; relaunch and retry the saved operation without creating duplicates.
5. Stream a real agent response with Markdown/code/tables/math, tools, reasoning, questions/approvals, attachments, diagrams and generated visuals. Exercise send/stop, cancelled import, retry, and invalid or unsupported output. Reopen an unresolved interaction after restart and verify its exact saved decision is reused.
6. Load at least the authored 10,000-message fixture on Mac, iPhone, and iPad, then test a real large history with pagination and sustained streaming. Read earlier messages while output continues, load older history, return to Latest, switch chats during uploads/sends, and background/restore. Record frame pacing and peak memory; visible stalls or lost reading position leave this gate open.
7. Review working-tree, staged, and branch changes in a real repository, including large, binary, renamed, deleted, and truncated patches. Switch scopes during loading and inspect the working-copy file.
8. Compare the native app with the current Zuse UI in light/dark mode. Capture composer states and compact settings; check iPad portrait/landscape, narrow split-screen, sidebar and inspector behavior, Mac shortcuts, VoiceOver, and larger text sizes. Save screenshots under `.context/` with the test environment and scenario noted.

Record the actual result, artifact path, target device/OS, and remaining issue for each audit row. Mark the goal complete only when the full requested behavior is verified; missing or indirect evidence leaves its row open.

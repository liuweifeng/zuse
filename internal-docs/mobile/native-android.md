# Native Android client

`apps/android` is the Kotlin Android client, independent of the React Native app in `apps/mobile` and the Swift work on `combee`. Open it as a project in Android Studio. It targets Android 9+ (API 28), compiles against API 35, and requires JDK 21. It connects to the existing Zuse runtime and cloud control plane; it does not run the desktop server on the phone.

## Build and checks

Install Android SDK platform 35 and build tools 35.0.0. Set `ANDROID_HOME` or create the ignored `apps/android/local.properties` with `sdk.dir=/absolute/path/to/android-sdk`.

```sh
cd apps/android
./gradlew checkKotlinFormat :core:test :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease :app:assembleDebugAndroidTest :app:lintDebug
./gradlew :app:connectedDebugAndroidTest
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`. Release output is unsigned until a signing configuration is supplied. Kotlin uses the pinned ktfmt formatter (`./gradlew formatKotlin`); Biome does not support Kotlin. The repository Biome configuration excludes native generated build output. Native Android CI builds both variants, runs core tests, native Robolectric layout tests/screenshots and Android lint, and runs instrumented native UI tests on an accelerated API 35 emulator.

## Architecture and behavior

- `core` is a JVM-testable implementation of the existing protocol-7 Effect JSON RPC wire format: handshake, gateway readiness, chunks/acks, exit/failure, cancellation, bounded stream queues, and disconnect propagation. Connection instances own requests. Mutations are never automatically replayed.
- `Transcript` owns identity-indexed history and cursor validation. Missing versions, runtime epoch changes, reset frames, or failed synchronization force a fresh connection. Paged history preserves message identities. The Compose list uses stable message keys and content types; ordinary live message updates replace only the affected row. Markdown parsing runs off the UI thread.
- `WorkspaceViewModel` owns connection/session generations, foreground/network recovery, capped reconnect backoff, per-session drafts, attachment uploads, and the durable outbox. Drafts and generated-form fields use independent monotonic revisions; late saves cannot revive submitted values. Input hydration completes before editing is enabled, without waiting for large history loads. An attempted send is persisted before dispatch. Unknown outcomes require an explicit retry with the same command/message identities. Switching chats or computers fences late asynchronous results.
- `Vault` uses atomic AES-GCM files in `noBackupFilesDir`, authenticated with each record identity, and a non-exportable Android Keystore key. History, drafts, pending sends, credentials, and saved devices are encrypted. Accounts, organizations, workspaces, and sessions have distinct archive identities. Transcript history is stored separately from small draft/outbox metadata, so typing and sending do not serialize cached conversations. Storage operations acquire a shared lock before dispatching IO, preserving action order. Existing combined records migrate atomically while retaining the old history until its separate copy is validated. Damaged records surface an error rather than being silently replaced.
- `Account` uses the existing public WorkOS client configuration, browser authorization with PKCE/state, persisted one-time callback state, and serialized token refresh. `zuse://auth` matches the existing mobile redirect. Deployment URLs/client IDs come from `packages/contracts/src/deployment-profiles.json` at build time.
- Cloud catalog, linked computers, workspace gateway tickets, P-256 DPoP device grants, repository connection, provider/size selection, provisioning, cloud agent device sign-in, and encrypted credential setup use existing APIs. Workspace/repository request identities survive uncertain responses and process termination. Credentials are RSA-OAEP-SHA256 sealed to the cloud authority before upload. Provider billing and runtime initialization stay on the existing server paths.
- LAN and Tailscale connections use the same RPC client. Android's system VPN owns Tailscale routing. Cleartext is restricted in application code to loopback, private/link-local networks, and tailnet hosts; public endpoints require TLS. HTTP redirects are disabled for credential-bearing calls. Optional certificate pins match the existing SHA-256 certificate-DER format, including self-signed `zuse serve` endpoints.
- Native NSD discovers `_zuse._tcp` computers. Pairing supports pasted links, camera QR scanning, and nearby one-time codes; the selected computer certificate pin is shown before pairing. Saved computers can reconnect or be forgotten. Nearby discovery is scoped to the settings sheet and its resolve queue is serialized.

## UI

The app follows Zuse's warm neutral surfaces, green accent, compact header, chat/project/device selectors, and rounded composer. Settings use 28dp visible input/action surfaces with larger native interaction rows. Material 3 Adaptive supplies list/detail navigation that responds to window size and separating folds; phones show one pane, and larger windows can retain the chat list beside the conversation. Native keyboard/insets, file picking, QR scanning, selectable text, attachment opening through a scoped FileProvider, and system dark mode are supported.

Messages render selectable native Markdown (including fenced code, tables, and bounded `$$` block/inline math), user attachments, collapsible thinking/tools/results, errors, usage/context/compaction, model changes, subagent summaries/progress, permission prompts, questions, and plan approvals. Unknown content remains readable as text/JSON. The transcript supports earlier-history pages and a jump-to-latest control. Diffs stream by file for working tree, staged, and branch scopes, with line numbers, binary/truncation/error states, and working-copy file views.

Model options come from the runtime's live catalog. Cloud creation uses the same generated catalog as the other clients, copied into build assets from `apps/web/public/models/v1.json`; no second model list is maintained.

## Validation boundaries

JVM tests exercise 10,000-message history merging, transcript version/epoch fences, LAN/Tailscale validation, diff line numbering, real local WebSocket handshake/acks/cancellation/disconnect (including cancellation racing late frames), archive migration, out-of-order draft/form saves, TLS cloud origin/redirect restrictions, and RSA credential encryption. Native Robolectric tests render the real application in phone, tablet, and dark configurations, assert compact settings and large-transcript navigation, render generated charts/forms (including edited typed-value submission and restoration after row recreation) and native math, and save PNGs under `apps/android/app/build/screenshots`. Android instrumentation covers the large transcript/composer, an actual local fixture connection/send through the native UI, isolated parser evaluation, and encrypted archive migration. In the cloud workspace, JVM/core/layout tests and debug/release builds passed; instrumented device tests compiled, but the unaccelerated emulator did not complete startup reliably. Physical device and live-account checks remain pending.

A successful build or synthetic 10,000-message test does not establish physical-device FPS, memory use, fold posture behavior, or authenticated production integration. WorkOS callback registration, real account billing/provisioning, physical LAN discovery/pinning, Tailscale routing, camera hardware, and sustained streaming need device/account validation. No live workspaces are provisioned by automated tests.

Generated `ui_spec` blocks use the existing shared OpenUI validator/parser, bundled by `bun apps/android/scripts/generate-assets.mjs`. AndroidX JavaScriptSandbox runs that parser in a DOM-less isolated process with a 64 MB heap cap, input/result size limits, serialized evaluation, timeouts, and native depth/node bounds. It has no Android, credential, or network bridge. All 24 component types are rendered as native Compose views: cards, text, stats, key/value and tables, progress, badges/callouts, lists/grids, three chart types, steps/flows/tabs, follow-ups, and form inputs. Explicit responses enter the encrypted durable outbox; response identities prevent repeat submissions across restarts. Unsupported/older WebView engines retain a readable source fallback.

Mermaid fenced blocks use the repository's pinned 11.15.0 distribution in the app's only WebView surface. CSP, strict Mermaid settings, source/edge limits, disabled file/content access and storage, blocked navigation, and an intercept-only resource client prevent diagram content from fetching network resources or calling native code. Themes, source copying, and fullscreen expansion are supported. Offline browser verification rendered an SVG from only the bundled script and confirmed that diagram directives cannot override strict security or edge limits. Native WebView process integration remains an instrumented-device check.

Terminal emulation, push notifications, and desktop-only settings are outside the current chat/cloud/remote/diff scope.

Debug-only visual fixtures are available with `adb shell am start -a android.intent.action.VIEW -d 'zuse://preview' sh.zuse.android` and `zuse://preview?large=true`. They are labeled sample data and do not submit agent requests. The debug RPC fixture entry accepts only a loopback address; neither debug route activates in a release build.

## Regenerating rich-content assets

With filtered or full workspace Bun dependencies installed:

```sh
bun apps/android/scripts/generate-assets.mjs
```

Generated parser/Mermaid bundles, provenance, notices, and the debug-only visual fixture are committed so Android Studio builds do not require Bun. Native CI regenerates them and rejects drift from the canonical parser or pinned Mermaid version. Hand-authored build/bridge scripts and shared parser changes are checked with Biome and the utils type/test suite.

## References

- Swift implementation reference: `combee` at `4cc7aa2bb7d6529dbffa1c2ddf931868cbbdabc1`.
- [Zeron Chat](https://github.com/zeronsh/chat) was evaluated as a UX reference. It uses React/TanStack/Zero and is not an Android rendering dependency.
- [Compose lazy lists](https://developer.android.com/develop/ui/compose/lists) provide lazy row composition and stable identities.
- [Compose adaptive apps](https://developer.android.com/develop/ui/compose/build-adaptive-apps) supplies native multi-pane/fold-aware navigation.
- [Markwon](https://github.com/noties/Markwon) supplies native TextView Markdown rendering; [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded) supplies camera QR scanning.

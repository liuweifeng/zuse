import SwiftUI
import ZuseCore

struct CloudSettingsView: View {
  let workspace: WorkspaceModel
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var status: JSONValue = .null
  @State private var operation: JSONValue = .null
  @State private var busy = false
  @State private var credential = ""
  @State private var credentialProvider = "claude"
  @State private var credentialMethod = "api-key"
  @State private var failure: String?
  var body: some View {
    NavigationStack {
      Form {
        if let failure { Text(failure).foregroundStyle(.red) }
        Section("Cloud agents") {
          ForEach(status["providers"].array, id: \.["providerId"].string) { row in
            LabeledContent(row["providerId"].string?.capitalized ?? "Agent") {
              Text(row["accountLabel"].string ?? row["state"].string ?? "Unknown").foregroundStyle(
                .secondary)
            }
          }
          Button("Sign in to Codex") { Task { await start("codex") } }.disabled(busy)
          Button("Sign in to Grok") { Task { await start("grok") } }.disabled(busy)
        }
        Section("Connect with a credential") {
          Picker("Agent", selection: $credentialProvider) {
            ForEach(["claude", "codex", "cursor", "grok"], id: \.self) {
              Text($0.capitalized).tag($0)
            }
          }
          Picker("Authentication", selection: $credentialMethod) {
            Text("API key").tag("api-key")
            Text("Subscription token").tag("subscription")
          }
          SecureField("Credential", text: $credential).textInputAutocapitalization(.never)
            .autocorrectionDisabled()
          Button("Connect agent") { Task { await configure() } }.disabled(
            busy || credential.isEmpty)
          Text("Encrypted on this device for your cloud authentication service.").font(.caption)
            .foregroundStyle(.secondary)
        }
        if operation["state"].string == "authorizing" {
          Section("Finish signing in") {
            if let code = operation["verificationCode"].string {
              LabeledContent("Code", value: code).textSelection(.enabled)
              Button("Copy code", systemImage: "doc.on.doc") { UIPasteboard.general.string = code }
            }
            if let address = operation["verificationUrl"].string, let url = URL(string: address),
              url.scheme == "https"
            {
              Button("Open sign-in page", systemImage: "arrow.up.right.square") { openURL(url) }
            }
            ProgressView("Waiting for sign-in…")
            Button("Cancel sign-in", role: .cancel) { Task { await cancel() } }
          }
        }
        Section {
          Text(
            "Existing cloud agent credentials are shared with your other Zuse clients. Creating the cloud authentication service uses your account's configured provider."
          ).font(.caption).foregroundStyle(.secondary)
        }
      }.navigationTitle("Cloud settings").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        .task { await refresh() }
        .onDisappear { credential = "" }
        .task(id: operation["operationId"].string) {
          guard let id = operation["operationId"].string else { return }
          do {
            while operation["state"].string == "authorizing" {
              try await Task.sleep(for: .seconds(3))
              operation = try await workspace.cloud.request("/v1/cloud/auth/login/" + encoded(id))
            }
            if operation["state"].string == "error" {
              failure = operation["errorCode"].string ?? "Agent sign-in failed."
            }
            await refresh()
          } catch is CancellationError {} catch { failure = error.localizedDescription }
        }
    }
  }
  private func encoded(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
  }
  private func refresh() async {
    do { status = try await workspace.cloud.request("/v1/cloud/auth") } catch {
      failure = error.localizedDescription
    }
  }
  private func start(_ provider: String) async {
    busy = true
    failure = nil
    defer { busy = false }
    do {
      if status["authorityState"].string != "ready" {
        status = try await workspace.cloud.request(
          "/v1/cloud/auth/provision", method: "POST", body: .object([:]))
      }
      operation = try await workspace.cloud.request(
        "/v1/cloud/auth/login/start", method: "POST",
        body: .object(["providerId": .string(provider)]))
    } catch { failure = error.localizedDescription }
  }
  private func configure() async {
    busy = true
    failure = nil
    defer { busy = false }
    do {
      if status["authorityState"].string != "ready" {
        status = try await workspace.cloud.request(
          "/v1/cloud/auth/provision", method: "POST", body: .object([:]))
      }
      guard let keyID = status["encryptionKeyId"].string,
        let jwk = status["encryptionPublicJwk"].string
      else { throw ClientError("Cloud authentication is still starting. Try again shortly.") }
      let sealed = try CloudSecret.seal(credential, publicJWK: jwk)
      _ = try await workspace.cloud.request(
        "/v1/cloud/auth/configure", method: "POST",
        body: .object([
          "providerId": .string(credentialProvider), "method": .string(credentialMethod),
          "sealedSecret": .object(["keyId": .string(keyID), "ciphertext": .string(sealed)]),
        ]))
      credential = ""
      await refresh()
    } catch { failure = error.localizedDescription }
  }
  private func cancel() async {
    guard let id = operation["operationId"].string else { return }
    do {
      _ = try await workspace.cloud.request(
        "/v1/cloud/auth/login/" + encoded(id) + "/cancel", method: "POST")
      operation = .null
      await refresh()
    } catch { failure = error.localizedDescription }
  }
}

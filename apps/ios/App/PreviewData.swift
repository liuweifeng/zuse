#if DEBUG
  import Foundation
  import ZuseCore

  extension WorkspaceModel {
    func loadPreview(selected: SessionRow? = nil) throws {
      let session =
        selected
        ?? SessionRow(
          id: "preview", projectId: "preview-project",
          title: ProcessInfo.processInfo.arguments.contains("--conversation-preview")
            ? "Compact composer" : "Native chat preview",
          providerId: "Preview", model: "preview", worktreeId: nil)
      selectedSession =
        ProcessInfo.processInfo.arguments.contains("--home-preview") && selected == nil
        ? nil : session
      sessions = [session]
      if ProcessInfo.processInfo.arguments.contains("--home-preview") {
        sessions = [
          "Polish the mobile navigation", "Review authentication changes", "Add workspace search",
          "Fix reconnect after sleep", "Simplify the chat composer",
        ].enumerated().map { index, title in
          SessionRow(
            id: "preview-\(index)", projectId: "preview-project", title: title,
            providerId: "Preview", model: "preview", worktreeId: nil)
        }
      }
      projects = [ProjectRow(id: "preview-project", name: "Zuse · Preview")]
      selectedProject = projects.first
      let count = ProcessInfo.processInfo.arguments.contains("--large-transcript") ? 10_000 : 30
      var messages: [JSONValue] = (0..<count).map { index in
        let user = index % 3 == 0
        let text =
          user
          ? "Review the changes for task \(index)."
          : """
          ### Task \(index)
          The implementation keeps **stable message identities** while history loads.

          ```swift
          let result = try await client.connect()
          ```

          | Check | Result |
          | --- | --- |
          | Transcript | Ready |

          Next, verify the updated behavior on iPhone and iPad.
          """
        return .object([
          "id": .string("preview-\(index)"), "sessionId": .string(session.id),
          "role": .string(user ? "user" : "assistant"),
          "content": .object(["_tag": .string(user ? "user" : "assistant"), "text": .string(text)]),
          "createdAt": .string("2026-10-18T00:00:00Z"),
        ])
      }
      if ProcessInfo.processInfo.arguments.contains("--conversation-preview")
        || (ProcessInfo.processInfo.arguments.contains("--home-preview") && selected != nil)
      {
        let contents: [JSONValue] = [
          .object([
            "_tag": .string("user"),
            "text": .string("Make the chat composer more compact and check the changes."),
          ]),
          .object([
            "_tag": .string("assistant"),
            "text": .string("I’ll tighten the spacing and keep the actions on one row."),
          ]),
          .object([
            "_tag": .string("thinking"),
            "text": .string(
              "Keep the input flexible while preserving accessible touch targets for attachments and send."
            ),
          ]),
          .object([
            "_tag": .string("tool_use"), "tool": .string("Read"), "id": .string("read-preview"),
            "input": .object(["file_path": .string("App/Composer.swift")]),
          ]),
          .object([
            "_tag": .string("tool_result"), "toolUseId": .string("read-preview"),
            "output": .string(
              "Composer.swift · 84 lines\nInput, attachment menu, model label, and send control."),
            "isError": .bool(false),
          ]),
          .object([
            "_tag": .string("tool_use"), "tool": .string("Edit"), "id": .string("edit-preview"),
            "input": .object([
              "file_path": .string("App/Composer.swift"), "old_string": .string("spacing: 16"),
              "new_string": .string("spacing: 8"),
            ]),
          ]),
          .object([
            "_tag": .string("tool_result"), "toolUseId": .string("edit-preview"),
            "output": .string("Updated spacing in Composer.swift."), "isError": .bool(false),
          ]),
          .object([
            "_tag": .string("tool_use"), "tool": .string("Run"), "id": .string("run-preview"),
            "input": .object(["command": .string("swift test")]),
          ]),
          .object([
            "_tag": .string("tool_result"), "toolUseId": .string("run-preview"),
            "output": .string(
              "Sample test output\n✓ Composer layout\n✓ Attachment actions\n✓ Send and stop states"),
            "isError": .bool(false),
          ]),
          .object([
            "_tag": .string("assistant"),
            "text": .string(
              "Updated the composer with a growing text area and a fixed action row.\n\n- Smaller send button, with a full touch target\n- Compact attachment and model controls\n- Less spacing between tool calls\n\n*This is a sample conversation for previewing the interface.*"
            ),
          ]),
        ]
        messages = contents.enumerated().map { index, content in
          .object([
            "id": .string("conversation-\(index)"), "sessionId": .string(session.id),
            "role": .string(index == 0 ? "user" : "assistant"), "content": content,
            "createdAt": .string("2026-10-18T00:00:00Z"),
          ])
        }
      }
      if ProcessInfo.processInfo.arguments.contains("--visual-preview") {
        messages = [
          .object([
            "id": .string("visual"), "sessionId": .string(session.id), "role": .string("assistant"),
            "content": .object([
              "_tag": .string("ui_spec"), "version": .number(1),
              "spec": .string(
                """
                summary = Stat("Completed tasks", "12", "Native rendering")
                chart = BarChart("Build checks", [{label: "Passed", value: 12}, {label: "Pending", value: 2}], "checks")
                root = Card([summary, chart, Steps([{label: "Review changes", status: "done"}, {label: "Run simulator", status: "active"}])], "Project overview")
                """),
            ]), "createdAt": .string("2026-10-18T00:00:00Z"),
          ])
        ]
      }
      if ProcessInfo.processInfo.arguments.contains("--diagram-preview") {
        messages = [
          .object([
            "id": .string("diagram"), "sessionId": .string(session.id),
            "role": .string("assistant"),
            "content": .object([
              "_tag": .string("assistant"),
              "text": .string(
                """
                ### Native diagram preview
                ```mermaid
                flowchart LR
                  A[Ready] --> B[Complete]
                ```
                """),
            ]), "createdAt": .string("2026-10-18T00:00:00Z"),
          ])
        ]
      }
      try transcript.apply(
        .object([
          "kind": .string("snapshot"), "sessionId": .string(session.id),
          "throughVersion": .number(0),
          "projection": .object(["messages": .array(messages), "status": .string("idle")]),
        ]), sessionID: session.id)
      connectionState = "Preview · offline"
    }
  }
#endif

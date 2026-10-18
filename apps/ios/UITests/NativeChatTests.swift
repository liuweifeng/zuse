import XCTest

final class NativeChatTests: XCTestCase {
  @MainActor func testConversationPreviewExpandsToolCalls() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--native-preview", "--conversation-preview"]
    app.launch()
    let transcript = app.collectionViews["chat-transcript"]
    XCTAssertTrue(transcript.waitForExistence(timeout: 15))
    let run = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "swift test"))
      .firstMatch
    if !run.exists { transcript.swipeDown() }
    XCTAssertTrue(run.waitForExistence(timeout: 5))
    run.tap()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", "command", "command")
      )
      .firstMatch
      .waitForExistence(timeout: 5))
    let result = app.buttons.matching(NSPredicate(format: "label == %@", "Completed"))
      .allElementsBoundByIndex.last
    XCTAssertNotNil(result)
    result?.tap()
    XCTAssertTrue(
      app.descendants(matching: .any).matching(
        NSPredicate(
          format: "label CONTAINS %@ OR value CONTAINS %@", "Sample test output",
          "Sample test output")
      ).firstMatch.waitForExistence(timeout: 5))
    let screenshot = XCTAttachment(screenshot: app.screenshot())
    screenshot.name = "Expanded tool call and composer"
    screenshot.lifetime = .keepAlways
    add(screenshot)
    XCTAssertTrue(app.textFields["chat-composer"].exists)
    XCTAssertFalse(app.buttons["Send message"].isEnabled)
  }

  @MainActor func testHomePreviewOpensConversation() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--native-preview", "--home-preview"]
    app.launch()
    let row = app.staticTexts["Polish the mobile navigation"]
    XCTAssertTrue(row.waitForExistence(timeout: 15))
    row.tap()
    XCTAssertTrue(app.collectionViews["chat-transcript"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Send message"].isEnabled)
  }

  @MainActor func testHomeKeepsSettingsSeparateAndSearchesChats() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--native-preview", "--home-preview"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Polish the mobile navigation"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["Sign in to Zuse"].exists)
    XCTAssertFalse(app.buttons["Connect a computer"].exists)
    let search = app.textFields["Search chats"]
    search.tap()
    search.typeText("authentication")
    XCTAssertTrue(app.staticTexts["Review authentication changes"].exists)
    XCTAssertFalse(app.staticTexts["Polish the mobile navigation"].exists)
    app.buttons["Clear search"].tap()
    app.buttons["Open settings"].tap()
    XCTAssertTrue(app.buttons["Sign in to Zuse"].waitForExistence(timeout: 5))
    app.buttons["Connect a computer"].tap()
    XCTAssertTrue(app.staticTexts["Nearby computers"].waitForExistence(timeout: 5))
  }

  @MainActor func testLargeTranscriptOpensAtLatestMessageAndScrolls() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--native-preview", "--large-transcript"]
    app.launch()
    XCTAssertTrue(
      app.staticTexts["Review the changes for task 9999."].waitForExistence(timeout: 20))
    let transcript = app.collectionViews["chat-transcript"]
    XCTAssertTrue(transcript.exists)
    transcript.swipeDown()
    transcript.swipeDown()
    XCTAssertTrue(app.textFields["chat-composer"].exists)
    XCTAssertFalse(app.buttons["Send message"].isEnabled)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Native transcript"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  @MainActor func testGeneratedVisualRendersNatively() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--native-preview", "--visual-preview"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Project overview"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["Completed tasks"].exists)
    XCTAssertTrue(app.staticTexts["Build checks"].exists)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Native visual"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  @MainActor func testConnectedChatSendsAndShowsDiff() throws {
    guard let url = ProcessInfo.processInfo.environment["ZUSE_IOS_FIXTURE_URL"] else {
      throw XCTSkip("Run scripts/test-simulator.sh to start the local RPC fixture.")
    }
    let app = XCUIApplication()
    app.launchArguments = ["--rpc-fixture"]
    app.launchEnvironment["ZUSE_IOS_FIXTURE_URL"] = url
    app.launch()
    let chat = app.buttons["Fixture conversation"]
    if chat.waitForExistence(timeout: 10) {
      chat.tap()
    } else {
      let link = app.staticTexts["Fixture conversation"].firstMatch
      XCTAssertTrue(link.waitForExistence(timeout: 10))
      link.tap()
    }
    XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 15))
    let composer = app.textFields["chat-composer"]
    composer.tap()
    composer.typeText("Hello from native UI")
    app.buttons["Send message"].tap()
    XCTAssertTrue(app.staticTexts["Received: Hello from native UI"].waitForExistence(timeout: 10))
    app.buttons["Changes"].tap()
    XCTAssertTrue(app.staticTexts["example.swift"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["+let value = 2"].exists)
  }
  @MainActor func testDiagramRendersOffline() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--native-preview", "--diagram-preview"]
    app.launch()
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 15))
    XCTAssertTrue(app.webViews.staticTexts["Complete"].waitForExistence(timeout: 15))
    XCTAssertTrue(app.buttons["Expand diagram"].exists)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Offline diagram"
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  @MainActor func testConnectedNewChatCreatesAndSendsWithNativeComposer() throws {
    guard let url = ProcessInfo.processInfo.environment["ZUSE_IOS_FIXTURE_URL"] else {
      throw XCTSkip("Run scripts/test-simulator.sh to start the local RPC fixture.")
    }
    let app = XCUIApplication()
    app.launchArguments = ["--rpc-fixture"]
    app.launchEnvironment["ZUSE_IOS_FIXTURE_URL"] = url
    app.launch()
    XCTAssertTrue(app.staticTexts["Fixture conversation"].firstMatch.waitForExistence(timeout: 15))
    app.buttons["New chat"].tap()
    app.buttons["On your computer"].tap()
    let create = app.buttons["new-chat-create"]
    XCTAssertTrue(create.waitForExistence(timeout: 10))
    let ready = expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: create)
    wait(for: [ready], timeout: 10)
    create.tap()
    let composer = app.textFields["chat-composer"]
    XCTAssertTrue(composer.waitForExistence(timeout: 15))
    composer.tap()
    composer.typeText("A fresh native chat")
    app.buttons["Send message"].tap()
    XCTAssertTrue(app.staticTexts["Received: A fresh native chat"].waitForExistence(timeout: 10))
  }

}

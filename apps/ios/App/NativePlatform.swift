import SwiftUI

#if os(macOS)
  import AppKit
#else
  import UIKit
#endif

#if os(macOS)
  typealias NativeImage = NSImage
#else
  typealias NativeImage = UIImage
#endif

@MainActor enum NativePlatform {
  static var deviceName: String {
    #if os(macOS)
      Host.current().localizedName ?? "Mac"
    #else
      UIDevice.current.name
    #endif
  }
  static func copy(_ text: String) {
    #if os(macOS)
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(text, forType: .string)
    #else
      UIPasteboard.general.string = text
    #endif
  }
}

@MainActor enum AppTheme {
  #if os(macOS)
    static let background = NSColor(name: nil) { appearance in
      appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(white: 0.06, alpha: 1)
        : NSColor(red: 247 / 255, green: 247 / 255, blue: 245 / 255, alpha: 1)
    }
    static let surface = Color(nsColor: background)
    static let accent = Color(
      nsColor: NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
          ? NSColor(red: 0.55, green: 0.79, blue: 0.13, alpha: 1)
          : NSColor(red: 0.28, green: 0.41, blue: 0, alpha: 1)
      })
  #else
    static let background = UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor(white: 0.06, alpha: 1)
        : UIColor(red: 247 / 255, green: 247 / 255, blue: 245 / 255, alpha: 1)
    }
    static let surface = Color(uiColor: background)
    static let accent = Color(
      uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
          ? UIColor(red: 0.55, green: 0.79, blue: 0.13, alpha: 1)
          : UIColor(red: 0.28, green: 0.41, blue: 0, alpha: 1)
      })
  #endif
}

extension View {
  @ViewBuilder func compactNavigationTitle() -> some View {
    #if os(iOS)
      navigationBarTitleDisplayMode(.inline)
    #else
      self
    #endif
  }
  @ViewBuilder func verbatimInput() -> some View {
    #if os(iOS)
      textInputAutocapitalization(.never)
    #else
      self
    #endif
  }
  @ViewBuilder func compactListSections() -> some View {
    #if os(iOS)
      listSectionSpacing(8)
    #else
      self
    #endif
  }
}

extension Image {
  init(nativeImage: NativeImage) {
    #if os(macOS)
      self.init(nsImage: nativeImage)
    #else
      self.init(uiImage: nativeImage)
    #endif
  }
}

extension View {
  @ViewBuilder func nativeSheetSize(width: CGFloat = 480, height: CGFloat = 560) -> some View {
    #if os(macOS)
      frame(minWidth: width, idealWidth: width, minHeight: height, idealHeight: height)
    #else
      self
    #endif
  }
}

extension View {
  @ViewBuilder func nativeWindowMinimum() -> some View {
    #if os(macOS)
      frame(minWidth: 760, minHeight: 520)
    #else
      self
    #endif
  }
}

extension Notification.Name {
  static let nativeNewChat = Notification.Name("sh.zuse.native.new-chat")
  static let nativeNewCloudChat = Notification.Name("sh.zuse.native.new-cloud-chat")
  static let nativeSettings = Notification.Name("sh.zuse.native.settings")
}

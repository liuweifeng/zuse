import Foundation

public struct DiffLine: Identifiable, Sendable, Equatable {
  public enum Kind: Sendable { case header, context, addition, deletion }
  public let id: Int
  public let text: String
  public let kind: Kind
  public let oldLine: Int?
  public let newLine: Int?
  public static func parse(_ patch: String) -> [DiffLine] {
    var old = 0
    var new = 0
    var inHunk = false
    return patch.components(separatedBy: "\n").enumerated().map { index, text in
      var kind = Kind.header
      var oldNumber: Int?
      var newNumber: Int?
      if text.hasPrefix("@@ ") {
        let parts = text.split(separator: " ")
        if parts.count >= 3 {
          old = parts[1].dropFirst().split(separator: ",").first.flatMap { Int($0) } ?? 0
          new = parts[2].dropFirst().split(separator: ",").first.flatMap { Int($0) } ?? 0
          inHunk = true
        }
      } else if text.hasPrefix("diff --git") {
        inHunk = false
      } else if inHunk && text.hasPrefix("+") {
        kind = .addition
        newNumber = new
        new += 1
      } else if inHunk && text.hasPrefix("-") {
        kind = .deletion
        oldNumber = old
        old += 1
      } else if inHunk && text.hasPrefix(" ") {
        kind = .context
        oldNumber = old
        newNumber = new
        old += 1
        new += 1
      }
      return DiffLine(id: index, text: text, kind: kind, oldLine: oldNumber, newLine: newNumber)
    }
  }
}

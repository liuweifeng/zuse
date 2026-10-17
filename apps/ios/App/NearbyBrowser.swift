import Foundation
import SwiftUI

@MainActor @Observable
final class NearbyBrowser: NSObject, @preconcurrency NetServiceBrowserDelegate,
  @preconcurrency NetServiceDelegate
{
  struct Computer: Identifiable {
    let id: String
    let name: String
    let url: URL
    let pin: String
  }
  private let browser = NetServiceBrowser()
  private var services: [NetService] = []
  var computers: [Computer] = []
  var error: String?
  func start() {
    stop()
    error = nil
    browser.delegate = self
    browser.includesPeerToPeer = true
    browser.searchForServices(ofType: "_zuse._tcp.", inDomain: "local.")
  }
  func stop() {
    browser.stop()
    for service in services { service.stop() }
    services = []
    computers = []
  }
  func netServiceBrowser(
    _ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool
  ) {
    services.append(service)
    service.delegate = self
    service.includesPeerToPeer = true
    service.resolve(withTimeout: 10)
  }
  func netServiceBrowser(
    _ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool
  ) {
    services.removeAll { $0 == service }
    computers.removeAll { $0.id == service.name + service.domain }
  }
  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
    error =
      "Nearby discovery is unavailable. Check Local Network access in Settings, or paste a pairing link."
  }
  func netServiceDidResolveAddress(_ service: NetService) {
    guard let host = service.hostName, let txt = service.txtRecordData(),
      let pinBytes = NetService.dictionary(fromTXTRecord: txt)["tls"],
      let pin = String(data: pinBytes, encoding: .utf8), pin.count == 43
    else { return }
    var url = URLComponents()
    url.scheme = "https"
    url.host = host
    url.port = service.port
    guard let address = url.url else { return }
    let computer = Computer(
      id: service.name + service.domain, name: service.name, url: address, pin: pin)
    computers.removeAll { $0.id == computer.id }
    computers.append(computer)
  }
}

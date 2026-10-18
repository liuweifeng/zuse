#if os(iOS)
  import AVFoundation
  import SwiftUI
  #if os(iOS)
    import VisionKit
  #endif

  struct QRScanner: UIViewControllerRepresentable {
    let scanned: (String) -> Void
    var onError: (String) -> Void = { _ in }
    func makeCoordinator() -> Coordinator { Coordinator(scanned, onError) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
      let controller = DataScannerViewController(
        recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced,
        recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
        isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
      controller.delegate = context.coordinator
      do { try controller.startScanning() } catch {
        Task { @MainActor in onError(error.localizedDescription) }
      }
      return controller
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(
      _ controller: DataScannerViewController, coordinator: Coordinator
    ) { controller.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
      let scanned: (String) -> Void
      let onError: (String) -> Void
      var delivered = false
      init(_ scanned: @escaping (String) -> Void, _ onError: @escaping (String) -> Void) {
        self.scanned = scanned
        self.onError = onError
      }
      func dataScanner(
        _ dataScanner: DataScannerViewController,
        becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable
      ) { onError(error.localizedDescription) }
      func dataScanner(
        _ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem],
        allItems: [RecognizedItem]
      ) {
        guard !delivered else { return }
        for item in addedItems {
          if case .barcode(let barcode) = item, let value = barcode.payloadStringValue {
            delivered = true
            dataScanner.stopScanning()
            scanned(value)
            return
          }
        }
      }
    }
  }

#endif

// Minimal host app for WalletView: one screen, the detector's stage colour behind the wallet.
import SwiftUI

@main
struct WalletDemoApp: App {
    var body: some Scene {
        WindowGroup {
            WalletView()
                .background(Color(red: 0xEC / 255, green: 0xEC / 255, blue: 0xEF / 255))
                .ignoresSafeArea()
        }
    }
}

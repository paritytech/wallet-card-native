// Minimal host app for WalletView: one screen, the detector's stage colour behind the wallet.
import SwiftUI

@main
struct WalletDemoApp: App {
    var body: some Scene {
        WindowGroup {
            // the view sized to the card and its shadow, not the whole screen
            WalletView()
                .aspectRatio(WalletView.fittedAspect(), contentMode: .fit)
                .padding(.horizontal, 24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(red: 0xEC / 255, green: 0xEC / 255, blue: 0xEF / 255))
                .ignoresSafeArea()
        }
    }
}

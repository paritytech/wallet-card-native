package io.parity.walletdemo

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import io.parity.wallet.WalletSurface
import io.parity.wallet.rememberWalletAspect

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            // the surface sized to the card and its shadow, not the whole screen; nothing is drawn over it,
            // so it can use the cheaper SurfaceView (onTop = true)
            Box(Modifier.fillMaxSize().background(Color(0xFFECECEF)), contentAlignment = Alignment.Center) {
                WalletSurface(Modifier.fillMaxWidth().padding(horizontal = 24.dp).aspectRatio(rememberWalletAspect()), onTop = true)
            }
        }
    }
}

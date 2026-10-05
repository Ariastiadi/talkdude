package io.github.ariastiadi.talkdude

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Inset the content away from system bars and display cutouts while
    // keeping the background color visible behind them (native feel).
    ViewCompat.setOnApplyWindowInsetsListener(
      findViewById(android.R.id.content)
    ) { view, windowInsets ->
      val insets = windowInsets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      // Keep the message box above the on-screen keyboard: with edge-to-edge the
      // window no longer shrinks for the keyboard, so pad by the IME height too.
      val ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(insets.left, insets.top, insets.right, maxOf(insets.bottom, ime.bottom))
      windowInsets
    }
  }
}

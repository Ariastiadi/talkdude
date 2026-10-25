package io.github.ariastiadi.talkdude

import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.util.Locale

class MainActivity : TauriActivity() {
  private var tts: TextToSpeech? = null
  @Volatile private var ttsReady = false
  private var webView: WebView? = null

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

    // Read-aloud: Android's WebView has no speech synthesis, so the app uses the
    // phone's own text-to-speech engine (works offline with installed voices).
    tts = TextToSpeech(this) { status ->
      ttsReady = status == TextToSpeech.SUCCESS
      tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) { notify(utteranceId, "done") }
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) { notify(utteranceId, "error") }
        override fun onError(utteranceId: String?, errorCode: Int) { notify(utteranceId, "error") }
        override fun onStop(utteranceId: String?, interrupted: Boolean) { notify(utteranceId, "stopped") }
      })
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    this.webView = webView
    webView.addJavascriptInterface(TtsBridge(), "TalkdudeTTS")
  }

  private fun notify(id: String?, event: String) {
    if (id == null) return
    val js = "window.__tdTts && window.__tdTts(${JSONObject.quote(id)}, ${JSONObject.quote(event)})"
    runOnUiThread { webView?.evaluateJavascript(js, null) }
  }

  inner class TtsBridge {
    @JavascriptInterface
    fun available(): Boolean = ttsReady

    @JavascriptInterface
    fun speak(id: String, text: String, lang: String, rate: Float): Boolean {
      val engine = tts ?: return false
      if (!ttsReady) return false
      val locale = Locale.forLanguageTag(lang)
      if (engine.isLanguageAvailable(locale) >= TextToSpeech.LANG_AVAILABLE) engine.language = locale
      engine.setSpeechRate(rate.coerceIn(0.5f, 2f))
      return engine.speak(text.take(3900), TextToSpeech.QUEUE_ADD, null, id) == TextToSpeech.SUCCESS
    }

    @JavascriptInterface
    fun stop() {
      tts?.stop()
    }
  }

  override fun onDestroy() {
    tts?.stop()
    tts?.shutdown()
    tts = null
    super.onDestroy()
  }
}

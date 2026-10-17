package sh.zuse.android

import android.graphics.Bitmap
import android.net.Uri
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import java.io.File
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import sh.zuse.core.*

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
class NativeLayoutTests {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private fun preview(large: Boolean = false) {
        compose.runOnUiThread {
            ViewModelProvider(compose.activity)[WorkspaceViewModel::class.java].handleLink(
                Uri.parse("zuse://preview?large=$large")
            )
        }
        compose.waitForIdle()
    }

    private fun screenshot(name: String) {
        val directory =
            File(requireNotNull(System.getProperty("zuse.screenshots"))).apply { mkdirs() }
        compose.waitForIdle()
        compose.runOnUiThread {
            val views =
                android.view.inspector.WindowInspector.getGlobalWindowViews().filter { it.isShown }
            val decor = compose.activity.window.decorView
            val bitmap = Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888)
            val canvas = android.graphics.Canvas(bitmap)
            views.forEachIndexed { index, view ->
                if (index > 0) canvas.drawColor(0x33000000)
                view.draw(canvas)
            }
            File(directory, "$name.png").outputStream().use {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    @Test
    fun phoneComposerAndTranscriptRender() {
        preview()
        compose.onNodeWithContentDescription("Ask Zuse").assertIsDisplayed()
        compose.onNodeWithContentDescription("Chat transcript").assertIsDisplayed()
        compose
            .onNodeWithContentDescription("Ask Zuse")
            .performTextInput("Make something thoughtful…")
        screenshot("phone-chat")
    }

    @Test
    @Config(qualifiers = "w900dp-h700dp-land-xhdpi")
    fun tabletRetainsListBesideConversation() {
        preview()
        compose.onNodeWithContentDescription("Ask Zuse").assertIsDisplayed()
        compose.onNodeWithContentDescription("Settings").assertIsDisplayed()
        compose.onNodeWithContentDescription("Chat transcript").assertIsDisplayed()
        screenshot("tablet-chat")
    }

    @Test
    @Config(qualifiers = "w411dp-h914dp-night-xhdpi")
    fun darkModeKeepsComposerReadable() {
        preview()
        compose.onNodeWithContentDescription("Ask Zuse").assertIsDisplayed()
        screenshot("phone-chat-dark")
    }

    @Test
    fun tenThousandMessageTranscriptScrollsBothDirections() {
        preview(large = true)
        compose.onNodeWithContentDescription("Chat transcript").performScrollToIndex(0)
        compose.onNodeWithContentDescription("Chat transcript").performScrollToIndex(9999)
        compose.onNodeWithContentDescription("Ask Zuse").assertIsDisplayed()
    }

    @Test
    fun nativeMathProducesAnEquationDrawable() {
        val message =
            Message(
                "math",
                "preview-session",
                "assistant",
                obj(
                    "_tag" to "assistant".json(),
                    "text" to "Energy, in native math:\n\n\$\$\nE = mc^2\n\$\$".json(),
                ),
            )
        compose.runOnUiThread {
            compose.activity.setContent {
                ZuseTheme {
                    Surface(Modifier.fillMaxSize()) {
                        Column(Modifier.padding(20.dp)) { MessageRow(message) }
                    }
                }
            }
        }
        screenshot("native-math-initial")
        try {
            compose.waitUntil(5000) {
                org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
                var rendered = false
                compose.runOnUiThread {
                    fun visit(view: android.view.View) {
                        if (view is android.widget.TextView) {
                            val text = view.text as? android.text.Spanned
                            if (
                                text != null &&
                                    text
                                        .getSpans(
                                            0,
                                            text.length,
                                            io.noties.markwon.image.AsyncDrawableSpan::class.java,
                                        )
                                        .any { it.drawable.hasResult() }
                            )
                                rendered = true
                        }
                        if (view is android.view.ViewGroup)
                            for (index in 0 until view.childCount) visit(view.getChildAt(index))
                    }
                    visit(compose.activity.window.decorView)
                }
                rendered
            }
        } catch (failure: Throwable) {
            org.robolectric.shadows.ShadowLog.getLogsForTag("JLatexMathPlugin").forEach { item ->
                println(item.msg)
                item.throwable?.printStackTrace()
            }
            throw failure
        }
        screenshot("native-math")
    }

    @Test
    fun generatedChartsAndFormsRenderAndSubmitTypedValues() {
        val fixture =
            compose.activity.assets.open("native/visual-preview.json").bufferedReader().use {
                WireJson.parseToJsonElement(it.readText())
            }
        var response: String? = null
        val drafts = mutableMapOf<String, JsonElement>()
        fun show(version: Int) {
            compose.runOnUiThread {
                compose.activity.setContent {
                    ZuseTheme {
                        Surface(Modifier.fillMaxSize()) {
                            androidx.compose.runtime.key(version) {
                                Column(
                                    Modifier.verticalScroll(rememberScrollState()).padding(20.dp)
                                ) {
                                    UiSpecView(
                                        fixture.text("spec").orEmpty(),
                                        respond = { response = it },
                                        validatedPreview = fixture.field("root"),
                                        savedDraft = drafts.toMap(),
                                        onDraftChange = { name, value -> drafts[name] = value },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
        show(0)
        compose.onNodeWithText("Workspace health").assertIsDisplayed()
        compose.onNodeWithText("feature/native-android").performTextReplacement("feature/foldable")
        org.junit.Assert.assertEquals(
            "feature/foldable",
            (drafts["branch"] as? JsonPrimitive)?.content,
        )
        show(1)
        compose.onNodeWithText("feature/foldable").assertExists()
        screenshot("generated-visual")
        compose.onNodeWithText("Run workspace checks").performScrollTo().performClick()
        compose.waitUntil(5000) { response != null }
        org.junit.Assert.assertTrue(response!!.contains("feature/foldable"))
        org.junit.Assert.assertTrue(response!!.contains("true"))
        compose.onNodeWithText("Response queued").assertExists()
    }

    @Test
    fun settingsExposeCloudPairingAndTailscale() {
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Zuse Cloud", ignoreCase = true).assertExists()
        compose.onNodeWithText("Pairing link").assertExists()
        screenshot("phone-settings")
        compose
            .onNodeWithText("Local, remote & Tailscale", ignoreCase = true)
            .performScrollTo()
            .assertIsDisplayed()
        screenshot("phone-connections")
    }
}

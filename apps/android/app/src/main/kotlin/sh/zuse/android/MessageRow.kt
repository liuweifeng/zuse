package sh.zuse.android

import android.text.method.LinkMovementMethod
import android.widget.TextView
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import io.noties.markwon.Markwon
import io.noties.markwon.ext.latex.JLatexMathPlugin
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.image.AsyncDrawableScheduler
import io.noties.markwon.inlineparser.MarkwonInlineParserPlugin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import sh.zuse.core.*

/** Markdown parses off the UI thread; TextViews and lazy rows are reused by message identity. */
private val equationExecutor =
    java.util.concurrent.Executors.newFixedThreadPool(2) { task ->
        Thread(task, "zuse-math").apply { isDaemon = true }
    }

@Composable
private fun Markdown(text: String) {
    val blocks = remember(text) { MarkdownBlock.parse(text) }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        blocks.forEach { block ->
            if (block.diagram) DiagramView(block.content) else NativeMarkdown(block.content)
        }
    }
}

@Composable
private fun NativeMarkdown(text: String) {
    val context = LocalContext.current
    val foreground = MaterialTheme.colorScheme.onSurface.toArgb()
    val linkColor = MaterialTheme.colorScheme.primary.toArgb()
    val mathEnabled = text.length <= 32 * 1024 && text.contains("$$")
    val textPixels = with(LocalDensity.current) { 14.sp.toPx() }
    val renderer =
        remember(context, foreground, textPixels, mathEnabled) {
            Markwon.builder(context)
                .apply {
                    if (mathEnabled) {
                        usePlugin(MarkwonInlineParserPlugin.create())
                        usePlugin(
                            JLatexMathPlugin.create(textPixels) { builder ->
                                builder.inlinesEnabled(true).executorService(equationExecutor)
                                builder.theme().textColor(foreground)
                            }
                        )
                    }
                }
                .usePlugin(TablePlugin.create(context))
                .usePlugin(StrikethroughPlugin.create())
                .build()
        }
    val parsed by
        produceState<CharSequence>(text, text, renderer) {
            value = withContext(Dispatchers.Default) { renderer.toMarkdown(text) }
        }
    val color = MaterialTheme.colorScheme.onSurface.toArgb()
    AndroidView(
        factory = {
            TextView(it).apply {
                textSize = 14f
                setTextIsSelectable(true)
                movementMethod = LinkMovementMethod.getInstance()
                setLineSpacing(3f, 1f)
            }
        },
        onReset = { view ->
            AsyncDrawableScheduler.unschedule(view)
            view.text = ""
        },
        update = { view ->
            view.setTextColor(color)
            view.setLinkTextColor(linkColor)
            view.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, textPixels)
            if (view.text != parsed)
                renderer.setParsedMarkdown(view, android.text.SpannableStringBuilder(parsed))
        },
        onRelease = { view -> AsyncDrawableScheduler.unschedule(view) },
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
fun MessageRow(
    message: Message,
    onAttachment: (JsonElement) -> Unit = {},
    responded: Boolean = false,
    onRespond: (suspend (String) -> Unit)? = null,
    uiDraft: Map<String, JsonElement> = emptyMap(),
    onUiDraftChange: ((String, JsonElement) -> Unit)? = null,
) {
    val user = message.role == "user"
    val tool =
        message.kind in
            listOf(
                "tool_use",
                "tool_result",
                "reasoning",
                "thinking",
                "error",
                "user_question",
                "user_question_answer",
            )
    var expanded by rememberSaveable(message.id) { mutableStateOf(message.kind == "error") }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (message.kind == "ui_spec") {
            UiSpecView(
                message.content.text("spec").orEmpty(),
                responded,
                onRespond,
                savedDraft = uiDraft,
                onDraftChange = onUiDraftChange,
            )
        } else if (user) {
            Surface(
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier.fillMaxWidth(),
            ) {
                SelectionContainer {
                    Text(
                        message.text,
                        Modifier.padding(14.dp),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            message.content.array("attachments").forEach { ref ->
                TextButton(onClick = { onAttachment(ref) }) {
                    Text(ref.text("originalName") ?: "Open attachment")
                }
            }
        } else if (message.kind == "model_switch") {
            Text(
                "Switched to ${message.content.text("toModel").orEmpty()}",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (message.kind == "interrupted") {
            Text(
                "Response stopped",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (message.kind == "subagent_summary") {
            Text(
                message.content.text("agentName") ?: "Subagent",
                style = MaterialTheme.typography.labelMedium,
            )
            Markdown(message.content.text("summary").orEmpty())
        } else if (
            message.kind in
                listOf(
                    "usage",
                    "context_usage",
                    "usage_limit",
                    "context_compaction",
                    "subagent_progress",
                )
        ) {
            val label =
                when (message.kind) {
                    "usage" ->
                        "${message.content.long("inputTokens") ?: 0} input · ${message.content.long("outputTokens") ?: 0} output tokens"
                    "context_usage" ->
                        "Context · ${message.content.long("usedTokens") ?: "?"} / ${message.content.long("windowTokens") ?: "?"} tokens"
                    "usage_limit" ->
                        "${message.content.text("label").orEmpty()} · ${message.content.long("usedPercent") ?: "?"}% used"
                    "context_compaction" ->
                        "Context compaction · ${message.content.text("status").orEmpty()}"
                    else ->
                        "Subagent · ${message.content.text("status").orEmpty()} · ${message.content.long("toolCalls") ?: 0} tools"
                }
            Text(
                label,
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else if (tool) {
            val label =
                when (message.kind) {
                    "tool_use" -> message.content.text("tool") ?: "Tool"
                    "tool_result" -> "Tool result"
                    "reasoning",
                    "thinking" -> "Thinking"
                    "error" -> "Something needs attention"
                    "user_question" -> "Question"
                    else -> "Answer"
                }
            TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
                Text(
                    "${if (expanded) "▾" else "▸"} $label",
                    style = MaterialTheme.typography.labelMedium,
                    color =
                        if (message.kind == "error") MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            if (expanded) {
                if (message.kind in listOf("reasoning", "thinking")) {
                    if (message.content.flag("redacted"))
                        Text("Thinking redacted", style = MaterialTheme.typography.bodySmall)
                    else Markdown(message.text)
                } else
                    SelectionContainer {
                        Text(
                            message.text,
                            style = MaterialTheme.typography.bodySmall,
                            fontFamily = FontFamily.Monospace,
                            modifier =
                                Modifier.fillMaxWidth()
                                    .horizontalScroll(rememberScrollState())
                                    .padding(vertical = 4.dp),
                        )
                    }
            }
        } else {
            if (message.role == "assistant")
                Text(
                    "Zuse",
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            Markdown(message.text)
        }
    }
}

@Composable
fun InteractionBar(workspace: WorkspaceViewModel) {
    val interaction = workspace.interactions.firstOrNull() ?: return
    val id = interaction.text("id") ?: return
    val expired =
        interaction.text("recoveryState") == "expired" ||
            interaction.field("request").text("recoveryState") == "expired"
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().heightIn(max = 280.dp).padding(horizontal = 12.dp),
        shape = RoundedCornerShape(12.dp),
    ) {
        Column(Modifier.padding(12.dp).verticalScroll(rememberScrollState())) {
            when (interaction.text("_tag")) {
                "Permission" -> {
                    Text("Permission needed", style = MaterialTheme.typography.labelLarge)
                    val request = interaction.field("request")
                    Text(
                        request.text("description")
                            ?: request.text("toolName")
                            ?: request.toString(),
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 5,
                    )
                    Row {
                        TextButton(
                            onClick = { workspace.permission(id, false) },
                            enabled = !expired && workspace.synced,
                        ) {
                            Text("Deny")
                        }
                        TextButton(
                            onClick = { workspace.permission(id, true) },
                            enabled = !expired && workspace.synced,
                        ) {
                            Text("Allow once")
                        }
                    }
                }
                "Plan" -> {
                    Text("Review the proposed plan", style = MaterialTheme.typography.labelLarge)
                    Row {
                        TextButton(
                            onClick = { workspace.plan(id, "cancelled") },
                            enabled = !expired && workspace.synced,
                        ) {
                            Text("Cancel")
                        }
                        TextButton(
                            onClick = { workspace.plan(id, "approved") },
                            enabled = !expired && workspace.synced,
                        ) {
                            Text("Approve")
                        }
                    }
                }
                "Question" -> {
                    val selected = remember(id) { mutableStateMapOf<Int, Set<Int>>() }
                    val other = remember(id) { mutableStateMapOf<Int, String>() }
                    val questions = interaction.array("questions")
                    questions.forEachIndexed { index, question ->
                        Text(
                            question.text("question") ?: "Question",
                            style = MaterialTheme.typography.labelLarge,
                        )
                        question.array("options").forEachIndexed { optionIndex, option ->
                            val label =
                                (option as? JsonPrimitive)?.contentOrNull ?: return@forEachIndexed
                            FilterChip(
                                selected = optionIndex in selected[index].orEmpty(),
                                onClick = {
                                    val current = selected[index].orEmpty()
                                    selected[index] =
                                        if (optionIndex in current) current - optionIndex
                                        else if (question.flag("multiSelect")) current + optionIndex
                                        else setOf(optionIndex)
                                },
                                label = { Text(label) },
                                enabled = !expired && workspace.synced,
                            )
                        }
                        CompactField("Other answer", other[index].orEmpty(), { other[index] = it })
                    }
                    TextButton(
                        onClick = {
                            workspace.answer(
                                id,
                                JsonArray(
                                    questions.indices.map { index ->
                                        obj(
                                            "questionIndex" to index.json(),
                                            "selected" to
                                                JsonArray(
                                                    selected[index].orEmpty().sorted().map {
                                                        it.json()
                                                    }
                                                ),
                                            "other" to
                                                other[index]?.takeIf { it.isNotBlank() }?.json(),
                                        )
                                    }
                                ),
                            )
                        },
                        enabled =
                            !expired &&
                                workspace.synced &&
                                questions.indices.all {
                                    selected[it].orEmpty().isNotEmpty() ||
                                        other[it]?.isNotBlank() == true
                                },
                    ) {
                        Text("Submit answers")
                    }
                }
            }
            if (expired)
                Text(
                    "This request expired. Reconnect to refresh.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
        }
    }
}

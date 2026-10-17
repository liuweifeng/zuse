@file:OptIn(
    androidx.compose.material3.ExperimentalMaterial3Api::class,
    androidx.compose.material3.adaptive.ExperimentalMaterial3AdaptiveApi::class,
)

package sh.zuse.android

import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.collectIsDraggedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.adaptive.layout.*
import androidx.compose.material3.adaptive.navigation.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import kotlinx.coroutines.launch
import sh.zuse.core.*

@Composable
fun ZuseApp(workspace: WorkspaceViewModel, openUri: (Uri) -> Unit) {
    val navigator = rememberListDetailPaneScaffoldNavigator<String>()
    val scope = rememberCoroutineScope()
    var settings by rememberSaveable { mutableStateOf(false) }
    var newChat by rememberSaveable { mutableStateOf(false) }
    var cloud by rememberSaveable { mutableStateOf(false) }
    var diffs by rememberSaveable { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val error = workspace.error
    LaunchedEffect(error, settings, newChat, cloud, diffs) {
        if (
            error != null &&
                !settings &&
                !newChat &&
                !cloud &&
                !diffs &&
                workspace.pairingLink == null
        ) {
            snackbar.showSnackbar(error)
            if (workspace.error == error) workspace.error = null
        }
    }
    BackHandler(navigator.canNavigateBack()) { scope.launch { navigator.navigateBack() } }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        containerColor = MaterialTheme.colorScheme.background,
    ) { insets ->
        ListDetailPaneScaffold(
            modifier = Modifier.padding(insets).consumeWindowInsets(insets).fillMaxSize(),
            directive = navigator.scaffoldDirective,
            value = navigator.scaffoldValue,
            listPane = {
                AnimatedPane {
                    HomePane(
                        workspace,
                        onSettings = { settings = true },
                        onNewChat = {
                            if (workspace.connected) newChat = true
                            else if (workspace.signedIn) cloud = true else settings = true
                        },
                        onOpen = { session ->
                            workspace.selectSession(session)
                            scope.launch {
                                navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, session.id)
                            }
                        },
                    )
                }
            },
            detailPane = {
                AnimatedPane {
                    key(workspace.conversationKey) {
                        ConversationPane(
                            workspace,
                            onBack = { scope.launch { navigator.navigateBack() } },
                            onNewChat = {
                                if (workspace.connected) newChat = true
                                else if (workspace.signedIn) cloud = true else settings = true
                            },
                            onDiffs = { diffs = true },
                        )
                    }
                }
            },
        )
    }
    if (settings || workspace.pairingLink != null)
        SettingsSheet(
            workspace,
            openUri,
            onCloud = {
                settings = false
                cloud = true
            },
            onClose = {
                settings = false
                workspace.pairingLink = null
            },
        )
    if (newChat)
        NewChatSheet(
            workspace,
            onClose = { newChat = false },
            onCreated = {
                newChat = false
                scope.launch {
                    navigator.navigateTo(
                        ListDetailPaneScaffoldRole.Detail,
                        workspace.selectedSession?.id,
                    )
                }
            },
        )
    if (cloud) CloudSheet(workspace, openUri, onClose = { cloud = false })
    if (diffs) DiffSheet(workspace) { diffs = false }
    LaunchedEffect(workspace.selectedSession?.id) {
        if (workspace.selectedSession != null)
            navigator.navigateTo(ListDetailPaneScaffoldRole.Detail, workspace.selectedSession!!.id)
    }
}

@Composable
fun SmallIcon(icon: ImageVector, label: String, onClick: () -> Unit, enabled: Boolean = true) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.size(44.dp)) {
        Icon(icon, label, Modifier.size(20.dp))
    }
}

@Composable
fun PaneHeader(
    title: String,
    subtitle: String? = null,
    leading: @Composable () -> Unit = {},
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        Column(Modifier.weight(1f).padding(horizontal = 8.dp)) {
            Text(
                title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
        }
        actions()
    }
}

@Composable
private fun HomePane(
    workspace: WorkspaceViewModel,
    onSettings: () -> Unit,
    onNewChat: () -> Unit,
    onOpen: (Session) -> Unit,
) {
    var search by rememberSaveable { mutableStateOf("") }
    var deviceMenu by remember { mutableStateOf(false) }
    var projectMenu by remember { mutableStateOf(false) }
    val source = workspace.source
    val name =
        when (source) {
            is Source.Device -> source.device.label
            is Source.Cloud -> "Zuse Cloud"
            is Source.Computer -> source.device.label ?: "Computer"
            null -> "Your workspace"
        }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        PaneHeader(
            "Zuse",
            workspace.status,
            actions = {
                SmallIcon(Icons.Outlined.Settings, "Settings", onSettings)
                SmallIcon(
                    Icons.Outlined.Edit,
                    "New chat",
                    onNewChat,
                    workspace.connected || workspace.signedIn,
                )
            },
        )
        Row(
            Modifier.padding(horizontal = 16.dp).fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box {
                TextButton(
                    onClick = { deviceMenu = true },
                    contentPadding = PaddingValues(horizontal = 8.dp),
                    modifier = Modifier.height(36.dp),
                ) {
                    Icon(Icons.Outlined.Devices, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(name, maxLines = 1)
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
                }
                DropdownMenu(deviceMenu, { deviceMenu = false }) {
                    workspace.devices.forEach { device ->
                        DropdownMenuItem(
                            text = { Text(device.label) },
                            onClick = {
                                deviceMenu = false
                                workspace.connect(Source.Device(device))
                            },
                        )
                    }
                    workspace.computers.forEach { computer ->
                        DropdownMenuItem(
                            text = { Text(computer.label ?: "Computer") },
                            onClick = {
                                deviceMenu = false
                                workspace.connect(Source.Computer(computer))
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text("Manage devices") },
                        onClick = {
                            deviceMenu = false
                            onSettings()
                        },
                    )
                }
            }
            Spacer(Modifier.weight(1f))
            if (source != null) SmallIcon(Icons.Outlined.Refresh, "Reconnect", workspace::reconnect)
        }
        if (workspace.projects.isNotEmpty())
            Box(Modifier.padding(horizontal = 16.dp)) {
                TextButton(
                    onClick = { projectMenu = true },
                    contentPadding = PaddingValues(horizontal = 8.dp),
                ) {
                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(workspace.selectedProject?.name ?: "Select project")
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
                }
                DropdownMenu(projectMenu, { projectMenu = false }) {
                    workspace.projects.forEach { project ->
                        DropdownMenuItem(
                            text = { Text(project.name) },
                            onClick = {
                                workspace.selectProject(project)
                                projectMenu = false
                            },
                        )
                    }
                }
            }
        LazyColumn(
            Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            val filtered =
                workspace.sessions.filter { search.isBlank() || it.title.contains(search, true) }
            items(filtered, key = { "session:${it.id}" }, contentType = { "chat" }) { session ->
                val selected = workspace.selectedSession?.id == session.id
                Column(
                    Modifier.fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(
                            if (selected) MaterialTheme.colorScheme.surfaceContainerHigh
                            else Color.Transparent
                        )
                        .clickable { onOpen(session) }
                        .padding(horizontal = 14.dp, vertical = 12.dp)
                ) {
                    Text(
                        session.title,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.Medium,
                    )
                    Spacer(Modifier.height(5.dp))
                    Text(
                        session.model,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (workspace.cloudChats.isNotEmpty()) {
                item {
                    Text(
                        "CLOUD CHATS",
                        Modifier.padding(14.dp),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                items(
                    workspace.cloudChats.filter {
                        search.isBlank() || it.title.contains(search, true)
                    },
                    key = { "cloud:${it.workspaceId}:${it.chatId}" },
                    contentType = { "cloud" },
                ) { chat ->
                    ListItem(
                        headlineContent = {
                            Text(chat.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        },
                        supportingContent = {
                            Text(
                                "${chat.repositoryDisplayName} · ${chat.runtimeState}",
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        },
                        leadingContent = {
                            Icon(Icons.Outlined.CloudQueue, null, Modifier.size(18.dp))
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier =
                            Modifier.clip(RoundedCornerShape(12.dp)).clickable {
                                workspace.connect(Source.Cloud(chat))
                            },
                    )
                }
            }
            if (filtered.isEmpty() && workspace.cloudChats.isEmpty())
                item {
                    Column(
                        Modifier.fillMaxWidth().padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Spacer(Modifier.height(56.dp))
                        Icon(
                            Icons.Outlined.Forum,
                            null,
                            Modifier.size(30.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(16.dp))
                        Text(
                            if (workspace.connected) "Start something new"
                            else "Your work, anywhere",
                            style = MaterialTheme.typography.titleMedium,
                        )
                        Text(
                            if (workspace.connected) "Create a chat in this project."
                            else "Connect your computer or sign in to Zuse Cloud.",
                            Modifier.padding(top = 8.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        TextButton(onClick = if (workspace.connected) onNewChat else onSettings) {
                            Text(if (workspace.connected) "New chat" else "Connect a device")
                        }
                    }
                }
        }
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.padding(12.dp).fillMaxWidth(),
        ) {
            Row(
                Modifier.padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Search, null, Modifier.size(18.dp))
                BasicSearch(search, { search = it }, Modifier.weight(1f))
                SmallIcon(
                    Icons.Outlined.Edit,
                    "Create chat",
                    onNewChat,
                    workspace.connected || workspace.signedIn,
                )
            }
        }
    }
}

@Composable
private fun BasicSearch(value: String, onChange: (String) -> Unit, modifier: Modifier = Modifier) {
    androidx.compose.foundation.text.BasicTextField(
        value,
        onChange,
        modifier.padding(10.dp),
        cursorBrush = androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
        singleLine = true,
        textStyle =
            MaterialTheme.typography.bodyMedium.copy(color = MaterialTheme.colorScheme.onSurface),
        decorationBox = { inner ->
            if (value.isEmpty())
                Text(
                    "Search chats",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            inner()
        },
    )
}

@Composable
private fun ConversationPane(
    workspace: WorkspaceViewModel,
    onBack: () -> Unit,
    onNewChat: () -> Unit,
    onDiffs: () -> Unit,
) {
    val session = workspace.selectedSession
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var follow by remember(session?.id) { mutableStateOf(true) }
    val atBottom by remember {
        derivedStateOf {
            list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ==
                list.layoutInfo.totalItemsCount - 1
        }
    }
    val dragging by list.interactionSource.collectIsDraggedAsState()
    LaunchedEffect(dragging, atBottom) { if (dragging) follow = atBottom }
    LaunchedEffect(session?.id) {
        if (workspace.messages.isNotEmpty())
            list.scrollToItem(
                workspace.messages.lastIndex + if (workspace.olderSequence != null) 1 else 0
            )
    }
    LaunchedEffect(
        workspace.messages.size,
        workspace.messages.lastOrNull(),
        workspace.pending.size,
    ) {
        withFrameNanos {}
        if (follow && list.layoutInfo.totalItemsCount > 0)
            list.scrollToItem(list.layoutInfo.totalItemsCount - 1)
    }
    Column(Modifier.fillMaxSize()) {
        PaneHeader(
            session?.title ?: "Zuse",
            if (session != null) "${workspace.status} · ${session.model}" else null,
            leading = { SmallIcon(Icons.AutoMirrored.Outlined.ArrowBack, "Back to chats", onBack) },
            actions = {
                if (session != null)
                    SmallIcon(
                        Icons.Outlined.Difference,
                        "Review changes",
                        onDiffs,
                        workspace.connected,
                    )
                SmallIcon(
                    Icons.Outlined.Edit,
                    "New chat",
                    onNewChat,
                    workspace.connected || workspace.signedIn,
                )
            },
        )
        if (session == null) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("What are we building?", style = MaterialTheme.typography.headlineSmall)
                    Text(
                        "Choose a chat, or start a new one.",
                        Modifier.padding(8.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        } else {
            Box(Modifier.weight(1f)) {
                LazyColumn(
                    state = list,
                    modifier =
                        Modifier.fillMaxSize().semantics { contentDescription = "Chat transcript" },
                    contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(18.dp),
                ) {
                    if (workspace.olderSequence != null)
                        item(key = "older") {
                            TextButton(
                                onClick = { workspace.loadOlder() },
                                enabled = !workspace.paging,
                            ) {
                                Text(
                                    if (workspace.paging) "Loading history…"
                                    else "Load earlier messages"
                                )
                            }
                        }
                    items(workspace.messages, key = { it.id }, contentType = { it.kind }) { message
                        ->
                        MessageRow(
                            message,
                            onAttachment = { ref ->
                                workspace.openAttachment(ref, message.sessionId)
                            },
                            responded = message.id in workspace.respondedUi,
                            onRespond =
                                if (workspace.source != null && workspace.inputsReady)
                                    { text -> workspace.respondToUi(message, text) }
                                else null,
                            uiDraft = workspace.uiDrafts[message.id].orEmpty(),
                            onUiDraftChange = { name, value ->
                                workspace.updateUiDraft(message, name, value)
                            },
                        )
                    }
                    items(
                        workspace.pending,
                        key = { "pending:${it.id}" },
                        contentType = { "pending" },
                    ) { item ->
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceContainerHigh,
                            shape = RoundedCornerShape(12.dp),
                        ) {
                            Column(Modifier.padding(12.dp)) {
                                Text(item.text, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    if (item.attempted)
                                        "Delivery unconfirmed. Check the transcript before retrying."
                                    else "Queued · waiting for synchronization",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Row {
                                    if (item.attempted)
                                        TextButton(
                                            onClick = { workspace.flushOutbox(item.id) },
                                            enabled = workspace.synced && !workspace.sending,
                                        ) {
                                            Text("Retry same message")
                                        }
                                    TextButton(
                                        onClick = { workspace.removePending(item.id) },
                                        enabled = !workspace.sending,
                                    ) {
                                        Text("Remove")
                                    }
                                }
                            }
                        }
                    }
                    if (workspace.activeTurnId != null)
                        item("working") {
                            Text(
                                "Zuse is working…",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                }
                if (!atBottom && workspace.messages.isNotEmpty())
                    FilledTonalIconButton(
                        onClick = {
                            follow = true
                            scope.launch {
                                list.animateScrollToItem(list.layoutInfo.totalItemsCount - 1)
                            }
                        },
                        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                    ) {
                        Icon(Icons.Outlined.ArrowDownward, "Jump to latest")
                    }
            }
            InteractionBar(workspace)
            Composer(workspace)
        }
    }
}

@Composable
private fun Composer(workspace: WorkspaceViewModel) {
    var modelMenu by remember { mutableStateOf(false) }
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            uri?.let { workspace.attach(it) }
        }
    Column(Modifier.fillMaxWidth().imePadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
        if (workspace.attachments.isNotEmpty())
            Row(
                Modifier.horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                workspace.attachments.forEach { ref ->
                    InputChip(
                        selected = false,
                        onClick = { workspace.removeAttachment(ref) },
                        label = { Text(ref.text("originalName") ?: "Attachment", maxLines = 1) },
                        trailingIcon = {
                            Icon(Icons.Outlined.Close, "Remove attachment", Modifier.size(14.dp))
                        },
                    )
                }
            }
        Surface(
            shape = RoundedCornerShape(22.dp),
            color = MaterialTheme.colorScheme.surfaceContainer,
        ) {
            Column {
                androidx.compose.foundation.text.BasicTextField(
                    value = workspace.draft,
                    onValueChange = workspace::updateDraft,
                    enabled = workspace.inputsReady,
                    cursorBrush =
                        androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                    textStyle =
                        MaterialTheme.typography.bodyMedium.copy(
                            color = MaterialTheme.colorScheme.onSurface
                        ),
                    modifier =
                        Modifier.fillMaxWidth()
                            .heightIn(min = 48.dp, max = 160.dp)
                            .padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 8.dp)
                            .semantics { contentDescription = "Ask Zuse" },
                    decorationBox = { inner ->
                        if (workspace.draft.isEmpty())
                            Text(
                                "Ask Zuse",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        inner()
                    },
                )
                Row(
                    Modifier.fillMaxWidth().padding(start = 4.dp, end = 8.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SmallIcon(
                        Icons.Outlined.Add,
                        "Add attachment",
                        { picker.launch(arrayOf("*/*")) },
                        workspace.synced && !workspace.uploading,
                    )
                    if (workspace.uploading)
                        CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.weight(1f))
                    Box {
                        TextButton(
                            onClick = { modelMenu = true },
                            enabled = workspace.synced && workspace.activeTurnId == null,
                            contentPadding = PaddingValues(horizontal = 8.dp),
                        ) {
                            Text(
                                workspace.selectedSession?.model.orEmpty(),
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.widthIn(max = 180.dp),
                            )
                        }
                        DropdownMenu(modelMenu, { modelMenu = false }) {
                            workspace.models.forEach { model ->
                                DropdownMenuItem(
                                    text = {
                                        Text("${model.name} · ${model.provider}", maxLines = 1)
                                    },
                                    onClick = {
                                        modelMenu = false
                                        workspace.changeModel(model)
                                    },
                                )
                            }
                        }
                    }
                    val stopping = workspace.activeTurnId != null
                    val sendEnabled =
                        if (stopping) workspace.connected
                        else
                            workspace.inputsReady &&
                                !workspace.sending &&
                                !workspace.uploading &&
                                (workspace.draft.isNotBlank() || workspace.attachments.isNotEmpty())
                    IconButton(
                        onClick = { if (stopping) workspace.stop() else workspace.send() },
                        enabled = sendEnabled,
                        modifier = Modifier.size(44.dp),
                    ) {
                        Box(
                            Modifier.size(30.dp)
                                .clip(RoundedCornerShape(9.dp))
                                .background(
                                    if (sendEnabled) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.onSurface.copy(alpha = .18f)
                                ),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                if (stopping) Icons.Outlined.Stop else Icons.Outlined.ArrowUpward,
                                if (stopping) "Stop response" else "Send message",
                                tint = MaterialTheme.colorScheme.onPrimary,
                                modifier = Modifier.size(18.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}

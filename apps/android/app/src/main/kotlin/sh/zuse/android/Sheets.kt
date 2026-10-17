@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package sh.zuse.android

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.flow.catch
import sh.zuse.core.*

/** 28dp visible controls with compact tonal surfaces and a 44dp interactive row. */
@Composable
fun CompactField(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    secret: Boolean = false,
    enabled: Boolean = true,
    placeholder: String? = null,
) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Surface(
            shape = RoundedCornerShape(6.dp),
            color = MaterialTheme.colorScheme.surfaceContainerHigh,
            modifier = Modifier.fillMaxWidth().height(28.dp),
        ) {
            Box(Modifier.padding(horizontal = 8.dp), contentAlignment = Alignment.CenterStart) {
                BasicTextField(
                    value,
                    onChange,
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
                    cursorBrush =
                        androidx.compose.ui.graphics.SolidColor(MaterialTheme.colorScheme.primary),
                    enabled = enabled,
                    decorationBox = { inner ->
                        if (value.isEmpty() && !placeholder.isNullOrEmpty())
                            Text(
                                placeholder,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        inner()
                    },
                    singleLine = true,
                    textStyle =
                        MaterialTheme.typography.bodySmall.copy(
                            color = MaterialTheme.colorScheme.onSurface
                        ),
                    keyboardOptions =
                        androidx.compose.foundation.text.KeyboardOptions(
                            keyboardType =
                                if (secret) androidx.compose.ui.text.input.KeyboardType.Password
                                else androidx.compose.ui.text.input.KeyboardType.Text,
                            autoCorrectEnabled = false,
                        ),
                    visualTransformation =
                        if (secret) PasswordVisualTransformation() else VisualTransformation.None,
                )
            }
        }
    }
}

@Composable
fun CompactAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(Modifier.height(44.dp), contentAlignment = Alignment.Center) {
        Button(
            onClick,
            enabled = enabled,
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
            shape = RoundedCornerShape(7.dp),
            modifier = Modifier.height(28.dp),
        ) {
            Text(label, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text.uppercase(),
        Modifier.padding(top = 20.dp, bottom = 8.dp),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
fun SettingsSheet(
    workspace: WorkspaceViewModel,
    openUri: (Uri) -> Unit,
    onCloud: () -> Unit,
    onClose: () -> Unit,
) {
    var label by rememberSaveable { mutableStateOf("") }
    var address by rememberSaveable { mutableStateOf("") }
    var token by rememberSaveable { mutableStateOf("") }
    var pin by rememberSaveable { mutableStateOf("") }
    var pairing by rememberSaveable { mutableStateOf(workspace.pairingLink.orEmpty()) }
    var nearbySelection by remember { mutableStateOf<NearbyComputer?>(null) }
    var code by rememberSaveable { mutableStateOf("") }
    var showAdvanced by rememberSaveable { mutableStateOf(false) }
    val scanner =
        rememberLauncherForActivityResult(ScanContract()) { result ->
            result.contents?.let { pairing = it }
        }
    val context = LocalContext.current
    var nearbyError by remember { mutableStateOf<String?>(null) }
    val nearby by
        remember(context) {
                NearbyBrowser(context).computers.catch {
                    nearbyError = it.message
                    emit(emptyList())
                }
            }
            .collectAsStateWithLifecycle(emptyList())
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier.fillMaxWidth()
                .fillMaxHeight(.9f)
                .widthIn(max = 620.dp)
                .align(Alignment.CenterHorizontally)
        ) {
            PaneHeader(
                "Settings",
                actions = { SmallIcon(Icons.Outlined.Close, "Close settings", onClose) },
            )
            Column(
                Modifier.weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 20.dp)
                    .imePadding()
            ) {
                workspace.error?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                SectionLabel("Zuse Cloud")
                Text(
                    if (workspace.signedIn) "Signed in to Zuse"
                    else "Your cloud workspaces and linked computers.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    CompactAction(
                        if (workspace.signedIn) "Refresh" else "Sign in",
                        !workspace.cloudLoading,
                    ) {
                        if (workspace.signedIn) workspace.refreshCloud()
                        else workspace.signIn(openUri)
                    }
                    if (workspace.signedIn)
                        TextButton(onClick = { workspace.signOut() }) { Text("Sign out") }
                }
                if (workspace.signedIn)
                    TextButton(onClick = onCloud) { Text("Workspaces & cloud agent settings") }
                workspace.computers.forEach { computer ->
                    ListItem(
                        headlineContent = {
                            Text(
                                computer.label ?: "Computer",
                                style = MaterialTheme.typography.bodyMedium,
                            )
                        },
                        supportingContent = {
                            Text(computer.providerKind, style = MaterialTheme.typography.labelSmall)
                        },
                        leadingContent = {
                            Icon(Icons.Outlined.Computer, null, Modifier.size(18.dp))
                        },
                        trailingContent = {
                            CompactAction("Connect") {
                                workspace.connect(Source.Computer(computer))
                                onClose()
                            }
                        },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
                SectionLabel("Connected devices")
                if (workspace.devices.isEmpty())
                    Text(
                        "No saved computers yet.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                workspace.devices.forEach { device ->
                    Row(
                        Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(
                            Modifier.weight(1f)
                                .clickable {
                                    workspace.connect(Source.Device(device))
                                    onClose()
                                }
                                .padding(vertical = 8.dp)
                        ) {
                            Text(device.label, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                device.address,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        SmallIcon(
                            Icons.Outlined.DeleteOutline,
                            "Forget ${device.label}",
                            { workspace.forgetDevice(device) },
                        )
                    }
                }
                if (workspace.source != null)
                    TextButton(onClick = workspace::disconnect) { Text("Disconnect") }
                SectionLabel("Pair a computer")
                Text(
                    "On your computer, open Zuse’s device settings or run zuse serve, then paste its pairing link.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                CompactField("Computer name", label, { label = it })
                CompactField("Pairing link", pairing, { pairing = it }, secret = true)
                TextButton(
                    onClick = {
                        scanner.launch(
                            ScanOptions()
                                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                .setPrompt("Scan a Zuse pairing code")
                                .setBeepEnabled(false)
                                .setOrientationLocked(false)
                        )
                    }
                ) {
                    Icon(Icons.Outlined.QrCodeScanner, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Scan QR code")
                }
                CompactField("Certificate pin, if supplied", pin, { pin = it })
                CompactAction(
                    if (workspace.busy) "Pairing…" else "Pair computer",
                    pairing.isNotBlank() && !workspace.busy,
                ) {
                    workspace.pair(pairing, label, pin.ifBlank { null }, onClose)
                }
                SectionLabel("Nearby computers")
                Text(
                    nearbyError
                        ?: if (nearby.isEmpty()) "Looking for Zuse on your local network…"
                        else "Verify the computer and enter its one-time code.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                nearby.forEach { computer ->
                    TextButton(onClick = { nearbySelection = computer }) {
                        Icon(Icons.Outlined.Laptop, null, Modifier.size(16.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(computer.name)
                    }
                }
                nearbySelection?.let { computer ->
                    Text(computer.name, style = MaterialTheme.typography.labelMedium)
                    SelectionContainerText("Certificate: ${computer.pin}")
                    CompactField(
                        "Pairing code from this computer",
                        code,
                        { code = it },
                        secret = true,
                    )
                    CompactAction("Pair ${computer.name}", code.isNotBlank() && !workspace.busy) {
                        workspace.pair(
                            "${computer.address}/#pair=${Uri.encode(code)}",
                            computer.name,
                            computer.pin,
                            onClose,
                        )
                    }
                }
                SectionLabel("Local, remote & Tailscale")
                Text(
                    "Zuse uses your system VPN. Connect Tailscale first, then use the computer’s tailnet address. Public servers require wss://; private LAN and tailnet addresses also support ws://.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { showAdvanced = !showAdvanced }) {
                    Text(if (showAdvanced) "Hide manual connection" else "Manual connection")
                }
                if (showAdvanced) {
                    CompactField("WebSocket address", address, { address = it })
                    CompactField("Connection token", token, { token = it }, secret = true)
                    CompactAction("Save and connect", address.isNotBlank() && label.isNotBlank()) {
                        workspace.saveDevice(label, address, token, pin.ifBlank { null })
                    }
                }
                Spacer(Modifier.height(24.dp))
            }
        }
    }
}

@Composable
private fun SelectionContainerText(text: String) {
    androidx.compose.foundation.text.selection.SelectionContainer {
        Text(text, style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace)
    }
}

@Composable
fun NewChatSheet(workspace: WorkspaceViewModel, onClose: () -> Unit, onCreated: () -> Unit) {
    var search by rememberSaveable { mutableStateOf("") }
    var model by remember { mutableStateOf<ModelChoice?>(null) }
    var branch by remember { mutableStateOf<Branch?>(null) }
    var fresh by rememberSaveable { mutableStateOf(true) }
    var branchMenu by remember { mutableStateOf(false) }
    var projectMenu by remember { mutableStateOf(false) }
    LaunchedEffect(workspace.selectedProject?.id) {
        workspace.loadBranches()
        branch = null
    }
    LaunchedEffect(workspace.models.size) {
        if (model == null) model = workspace.models.firstOrNull()
    }
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(
            Modifier.fillMaxHeight(.85f)
                .fillMaxWidth()
                .widthIn(max = 620.dp)
                .align(Alignment.CenterHorizontally)
                .padding(horizontal = 16.dp)
        ) {
            PaneHeader(
                "New chat",
                actions = { SmallIcon(Icons.Outlined.Close, "Close new chat", onClose) },
            )
            workspace.error?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            Box {
                TextButton(onClick = { projectMenu = true }) {
                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(16.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(workspace.selectedProject?.name ?: "Choose project")
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
                }
                DropdownMenu(projectMenu, { projectMenu = false }) {
                    workspace.projects.forEach { project ->
                        DropdownMenuItem(
                            text = { Text(project.name) },
                            onClick = {
                                projectMenu = false
                                workspace.selectProject(project)
                            },
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(fresh, { fresh = it })
                Column {
                    Text("New worktree", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "Keep this chat’s changes isolated",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            if (!fresh)
                Box {
                    TextButton(onClick = { branchMenu = true }) {
                        Text(
                            branch?.name
                                ?: workspace.branches.firstOrNull { it.current }?.name
                                ?: "Current branch"
                        )
                        Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
                    }
                    DropdownMenu(branchMenu, { branchMenu = false }) {
                        workspace.branches.forEach { item ->
                            DropdownMenuItem(
                                text = { Text(item.name, maxLines = 1) },
                                onClick = {
                                    branch = item
                                    branchMenu = false
                                },
                            )
                        }
                    }
                    Text(
                        "Uses the project’s working directory.",
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(top = 44.dp),
                    )
                }
            CompactField("Search models", search, { search = it })
            LazyColumn(Modifier.weight(1f)) {
                items(
                    workspace.models.filter {
                        search.isBlank() ||
                            it.name.contains(search, true) ||
                            it.provider.contains(search, true)
                    },
                    key = { "${it.provider}:${it.id}" },
                ) { choice ->
                    Row(
                        Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable { model = choice }
                            .padding(vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(model == choice, onClick = { model = choice })
                        Column {
                            Text(choice.name, style = MaterialTheme.typography.bodyMedium)
                            Text(
                                choice.provider,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                if (workspace.models.isEmpty())
                    item {
                        Text(
                            "Connect a runtime to load its available models.",
                            Modifier.padding(12.dp),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
            }
            Row(
                Modifier.fillMaxWidth().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.End,
            ) {
                CompactAction(
                    if (workspace.busy) "Creating…" else "Create chat",
                    model != null && workspace.connected && !workspace.busy,
                ) {
                    model?.let { workspace.createChat(it, branch, fresh, onCreated) }
                }
            }
        }
    }
}

@Composable
fun DiffSheet(workspace: WorkspaceViewModel, onClose: () -> Unit) {
    var scope by rememberSaveable { mutableStateOf("unstaged") }
    var file by remember { mutableStateOf<String?>(null) }
    file?.let { path -> FileDialog(workspace, path) { file = null } }
    LaunchedEffect(scope) { workspace.loadDiff(scope) }
    DisposableEffect(Unit) { onDispose { workspace.closeDiff() } }
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
    ) {
        Column(Modifier.fillMaxHeight(.92f).fillMaxWidth()) {
            PaneHeader(
                "Changes",
                actions = {
                    SmallIcon(
                        Icons.Outlined.Refresh,
                        "Refresh changes",
                        { workspace.loadDiff(scope) },
                    )
                    SmallIcon(Icons.Outlined.Close, "Close changes", onClose)
                },
            )
            Row(
                Modifier.padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf("unstaged" to "Working tree", "staged" to "Staged", "branch" to "Branch")
                    .forEach { (key, label) ->
                        FilterChip(scope == key, { scope = key }, label = { Text(label) })
                    }
            }
            workspace.error?.let {
                Text(
                    it,
                    Modifier.padding(horizontal = 16.dp),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            if (workspace.diffLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            LazyColumn(
                Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(vertical = 12.dp),
            ) {
                workspace.patches.forEach { patch ->
                    item(key = "path:${patch.path}") {
                        Text(
                            patch.path,
                            Modifier.clickable { file = patch.path }
                                .fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                                .padding(12.dp),
                            style = MaterialTheme.typography.labelMedium,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    if (patch.error != null || patch.mode == "binary" || patch.truncated)
                        item(key = "note:${patch.path}") {
                            Text(
                                patch.error
                                    ?: if (patch.mode == "binary") "Binary file changed"
                                    else "Patch truncated by server",
                                Modifier.padding(12.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    itemsIndexed(
                        patch.lines,
                        key = { index, _ -> "${patch.path}:$index" },
                        contentType = { _, _ -> "diff" },
                    ) { _, line ->
                        val color =
                            when (line.kind) {
                                DiffLine.Kind.ADDITION -> Color(0x16269A3B)
                                DiffLine.Kind.DELETION -> Color(0x16D93F4C)
                                else -> Color.Transparent
                            }
                        Row(
                            Modifier.fillMaxWidth()
                                .background(color)
                                .padding(horizontal = 8.dp, vertical = 2.dp)
                        ) {
                            Text(
                                line.oldLine?.toString().orEmpty(),
                                Modifier.width(34.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                line.newLine?.toString().orEmpty(),
                                Modifier.width(34.dp),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            androidx.compose.foundation.text.selection.SelectionContainer {
                                Text(
                                    line.text,
                                    fontFamily = FontFamily.Monospace,
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                                )
                            }
                        }
                    }
                }
                if (!workspace.diffLoading && workspace.patches.isEmpty())
                    item {
                        Text(
                            "No changes",
                            Modifier.padding(24.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
            }
        }
    }
}

@Composable
private fun FileDialog(workspace: WorkspaceViewModel, path: String, onClose: () -> Unit) {
    var lines by remember(path) { mutableStateOf<List<String>?>(null) }
    var failure by remember(path) { mutableStateOf<String?>(null) }
    LaunchedEffect(path) {
        try {
            lines = workspace.readFile(path)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            failure = error.message
        }
    }
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onClose,
        properties = androidx.compose.ui.window.DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            Modifier.fillMaxSize().padding(16.dp).widthIn(max = 1100.dp),
            shape = RoundedCornerShape(16.dp),
        ) {
            Column {
                PaneHeader(
                    path,
                    actions = { SmallIcon(Icons.Outlined.Close, "Close file", onClose) },
                )
                if (failure != null)
                    Text(
                        failure.orEmpty(),
                        Modifier.padding(16.dp),
                        color = MaterialTheme.colorScheme.error,
                    )
                else if (lines == null) CircularProgressIndicator(Modifier.padding(16.dp))
                else
                    LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(12.dp)) {
                        itemsIndexed(lines.orEmpty()) { index, text ->
                            Row(Modifier.padding(vertical = 2.dp)) {
                                Text(
                                    "${index + 1}",
                                    Modifier.width(40.dp),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                androidx.compose.foundation.text.selection.SelectionContainer {
                                    Text(
                                        text.ifEmpty { " " },
                                        fontFamily = FontFamily.Monospace,
                                        style = MaterialTheme.typography.bodySmall,
                                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                                    )
                                }
                            }
                        }
                    }
            }
        }
    }
}

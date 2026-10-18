package sh.zuse.android

import android.app.Application
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import sh.zuse.core.*

@Serializable
sealed interface Source {
    @Serializable data class Device(val device: SavedDevice) : Source

    @Serializable data class Cloud(val chat: CloudChat) : Source

    @Serializable data class Computer(val device: RemoteEnvironment) : Source
}

data class Patch(
    val path: String,
    val lines: List<DiffLine>,
    val mode: String,
    val truncated: Boolean,
    val error: String?,
)

class WorkspaceViewModel(application: Application) : AndroidViewModel(application) {
    private val app
        get() = getApplication<ZuseApplication>()

    private val vault
        get() = app.vault

    val account
        get() = app.account

    val projects = mutableStateListOf<Project>()
    val sessions = mutableStateListOf<Session>()
    val messages = mutableStateListOf<Message>()
    val devices = mutableStateListOf<SavedDevice>()
    val cloudChats = mutableStateListOf<CloudChat>()
    val computers = mutableStateListOf<RemoteEnvironment>()
    val models = mutableStateListOf<ModelChoice>()
    val branches = mutableStateListOf<Branch>()
    val patches = mutableStateListOf<Patch>()
    val pending = mutableStateListOf<PendingMessage>()
    val attachments = mutableStateListOf<JsonElement>()
    val respondedUi = mutableStateListOf<String>()
    val uiDrafts = mutableStateMapOf<String, Map<String, JsonElement>>()
    var interactions by mutableStateOf<List<JsonElement>>(emptyList())
        private set

    var selectedProject by mutableStateOf<Project?>(null)
        private set

    var selectedSession by mutableStateOf<Session?>(null)
        private set

    var source by mutableStateOf<Source?>(null)
        private set

    var status by mutableStateOf("Not connected")
        private set

    var connected by mutableStateOf(false)
        private set

    var synced by mutableStateOf(false)
        private set

    var signedIn by mutableStateOf(false)
        private set

    var error by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
        private set

    var sending by mutableStateOf(false)
        private set

    var uploading by mutableStateOf(false)
        private set

    var paging by mutableStateOf(false)
        private set

    var cloudLoading by mutableStateOf(false)
        private set

    var diffLoading by mutableStateOf(false)
        private set

    var inputsReady by mutableStateOf(false)
        private set

    var draft by mutableStateOf("")
        private set

    var olderSequence by mutableStateOf<Long?>(null)
        private set

    var activeTurnId by mutableStateOf<String?>(null)
        private set

    var pairingLink by mutableStateOf<String?>(null)
    private var rpc: RpcClient? = null
    private var connectionJob: Job? = null
    private var timelineJob: Job? = null
    private var diffJob: Job? = null
    private var inputJob: Job? = null
    private var draftRevision = 0L
    private var formRevision = 0L
    private var flushRequested = false
    private val requestedRetries = HashSet<String>()
    private var checkpointJob: Job? = null
    private var generation = UUID.randomUUID()
    private var sessionGeneration = UUID.randomUUID()
    private var transcript = Transcript()
    private val rowIndices = HashMap<String, Int>()
    private var foreground = true

    private fun uuid() = UUID.randomUUID().toString()

    private val cloud
        get() = CloudClient(BuildConfig.API_URL, account::token)

    private fun identity(): String =
        when (val source = source) {
            is Source.Device -> "device:${source.device.id}"
            is Source.Cloud -> "${account.identity}|workspace:${source.chat.workspaceId}"
            is Source.Computer -> "${account.identity}|computer:${source.device.environmentId}"
            null -> "disconnected"
        }

    val conversationKey: String
        get() = "${identity()}|${selectedSession?.id.orEmpty()}"

    private fun archiveKey(session: Session) = "${identity()}|${session.id}"

    init {
        action {
            vault.read("devices")?.let {
                devices.addAll(WireJson.decodeFromString<List<SavedDevice>>(it))
            }
            account.hydrate()
            signedIn = account.signedIn
            if (signedIn) refreshCloud()
            val previous = vault.read("last-source")?.let(WireJson::parseToJsonElement)
            if (previous != null) {
                val target: Source = previous.field("source").decode()
                if (
                    (target is Source.Device && devices.any { it.id == target.device.id }) ||
                        (signedIn && previous.text("account") == account.identity)
                )
                    connect(target)
            }
        }
    }

    private fun action(block: suspend () -> Unit): Job =
        viewModelScope.launch {
            try {
                block()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                error = failure.message ?: "The operation failed. Try again."
            }
        }

    fun handleLink(uri: Uri) {
        if (uri.host == "fixture" && BuildConfig.DEBUG) {
            val address = uri.getQueryParameter("address") ?: return
            require(java.net.URI(address).host in listOf("127.0.0.1", "localhost"))
            connect(Source.Device(SavedDevice(uuid(), "Local test fixture", address, "")))
            return
        }
        if (uri.host == "preview" && BuildConfig.DEBUG) {
            loadPreview(uri.getQueryParameter("large") == "true")
            return
        }
        if (uri.host == "auth")
            action {
                account.callback(uri)
                signedIn = account.signedIn
                refreshCloud()
            }
        else pairingLink = uri.toString()
    }

    private fun loadPreview(large: Boolean) {
        if (!BuildConfig.DEBUG) return
        disconnect()
        val project = Project("preview-project", "zuse")
        val session =
            Session(
                "preview-session",
                project.id,
                "Build something worth using",
                "claude",
                "Sonnet 5.5",
            )
        projects.add(project)
        selectedProject = project
        sessions.add(session)
        selectedSession = session
        status = "Preview · sample data"
        inputsReady = true
        val samples =
            listOf(
                Message(
                    "user",
                    session.id,
                    "user",
                    obj(
                        "_tag" to "text".json(),
                        "text" to "Tighten the chat layout and keep the composer compact.".json(),
                    ),
                ),
                Message(
                    "assistant",
                    session.id,
                    "assistant",
                    obj(
                        "_tag" to "text".json(),
                        "text" to
                            "I’ll follow the mobile app’s spacing, simplify the header, and keep the composer small until you start typing."
                                .json(),
                    ),
                ),
                Message(
                    "tool",
                    session.id,
                    "assistant",
                    obj(
                        "_tag" to "tool_use".json(),
                        "tool" to "Read · composer.tsx".json(),
                        "input" to obj("path" to "composer.tsx".json()),
                    ),
                ),
                Message(
                    "result",
                    session.id,
                    "assistant",
                    obj(
                        "_tag" to "text".json(),
                        "text" to
                            "### Updated\n\n- Native controls and keyboard behavior\n- A paged, recycling conversation\n- Your devices, one tap away\n\n```kotlin\nComposer(expanded = focused)\n```\n\nReady to review the changes?"
                                .json(),
                    ),
                ),
            )
        val rows =
            if (large)
                (0 until 10_000).map { index ->
                    Message(
                        "row-$index",
                        session.id,
                        if (index % 3 == 0) "user" else "assistant",
                        obj(
                            "_tag" to "text".json(),
                            "text" to
                                "Message $index · Native transcript performance fixture.".json(),
                        ),
                    )
                }
            else samples
        transcript = Transcript()
        transcript.restore(rows)
        rebuildRows()
    }

    fun signIn(open: (Uri) -> Unit) = action { open(account.authorize()) }

    fun signOut() = action {
        if (source is Source.Cloud || source is Source.Computer) disconnect()
        account.signOut()
        signedIn = false
        cloudChats.clear()
        computers.clear()
    }

    fun refreshCloud() = action {
        if (!signedIn || cloudLoading) return@action
        cloudLoading = true
        try {
            val epoch = account.identity
            supervisorScope {
                val chats = async { runCatching { cloud.chats() } }
                val environments = async { runCatching { cloud.environments() } }
                val loadedChats = chats.await()
                val loadedEnvironments = environments.await()
                if (epoch != account.identity || !signedIn) return@supervisorScope
                loadedChats
                    .onSuccess {
                        cloudChats.clear()
                        cloudChats.addAll(it)
                    }
                    .onFailure { error = it.message }
                loadedEnvironments
                    .onSuccess {
                        computers.clear()
                        computers.addAll(it)
                    }
                    .onFailure { error = it.message }
            }
        } finally {
            cloudLoading = false
        }
    }

    fun connect(next: Source) {
        persistDraft()
        connectionJob?.cancel()
        timelineJob?.cancel()
        diffJob?.cancel()
        checkpointJob?.cancel()
        rpc?.close()
        rpc = null
        generation = UUID.randomUUID()
        sessionGeneration = UUID.randomUUID()
        source = next
        val sourceRecord =
            obj(
                "source" to WireJson.encodeToJsonElement<Source>(next),
                "account" to account.identity.json(),
            )
        action { vault.write("last-source", sourceRecord.toString()) }
        connected = false
        synced = false
        projects.clear()
        sessions.clear()
        selectedProject = null
        selectedSession = null
        inputsReady = false
        messages.clear()
        rowIndices.clear()
        transcript = Transcript()
        pending.clear()
        attachments.clear()
        respondedUi.clear()
        uiDrafts.clear()
        draft = ""
        interactions = emptyList()
        activeTurnId = null
        startConnection()
    }

    private fun startConnection() {
        connectionJob?.cancel()
        val current = generation
        connectionJob =
            viewModelScope.launch {
                var attempt = 0
                try {
                    val previous =
                        vault.read("last-session:${identity()}")?.let {
                            WireJson.decodeFromString<Session>(it)
                        }
                    val target = source
                    if (
                        current == generation &&
                            selectedSession == null &&
                            previous != null &&
                            (target !is Source.Cloud || target.chat.sessionId == previous.id)
                    )
                        selectSession(previous)
                } catch (failure: Exception) {
                    error = "Could not restore the previous chat: ${failure.message}"
                }
                while (isActive && foreground && current == generation) {
                    var client: RpcClient? = null
                    try {
                        connected = false
                        synced = false
                        status = if (attempt == 0) "Connecting…" else "Reconnecting…"
                        client =
                            when (val target = source) {
                                is Source.Device ->
                                    RpcClient(
                                            target.device.address,
                                            token = target.device.token,
                                            http = pinnedHttp(target.device.certificatePin),
                                        )
                                        .also {
                                            it.connect()
                                            try {
                                                target.device.environmentId?.let { expected ->
                                                    require(
                                                        it.call("connect.describe")
                                                            .text("environmentId") == expected
                                                    ) {
                                                        "The computer identity changed. Pair again."
                                                    }
                                                }
                                            } catch (failure: Throwable) {
                                                it.close()
                                                throw failure
                                            }
                                        }
                                is Source.Cloud -> cloud.connect(target.chat.workspaceId)
                                is Source.Computer ->
                                    cloud.connectEnvironment(
                                        target.device.environmentId,
                                        withContext(Dispatchers.IO) { DeviceProof() }::sign,
                                    )
                                null -> return@launch
                            }
                        ensureActive()
                        if (current != generation) return@launch
                        rpc = client
                        val rows: List<Project> = client.call("workspace.list").decode()
                        ensureActive()
                        projects.clear()
                        projects.addAll(rows)
                        connected = true
                        status = "Connected"
                        val selected = selectedSession
                        if (selected != null) {
                            selectedProject = projects.find { it.id == selected.projectId }
                            loadSessions()
                            selectSession(selected)
                        } else if (source is Source.Cloud) {
                            val session: Session =
                                client
                                    .call(
                                        "session.get",
                                        obj(
                                            "sessionId" to
                                                (source as Source.Cloud).chat.sessionId.json()
                                        ),
                                    )
                                    .decode()
                            selectedProject = projects.find { it.id == session.projectId }
                            loadSessions()
                            selectSession(session)
                        } else {
                            selectedProject = projects.firstOrNull()
                            loadSessions()
                        }
                        loadModels()
                        attempt = 0
                        throw client.awaitDisconnect()
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (failure: Throwable) {
                        if (current != generation) return@launch
                        status = "Offline · retrying"
                        connected = false
                        synced = false
                        error = failure.message ?: "Connection interrupted."
                        timelineJob?.cancel()
                        client?.close()
                        rpc = null
                        delay((1_000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000))
                        attempt++
                    } finally {
                        if (!isActive || current != generation) client?.close()
                    }
                }
            }
    }

    fun reconnect() {
        if (source != null) {
            rpc?.close()
            startConnection()
        }
    }

    fun setForeground(value: Boolean) {
        if (foreground == value) return
        foreground = value
        if (!value) {
            persistDraft()
            connectionJob?.cancel()
            timelineJob?.cancel()
            rpc?.close()
            rpc = null
            connected = false
            synced = false
            status = "Paused"
        } else if (source != null) startConnection()
    }

    fun networkRecovered() {
        if (foreground && source != null && !connected) reconnect()
    }

    fun disconnect() {
        action { vault.write("last-source", null) }
        persistDraft()
        generation = UUID.randomUUID()
        sessionGeneration = UUID.randomUUID()
        connectionJob?.cancel()
        timelineJob?.cancel()
        diffJob?.cancel()
        rpc?.close()
        rpc = null
        source = null
        connected = false
        synced = false
        status = "Not connected"
        projects.clear()
        sessions.clear()
        messages.clear()
        rowIndices.clear()
        pending.clear()
        attachments.clear()
        respondedUi.clear()
        uiDrafts.clear()
        interactions = emptyList()
        selectedProject = null
        selectedSession = null
        inputsReady = false
        draft = ""
        activeTurnId = null
    }

    fun selectProject(project: Project) = action {
        selectedProject = project
        sessions.clear()
        loadSessions()
    }

    private suspend fun loadSessions() {
        val project = selectedProject ?: return
        val epoch = generation
        val rows: List<Session> =
            rpc?.call("session.list", obj("projectId" to project.id.json()))?.decode() ?: return
        if (epoch == generation && selectedProject?.id == project.id) {
            sessions.clear()
            sessions.addAll(rows)
        }
    }

    fun selectSession(session: Session) {
        persistDraft()
        timelineJob?.cancel()
        checkpointJob?.cancel()
        sessionGeneration = UUID.randomUUID()
        val current = sessionGeneration
        val same = selectedSession?.id == session.id
        selectedSession = session
        inputsReady = false
        synced = false
        olderSequence = null
        activeTurnId = null
        interactions = emptyList()
        paging = false
        sending = false
        uploading = false
        val key = archiveKey(session)
        val metadataKey = "last-session:${identity()}"
        action { vault.write(metadataKey, WireJson.encodeToString(session)) }
        if (!same) {
            draftRevision = 0
            formRevision = 0
            requestedRetries.clear()
            transcript = Transcript()
            messages.clear()
            rowIndices.clear()
            draft = ""
            pending.clear()
            attachments.clear()
            respondedUi.clear()
            uiDrafts.clear()
        }
        timelineJob =
            viewModelScope.launch {
                try {
                    val metadata = vault.readMetadata(key)
                    ensureActive()
                    if (!same || metadata.draftRevision > draftRevision) {
                        draft = metadata.draft
                        draftRevision = metadata.draftRevision
                    }
                    if (!same || metadata.formRevision > formRevision) {
                        uiDrafts.clear()
                        uiDrafts.putAll(metadata.uiDrafts)
                        formRevision = metadata.formRevision
                    }
                    pending.clear()
                    pending.addAll(metadata.pending)
                    attachments.clear()
                    attachments.addAll(metadata.attachments)
                    respondedUi.clear()
                    respondedUi.addAll(metadata.responses.keys)
                    inputsReady = true
                    if (!same) {
                        val history = vault.readHistory(key)
                        ensureActive()
                        transcript.restore(history)
                        rebuildRows()
                    }
                    val client = rpc ?: return@launch
                    client
                        .stream(
                            "session.events",
                            obj("sessionId" to session.id.json(), "includeRuntime" to true.json()),
                        )
                        .collect { frame ->
                            ensureActive()
                            check(current == sessionGeneration)
                            transcript.apply(frame, session.id)
                            publishFrame(frame)
                            if (frame.text("kind") == "synchronized") {
                                synced = true
                                status = "Connected"
                                flushOutbox()
                            }
                            scheduleCheckpoint(key, current)
                        }
                    throw ClientException("Transcript stream ended. Reconnecting…")
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    if (current == sessionGeneration) {
                        synced = false
                        error = failure.message
                        rpc?.close()
                    }
                }
            }
    }

    private fun publishFrame(frame: JsonElement) {
        val event = frame.field("event")
        if (frame.text("kind") == "event" && event.text("_tag") == "MessagePersisted") {
            val id = event.field("message").text("id")
            val index = rowIndices[id]
            if (index != null) messages[index] = transcript.messages[index]
            else if (transcript.messages.size > messages.size) {
                val row = transcript.messages.last()
                rowIndices[row.id] = messages.size
                messages.add(row)
            }
        } else if (
            frame.text("kind") in listOf("snapshot", "snapshot-chunk") ||
                event.text("_tag") == "TranscriptRolledBack"
        )
            rebuildRows()
        olderSequence = transcript.olderSequence
        activeTurnId = transcript.activeTurnId
        interactions = transcript.interactions
    }

    private fun rebuildRows() {
        messages.clear()
        messages.addAll(transcript.messages)
        rowIndices.clear()
        messages.forEachIndexed { index, row -> rowIndices[row.id] = index }
    }

    private fun scheduleCheckpoint(key: String, current: UUID) {
        if (checkpointJob?.isActive == true) return
        checkpointJob =
            viewModelScope.launch {
                delay(1000)
                if (current == sessionGeneration) {
                    val history = transcript.messages.toList()
                    try {
                        vault.saveHistory(key, history)
                    } catch (failure: Exception) {
                        error = "Could not save chat history: ${failure.message}"
                    }
                }
            }
    }

    private fun inputsSnapshot() =
        SessionInputs(draftRevision, draft, formRevision, uiDrafts.toMap())

    private fun scheduleInputs() {
        inputJob?.cancel()
        val key = selectedSession?.let(::archiveKey) ?: return
        val inputs = inputsSnapshot()
        inputJob = action {
            delay(250)
            vault.updateMetadata(key) { it.withInputs(inputs) }
        }
    }

    fun updateDraft(value: String) {
        if (!inputsReady || draft == value) return
        draft = value
        draftRevision++
        scheduleInputs()
    }

    private fun persistDraft() {
        inputJob?.cancel()
        if (!inputsReady) return
        val key = selectedSession?.let(::archiveKey) ?: return
        val inputs = inputsSnapshot()
        action { vault.updateMetadata(key) { it.withInputs(inputs) } }
    }

    fun updateUiDraft(message: Message, name: String, value: JsonElement) {
        val session = selectedSession ?: return
        if (!inputsReady || message.sessionId != session.id) return
        uiDrafts[message.id] = uiDrafts[message.id].orEmpty() + (name to value)
        formRevision++
        scheduleInputs()
    }

    fun loadOlder() = action {
        val session = selectedSession ?: return@action
        val before = olderSequence ?: return@action
        val client = rpc ?: return@action
        if (paging) return@action
        val current = sessionGeneration
        paging = true
        try {
            val page =
                client.call(
                    "session.messages.page",
                    obj(
                        "sessionId" to session.id.json(),
                        "beforeSequence" to before.json(),
                        "limit" to 100.json(),
                    ),
                )
            if (current == sessionGeneration) {
                transcript.prependPage(page, session.id)
                rebuildRows()
                olderSequence = transcript.olderSequence
            }
        } finally {
            if (current == sessionGeneration) paging = false
        }
    }

    fun send() = action {
        val session = selectedSession ?: return@action
        if (!inputsReady || sending || uploading || (draft.isBlank() && attachments.isEmpty()))
            return@action
        val current = sessionGeneration
        val key = archiveKey(session)
        val text = draft
        val refs = attachments.toList()
        sending = true
        inputJob?.cancel()
        draftRevision++
        val submittedInputs = inputsSnapshot().copy(draft = "")
        try {
            val item = PendingMessage(uuid(), uuid(), session.id, text.trim(), attachments = refs)
            val archive =
                vault.updateMetadata(key) {
                    it.copy(
                            attachments = it.attachments.filterNot { ref -> ref in refs },
                            pending = it.pending + item,
                        )
                        .withInputs(submittedInputs)
                }
            if (current != sessionGeneration) return@action
            if (draftRevision == submittedInputs.draftRevision) draft = ""
            attachments.removeAll(refs.toSet())
            pending.clear()
            pending.addAll(archive.pending)
        } finally {
            if (current == sessionGeneration) sending = false
        }
        if (current == sessionGeneration) flushOutbox()
    }

    fun flushOutbox(retryId: String? = null) = action {
        if (retryId != null) requestedRetries.add(retryId)
        if (sending) {
            flushRequested = true
            return@action
        }
        if (!synced) return@action
        val session = selectedSession ?: return@action
        val key = archiveKey(session)
        val client = rpc ?: return@action
        val current = sessionGeneration
        sending = true
        try {
            do {
                flushRequested = false
                val queued = vault.readMetadata(key).pending
                if (current != sessionGeneration || !synced) break
                pending.clear()
                pending.addAll(queued)
                for (item in queued) {
                    if (current != sessionGeneration || !synced) break
                    val retry = requestedRetries.remove(item.id)
                    if (item.attempted && !retry) continue
                    val archive =
                        vault.updateMetadata(key) {
                            it.copy(
                                pending =
                                    it.pending.map { old ->
                                        if (old.id == item.id) old.copy(attempted = true) else old
                                    }
                            )
                        }
                    if (current != sessionGeneration) break
                    pending.clear()
                    pending.addAll(archive.pending)
                    client.call("messages.send", item.payload)
                    val updated =
                        vault.updateMetadata(key) {
                            it.copy(pending = it.pending.filterNot { p -> p.id == item.id })
                        }
                    if (current == sessionGeneration) {
                        pending.clear()
                        pending.addAll(updated.pending)
                    }
                }
            } while (flushRequested && current == sessionGeneration && synced)
        } finally {
            if (current == sessionGeneration) sending = false
        }
    }

    suspend fun respondToUi(message: Message, text: String) {
        val session = selectedSession ?: throw ClientException("Open this chat to respond.")
        require(inputsReady && session.id == message.sessionId && source != null) {
            "Open this chat on its connected device to respond."
        }
        require(text.length <= 64 * 1024) { "This response is too large." }
        val current = sessionGeneration
        val item = PendingMessage(uuid(), uuid(), session.id, text)
        formRevision++
        val submittedInputs = inputsSnapshot().copy(uiDrafts = uiDrafts.toMap() - message.id)
        val updated =
            vault.updateMetadata(archiveKey(session)) { record ->
                if (record.responses.containsKey(message.id)) record
                else
                    record
                        .copy(
                            pending = record.pending + item,
                            responses = record.responses + (message.id to item.id),
                        )
                        .withInputs(submittedInputs)
            }
        if (current == sessionGeneration) {
            pending.clear()
            pending.addAll(updated.pending)
            respondedUi.clear()
            respondedUi.addAll(updated.responses.keys)
            uiDrafts.remove(message.id)
            flushOutbox()
        }
    }

    fun removePending(id: String) = action {
        if (sending) return@action
        val key = selectedSession?.let(::archiveKey) ?: return@action
        val current = sessionGeneration
        val updated =
            vault.updateMetadata(key) {
                it.copy(pending = it.pending.filterNot { p -> p.id == id })
            }
        if (current == sessionGeneration) {
            pending.clear()
            pending.addAll(updated.pending)
            requestedRetries.remove(id)
            flushOutbox()
        }
    }

    fun changeModel(model: ModelChoice) = action {
        val session = selectedSession ?: return@action
        val current = sessionGeneration
        val method =
            if (model.provider == session.providerId) "session.setModel" else "session.setProvider"
        rpc?.call(
            method,
            obj(
                "sessionId" to session.id.json(),
                "model" to model.id.json(),
                "providerId" to
                    if (model.provider != session.providerId) model.provider.json() else null,
            ),
        ) ?: return@action
        if (current == sessionGeneration)
            selectedSession = session.copy(providerId = model.provider, model = model.id)
    }

    suspend fun readFile(path: String): List<String> {
        val session = selectedSession ?: throw ClientException("Open a chat first.")
        val result =
            rpc?.call(
                "git.reviewFileContents",
                obj(
                    "folderId" to session.projectId.json(),
                    "path" to path.json(),
                    "worktreeId" to session.worktreeId?.json(),
                ),
            ) ?: throw ClientException("Reconnect to view this file.")
        val content =
            result.text("newContent")
                ?: throw ClientException("This file was removed or has no text content.")
        return withContext(Dispatchers.Default) { content.split('\n') }
    }

    fun stop() = action {
        val session = selectedSession ?: return@action
        val turn = activeTurnId ?: return@action
        rpc?.call(
            "messages.interrupt",
            obj(
                "sessionId" to session.id.json(),
                "commandId" to uuid().json(),
                "expectedTurnId" to turn.json(),
            ),
        )
    }

    private suspend fun loadModels() {
        val epoch = generation
        val catalog = rpc?.call("model.catalog") ?: return
        if (epoch != generation) return
        val options = modelChoices(catalog, availableOnly = true)
        models.clear()
        models.addAll(options)
    }

    fun loadBranches() = action {
        val project = selectedProject ?: return@action
        val epoch = generation
        val result: List<Branch> =
            rpc?.call("git.branches", obj("folderId" to project.id.json()))?.decode()
                ?: return@action
        if (epoch == generation && selectedProject?.id == project.id) {
            branches.clear()
            branches.addAll(result)
        }
    }

    fun createChat(
        model: ModelChoice,
        branch: Branch?,
        fresh: Boolean,
        initialPrompt: String = "",
        done: () -> Unit,
    ) = action {
        if (busy) return@action
        val project = selectedProject ?: throw ClientException("Choose a connected project.")
        val client = rpc ?: return@action
        val epoch = generation
        val archiveIdentity = identity()
        busy = true
        try {
            // Branch selection is a server-side checkout; surface errors before creating a chat.
            if (branch != null && !branch.current && !fresh)
                client.call(
                    "git.switchBranch",
                    obj(
                        "folderId" to project.id.json(),
                        "branch" to branch.name.json(),
                        "remote" to branch.remote?.json(),
                    ),
                )
            val intentKey = "chat-create:$archiveIdentity:${project.id}"
            val (request, savedPrompt) =
                vault.prepareChatIntent(
                    intentKey,
                    obj(
                        "projectId" to project.id.json(),
                        "providerId" to model.provider.json(),
                        "model" to model.id.json(),
                        "runtimeMode" to "approval-required".json(),
                        "workspacePolicy" to obj("_tag" to (if (fresh) "fresh" else "main").json()),
                    ),
                    initialPrompt,
                )
            val response =
                try {
                    client.call("chat.create", request)
                } catch (failure: RpcRequestFailure) {
                    vault.write(intentKey, null)
                    throw failure
                }
            val created: Session = response.field("initialSession").decode()
            if (savedPrompt.isNotBlank() || initialPrompt != savedPrompt) {
                val operation = requireNotNull(request.text("operationId"))
                val item =
                    PendingMessage(
                        operation,
                        UUID.nameUUIDFromBytes(("initial:" + operation).toByteArray()).toString(),
                        created.id,
                        savedPrompt.trim(),
                    )
                vault.updateMetadata("$archiveIdentity|${created.id}") { record ->
                    var updated =
                        if (savedPrompt.isBlank() || record.pending.any { it.id == item.id }) record
                        else record.copy(pending = record.pending + item)
                    if (initialPrompt != savedPrompt)
                        updated =
                            updated.copy(
                                draftRevision = updated.draftRevision + 1,
                                draft = initialPrompt,
                            )
                    updated
                }
            }
            vault.write(intentKey, null)
            if (epoch == generation) {
                selectSession(created)
                done()
                loadSessions()
                if (initialPrompt != savedPrompt)
                    error =
                        "Recovered the previous chat. Your edited message is saved in the composer."
            } else {
                done()
                error = "Chat created on the original computer. Open it there to continue."
            }
        } finally {
            busy = false
        }
    }

    fun permission(id: String, allow: Boolean) = action {
        rpc?.call(
            "permission.decide",
            obj(
                "requestId" to id.json(),
                "decision" to obj("_tag" to (if (allow) "AllowOnce" else "Deny").json()),
            ),
        )
    }

    fun answer(id: String, answers: JsonArray) = action {
        val session = selectedSession ?: return@action
        rpc?.call(
            "session.answerQuestion",
            obj(
                "sessionId" to session.id.json(),
                "commandId" to uuid().json(),
                "itemId" to id.json(),
                "answers" to answers,
            ),
        )
    }

    fun plan(id: String, outcome: String) = action {
        val session = selectedSession ?: return@action
        rpc?.call(
            "session.plan.respond",
            obj(
                "sessionId" to session.id.json(),
                "commandId" to uuid().json(),
                "toolCallId" to id.json(),
                "outcome" to outcome.json(),
            ),
        )
    }

    fun loadDiff(scope: String) {
        diffJob?.cancel()
        patches.clear()
        val session = selectedSession ?: return
        val client = rpc ?: return
        val current = sessionGeneration
        diffJob = action {
            diffLoading = true
            try {
                client
                    .stream(
                        "git.reviewPatches",
                        obj(
                            "folderId" to session.projectId.json(),
                            "scope" to scope.json(),
                            "worktreeId" to session.worktreeId?.json(),
                        ),
                    )
                    .collect { frame ->
                        val result = frame.field("result")
                        val lines =
                            withContext(Dispatchers.Default) {
                                DiffLine.parse(result.text("patch").orEmpty())
                            }
                        if (current == sessionGeneration)
                            patches.add(
                                Patch(
                                    frame.text("path") ?: "Unknown file",
                                    lines,
                                    result.text("mode").orEmpty(),
                                    result.flag("truncated"),
                                    frame.text("error"),
                                )
                            )
                    }
            } finally {
                diffLoading = false
            }
        }
    }

    fun closeDiff() {
        diffJob?.cancel()
    }

    fun openAttachment(reference: JsonElement, sessionId: String) = action {
        require(selectedSession?.id == sessionId) { "Open this chat to view its attachments." }
        val result =
            rpc?.call(
                "attachments.read",
                obj("id" to reference.field("id"), "sessionId" to sessionId.json()),
            ) ?: throw ClientException("Reconnect to view this attachment.")
        val encoded = result.text("bytes") ?: throw ClientException("Missing attachment data.")
        require(encoded.length <= 100 * 1024 * 1024 * 4 / 3 + 8) {
            "Attachment exceeds the supported size."
        }
        val file =
            withContext(Dispatchers.IO) {
                val directory = java.io.File(app.cacheDir, "previews").apply { mkdirs() }
                directory
                    .listFiles()
                    ?.filter { System.currentTimeMillis() - it.lastModified() > 86_400_000 }
                    ?.forEach { it.delete() }
                val name =
                    (reference.text("originalName") ?: "Attachment")
                        .substringAfterLast('/')
                        .substringAfterLast('\\')
                        .takeLast(100)
                java.io.File(directory, "${uuid()}-$name").also {
                    it.writeBytes(Base64.decode(encoded, Base64.DEFAULT))
                }
            }
        val uri =
            androidx.core.content.FileProvider.getUriForFile(
                app,
                "${BuildConfig.APPLICATION_ID}.files",
                file,
            )
        val intent =
            android.content
                .Intent(android.content.Intent.ACTION_VIEW)
                .setDataAndType(
                    uri,
                    result.text("mimeType")
                        ?: reference.text("mimeType")
                        ?: "application/octet-stream",
                )
                .addFlags(
                    android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                )
        try {
            app.startActivity(intent)
        } catch (_: android.content.ActivityNotFoundException) {
            throw ClientException("No installed app can open this file type.")
        }
    }

    fun removeAttachment(ref: JsonElement) = action {
        attachments.remove(ref)
        val key = selectedSession?.let(::archiveKey) ?: return@action
        val refs = attachments.toList()
        vault.updateMetadata(key) { it.copy(attachments = refs) }
    }

    fun attach(uri: Uri) = action {
        if (uploading || !synced) return@action
        val session = selectedSession ?: return@action
        val key = archiveKey(session)
        val current = sessionGeneration
        val client = rpc ?: return@action
        uploading = true
        try {
            val ref =
                withContext(Dispatchers.IO) {
                    val resolver = app.contentResolver
                    val name =
                        resolver
                            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                            ?.use { if (it.moveToFirst()) it.getString(0) else null }
                            ?: "Attachment"
                    val mime = resolver.getType(uri) ?: "application/octet-stream"
                    val cache = java.io.File.createTempFile("attachment", null, app.cacheDir)
                    try {
                        var total = 0L
                        resolver.openInputStream(uri)?.use { input ->
                            cache.outputStream().use { output ->
                                val buffer = ByteArray(64 * 1024)
                                while (true) {
                                    ensureActive()
                                    val count = input.read(buffer)
                                    if (count < 0) break
                                    total += count
                                    require(total <= 100L * 1024 * 1024) {
                                        "Attachments must be 100 MB or smaller."
                                    }
                                    output.write(buffer, 0, count)
                                }
                            }
                        } ?: throw ClientException("Could not open this file.")
                        val uploadId = uuid()
                        val chunk = ByteArray(2 * 1024 * 1024)
                        var offset = 0L
                        var result: JsonElement = JsonNull
                        cache.inputStream().use { input ->
                            do {
                                ensureActive()
                                var size = 0
                                while (size < chunk.size) {
                                    val read = input.read(chunk, size, chunk.size - size)
                                    if (read < 0) break
                                    size += read
                                }
                                val base =
                                    obj(
                                        "sessionId" to session.id.json(),
                                        "mimeType" to mime.json(),
                                        "originalName" to name.json(),
                                        "bytes" to
                                            Base64.encodeToString(
                                                    chunk.copyOf(size),
                                                    Base64.NO_WRAP,
                                                )
                                                .json(),
                                    )
                                result =
                                    if (total <= chunk.size) client.call("attachments.upload", base)
                                    else
                                        client.call(
                                            "attachments.uploadChunk",
                                            JsonObject(
                                                base +
                                                    mapOf(
                                                        "uploadId" to uploadId.json(),
                                                        "offset" to offset.json(),
                                                        "totalBytes" to total.json(),
                                                    )
                                            ),
                                        )
                                offset += size
                                require((offset == total) == (result != JsonNull)) {
                                    "The file upload did not complete."
                                }
                            } while (offset < total)
                        }
                        require(result.text("id") != null)
                        obj(
                            "id" to result.field("id"),
                            "mimeType" to mime.json(),
                            "originalName" to name.json(),
                        )
                    } finally {
                        cache.delete()
                    }
                }
            vault.updateMetadata(key) { it.copy(attachments = it.attachments + ref) }
            if (current == sessionGeneration) attachments.add(ref)
        } finally {
            if (current == sessionGeneration) uploading = false
        }
    }

    fun saveDevice(label: String, address: String, token: String, pin: String? = null) = action {
        Endpoint.validate(address)
        require(label.isNotBlank()) { "Give this device a name." }
        val next =
            SavedDevice(uuid(), label.trim(), address.trim(), token.trim(), certificatePin = pin)
        vault.write("devices", WireJson.encodeToString(devices.toList() + next))
        devices.add(next)
        connect(Source.Device(next))
    }

    fun forgetDevice(device: SavedDevice) = action {
        if ((source as? Source.Device)?.device?.id == device.id) disconnect()
        val remaining = devices.filterNot { it.id == device.id }
        vault.write("devices", WireJson.encodeToString(remaining))
        devices.remove(device)
    }

    fun pair(link: String, label: String, pin: String? = null, done: () -> Unit) = action {
        if (busy) return@action
        busy = true
        try {
            val pairing = Endpoint.pairing(link)
            val deviceId = vault.read("device-id") ?: uuid().also { vault.write("device-id", it) }
            val result =
                withContext(Dispatchers.IO) {
                    val request =
                        Request.Builder()
                            .url(pairing.http + "/pair")
                            .post(
                                obj(
                                        "code" to pairing.code.json(),
                                        "deviceId" to deviceId.json(),
                                        "deviceLabel" to "Zuse Android".json(),
                                    )
                                    .toString()
                                    .toRequestBody("application/json".toMediaType())
                            )
                            .build()
                    pinnedHttp(pin)
                        .newBuilder()
                        .callTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                        .readTimeout(15, java.util.concurrent.TimeUnit.SECONDS)
                        .build()
                        .newCall(request)
                        .execute()
                        .use { response ->
                            require(response.isSuccessful) {
                                if (response.code == 410)
                                    "Pairing code expired. Generate a new code."
                                else "Pairing failed. Check the code and address."
                            }
                            WireJson.parseToJsonElement(response.body?.string().orEmpty())
                        }
                }
            val token = result.text("token") ?: throw ClientException("Missing pairing token.")
            require(token.startsWith("zt_"))
            val device =
                SavedDevice(
                    uuid(),
                    label.ifBlank { "Computer" },
                    pairing.websocket,
                    token,
                    result.text("environmentId"),
                    pin,
                )
            vault.write("devices", WireJson.encodeToString(devices.toList() + device))
            devices.add(device)
            connect(Source.Device(device))
            pairingLink = null
            done()
        } finally {
            busy = false
        }
    }

    override fun onCleared() {
        rpc?.close()
        super.onCleared()
    }
}

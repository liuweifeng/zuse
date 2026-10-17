package sh.zuse.core

import java.io.Closeable
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okio.ByteString

/** A client owns one socket generation. Requests and mutations are never replayed. */
class RpcClient(
    private val address: String,
    private val protocols: List<String> = emptyList(),
    private val token: String? = null,
    private val http: OkHttpClient = defaultHttp(),
) : Closeable {
    private val pending = ConcurrentHashMap<String, Channel<JsonElement>>()
    private val ready = CompletableDeferred<Unit>()
    private val connected = CompletableDeferred<Unit>()
    private val terminal = CompletableDeferred<Throwable>()
    @Volatile private var closed = false
    @Volatile private var available = !protocols.contains("zuse-workspace-v3")
    private var socket: WebSocket? = null

    suspend fun connect() {
        check(socket == null && !closed)
        Endpoint.validate(address)
        val base = address.replaceFirst("wss://", "https://").replaceFirst("ws://", "http://")
        val url =
            base
                .toHttpUrl()
                .newBuilder()
                .setQueryParameter("wireVersion", "7")
                .apply { if (!token.isNullOrEmpty()) setQueryParameter("token", token) }
                .build()
        val request =
            Request.Builder()
                .url(url)
                .apply {
                    if (protocols.isNotEmpty())
                        header("Sec-WebSocket-Protocol", protocols.joinToString(", "))
                }
                .build()
        socket =
            http.newWebSocket(
                request,
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        connected.complete(Unit)
                        if (available) ready.complete(Unit)
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) = receive(text)

                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) =
                        receive(bytes.utf8())

                    override fun onFailure(
                        webSocket: WebSocket,
                        t: Throwable,
                        response: Response?,
                    ) {
                        fail(ClientException("Connection lost. Reconnect to synchronize."))
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(code, null)
                        fail(ClientException("The server closed the connection."))
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        fail(ClientException("The connection ended."))
                    }
                },
            )
        try {
            withTimeout(45_000) {
                connected.await()
                ready.await()
            }
            val welcome = call("connect.handshake", obj("protocolVersion" to 7.json()))
            require(welcome.long("protocolVersion") == 7L) {
                "Update the runtime and app to compatible versions."
            }
        } catch (error: Throwable) {
            close()
            throw error
        }
    }

    suspend fun call(method: String, payload: JsonObject = obj()): JsonElement =
        try {
            withTimeout(30_000) {
                var result: JsonElement = JsonNull
                stream(method, payload).collect { result = it }
                result
            }
        } catch (_: TimeoutCancellationException) {
            throw ClientException(
                "The request timed out. Its outcome may be unknown; refresh before retrying."
            )
        }

    fun stream(method: String, payload: JsonObject = obj()): Flow<JsonElement> = flow {
        check(!closed && available) { "The connection is unavailable." }
        val id = UUID.randomUUID().toString()
        val channel = Channel<JsonElement>(512)
        pending[id] = channel
        if (closed) {
            pending.remove(id)
            channel.close(ClientException("Connection closed."))
        }
        try {
            send(
                obj(
                    "_tag" to "Request".json(),
                    "id" to id.json(),
                    "tag" to method.json(),
                    "payload" to payload,
                    "headers" to JsonArray(emptyList()),
                )
            )
            for (value in channel) emit(value)
        } finally {
            if (pending.remove(id) != null && !closed)
                runCatching { send(obj("_tag" to "Interrupt".json(), "requestId" to id.json())) }
            channel.cancel()
        }
    }

    suspend fun awaitDisconnect(): Throwable = terminal.await()

    private fun receive(text: String) {
        try {
            val parsed = WireJson.parseToJsonElement(text)
            (if (parsed is JsonArray) parsed.toList() else listOf(parsed)).forEach(::frame)
        } catch (error: Throwable) {
            fail(error)
        }
    }

    private fun frame(frame: JsonElement) {
        if (frame.text("_zuseGateway") == "availability") {
            if (frame.flag("reset") || (available && frame.text("state") != "available"))
                throw ClientException("The workspace runtime changed. Reconnect to continue.")
            if (frame.text("state") == "available") {
                available = true
                ready.complete(Unit)
            }
            return
        }
        when (frame.text("_tag")) {
            "Ping" -> {
                send(obj("_tag" to "Pong".json()))
                return
            }
            "Pong" -> return
            "Defect" -> throw ClientException("The runtime rejected the connection.")
        }
        val id = frame.text("requestId") ?: return
        val channel = pending[id] ?: return
        when (frame.text("_tag")) {
            "Chunk" -> {
                frame.array("values").forEach { if (!offer(channel, it)) return }
                send(obj("_tag" to "Ack".json(), "requestId" to id.json()))
            }
            "Exit" -> {
                val exit = frame.field("exit")
                if (exit.text("_tag") == "Success") {
                    val value = exit.field("value")
                    if (value != JsonNull && !offer(channel, value)) return
                    pending.remove(id)
                    channel.close()
                } else {
                    pending.remove(id)
                    val error = exit.array("cause").firstOrNull()?.field("error")
                    channel.close(
                        RpcRequestFailure(
                            error?.text("_tag"),
                            error?.text("message")
                                ?: error?.text("_tag")
                                ?: "The runtime rejected the request.",
                        )
                    )
                }
            }
        }
    }

    private fun offer(channel: Channel<JsonElement>, value: JsonElement): Boolean {
        val result = channel.trySend(value)
        // Cancellation may race a frame already read from the socket. It does not invalidate other
        // requests.
        if (result.isClosed) return false
        if (result.isFailure)
            throw ClientException("Response buffer exceeded. Reconnect to recover missing updates.")
        return true
    }

    private fun send(value: JsonElement) {
        check(socket?.send(value.toString()) == true) {
            "The request could not be sent. Reconnect before retrying."
        }
    }

    @Synchronized
    private fun fail(error: Throwable) {
        if (closed) return
        closed = true
        connected.completeExceptionally(error)
        ready.completeExceptionally(error)
        terminal.complete(error)
        pending.values.forEach { it.close(error) }
        pending.clear()
        socket?.cancel()
    }

    override fun close() = fail(ClientException("Connection closed."))

    companion object {
        fun defaultHttp(): OkHttpClient =
            OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .build()
    }
}

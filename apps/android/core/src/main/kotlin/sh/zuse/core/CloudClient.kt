package sh.zuse.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody

class CloudClient(
    val baseUrl: String,
    private val token: suspend () -> String,
    private val http: OkHttpClient =
        RpcClient.defaultHttp()
            .newBuilder()
            .callTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .readTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
            .build(),
) {
    suspend fun request(
        path: String,
        method: String = "GET",
        body: JsonElement? = null,
        proof: ((String, String) -> String)? = null,
        deviceToken: String? = null,
    ): JsonElement {
        val base = baseUrl.toHttpUrl()
        require(base.isHttps && base.username.isEmpty() && base.password.isEmpty()) {
            "Cloud requires HTTPS."
        }
        val url = base.resolve(path) ?: throw ClientException("Invalid cloud address.")
        require(url.host == base.host && url.port == base.port && url.isHttps)
        val credential = deviceToken ?: token()
        return withContext(Dispatchers.IO) {
            val builder =
                Request.Builder()
                    .url(url)
                    .header(
                        "Authorization",
                        "${if (deviceToken == null) "Bearer" else "DPoP"} $credential",
                    )
            if (proof != null) builder.header("DPoP", proof(method, url.toString()))
            builder.method(
                method,
                if (method == "GET" || method == "HEAD") null
                else (body ?: obj()).toString().toRequestBody("application/json".toMediaType()),
            )
            http.newCall(builder.build()).execute().use { response ->
                if (!response.isSuccessful)
                    throw HttpRequestFailure(
                        response.code,
                        if (response.code == 401) "Your account session expired. Sign in again."
                        else "Cloud request failed (${response.code}).",
                    )
                val text = response.body?.string().orEmpty()
                if (text.isBlank()) JsonNull else WireJson.parseToJsonElement(text)
            }
        }
    }

    suspend fun chats(): List<CloudChat> =
        request("/v1/cloud/chats?scope=active").field("chats").decode()

    suspend fun environments(): List<RemoteEnvironment> =
        request("/v1/environments").field("environments").decode()

    suspend fun connect(workspaceId: String): RpcClient {
        val id =
            HttpUrl.Builder()
                .scheme("https")
                .host("local")
                .addPathSegment(workspaceId)
                .build()
                .encodedPath
                .removePrefix("/")
        val ticket =
            request(
                "/v1/cloud/workspaces/$id/gateway/ticket",
                "POST",
                obj("protocol" to "zuse-workspace-v3".json()),
            )
        val address =
            ticket.text("wsUrl") ?: throw ClientException("Missing cloud gateway address.")
        require(address.startsWith("wss://"))
        val protocols =
            listOf(
                ticket.text("protocol") ?: throw ClientException("Missing gateway protocol."),
                ticket.text("credential") ?: throw ClientException("Missing gateway credential."),
            )
        return RpcClient(address, protocols).also { it.connect() }
    }

    suspend fun connectEnvironment(id: String, proof: (String, String) -> String): RpcClient {
        val grant = request("/v1/client/dpop-token", "POST", proof = proof)
        val encoded =
            HttpUrl.Builder()
                .scheme("https")
                .host("local")
                .addPathSegment(id)
                .build()
                .encodedPath
                .removePrefix("/")
        val connection =
            request(
                "/v1/environments/$encoded/connect",
                "POST",
                proof = proof,
                deviceToken =
                    grant.text("accessToken") ?: throw ClientException("Missing device grant."),
            )
        val endpoint =
            connection.field("endpoint").text("wsBaseUrl")
                ?: throw ClientException("Missing computer address.")
        require(endpoint.startsWith("wss://"))
        val rpc =
            RpcClient(
                endpoint,
                token =
                    connection.text("connectToken")
                        ?: throw ClientException("Missing connection grant."),
            )
        try {
            rpc.connect()
            require(rpc.call("connect.describe").text("environmentId") == id) {
                "The computer identity changed."
            }
            return rpc
        } catch (error: Throwable) {
            rpc.close()
            throw error
        }
    }
}

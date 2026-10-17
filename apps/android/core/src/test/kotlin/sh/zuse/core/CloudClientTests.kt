package sh.zuse.core

import kotlin.test.*
import kotlinx.coroutines.runBlocking
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate

class CloudClientTests {
    @Test
    fun `cloud requests keep bearer tokens on the configured secure origin and reject redirects`() =
        runBlocking {
            val certificate =
                HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
            val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
            val trusted =
                HandshakeCertificates.Builder()
                    .addTrustedCertificate(certificate.certificate)
                    .build()
            val server = MockWebServer()
            server.useHttps(serverTls.sslSocketFactory(), false)
            server.enqueue(MockResponse().setBody("{\"chats\":[]}"))
            server.enqueue(
                MockResponse()
                    .setResponseCode(302)
                    .setHeader("Location", "https://other.example/leak")
            )
            server.start()
            try {
                val http =
                    RpcClient.defaultHttp()
                        .newBuilder()
                        .sslSocketFactory(trusted.sslSocketFactory(), trusted.trustManager)
                        .build()
                val cloud = CloudClient(server.url("/").toString(), { "account-secret" }, http)
                assertEquals(emptyList(), cloud.chats())
                val request = server.takeRequest()
                assertEquals("/v1/cloud/chats?scope=active", request.path)
                assertEquals("Bearer account-secret", request.getHeader("Authorization"))
                assertFails { cloud.request("/redirect") }
                assertFails { cloud.request("https://other.example/leak") }
                assertEquals(2, server.requestCount)
            } finally {
                server.shutdown()
            }
        }
}

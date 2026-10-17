package sh.zuse.android

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val light =
    lightColorScheme(
        primary = Color(0xFF486900),
        onPrimary = Color.White,
        primaryContainer = Color(0xFFE6EFD3),
        onPrimaryContainer = Color(0xFF314800),
        background = Color(0xFFF7F7F5),
        onBackground = Color(0xFF171716),
        surface = Color(0xFFF7F7F5),
        onSurface = Color(0xFF171716),
        surfaceContainer = Color.White,
        surfaceContainerHigh = Color(0xFFF0F0ED),
        onSurfaceVariant = Color(0xFF686862),
        outlineVariant = Color(0xFFE5E5DF),
    )
private val dark =
    darkColorScheme(
        primary = Color(0xFF9AD43B),
        onPrimary = Color(0xFF172800),
        primaryContainer = Color(0xFF2D3A1B),
        onPrimaryContainer = Color(0xFFCAE9A0),
        background = Color(0xFF101010),
        onBackground = Color(0xFFEDEDEB),
        surface = Color(0xFF101010),
        onSurface = Color(0xFFEDEDEB),
        surfaceContainer = Color(0xFF1F1F1F),
        surfaceContainerHigh = Color(0xFF262626),
        onSurfaceVariant = Color(0xFFAAAAA4),
        outlineVariant = Color(0xFF333330),
    )

@Composable
fun ZuseTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) dark else light, content = content)
}

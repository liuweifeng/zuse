package sh.zuse.android

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

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
        outline = Color(0xFF999994),
        outlineVariant = Color(0x1A171716),
        secondary = Color(0xFF6F6F6B),
        onSecondary = Color.White,
        secondaryContainer = Color(0xFFECECEA),
        onSecondaryContainer = Color(0xFF171716),
        tertiary = Color(0xFF486900),
        onTertiary = Color.White,
        tertiaryContainer = Color(0xFFE6EFD3),
        onTertiaryContainer = Color(0xFF314800),
        surfaceVariant = Color(0xFFECECEA),
        surfaceContainerLow = Color(0xFFF7F7F5),
        surfaceContainerLowest = Color.White,
        surfaceContainerHighest = Color(0xFFECECEA),
        inverseSurface = Color(0xFF1F1F1F),
        inverseOnSurface = Color(0xFFEDEDED),
        inversePrimary = Color(0xFF89CA21),
        surfaceTint = Color.Transparent,
        scrim = Color(0x52000000),
        error = Color(0xFFDC2626),
        onError = Color.White,
        errorContainer = Color(0xFFFFE9E7),
        onErrorContainer = Color(0xFF8C1717),
    )
private val dark =
    darkColorScheme(
        primary = Color(0xFF89CA21),
        onPrimary = Color.White,
        primaryContainer = Color(0xFF2D3A1B),
        onPrimaryContainer = Color(0xFFCAE9A0),
        background = Color(0xFF0F0F0F),
        onBackground = Color(0xFFEDEDEB),
        surface = Color(0xFF0F0F0F),
        onSurface = Color(0xFFEDEDEB),
        surfaceContainer = Color(0xFF1F1F1F),
        surfaceContainerHigh = Color(0xFF212121),
        onSurfaceVariant = Color(0xFFAAAAA4),
        outline = Color(0xFF6E6E6E),
        outlineVariant = Color(0x1AFFFFFF),
        secondary = Color(0xFFADADAD),
        onSecondary = Color(0xFF0F0F0F),
        secondaryContainer = Color(0xFF333333),
        onSecondaryContainer = Color(0xFFEDEDED),
        tertiary = Color(0xFF89CA21),
        onTertiary = Color.White,
        tertiaryContainer = Color(0xFF2D3A1B),
        onTertiaryContainer = Color(0xFFCAE9A0),
        surfaceVariant = Color(0xFF333333),
        surfaceContainerLow = Color(0xFF0F0F0F),
        surfaceContainerLowest = Color(0xFF1F1F1F),
        surfaceContainerHighest = Color(0xFF333333),
        inverseSurface = Color(0xFFEDEDED),
        inverseOnSurface = Color(0xFF171716),
        inversePrimary = Color(0xFF486900),
        surfaceTint = Color.Transparent,
        scrim = Color(0x52000000),
        error = Color(0xFFF04848),
        onError = Color.White,
        errorContainer = Color(0xFF401C1C),
        onErrorContainer = Color(0xFFFFDAD6),
    )

/** Same brand fills as apps/mobile/global.css; standalone text uses the adaptive accent. */
val brandFill: Color
    @Composable get() = if (isSystemInDarkTheme()) Color(0xFF89CA21) else Color(0xFF81BF1D)

// Match the mobile app's restrained type and avoid Material's wide label tracking.
private val compactTypography =
    Typography(
        titleLarge =
            TextStyle(
                letterSpacing = 0.sp,
                fontSize = 20.sp,
                lineHeight = 26.sp,
                fontWeight = FontWeight.Medium,
            ),
        titleMedium =
            TextStyle(
                letterSpacing = 0.sp,
                fontSize = 16.sp,
                lineHeight = 22.sp,
                fontWeight = FontWeight.Medium,
            ),
        titleSmall =
            TextStyle(
                letterSpacing = 0.sp,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
            ),
        bodyLarge = TextStyle(letterSpacing = 0.sp, fontSize = 16.sp, lineHeight = 22.sp),
        bodyMedium = TextStyle(letterSpacing = 0.sp, fontSize = 15.sp, lineHeight = 22.sp),
        bodySmall = TextStyle(letterSpacing = 0.sp, fontSize = 13.sp, lineHeight = 18.sp),
        labelLarge =
            TextStyle(
                letterSpacing = 0.sp,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                fontWeight = FontWeight.Medium,
            ),
        labelMedium = TextStyle(letterSpacing = 0.sp, fontSize = 12.sp, lineHeight = 16.sp),
        labelSmall = TextStyle(letterSpacing = 0.sp, fontSize = 11.sp, lineHeight = 15.sp),
    )

@Composable
fun ZuseTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) dark else light,
        typography = compactTypography,
        content = content,
    )
}

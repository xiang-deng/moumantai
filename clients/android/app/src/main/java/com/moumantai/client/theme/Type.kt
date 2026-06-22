package com.moumantai.client.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.moumantai.client.generated.CompactTokens
import com.moumantai.client.generated.ExpandedTokens

// Typography sourced from generated tokens (shared/tokens/*.yaml).
// Run: python scripts/generate-tokens.py

/** Standard typography for expanded-class screens (>240dp) — from ExpandedTokens. */
val StandardTypography =
    Typography(
        displayLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.DISPLAY_LARGE.sp,
            lineHeight = 64.sp,
            letterSpacing = (-0.25).sp,
        ),
        displayMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.DISPLAY_MEDIUM.sp,
            lineHeight = 52.sp,
        ),
        displaySmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.DISPLAY_SMALL.sp,
            lineHeight = 44.sp,
        ),
        headlineLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.HEADLINE_LARGE.sp,
            lineHeight = 40.sp,
        ),
        headlineMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.HEADLINE_MEDIUM.sp,
            lineHeight = 36.sp,
        ),
        headlineSmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.HEADLINE_SMALL.sp,
            lineHeight = 32.sp,
        ),
        titleLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = ExpandedTokens.TITLE_LARGE.sp,
            lineHeight = 28.sp,
        ),
        titleMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = ExpandedTokens.TITLE_MEDIUM.sp,
            lineHeight = 24.sp,
            letterSpacing = 0.15.sp,
        ),
        titleSmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = ExpandedTokens.TITLE_SMALL.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.1.sp,
        ),
        bodyLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.BODY_LARGE.sp,
            lineHeight = 24.sp,
            letterSpacing = 0.5.sp,
        ),
        bodyMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.BODY_MEDIUM.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.25.sp,
        ),
        bodySmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = ExpandedTokens.BODY_SMALL.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.4.sp,
        ),
        labelLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = ExpandedTokens.LABEL_LARGE.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.1.sp,
        ),
        labelMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = ExpandedTokens.LABEL_MEDIUM.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.5.sp,
        ),
        labelSmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = ExpandedTokens.LABEL_SMALL.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.5.sp,
        ),
    )

/** Compact typography for compact-class screens (≤ 240dp) — from CompactTokens. */
val CompactTypography =
    Typography(
        displayLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.DISPLAY_LARGE.sp,
            lineHeight = 36.sp,
        ),
        displayMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.DISPLAY_MEDIUM.sp,
            lineHeight = 34.sp,
        ),
        displaySmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.DISPLAY_SMALL.sp,
            lineHeight = 30.sp,
        ),
        headlineLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.HEADLINE_LARGE.sp,
            lineHeight = 24.sp,
        ),
        headlineMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.HEADLINE_MEDIUM.sp,
            lineHeight = 22.sp,
        ),
        headlineSmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.HEADLINE_SMALL.sp,
            lineHeight = 22.sp,
        ),
        titleLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.TITLE_LARGE.sp,
            lineHeight = 24.sp,
        ),
        titleMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.TITLE_MEDIUM.sp,
            lineHeight = 22.sp,
            letterSpacing = 0.15.sp,
        ),
        titleSmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.TITLE_SMALL.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.1.sp,
        ),
        bodyLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = CompactTokens.BODY_LARGE.sp,
            lineHeight = 20.sp,
            letterSpacing = 0.5.sp,
        ),
        bodyMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = CompactTokens.BODY_MEDIUM.sp,
            lineHeight = 18.sp,
            letterSpacing = 0.25.sp,
        ),
        bodySmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Normal,
            fontSize = CompactTokens.BODY_SMALL.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.4.sp,
        ),
        labelLarge =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.LABEL_LARGE.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.1.sp,
        ),
        labelMedium =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.LABEL_MEDIUM.sp,
            lineHeight = 16.sp,
            letterSpacing = 0.5.sp,
        ),
        labelSmall =
        TextStyle(
            fontFamily = FontFamily.Default,
            fontWeight = FontWeight.Medium,
            fontSize = CompactTokens.LABEL_SMALL.sp,
            lineHeight = 14.sp,
            letterSpacing = 0.5.sp,
        ),
    )

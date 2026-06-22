package com.moumantai.client.renderer

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.Chat
import androidx.compose.material.icons.automirrored.rounded.List
import androidx.compose.material.icons.automirrored.rounded.Login
import androidx.compose.material.icons.automirrored.rounded.Logout
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.TrendingUp
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.AddCircle
import androidx.compose.material.icons.rounded.Alarm
import androidx.compose.material.icons.rounded.ArrowDownward
import androidx.compose.material.icons.rounded.ArrowForward
import androidx.compose.material.icons.rounded.ArrowUpward
import androidx.compose.material.icons.rounded.AttachMoney
import androidx.compose.material.icons.rounded.Bookmark
import androidx.compose.material.icons.rounded.Cancel
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.rounded.ChevronLeft
import androidx.compose.material.icons.rounded.ChevronRight
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.CloudDone
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.Coffee
import androidx.compose.material.icons.rounded.Dashboard
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.DirectionsCar
import androidx.compose.material.icons.rounded.DirectionsRun
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.Error
import androidx.compose.material.icons.rounded.Event
import androidx.compose.material.icons.rounded.Fastfood
import androidx.compose.material.icons.rounded.Favorite
import androidx.compose.material.icons.rounded.FitnessCenter
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.Group
import androidx.compose.material.icons.rounded.Help
import androidx.compose.material.icons.rounded.HelpOutline
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.Info
import androidx.compose.material.icons.rounded.Keyboard
import androidx.compose.material.icons.rounded.LocalCafe
import androidx.compose.material.icons.rounded.LocalFireDepartment
import androidx.compose.material.icons.rounded.LocalHospital
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.MoreHoriz
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Nightlight
import androidx.compose.material.icons.rounded.Notifications
import androidx.compose.material.icons.rounded.Pause
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.PhotoCamera
import androidx.compose.material.icons.rounded.PlayArrow
import androidx.compose.material.icons.rounded.Public
import androidx.compose.material.icons.rounded.Radio
import androidx.compose.material.icons.rounded.RadioButtonUnchecked
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material.icons.rounded.Remove
import androidx.compose.material.icons.rounded.Replay
import androidx.compose.material.icons.rounded.Restaurant
import androidx.compose.material.icons.rounded.Save
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.ShoppingBag
import androidx.compose.material.icons.rounded.ShoppingCart
import androidx.compose.material.icons.rounded.SkipNext
import androidx.compose.material.icons.rounded.SkipPrevious
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material.icons.rounded.StarBorder
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Today
import androidx.compose.material.icons.rounded.Train
import androidx.compose.material.icons.rounded.VolumeOff
import androidx.compose.material.icons.rounded.VolumeUp
import androidx.compose.material.icons.rounded.Warning
import androidx.compose.material.icons.rounded.WbSunny
import androidx.compose.material.icons.rounded.Whatshot
import androidx.compose.ui.graphics.vector.ImageVector

/**
 * Resolves a Material Symbols / Material Icons name emitted by the server
 * (e.g. `check_circle`, `directions_run`, `CHECK_CIRCLE`, `check-circle`) to a
 * Compose [ImageVector].
 *
 * Lookups are case-insensitive and accept kebab- or snake_case. Unknown names
 * fall back to `Icons.Rounded.HelpOutline` so the slot renders something
 * intelligible instead of raw text.
 */
fun lookupMaterialIcon(name: String?): ImageVector {
    if (name.isNullOrBlank()) return Icons.Rounded.HelpOutline
    val raw = name.trim()
    // `fa:` prefix is the FontAwesome escape hatch. Phone doesn't render FA,
    // so surface HelpOutline rather than trying to match a
    // Material name that won't exist.
    if (raw.startsWith("fa:")) return Icons.Rounded.HelpOutline
    val key = raw.lowercase().replace('-', '_')
    return ICONS[key] ?: Icons.Rounded.HelpOutline
}

private val ICONS: Map<String, ImageVector> =
    mapOf(
        // Navigation
        "arrow_back" to Icons.AutoMirrored.Rounded.ArrowBack,
        "arrow_forward" to Icons.Rounded.ArrowForward,
        "arrow_upward" to Icons.Rounded.ArrowUpward,
        "arrow_downward" to Icons.Rounded.ArrowDownward,
        "chevron_left" to Icons.Rounded.ChevronLeft,
        "chevron_right" to Icons.Rounded.ChevronRight,
        "close" to Icons.Rounded.Close,
        "more_horiz" to Icons.Rounded.MoreHoriz,
        "more_vert" to Icons.Rounded.MoreVert,
        // State / status
        "check" to Icons.Rounded.Check,
        "check_circle" to Icons.Rounded.CheckCircle,
        "cancel" to Icons.Rounded.Cancel,
        "error" to Icons.Rounded.Error,
        "warning" to Icons.Rounded.Warning,
        "info" to Icons.Rounded.Info,
        "help" to Icons.Rounded.Help,
        "help_outline" to Icons.Rounded.HelpOutline,
        "radio_button_unchecked" to Icons.Rounded.RadioButtonUnchecked,
        // Actions
        "add" to Icons.Rounded.Add,
        "add_circle" to Icons.Rounded.AddCircle,
        "remove" to Icons.Rounded.Remove,
        "delete" to Icons.Rounded.Delete,
        "edit" to Icons.Rounded.Edit,
        "save" to Icons.Rounded.Save,
        "refresh" to Icons.Rounded.Refresh,
        "replay" to Icons.Rounded.Replay,
        "search" to Icons.Rounded.Search,
        "send" to Icons.AutoMirrored.Rounded.Send,
        "settings" to Icons.Rounded.Settings,
        // Playback
        "play_arrow" to Icons.Rounded.PlayArrow,
        "pause" to Icons.Rounded.Pause,
        "stop" to Icons.Rounded.Stop,
        "skip_next" to Icons.Rounded.SkipNext,
        "skip_previous" to Icons.Rounded.SkipPrevious,
        "volume_up" to Icons.Rounded.VolumeUp,
        "volume_off" to Icons.Rounded.VolumeOff,
        "mic" to Icons.Rounded.Mic,
        "mic_off" to Icons.Rounded.MicOff,
        // Nav destinations
        "home" to Icons.Rounded.Home,
        "dashboard" to Icons.Rounded.Dashboard,
        "list" to Icons.AutoMirrored.Rounded.List,
        "chat" to Icons.AutoMirrored.Rounded.Chat,
        "person" to Icons.Rounded.Person,
        "group" to Icons.Rounded.Group,
        "notifications" to Icons.Rounded.Notifications,
        "login" to Icons.AutoMirrored.Rounded.Login,
        "logout" to Icons.AutoMirrored.Rounded.Logout,
        // Time
        "today" to Icons.Rounded.Today,
        "event" to Icons.Rounded.Event,
        "schedule" to Icons.Rounded.Schedule,
        "alarm" to Icons.Rounded.Alarm,
        // Favorites
        "star" to Icons.Rounded.Star,
        "star_border" to Icons.Rounded.StarBorder,
        "favorite" to Icons.Rounded.Favorite,
        "bookmark" to Icons.Rounded.Bookmark,
        "flag" to Icons.Rounded.Flag,
        // Capture
        "photo_camera" to Icons.Rounded.PhotoCamera,
        // Food / diet
        "restaurant" to Icons.Rounded.Restaurant,
        "fastfood" to Icons.Rounded.Fastfood,
        "local_cafe" to Icons.Rounded.LocalCafe,
        "coffee" to Icons.Rounded.Coffee,
        "local_fire_department" to Icons.Rounded.LocalFireDepartment,
        "whatshot" to Icons.Rounded.Whatshot,
        // Fitness / health
        "directions_run" to Icons.Rounded.DirectionsRun,
        "fitness_center" to Icons.Rounded.FitnessCenter,
        "local_hospital" to Icons.Rounded.LocalHospital,
        // Shopping / finance
        "shopping_cart" to Icons.Rounded.ShoppingCart,
        "shopping_bag" to Icons.Rounded.ShoppingBag,
        "attach_money" to Icons.Rounded.AttachMoney,
        // Transit
        "directions_car" to Icons.Rounded.DirectionsCar,
        "train" to Icons.Rounded.Train,
        // Weather / state
        "wb_sunny" to Icons.Rounded.WbSunny,
        "nightlight" to Icons.Rounded.Nightlight,
        "public" to Icons.Rounded.Public,
        // Input & connectivity
        "keyboard" to Icons.Rounded.Keyboard,
        "cloud_done" to Icons.Rounded.CloudDone,
        "cloud_off" to Icons.Rounded.CloudOff,
        // Misc
        "trending_up" to Icons.AutoMirrored.Rounded.TrendingUp,
        "radio" to Icons.Rounded.Radio,
    )

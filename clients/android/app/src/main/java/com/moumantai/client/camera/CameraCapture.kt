@file:Suppress("DEPRECATION")

package com.moumantai.client.camera

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.util.Log
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.max

/**
 * Full-screen camera preview with capture and dismiss controls.
 *
 * Uses CameraX [Preview] for the viewfinder and [ImageCapture] to snap
 * photos. Captured images are compressed to JPEG and delivered via
 * [onImageCaptured] as raw bytes.
 *
 * @param onImageCaptured Called with JPEG bytes after a successful capture.
 * @param onDismiss Called when the user taps the close button.
 * @param modifier Optional modifier for the container.
 */
@Composable
fun CameraCapture(
    onImageCaptured: (ByteArray) -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    var permissionGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.CAMERA,
            ) == PackageManager.PERMISSION_GRANTED,
        )
    }
    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> permissionGranted = granted }

    LaunchedEffect(Unit) {
        if (!permissionGranted) {
            permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    val imageCapture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setTargetRotation(android.view.Surface.ROTATION_0)
            .build()
    }

    val previewView = remember { PreviewView(context) }

    // Bind camera once permission is granted. Re-fires if the user later
    // grants access via the system prompt or Settings.
    if (permissionGranted) {
        DisposableEffect(lifecycleOwner) {
            val cameraProviderFuture = ProcessCameraProvider.getInstance(context)

            cameraProviderFuture.addListener({
                val cameraProvider = cameraProviderFuture.get()

                val preview = Preview.Builder().build().also {
                    it.surfaceProvider = previewView.surfaceProvider
                }

                val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

                try {
                    cameraProvider.unbindAll()
                    cameraProvider.bindToLifecycle(
                        lifecycleOwner,
                        cameraSelector,
                        preview,
                        imageCapture,
                    )
                } catch (e: Exception) {
                    Log.e("CameraCapture", "Camera bind failed", e)
                }
            }, ContextCompat.getMainExecutor(context))

            onDispose {
                try {
                    cameraProviderFuture.get().unbindAll()
                } catch (e: Exception) {
                    Log.e("CameraCapture", "Unbind failed", e)
                }
            }
        }
    }

    Box(modifier = modifier.fillMaxSize().background(Color.Black)) {
        if (permissionGranted) {
            // Camera preview fills the screen
            AndroidView(
                factory = { previewView },
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            // Permission not granted: keep the surface dark with a hint.
            // The launcher fires once on enter; tapping the hint re-prompts.
            Text(
                text = "Camera permission needed.\nTap to request again.",
                color = Color.White,
                modifier = Modifier
                    .align(Alignment.Center)
                    .padding(24.dp),
            )
        }

        // Close button (top-left) — always available
        IconButton(
            onClick = onDismiss,
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(8.dp),
        ) {
            Icon(
                imageVector = Icons.Filled.Close,
                contentDescription = "Close camera",
                tint = Color.White,
            )
        }

        // Capture button — only when granted
        if (permissionGranted) {
            FloatingActionButton(
                onClick = {
                    imageCapture.takePicture(
                        ContextCompat.getMainExecutor(context),
                        object : ImageCapture.OnImageCapturedCallback() {
                            override fun onCaptureSuccess(image: ImageProxy) {
                                val jpegBytes = imageProxyToJpeg(image)
                                image.close()
                                if (jpegBytes != null) {
                                    onImageCaptured(jpegBytes)
                                }
                            }

                            override fun onError(exception: ImageCaptureException) {
                                Log.e("CameraCapture", "Capture failed", exception)
                            }
                        },
                    )
                },
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .padding(bottom = 24.dp)
                    .size(64.dp),
                shape = CircleShape,
                containerColor = Color.White,
                contentColor = Color.Black,
            ) {
                Icon(
                    imageVector = Icons.Filled.CameraAlt,
                    contentDescription = "Take photo",
                )
            }
        } else {
            // Tap-anywhere-to-retry: a transparent click target over the hint.
            IconButton(
                onClick = { permissionLauncher.launch(Manifest.permission.CAMERA) },
                modifier = Modifier
                    .align(Alignment.Center)
                    .size(220.dp),
            ) {}
        }
    }
}

/**
 * Convert an [ImageProxy] to JPEG bytes.
 *
 * Handles YUV_420_888 (decode from first plane) and JPEG formats.
 * Applies rotation correction from the image's rotation degrees, then
 * downscales so the long edge is at most [MAX_LONG_EDGE_PX] — typical phone
 * sensors produce 3-15 MB JPEGs at native resolution; downscaling here keeps
 * the wire payload around 200-500 KB without sacrificing OCR-grade legibility
 * (matches Anthropic's recommended vision input ceiling of 1568 px).
 */
private const val MAX_LONG_EDGE_PX = 1568

private fun imageProxyToJpeg(image: ImageProxy, quality: Int = 80): ByteArray? {
    return try {
        if (image.planes.isEmpty()) return null
        val buffer: ByteBuffer = image.planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)

        val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            ?: return bytes // Already JPEG — pass through unchanged.

        // Apply rotation if needed
        val rotated = if (image.imageInfo.rotationDegrees != 0) {
            val matrix = Matrix().apply {
                postRotate(image.imageInfo.rotationDegrees.toFloat())
            }
            Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        } else {
            bitmap
        }

        // Downscale long edge to MAX_LONG_EDGE_PX, preserving aspect ratio.
        val longest = max(rotated.width, rotated.height)
        val scaled = if (longest > MAX_LONG_EDGE_PX) {
            val ratio = MAX_LONG_EDGE_PX.toFloat() / longest
            Bitmap.createScaledBitmap(
                rotated,
                (rotated.width * ratio).toInt().coerceAtLeast(1),
                (rotated.height * ratio).toInt().coerceAtLeast(1),
                true, // bilinear filter
            )
        } else {
            rotated
        }

        val output = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, quality, output)
        output.toByteArray().also {
            Log.d("CameraCapture", "outgoing JPEG ${it.size}B (${scaled.width}x${scaled.height})")
        }
    } catch (e: Exception) {
        Log.e("CameraCapture", "Image conversion failed", e)
        null
    }
}

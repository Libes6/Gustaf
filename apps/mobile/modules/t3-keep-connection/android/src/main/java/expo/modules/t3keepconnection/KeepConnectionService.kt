package expo.modules.t3keepconnection

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat

/**
 * Only keeps the app process, and with it the JS connection supervisor, alive in the background.
 * START_NOT_STICKY: after the OS kills the process the app starts the service again on next open,
 * so the notification never outlives a connection nobody is holding.
 */
class KeepConnectionService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val content = intent?.let(KeepConnectionContent::from)
    if (content == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      ensureChannel(content.channelName)
      val notification = notification(content)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      if (KeepConnection.runningSinceMs == 0L) {
        KeepConnection.runningSinceMs = System.currentTimeMillis()
      }
    } catch (error: IllegalStateException) {
      // ForegroundServiceStartNotAllowedException extends IllegalStateException; retry on next open.
      Log.w(TAG, "Could not keep the connection in the foreground", error)
      stopSelf()
    } catch (error: SecurityException) {
      Log.w(TAG, "Missing permission to keep the connection in the foreground", error)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    KeepConnection.runningSinceMs = 0L
    super.onDestroy()
  }

  private fun ensureChannel(name: String) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val channel = NotificationChannel(CHANNEL_ID, name, NotificationManager.IMPORTANCE_LOW)
    channel.setShowBadge(false)
    getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
  }

  private fun notification(content: KeepConnectionContent): Notification {
    val stop = PendingIntent.getBroadcast(
      this,
      0,
      Intent(this, KeepConnectionStopReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(
        this,
        0,
        it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
    }
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(smallIcon())
      .setContentTitle(content.title)
      .setContentText(content.text)
      .setContentIntent(open)
      .addAction(0, content.stopLabel, stop)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  // expo-notifications generates `notification_icon` from app.config.ts; fall back to the app icon.
  private fun smallIcon(): Int {
    val generated = resources.getIdentifier("notification_icon", "drawable", packageName)
    return if (generated != 0) generated else applicationInfo.icon
  }

  companion object {
    private const val TAG = "T3KeepConnection"
    private const val CHANNEL_ID = "keep-connection"
    private const val NOTIFICATION_ID = 0x6b65
  }
}

/** The notification's "Turn off" action: remembers the choice for the app, then stops. */
class KeepConnectionStopReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    KeepConnection.turnOff(context)
  }
}

internal data class KeepConnectionContent(
  val title: String,
  val text: String,
  val stopLabel: String,
  val channelName: String
) {
  fun into(intent: Intent): Intent = intent
    .putExtra(EXTRA_TITLE, title)
    .putExtra(EXTRA_TEXT, text)
    .putExtra(EXTRA_STOP_LABEL, stopLabel)
    .putExtra(EXTRA_CHANNEL_NAME, channelName)

  companion object {
    private const val EXTRA_TITLE = "expo.modules.t3keepconnection.TITLE"
    private const val EXTRA_TEXT = "expo.modules.t3keepconnection.TEXT"
    private const val EXTRA_STOP_LABEL = "expo.modules.t3keepconnection.STOP_LABEL"
    private const val EXTRA_CHANNEL_NAME = "expo.modules.t3keepconnection.CHANNEL_NAME"

    fun from(intent: Intent): KeepConnectionContent? {
      val values = listOf(EXTRA_TITLE, EXTRA_TEXT, EXTRA_STOP_LABEL, EXTRA_CHANNEL_NAME)
        .map { intent.getStringExtra(it) }
      if (values.any { it == null }) return null
      val present = values.requireNoNulls()
      return KeepConnectionContent(present[0], present[1], present[2], present[3])
    }
  }
}

internal object KeepConnection {
  private const val PREFERENCES = "expo.modules.t3keepconnection"
  private const val TURNED_OFF = "turnedOff"

  @Volatile
  var runningSinceMs: Long = 0L

  @Volatile
  var onTurnedOff: (() -> Unit)? = null

  fun start(context: Context, content: KeepConnectionContent): Boolean = try {
    val intent = content.into(Intent(context, KeepConnectionService::class.java))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent)
    } else {
      context.startService(intent)
    }
    true
  } catch (error: IllegalStateException) {
    // Android 12+ refuses a foreground start from the background; the app only starts while active.
    Log.w("T3KeepConnection", "Could not start the keep-connection service", error)
    false
  } catch (error: SecurityException) {
    Log.w("T3KeepConnection", "Missing permission to start the keep-connection service", error)
    false
  }

  fun stop(context: Context) {
    context.stopService(Intent(context, KeepConnectionService::class.java))
  }

  fun turnOff(context: Context) {
    // Persisted so an app that was not listening still sees the choice on its next start.
    context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit()
      .putBoolean(TURNED_OFF, true).apply()
    stop(context)
    onTurnedOff?.invoke()
  }

  fun takeTurnedOff(context: Context): Boolean {
    val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    val turnedOff = preferences.getBoolean(TURNED_OFF, false)
    if (turnedOff) preferences.edit().remove(TURNED_OFF).apply()
    return turnedOff
  }
}

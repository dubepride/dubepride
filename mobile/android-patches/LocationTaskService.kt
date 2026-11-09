// BioBridge native location engine: biobridge-native-v2
package expo.modules.location.services

import android.annotation.TargetApi
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.os.Binder
import android.os.Build
import android.os.Bundle
import android.os.IBinder

class LocationTaskService : Service() {
  private var mChannelId: String = DEFAULT_CHANNEL_ID
  private var mKillService = false
  private var mParentContext: Context? = null
  private val mServiceId = sServiceId++
  private val mBinder: IBinder = ServiceBinder()

  inner class ServiceBinder : Binder() {
    val service: LocationTaskService
      get() = this@LocationTaskService
  }

  override fun onBind(intent: Intent?): IBinder {
    return mBinder
  }

  @TargetApi(26)
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val extras = intent?.extras
    if (extras != null) {
      val appId = extras.getString("appId") ?: "biobridge"
      val taskName = extras.getString("taskName") ?: "location"
      mChannelId = "$appId:$taskName"
      mKillService = extras.getBoolean("killService", false)
    }
    return START_REDELIVER_INTENT
  }

  fun setParentContext(context: Context) {
    // Background location logic is still outside LocationTaskService,
    // so we have to save parent context in order to make sure it won't be destroyed by the OS.
    mParentContext = context
  }

  fun stop() {
    try {
      stopForeground(true)
    } catch (_: Throwable) {}
    try {
      stopSelf()
    } catch (_: Throwable) {}
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    if (mKillService) {
      super.onTaskRemoved(rootIntent)
      stop()
    }
  }

  fun startForeground(serviceOptions: Bundle) {
    try {
      val notification = buildServiceNotification(serviceOptions)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(mServiceId, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      } else {
        startForeground(mServiceId, notification)
      }
    } catch (e: Throwable) {
      android.util.Log.w("expo-location", "Could not start foreground service notification", e)
    }
  }

  //region private
  @TargetApi(26)
  private fun buildServiceNotification(serviceOptions: Bundle): Notification {
    val channelId = if (mChannelId.isBlank()) DEFAULT_CHANNEL_ID else mChannelId
    prepareChannel(channelId)
    val builder = Notification.Builder(this, channelId)
    val title = serviceOptions.getString("notificationTitle")
    val body = serviceOptions.getString("notificationBody")
    val color = colorStringToInteger(serviceOptions.getString("notificationColor"))

    title?.let { builder.setContentTitle(title) }
    body?.let { builder.setContentText(body) }
    color?.let {
      builder.setColorized(true).setColor(color)
    } ?: run {
      builder.setColorized(false)
    }

    val hostContext = mParentContext ?: this
    hostContext.packageManager.getLaunchIntentForPackage(hostContext.packageName)?.let {
      it.flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
      val mutableFlag = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
      val contentIntent = PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or mutableFlag)
      builder.setContentIntent(contentIntent)
    }

    val iconsResId = try {
      val packageManager = hostContext.packageManager
      val ai = packageManager.getApplicationInfo(
        hostContext.packageName,
        android.content.pm.PackageManager.GET_META_DATA
      )
      if (ai.metaData?.containsKey(META_DATA_FOREGROUND_SERVICE_ICON_KEY) == true) {
        ai.metaData.getInt(META_DATA_FOREGROUND_SERVICE_ICON_KEY)
      } else {
        getDefaultNotificationIcon()
      }
    } catch (e: Exception) {
      android.util.Log.e("expo-location", "Could not fetch default notification icon.", e)
      getDefaultNotificationIcon()
    }

    return builder.setCategory(Notification.CATEGORY_SERVICE)
      .setSmallIcon(iconsResId)
      .build()
  }

  @TargetApi(26)
  private fun prepareChannel(id: String?) {
    val channelId = if (id.isNullOrBlank()) DEFAULT_CHANNEL_ID else id
    val notificationManager = getSystemService(NOTIFICATION_SERVICE) as? NotificationManager
      ?: return
    val appName = applicationInfo.loadLabel(packageManager).toString()
    var channel = notificationManager.getNotificationChannel(channelId)
    if (channel == null) {
      channel = NotificationChannel(channelId, appName, NotificationManager.IMPORTANCE_LOW)
      channel.description = "Background location notification channel"
      notificationManager.createNotificationChannel(channel)
    }
  }

  private fun getDefaultNotificationIcon(): Int {
    val hostContext = mParentContext ?: this
    return hostContext.resources.getIdentifier("notification_icon", "drawable", hostContext.packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
  }

  private fun colorStringToInteger(color: String?): Int? {
    return try {
      Color.parseColor(color)
    } catch (e: Exception) {
      null
    }
  } //endregion

  companion object {
    private const val DEFAULT_CHANNEL_ID = "biobridge_location_channel"
    private var sServiceId = 481756
    const val META_DATA_FOREGROUND_SERVICE_ICON_KEY: String =
      "expo.modules.location.foreground_service_icon"
  }
}

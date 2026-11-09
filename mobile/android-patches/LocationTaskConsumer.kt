// BioBridge native location engine: biobridge-native-v2
package expo.modules.location.taskConsumers

import android.app.PendingIntent
import android.app.job.JobParameters
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.PersistableBundle
import android.util.Log
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import expo.modules.core.arguments.MapArguments
import expo.modules.core.arguments.ReadableArguments
import expo.modules.core.interfaces.LifecycleEventListener
import expo.modules.interfaces.taskManager.TaskConsumer
import expo.modules.interfaces.taskManager.TaskConsumerInterface
import expo.modules.interfaces.taskManager.TaskExecutionCallback
import expo.modules.interfaces.taskManager.TaskInterface
import expo.modules.interfaces.taskManager.TaskManagerUtilsInterface
import expo.modules.location.AppForegroundedSingleton
import expo.modules.location.BIOBRIDGE_NATIVE_LOCATION_ENGINE
import expo.modules.location.LocationHelpers
import expo.modules.location.records.LocationOptions
import expo.modules.location.records.LocationResponse
import expo.modules.location.services.LocationTaskService
import expo.modules.location.services.LocationTaskService.ServiceBinder
import kotlin.math.abs

class LocationTaskConsumer(context: Context, taskManagerUtils: TaskManagerUtilsInterface?) : TaskConsumer(context, taskManagerUtils), TaskConsumerInterface, LifecycleEventListener {
  private var mTask: TaskInterface? = null
  private var mPendingIntent: PendingIntent? = null
  private var mService: LocationTaskService? = null
  private var mLocationRequest: LocationRequest? = null
  private var mLastReportedLocation: Location? = null
  private var mNativeListener: LocationListener? = null
  private var mDeferredDistance = 0.0
  private val mDeferredLocations: MutableList<Location> = ArrayList()

  // Apps start in foreground state; lifecycle callbacks update this after initialization
  private var mIsHostPaused = false
  private val mLocationClient: FusedLocationProviderClient by lazy {
    LocationServices.getFusedLocationProviderClient(context)
  }

  //region TaskConsumerInterface
  override fun taskType(): String {
    return "location"
  }

  override fun didRegister(task: TaskInterface) {
    mTask = task
    startLocationUpdates()
    maybeStartForegroundService()
  }

  override fun didUnregister() {
    stopLocationUpdates()
    stopForegroundService()
    mTask = null
    mPendingIntent = null
    mLocationRequest = null
  }

  override fun setOptions(options: Map<String, Any>) {
    super.setOptions(options)

    // Restart location updates
    stopLocationUpdates()
    startLocationUpdates()

    // Restart foreground service if its option has changed.
    maybeStartForegroundService()
  }

  override fun didReceiveBroadcast(intent: Intent) {
    mTask ?: return
    val result = LocationResult.extractResult(intent)
    if (result != null) {
      handleLocationUpdate(result.locations)
    } else if (LocationHelpers.isGooglePlayServicesAvailable(context)) {
      try {
        mLocationClient.lastLocation.addOnCompleteListener { task ->
          task.result?.let { handleLocationUpdate(listOf(it)) }
        }
      } catch (e: Throwable) {
        Log.e(TAG, "Cannot get last location: " + e.message)
      }
    } else {
      LocationHelpers.getLastKnownLocationFromLocationManager(context)?.let {
        handleLocationUpdate(listOf(it))
      }
    }
  }

  /**
   * Handles incoming location updates by either reporting immediately (foreground)
   * or deferring for battery optimization (background).
   */
  private fun handleLocationUpdate(locations: List<Location>) {
    if (locations.isEmpty()) return

    // Foreground: report immediately for responsive UI (matches iOS behavior)
    if (!mIsHostPaused) {
      reportLocationsImmediately(locations)
      return
    }

    // Background: use deferred buffer for battery optimization
    deferLocations(locations)
    maybeReportDeferredLocations()
  }

  override fun didExecuteJob(jobService: JobService, params: JobParameters): Boolean {
    val data = taskManagerUtils.extractDataFromJobParams(params)
    val locationBundles = ArrayList<Bundle>()
    for (persistableLocationBundle in data) {
      val locationBundle = Bundle()
      val coordsBundle = Bundle()
      if (persistableLocationBundle != null) {
        coordsBundle.putAll(persistableLocationBundle.getPersistableBundle("coords"))
        locationBundle.putAll(persistableLocationBundle)
        locationBundle.putBundle("coords", coordsBundle)
        locationBundles.add(locationBundle)
      }
    }
    executeTaskWithLocationBundles(locationBundles) { jobService.jobFinished(params, false) }

    // Returning `true` indicates that the job is still running, but in async mode.
    // In that case we're obligated to call `jobService.jobFinished` as soon as the async block finishes.
    return true
  }

  //region private
  private fun startLocationUpdates() {
    val context = context ?: run {
      Log.w(TAG, "The context has been abandoned")
      return
    }

    if (!LocationHelpers.isAnyProviderAvailable(context)) {
      Log.w(TAG, "There is no location provider available")
      return
    }
    val task = mTask ?: run {
      Log.w(TAG, "Could not find a location task for the location update")
      return
    }
    mLocationRequest = LocationHelpers.prepareLocationRequest(LocationOptions(task.options))

    val locationRequest = mLocationRequest ?: run {
      Log.w(TAG, "Could not find a location request for the location update")
      return
    }

    // 1. Register native LocationManager listener (essential for Huawei/non-GMS and offline GPS)
    try {
      Log.i(TAG, "$BIOBRIDGE_NATIVE_LOCATION_ENGINE starting native provider stream")
      val lm = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      if (lm != null) {
        mNativeListener?.let { old ->
          try { lm.removeUpdates(old) } catch (_: Throwable) {}
        }
        val listener = object : LocationListener {
          override fun onLocationChanged(location: Location) {
            handleLocationUpdate(listOf(location))
          }
          override fun onProviderDisabled(p: String) {}
          override fun onProviderEnabled(p: String) {}
          @Deprecated("Deprecated in Java")
          override fun onStatusChanged(p: String?, status: Int, extras: Bundle?) {}
        }
        mNativeListener = listener
        val all = try { lm.allProviders } catch (_: Throwable) { emptyList<String>() }
        val providers = (all + listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER, "fused")).distinct()
        for (p in providers) {
          try {
            if (lm.isProviderEnabled(p) || p == LocationManager.PASSIVE_PROVIDER) {
              // minDistance = 0 is deliberate: Huawei (and several OEM skins)
              // honour minDistance so strictly that a stationary phone would
              // never get a time-based fix. The interval still throttles updates.
              lm.requestLocationUpdates(
                p,
                locationRequest.intervalMillis,
                0f,
                listener,
                Looper.getMainLooper()
              )
            }
          } catch (_: Throwable) {}
        }
      }
    } catch (e: Throwable) {
      Log.w(TAG, "Native LocationManager registration failed in task consumer", e)
    }

    // 2. Also register with Google Play Services FusedLocationProviderClient when available
    if (LocationHelpers.isGooglePlayServicesAvailable(context)) {
      mPendingIntent = preparePendingIntent()
      val intent = mPendingIntent
      if (intent != null) {
        try {
          mLocationClient.requestLocationUpdates(locationRequest, intent)
            .addOnFailureListener {
              LocationHelpers.sGooglePlayServicesBroken = true
            }
        } catch (e: Throwable) {
          Log.w(TAG, "GMS Location request has been rejected.", e)
        }
      }
    }
  }

  private fun stopLocationUpdates() {
    try {
      val lm = context?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      mNativeListener?.let { listener ->
        try { lm?.removeUpdates(listener) } catch (_: Throwable) {}
      }
      mNativeListener = null
    } catch (_: Throwable) {}

    mPendingIntent?.let {
      try {
        if (LocationHelpers.isGooglePlayServicesAvailable(context)) {
          mLocationClient.removeLocationUpdates(it)
        }
      } catch (_: Throwable) {}
      try {
        it.cancel()
      } catch (_: Throwable) {}
    }
  }

  private fun maybeStartForegroundService() {
    // Foreground service is available as of Android Oreo.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return
    }
    // Do not refuse to start just because the host activity is paused/absent.
    // Huawei frequently recreates the task headlessly (boot, app launch,
    // connectivity change); the old early return left the foreground service
    // permanently off in exactly those cases. Android 12+ still enforces its
    // own background-start rules, so the attempt is wrapped below.
    if (!AppForegroundedSingleton.isForegrounded) {
      Log.i(TAG, "Attempting foreground location service from a background context")
    }
    val task = mTask ?: run {
      Log.w(TAG, "Location task is null")
      return
    }
    val options: ReadableArguments = MapArguments(task.options)
    val useForegroundService = shouldUseForegroundService(task.options)

    // Service is already running, but the task has been registered again without `foregroundService` option.
    if (mService != null && !useForegroundService) {
      stopForegroundService()
      return
    }

    // Service is not running and the user don't want to start foreground service.
    if (!useForegroundService) {
      return
    }

    // Foreground service is requested but not running.
    if (mService == null) {
      try {
        val serviceIntent = Intent(context, LocationTaskService::class.java)
        val extras = Bundle()
        val serviceOptions = options.getArguments(FOREGROUND_SERVICE_KEY).toBundle()

        // extras param name is appId for legacy reasons
        extras.putString("appId", task.appScopeKey)
        extras.putString("taskName", task.name)
        extras.putBoolean("killService", serviceOptions.getBoolean("killServiceOnDestroy", false))
        serviceIntent.putExtras(extras)
        context.startForegroundService(serviceIntent)
        context.bindService(
          serviceIntent,
          object : ServiceConnection {
            override fun onServiceConnected(name: ComponentName, service: IBinder) {
              mService = (service as? ServiceBinder)?.service
              mService?.let {
                it.setParentContext(context)
                it.startForeground(serviceOptions)
              }
            }

            override fun onServiceDisconnected(name: ComponentName) {
              mService?.stop()
              mService = null
            }
          },
          Context.BIND_AUTO_CREATE
        )
      } catch (e: Throwable) {
        Log.w(TAG, "Could not start foreground location service", e)
      }
    } else {
      // Restart the service with new service options.
      try {
        mService?.startForeground(options.getArguments(FOREGROUND_SERVICE_KEY).toBundle())
      } catch (e: Throwable) {
        Log.w(TAG, "Could not restart foreground location service", e)
      }
    }
  }

  private fun stopForegroundService() {
    try {
      mService?.stop()
    } catch (_: Throwable) {}
  }

  /**
   * Reports locations immediately without deferred batching.
   * Used in foreground mode to provide responsive location updates (matches iOS behavior).
   */
  private fun reportLocationsImmediately(locations: List<Location>) {
    if (locations.isEmpty()) return
    val context = context.applicationContext
    val data: MutableList<PersistableBundle> = ArrayList()
    var lastReported: Location? = null
    for (location in locations) {
      val timestamp = location.time
      // Some devices may broadcast the same location multiple times (mostly twice)
      // so we're filtering out these locations.
      if (timestamp > sLastTimestamp) {
        val bundle = LocationResponse(location).toBundle(PersistableBundle::class.java)
        data.add(bundle)
        sLastTimestamp = timestamp
        lastReported = location
      }
    }
    if (data.isNotEmpty()) {
      mLastReportedLocation = lastReported
      taskManagerUtils.scheduleJob(context, mTask, data)
    }
  }

  private fun deferLocations(locations: List<Location>) {
    val size = mDeferredLocations.size
    var lastLocation = if (size > 0) mDeferredLocations[size - 1] else mLastReportedLocation
    for (location in locations) {
      if (lastLocation != null) {
        mDeferredDistance += abs(location.distanceTo(lastLocation)).toDouble()
      }
      lastLocation = location
    }
    mDeferredLocations.addAll(locations)
  }

  private fun maybeReportDeferredLocations() {
    if (!shouldReportDeferredLocations()) {
      return
    }
    val context = context.applicationContext
    val data: MutableList<PersistableBundle> = ArrayList()
    for (location in mDeferredLocations) {
      val timestamp = location.time

      // Some devices may broadcast the same location multiple times (mostly twice) so we're filtering out these locations,
      // so only one location at the specific timestamp can schedule a job.
      if (timestamp > sLastTimestamp) {
        val bundle = LocationResponse(location).toBundle(PersistableBundle::class.java)
        data.add(bundle)
        sLastTimestamp = timestamp
      }
    }
    if (data.isNotEmpty()) {
      // Save last reported location, reset the distance and clear a list of locations.
      mLastReportedLocation = mDeferredLocations[mDeferredLocations.size - 1]
      mDeferredDistance = 0.0
      mDeferredLocations.clear()

      // Schedule new job.
      taskManagerUtils.scheduleJob(context, mTask, data)
    }
  }

  private fun shouldReportDeferredLocations(): Boolean {
    val task = mTask ?: return false
    if (mDeferredLocations.isEmpty()) {
      return false
    }
    if (!mIsHostPaused) {
      // Don't defer location updates when the activity is in foreground state.
      return true
    }
    val oldestLocation = mLastReportedLocation ?: mDeferredLocations[0]
    val newestLocation = mDeferredLocations[mDeferredLocations.size - 1]
    val distance = (task.options["deferredUpdatesDistance"] as? Number)?.toDouble() ?: 0.0
    val interval = (task.options["deferredUpdatesInterval"] as? Number)?.toLong() ?: 0L
    return newestLocation.time - oldestLocation.time >= interval && mDeferredDistance >= distance
  }

  private fun preparePendingIntent(): PendingIntent {
    return taskManagerUtils.createTaskIntent(context, mTask)
  }

  private fun executeTaskWithLocationBundles(locationBundles: ArrayList<Bundle>, callback: TaskExecutionCallback) {
    if (locationBundles.isNotEmpty() && mTask != null) {
      val data = Bundle()
      data.putParcelableArrayList("locations", locationBundles)
      mTask?.execute(data, null, callback)
    } else {
      callback.onFinished(null)
    }
  }

  override fun onHostResume() {
    mIsHostPaused = false
    maybeReportDeferredLocations()
  }

  override fun onHostPause() {
    mIsHostPaused = true
  }

  override fun onHostDestroy() {
    mIsHostPaused = true
  } //endregion

  companion object {
    private const val TAG = "LocationTaskConsumer"
    private const val FOREGROUND_SERVICE_KEY = "foregroundService"
    private var sLastTimestamp: Long = 0
    fun shouldUseForegroundService(options: Map<String?, Any?>): Boolean {
      return options.containsKey(FOREGROUND_SERVICE_KEY)
    }
  }
}

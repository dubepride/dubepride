// BioBridge native location engine: biobridge-native-v2
package expo.modules.location

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.location.LocationManagerCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.Granularity
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.Priority
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.location.records.LocationLastKnownOptions
import expo.modules.location.records.LocationOptions
import expo.modules.location.records.LocationResponse
import expo.modules.location.records.PermissionRequestResponse
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * Markers stamped into the compiled APK. The JavaScript layer reads these via
 * `biobridgeGetNativeInfo()` so an old APK can never silently claim to have the
 * Huawei / non-GMS native fallback.
 */
const val BIOBRIDGE_NATIVE_LOCATION_ENGINE = "biobridge-native-v2"
const val BIOBRIDGE_NATIVE_FALLBACK_ENABLED = true

class LocationHelpers {
  companion object {
    @Volatile
    var sGooglePlayServicesBroken: Boolean = false

    /**
     * Checks whether Google Play Services is available and working on the device.
     */
    fun isGooglePlayServicesAvailable(context: Context?): Boolean {
      if (sGooglePlayServicesBroken) return false
      if (context == null) return false
      return try {
        val availability = GoogleApiAvailability.getInstance()
        val resultCode = availability.isGooglePlayServicesAvailable(context)
        resultCode == ConnectionResult.SUCCESS
      } catch (_: Throwable) {
        false
      }
    }

    /**
     * Determines whether one Location reading is better than the current Location fix.
     * Prevents low-accuracy cell tower fixes from overriding high-precision GPS fixes,
     * while allowing live updates across all providers (gps, network, passive, fused).
     */
    fun isBetterLocation(location: Location, currentBestLocation: Location?): Boolean {
      if (currentBestLocation == null) return true

      val timeDelta = location.time - currentBestLocation.time
      val isSignificantlyNewer = timeDelta > 8_000
      val isSignificantlyOlder = timeDelta < -15_000
      val isNewer = timeDelta >= 0

      if (isSignificantlyNewer) return true
      if (isSignificantlyOlder) return false

      val accuracyDelta = (location.accuracy - currentBestLocation.accuracy).toInt()
      val isMoreAccurate = accuracyDelta <= 0
      val isNotMuchWorse = accuracyDelta <= 35

      return when {
        isMoreAccurate -> true
        isNewer && isNotMuchWorse -> true
        else -> false
      }
    }

    /**
     * Obtains the most recent location known to the device's native LocationManager (GPS, Network, Passive, Fused).
     */
    fun getLastKnownLocationFromLocationManager(context: Context?): Location? {
      if (context == null) return null
      val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
      var best: Location? = null
      val all = try { locationManager.allProviders } catch (_: Throwable) { emptyList<String>() }
      val providers = (all + listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER, "fused")).distinct()
      for (provider in providers) {
        try {
          val loc = locationManager.getLastKnownLocation(provider)
          if (loc != null && isBetterLocation(loc, best)) {
            best = loc
          }
        } catch (_: Throwable) {}
      }
      return best
    }

    /**
     * Obtains a single location fix using Android's native LocationManager.
     * Works on all devices with or without Google Play Services (Huawei, Honor, Redmi, Itel, Samsung, Oppo, ZTE, Volion).
     */
    fun requestSingleLocationFromLocationManager(context: Context?, promise: Promise) {
      if (context == null) {
        promise.reject(CurrentLocationIsUnavailableException())
        return
      }
      val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      if (locationManager == null) {
        promise.reject(CurrentLocationIsUnavailableException())
        return
      }

      val bestLastKnown = getLastKnownLocationFromLocationManager(context)
      // Only resolve immediately without querying live hardware if the cached fix is ultra-fresh (< 5s and <= 30m)
      if (bestLastKnown != null && bestLastKnown.accuracy <= 30f && (System.currentTimeMillis() - bestLastKnown.time) in 0L..5_000L) {
        promise.resolve(LocationResponse(bestLastKnown))
        return
      }

      val isLocEnabled = isAnyProviderAvailable(context)
      val allProviders = try { locationManager.allProviders } catch (_: Throwable) { emptyList<String>() }
      val providersToTry = (allProviders + listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER, "fused")).distinct()

      val mainHandler = Handler(Looper.getMainLooper())
      val hasResolved = AtomicBoolean(false)

      val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
          if (hasResolved.compareAndSet(false, true)) {
            try {
              locationManager.removeUpdates(this)
            } catch (_: Throwable) {}
            promise.resolve(LocationResponse(location))
          }
        }

        override fun onProviderDisabled(p: String) {}
        override fun onProviderEnabled(p: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(p: String?, status: Int, extras: Bundle?) {}
      }

      val timeoutRunnable = Runnable {
        if (hasResolved.compareAndSet(false, true)) {
          try {
            locationManager.removeUpdates(listener)
          } catch (_: Throwable) {}
          val fallback = getLastKnownLocationFromLocationManager(context) ?: bestLastKnown
          if (fallback != null && (System.currentTimeMillis() - fallback.time) < 600_000L) {
            promise.resolve(LocationResponse(fallback))
          } else if (!isLocEnabled) {
            promise.reject(LocationSettingsUnsatisfiedException())
          } else {
            promise.reject(CurrentLocationIsUnavailableException())
          }
        }
      }
      mainHandler.postDelayed(timeoutRunnable, 8_000L)

      var registered = false
      for (p in providersToTry) {
        try {
          if (locationManager.isProviderEnabled(p) || p == LocationManager.PASSIVE_PROVIDER) {
            locationManager.requestLocationUpdates(p, 0L, 0f, listener, Looper.getMainLooper())
            registered = true
          }
        } catch (_: Throwable) {}
      }

      if (!registered) {
        mainHandler.removeCallbacks(timeoutRunnable)
        if (bestLastKnown != null && (System.currentTimeMillis() - bestLastKnown.time) < 600_000L) {
          promise.resolve(LocationResponse(bestLastKnown))
        } else if (!isLocEnabled) {
          promise.reject(LocationSettingsUnsatisfiedException())
        } else {
          promise.reject(CurrentLocationIsUnavailableException())
        }
      }
    }

    /**
     * Checks whether given location didn't exceed given `maxAge` and fits in the required accuracy.
     */
    internal fun isLocationValid(location: Location?, options: LocationLastKnownOptions): Boolean {
      if (location == null) {
        return false
      }
      val maxAge = options.maxAge ?: Double.MAX_VALUE
      val requiredAccuracy = options.requiredAccuracy ?: Double.MAX_VALUE
      val timeDiff = (System.currentTimeMillis() - location.time).toDouble()
      return timeDiff <= maxAge && location.accuracy <= requiredAccuracy
    }

    fun hasNetworkProviderEnabled(context: Context?): Boolean {
      if (context == null) {
        return false
      }
      val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      return try {
        locationManager != null && locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
      } catch (_: Throwable) {
        false
      }
    }

    internal fun prepareLocationRequest(options: LocationOptions): LocationRequest {
      val locationParams = mapOptionsToLocationParams(options)

      return LocationRequest.Builder(locationParams.interval)
        .setMinUpdateIntervalMillis(locationParams.interval)
        .setMaxUpdateDelayMillis(locationParams.interval)
        .setMinUpdateDistanceMeters(locationParams.distance)
        .setPriority(mapAccuracyToPriority(options.accuracy))
        .build()
    }

    internal fun prepareCurrentLocationRequest(options: LocationOptions): CurrentLocationRequest {
      val locationParams = mapOptionsToLocationParams(options)

      return CurrentLocationRequest.Builder().apply {
        setGranularity(Granularity.GRANULARITY_PERMISSION_LEVEL)
        setPriority(mapAccuracyToPriority(options.accuracy))
        setMaxUpdateAgeMillis(locationParams.interval)
      }.build()
    }

    /**
     * Races Google Play Services FusedLocationProviderClient AND Android's native LocationManager
     * simultaneously so offline devices, slow-TTFF chipsets, and non-GMS Huawei/Honor phones
     * all resolve as fast as physically possible without hanging.
     */
    fun requestSingleLocation(context: Context?, locationProvider: FusedLocationProviderClient, locationRequest: CurrentLocationRequest, promise: Promise) {
      if (context == null || !isGooglePlayServicesAvailable(context)) {
        requestSingleLocationFromLocationManager(context, promise)
        return
      }

      val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
      if (locationManager == null) {
        requestSingleLocationFromLocationManager(context, promise)
        return
      }

      val bestLastKnown = getLastKnownLocationFromLocationManager(context)
      if (bestLastKnown != null && bestLastKnown.accuracy <= 30f && (System.currentTimeMillis() - bestLastKnown.time) in 0L..5_000L) {
        promise.resolve(LocationResponse(bestLastKnown))
        return
      }

      val mainHandler = Handler(Looper.getMainLooper())
      val hasResolved = AtomicBoolean(false)

      val nativeListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
          if (hasResolved.compareAndSet(false, true)) {
            try {
              locationManager.removeUpdates(this)
            } catch (_: Throwable) {}
            promise.resolve(LocationResponse(location))
          }
        }

        override fun onProviderDisabled(p: String) {}
        override fun onProviderEnabled(p: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(p: String?, status: Int, extras: Bundle?) {}
      }

      val cleanupNative = {
        try {
          locationManager.removeUpdates(nativeListener)
        } catch (_: Throwable) {}
      }

      val isLocEnabled = isAnyProviderAvailable(context)
      val allProviders = try { locationManager.allProviders } catch (_: Throwable) { emptyList<String>() }
      val providersToTry = (allProviders + listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER, "fused")).distinct()

      for (p in providersToTry) {
        try {
          if (locationManager.isProviderEnabled(p) || p == LocationManager.PASSIVE_PROVIDER) {
            locationManager.requestLocationUpdates(p, 0L, 0f, nativeListener, Looper.getMainLooper())
          }
        } catch (_: Throwable) {}
      }

      val timeoutRunnable = Runnable {
        if (hasResolved.compareAndSet(false, true)) {
          cleanupNative()
          val fallback = getLastKnownLocationFromLocationManager(context) ?: bestLastKnown
          if (fallback != null && (System.currentTimeMillis() - fallback.time) < 600_000L) {
            promise.resolve(LocationResponse(fallback))
          } else if (!isLocEnabled) {
            promise.reject(LocationSettingsUnsatisfiedException())
          } else {
            promise.reject(CurrentLocationIsUnavailableException())
          }
        }
      }
      mainHandler.postDelayed(timeoutRunnable, 8_000L)

      try {
        locationProvider.getCurrentLocation(locationRequest, null)
          .addOnSuccessListener { location: Location? ->
            if (location != null && hasResolved.compareAndSet(false, true)) {
              mainHandler.removeCallbacks(timeoutRunnable)
              cleanupNative()
              promise.resolve(LocationResponse(location))
            }
          }
          .addOnFailureListener { err ->
            if (err is ApiException && (err.statusCode == 17 || err.statusCode == ConnectionResult.SERVICE_INVALID || err.statusCode == ConnectionResult.SERVICE_MISSING)) {
              sGooglePlayServicesBroken = true
            }
          }
      } catch (_: Throwable) {
        sGooglePlayServicesBroken = true
      }
    }

    fun requestSingleLocation(locationProvider: FusedLocationProviderClient, locationRequest: CurrentLocationRequest, promise: Promise) {
      try {
        locationProvider.getCurrentLocation(locationRequest, null)
          .addOnSuccessListener { location: Location? ->
            if (location == null) {
              promise.reject(CurrentLocationIsUnavailableException())
              return@addOnSuccessListener
            }

            promise.resolve(LocationResponse(location))
          }
          .addOnFailureListener {
            promise.reject(LocationRequestRejectedException(it))
          }
          .addOnCanceledListener {
            promise.reject(LocationRequestCancelledException())
          }
      } catch (e: SecurityException) {
        promise.reject(LocationRequestRejectedException(e))
      }
    }

    fun requestContinuousUpdates(locationModule: LocationModule, locationRequest: LocationRequest, watchId: Int, promise: Promise) {
      val settled = AtomicBoolean(false)
      locationModule.requestLocationUpdates(
        locationRequest,
        watchId,
        object : LocationRequestCallbacks {
          override fun onLocationChanged(location: Location) {
            locationModule.sendLocationResponse(watchId, LocationResponse(location))
          }

          override fun onRequestSuccess() {
            if (settled.compareAndSet(false, true)) {
              promise.resolve(null)
            }
          }

          override fun onRequestFailed(cause: CodedException) {
            if (settled.compareAndSet(false, true)) {
              promise.reject(cause)
            }
          }
        }
      )
    }

    private fun mapOptionsToLocationParams(options: LocationOptions): LocationParams {
      val accuracy = options.accuracy
      val locationParams = buildLocationParamsForAccuracy(accuracy)

      options.timeInterval?.let {
        locationParams.interval = it
      }
      options.distanceInterval?.let {
        locationParams.distance = it.toFloat()
      }

      return locationParams
    }

    private fun mapAccuracyToPriority(accuracy: Int): Int {
      return when (accuracy) {
        LocationModule.ACCURACY_BEST_FOR_NAVIGATION, LocationModule.ACCURACY_HIGHEST, LocationModule.ACCURACY_HIGH -> Priority.PRIORITY_HIGH_ACCURACY
        LocationModule.ACCURACY_BALANCED, LocationModule.ACCURACY_LOW -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
        LocationModule.ACCURACY_LOWEST -> Priority.PRIORITY_LOW_POWER
        else -> Priority.PRIORITY_BALANCED_POWER_ACCURACY
      }
    }

    private fun buildLocationParamsForAccuracy(accuracy: Int): LocationParams {
      return when (accuracy) {
        LocationModule.ACCURACY_LOWEST -> LocationParams(accuracy = LocationAccuracy.LOWEST, distance = 3000f, interval = 10000)
        LocationModule.ACCURACY_LOW -> LocationParams(accuracy = LocationAccuracy.LOW, distance = 1000f, interval = 5000)
        LocationModule.ACCURACY_BALANCED -> LocationParams(accuracy = LocationAccuracy.MEDIUM, distance = 100f, interval = 3000)
        LocationModule.ACCURACY_HIGH -> LocationParams(accuracy = LocationAccuracy.HIGH, distance = 50f, interval = 2000)
        LocationModule.ACCURACY_HIGHEST -> LocationParams(accuracy = LocationAccuracy.HIGH, distance = 25f, interval = 1000)
        LocationModule.ACCURACY_BEST_FOR_NAVIGATION -> LocationParams(accuracy = LocationAccuracy.HIGH, distance = 0f, interval = 500)
        else -> LocationParams(accuracy = LocationAccuracy.MEDIUM, distance = 100f, interval = 3000)
      }
    }

    fun isAnyProviderAvailable(context: Context?): Boolean {
      if (context == null) return false
      val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        ?: return false

      // 1. Android official master location switch (API 28+ and compat)
      try {
        if (LocationManagerCompat.isLocationEnabled(locationManager)) {
          return true
        }
      } catch (_: Throwable) {}

      // 2. Settings.Secure.LOCATION_MODE check for all Android versions and OEM skins (MIUI, EMUI, ColorOS, HiOS)
      try {
        val mode = Settings.Secure.getInt(
          context.contentResolver,
          Settings.Secure.LOCATION_MODE,
          Settings.Secure.LOCATION_MODE_OFF
        )
        if (mode != Settings.Secure.LOCATION_MODE_OFF) {
          return true
        }
      } catch (_: Throwable) {}

      // 3. Check individual providers (GPS, Network, Passive, Fused, etc.)
      try {
        if (locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
            locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
          return true
        }
      } catch (_: Throwable) {}

      try {
        for (provider in locationManager.allProviders) {
          if (locationManager.isProviderEnabled(provider)) {
            return true
          }
        }
      } catch (_: Throwable) {}

      return false
    }

    // Decorator for Permissions.getPermissionsWithPermissionsManager, for use in Kotlin coroutines
    internal suspend fun getPermissionsWithPermissionsManager(contextPermissions: Permissions, vararg permissionStrings: String): PermissionRequestResponse {
      return suspendCoroutine { continuation ->
        Permissions.getPermissionsWithPermissionsManager(
          contextPermissions,
          object : Promise {
            override fun resolve(value: Any?) {
              val result = value as? Bundle
                ?: throw ConversionException(Any::class.java, Bundle::class.java, "value returned by the permission promise is not a Bundle")
              continuation.resume(PermissionRequestResponse(result))
            }

            override fun reject(code: String?, message: String?, cause: Throwable?) {
              continuation.resumeWithException(CodedException(code, message, cause))
            }
          },
          *permissionStrings
        )
      }
    }

    // Decorator for Permissions.getPermissionsWithPermissionsManager, for use in Kotlin coroutines
    internal suspend fun askForPermissionsWithPermissionsManager(contextPermissions: Permissions, vararg permissionStrings: String): Bundle {
      return suspendCoroutine {
        Permissions.askForPermissionsWithPermissionsManager(
          contextPermissions,
          object : Promise {
            override fun resolve(value: Any?) {
              it.resume(
                value as? Bundle
                  ?: throw ConversionException(Any::class.java, Bundle::class.java, "value returned by the permission promise is not a Bundle")
              )
            }

            override fun reject(code: String?, message: String?, cause: Throwable?) {
              it.resumeWithException(CodedException(code, message, cause))
            }
          },
          *permissionStrings
        )
      }
    }
  }
}

/**
 * A singleton that keeps information about whether the app is in the foreground or not.
 * Defaults to true because apps start in the foreground before OnActivityEntersForeground fires.
 */
object AppForegroundedSingleton {
  @Volatile
  var isForegrounded = true
}

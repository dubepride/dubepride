package expo.modules.location

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
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

class LocationHelpers {
  companion object {
    /**
     * Checks whether Google Play Services is available and working on the device.
     */
    fun isGooglePlayServicesAvailable(context: Context?): Boolean {
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
     * Prevents low-accuracy cell tower fixes from overriding high-precision GPS fixes.
     */
    fun isBetterLocation(location: Location, currentBestLocation: Location?): Boolean {
      if (currentBestLocation == null) return true

      val timeDelta = location.time - currentBestLocation.time
      val isSignificantlyNewer = timeDelta > 60_000
      val isSignificantlyOlder = timeDelta < -60_000
      val isNewer = timeDelta > 0

      if (isSignificantlyNewer) return true
      if (isSignificantlyOlder) return false

      val accuracyDelta = (location.accuracy - currentBestLocation.accuracy).toInt()
      val isLessAccurate = accuracyDelta > 0
      val isMoreAccurate = accuracyDelta < 0
      val isSignificantlyLessAccurate = accuracyDelta > 50

      val isFromSameProvider = location.provider == currentBestLocation.provider

      return when {
        isMoreAccurate -> true
        isNewer && !isLessAccurate -> true
        isNewer && !isSignificantlyLessAccurate && isFromSameProvider -> true
        else -> false
      }
    }

    /**
     * Obtains the most recent location known to the device's native LocationManager (GPS, Network, Passive).
     */
    fun getLastKnownLocationFromLocationManager(context: Context?): Location? {
      if (context == null) return null
      val locationManager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return null
      var best: Location? = null
      val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)
      for (provider in providers) {
        try {
          if (locationManager.isProviderEnabled(provider)) {
            val loc = locationManager.getLastKnownLocation(provider)
            if (loc != null && isBetterLocation(loc, best)) {
              best = loc
            }
          }
        } catch (_: Throwable) {}
      }
      return best
    }

    /**
     * Obtains a single location fix using Android's native LocationManager.
     * Works on all devices without Google Play Services (e.g. Huawei, custom ROMs).
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
      if (bestLastKnown != null && bestLastKnown.accuracy <= 30f && (System.currentTimeMillis() - bestLastKnown.time) < 20_000) {
        promise.resolve(LocationResponse(bestLastKnown))
        return
      }

      val provider = when {
        locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
        locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
        locationManager.isProviderEnabled(LocationManager.PASSIVE_PROVIDER) -> LocationManager.PASSIVE_PROVIDER
        else -> null
      }

      if (provider == null) {
        if (bestLastKnown != null) {
          promise.resolve(LocationResponse(bestLastKnown))
          return
        }
        promise.reject(CurrentLocationIsUnavailableException())
        return
      }

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
          if (fallback != null) {
            promise.resolve(LocationResponse(fallback))
          } else {
            promise.reject(CurrentLocationIsUnavailableException())
          }
        }
      }
      mainHandler.postDelayed(timeoutRunnable, 10_000)

      try {
        locationManager.requestLocationUpdates(provider, 500L, 0f, listener, Looper.getMainLooper())
      } catch (e: SecurityException) {
        mainHandler.removeCallbacks(timeoutRunnable)
        if (bestLastKnown != null) {
          promise.resolve(LocationResponse(bestLastKnown))
        } else {
          promise.reject(LocationRequestRejectedException(e))
        }
      } catch (e: Throwable) {
        mainHandler.removeCallbacks(timeoutRunnable)
        if (bestLastKnown != null) {
          promise.resolve(LocationResponse(bestLastKnown))
        } else {
          promise.reject(LocationUnavailableException())
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
      return locationManager != null && locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
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

    fun requestSingleLocation(context: Context?, locationProvider: FusedLocationProviderClient, locationRequest: CurrentLocationRequest, promise: Promise) {
      if (!isGooglePlayServicesAvailable(context)) {
        requestSingleLocationFromLocationManager(context, promise)
        return
      }

      try {
        locationProvider.getCurrentLocation(locationRequest, null)
          .addOnSuccessListener { location: Location? ->
            if (location == null) {
              requestSingleLocationFromLocationManager(context, promise)
              return@addOnSuccessListener
            }

            promise.resolve(LocationResponse(location))
          }
          .addOnFailureListener {
            requestSingleLocationFromLocationManager(context, promise)
          }
          .addOnCanceledListener {
            promise.reject(LocationRequestCancelledException())
          }
      } catch (_: Throwable) {
        requestSingleLocationFromLocationManager(context, promise)
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
      locationModule.requestLocationUpdates(
        locationRequest,
        watchId,
        object : LocationRequestCallbacks {
          override fun onLocationChanged(location: Location) {
            locationModule.sendLocationResponse(watchId, LocationResponse(location))
          }

          override fun onRequestSuccess() {
            promise.resolve(null)
          }

          override fun onRequestFailed(cause: CodedException) {
            promise.reject(cause)
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
      val locationManager = context?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        ?: return false
      return locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER) || locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
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
 * This is a simple solution for passing current foreground information from the LocationModule to LocationTaskConsumer.
 */
object AppForegroundedSingleton {
  var isForegrounded = false
}

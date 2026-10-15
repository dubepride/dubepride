/**
 * withAndroidCleartext
 * ---------------------------------------------------------------------------
 * Adds `android:usesCleartextTraffic="true"` to the <application> element of
 * the generated Android manifest.
 *
 * WHY THIS EXISTS
 *   Android 9 (API 28) and later block plain `http://` traffic by default.
 *   Expo's own template only sets this flag in the *debug* and *debugOptimized*
 *   manifests (see android/app/src/debug/AndroidManifest.xml), so a **release**
 *   build silently refuses every http request and the app reports
 *   "Cannot reach the bridge" — even when the server, firewall and Wi-Fi are
 *   all fine.
 *
 *   BIOBRIDGE speaks plain HTTP to the bridge on the LAN
 *   (e.g. http://192.168.1.65:3000), so the release build must allow it.
 *
 * This plugin makes the setting survive `npx expo prebuild`, which otherwise
 * regenerates android/ from scratch and drops any hand edit.
 *
 * NOTE: the same flag is also written by hand into
 * android/app/src/main/AndroidManifest.xml for builds that skip prebuild.
 */
const { withAndroidManifest } = require("expo/config-plugins");

module.exports = function withAndroidCleartext(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults?.manifest;
    const application = manifest?.application?.[0];
    if (!application) {
      throw new Error(
        "withAndroidCleartext: no <application> element found in the Android manifest."
      );
    }
    application.$ = application.$ || {};
    application.$["android:usesCleartextTraffic"] = "true";
    return cfg;
  });
};

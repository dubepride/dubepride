/**
 * ============================================================================
 *  index.ts — entry point of the BIOBRIDGE companion app
 * ============================================================================
 *
 *  The side-effect import below is load-bearing: `TaskManager.defineTask()`
 *  must run at module scope, in EVERY JS context Expo boots — including the
 *  headless one Android spins up when the OS delivers a geofence event while
 *  the app is backgrounded or killed. Expo boots that context from this same
 *  entry module, so registering here (rather than inside a component) is what
 *  makes hands-free clocking survive the app being swiped away.
 */

import { registerRootComponent } from "expo";

import "./src/tasks/geofenceTask";
import App from "./App";

registerRootComponent(App);

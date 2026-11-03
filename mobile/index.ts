/**
 * ============================================================================
 *  index.ts — entry point of the Mine Eazy Mobile app
 * ============================================================================
 */

import { registerRootComponent } from "expo";

import "./src/tasks/geofenceTask";
import App from "./App";

registerRootComponent(App);

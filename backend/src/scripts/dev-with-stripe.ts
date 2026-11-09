import { loadBackendEnvironment } from "../config/load-environment.js";
import { runLocalStripeDevelopment } from "./local-stripe-development.js";

loadBackendEnvironment();
runLocalStripeDevelopment();

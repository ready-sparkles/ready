// Repository tests do not start the API's network adapters.
import { configureRealtimePublisher } from "../ports/realtime";

import { configureContentTestKeys } from "./content-key-fixture";

configureContentTestKeys();
configureRealtimePublisher(async () => undefined);

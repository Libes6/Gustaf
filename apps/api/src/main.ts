import { createApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
const app = await createApp(config);
await app.listen(config.port, config.host);

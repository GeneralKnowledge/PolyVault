#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { startRelayServer } from "./server.js";

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startRelayServer();
}

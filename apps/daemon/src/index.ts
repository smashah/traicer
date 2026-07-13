import { Schema } from "effect";

import { BootstrapV1 } from "@traice/api-contract";
import { makeCaptureControl } from "@traice/effect-runtime";
import { openOperationalState } from "@traice/state-sqlite";

import { createControlApp } from "./app";

const readBootstrap = async () => {
  const text = (await Bun.stdin.text()).trim();
  return Schema.decodeUnknownSync(BootstrapV1)(JSON.parse(text));
};

const bootstrap = await readBootstrap();
const state = openOperationalState("traicer-state.db");
const control = makeCaptureControl("healthy");
const app = createControlApp({
  control,
  controlToken: bootstrap.controlToken,
  databaseReady: state.integrityCheck,
});

const server = Bun.serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });

console.log(JSON.stringify({
  pid: process.pid,
  port: server.port,
  protocolVersion: 1,
  type: "ready",
}));

const shutdown = () => {
  server.stop(true);
  state.close();
  process.exit(0);
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

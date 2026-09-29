// Operator-only, read-only native queue evidence. Never clears or changes queue items.
import { loadEnvFile, env } from "node:process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { log } from "node:console";
import { EnvCredentialProvider, DEFAULT_AUTOMATEC_PATH } from "@bpdev/bridge";
import { runTool } from "../../packages/bridge/dist/process.js";

if (env.BP_INTEGRATION !== "1") throw new Error("Set BP_INTEGRATION=1 for native evidence export");
loadEnvFile(".env");
const id = env.BPDEMO_QUEUE_ID;
if (!id || !/^[a-zA-Z0-9-]{1,80}$/.test(id))
  throw new Error("Specify a demo suite ID in BPDEMO_QUEUE_ID");
const directory = resolve(".bpdev/demo", id);
const suite = JSON.parse(await readFile(resolve(directory, "suite.json"), "utf8"));
if (
  typeof suite.queueName !== "string" ||
  !suite.queueName.startsWith("BPDEV ") ||
  /[\r\n\0]/.test(suite.queueName)
)
  throw new Error("Expected a recorded BPDEV demo queue");
const file = resolve(directory, `queue-export-${Date.now()}.csv`);
const { user, password } = await new EnvCredentialProvider(env).getCredentials();
const result = await runTool(
  env.BP_AUTOMATEC_PATH ?? DEFAULT_AUTOMATEC_PATH,
  [
    "/user",
    user,
    password,
    ...(env.BP_DB_CONNECTION ? ["/dbconname", env.BP_DB_CONNECTION] : []),
    "/exportqueue",
    file,
    "/queuename",
    suite.queueName,
    "/locale",
    "en-US",
  ],
  {
    tool: "AutomateC",
    command: "/exportqueue",
    timeoutMs: 30000,
    encoding: env.BP_OUTPUT_ENCODING ?? "windows-1252",
    secrets: [password],
    maxOutputBytes: 1024 * 1024,
  },
);
if (result.exitCode !== 0 || result.interruption)
  throw new Error("Native export was not confirmed");
const info = await stat(file);
if (!info.isFile()) throw new Error("Native export file is absent");
log({
  file,
  bytes: info.size,
  queueName: suite.queueName,
  scope: "read-only queue export; no clearing",
});

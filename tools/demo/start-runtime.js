// Start a private local BP resource under the configured account, preserving the open client.
import { loadEnvFile, env } from "node:process";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { log } from "node:console";
loadEnvFile(".env");
const port = Number(env.BP_LISTENER_PORT ?? 8182);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || !env.BP_USER || !env.BP_PASSWORD)
  throw new Error("Set valid BP_LISTENER_PORT, BP_USER and BP_PASSWORD locally");
const occupied = await new Promise((done) => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(1000);
  socket.once("connect", () => {
    socket.destroy();
    done(true);
  });
  socket.once("error", () => {
    done(false);
  });
  socket.once("timeout", () => {
    socket.destroy();
    done(true);
  });
});
if (occupied) throw new Error("Listener port already occupied; no second resource started");
const executable = resolve(
  dirname(
    env.BP_AUTOMATEC_PATH ??
      "C:/Program Files/Blue Prism Limited/Blue Prism Automate/AutomateC.exe",
  ),
  "Automate.exe",
);
const child = spawn(
  executable,
  [
    "/resourcepc",
    "/user",
    env.BP_USER,
    env.BP_PASSWORD,
    "/dbconname",
    env.BP_DB_CONNECTION ?? "LocalDB Connection",
    "/port",
    String(port),
    "/local",
    "/invisible",
    "/nohttp",
  ],
  { windowsHide: true, detached: true, stdio: "ignore" },
);
await new Promise((done, fail) => {
  child.once("spawn", done);
  child.once("error", () => {
    fail(new Error("Could not start the local BP runtime"));
  });
});
child.unref();
await mkdir(".bpdev", { recursive: true });
await writeFile(
  `.bpdev/runtime-${port}.json`,
  JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() }),
);
log({ pid: child.pid, port, state: "started; verify listener before execution" });

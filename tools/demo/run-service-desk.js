// Small native browser qualification before the queue scenario. Synthetic data only.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env, execPath } from "node:process";
import { log } from "node:console";
import { setTimeout } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { serviceDeskObjects } from "./service-desk.js";
if (env.BP_INTEGRATION !== "1") throw new Error("Set BP_INTEGRATION=1 to enable native execution");
const suffix = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
const key = `demo-browser-${suffix}`;
const directory = resolve(".bpdev/demo", key);
await mkdir(directory, { recursive: true });
const client = new Client({ name: "bpdev-service-desk", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: execPath,
    args: [resolve("packages/mcp/dist/cli.js"), resolve(".")],
    stderr: "pipe",
  }),
);
let seq = 0;
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  await writeFile(
    resolve(directory, `${String(seq++).padStart(3, "0")}-${name}.json`),
    JSON.stringify(result, null, 2),
  );
  const text = result.content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}
try {
  const objects = serviceDeskObjects(suffix);
  const artifact = await call("bp_prepare", {
    objects,
    harness: {
      name: `BPDEV Service Desk Proof ${suffix}`,
      object: objects[1].name,
      calls: [
        { object: objects[0].name, action: "Launch" },
        {
          action: "Submit Case",
          inputs: { CaseKey: `"${key}"` },
          expect: { Confirmation: `CONFIRMED:${key}` },
        },
        { object: objects[0].name, action: "Terminate" },
      ],
      cleanupObject: objects[0].name,
      cleanupAction: "Terminate",
    },
  });
  if (!(await call("bp_validate", { artifactId: artifact.artifactId })).valid)
    throw new Error("Native parser rejected plan");
  await call("bp_deploy", { artifactId: artifact.artifactId });
  const run = await call("bp_start", { artifactId: artifact.artifactId, requestKey: key });
  log({
    directory,
    artifactId: artifact.artifactId,
    runId: run.runId,
    state: run.state,
    launchError: run.launchError,
  });
  let cursor = 0;
  for (let i = 0; i < 90; i++) {
    const observed = await call("bp_inspect", { runId: run.runId, cursor, limit: 200 });
    cursor = observed.nextCursor;
    if (["completed", "failed", "stopped"].includes(observed.run.state) && !observed.more) {
      const receipts = await (await globalThis.fetch("http://127.0.0.1:8931/records")).json();
      await writeFile(resolve(directory, "receipts.json"), JSON.stringify(receipts, null, 2));
      log({
        state: observed.run.state,
        verification: observed.run.verification.status,
        firstException: observed.run.logEvidence?.firstLoggedException,
        attempts: receipts.attempts[key] ?? 0,
      });
      if (observed.run.verification.status !== "passed" || receipts.attempts[key] !== 1)
        throw new Error("Native browser proof did not pass; inspect saved evidence");
      break;
    }
    if (i === 89) throw new Error("Observation budget exceeded; do not relaunch");
    await setTimeout(1500);
  }
} finally {
  await client.close();
}

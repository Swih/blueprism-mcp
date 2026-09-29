// Native integration via the public MCP protocol. Run from the repository root after build.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { env, execPath } from "node:process";
import { log } from "node:console";
import { setTimeout } from "node:timers";

if (env.BP_INTEGRATION !== "1")
  throw new Error("Set BP_INTEGRATION=1 to explicitly enable native BP imports and execution");
const root = resolve(".");
const client = new Client({ name: "bpdev-reproducible-demo", version: "1" });
const transport = new StdioClientTransport({
  command: execPath,
  args: [resolve("packages/mcp/dist/cli.js"), root],
  stderr: "pipe",
});
let diagnostic = "";
transport.stderr?.on("data", (part) => {
  diagnostic += String(part);
});
await client.connect(transport);
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};
try {
  const suffix = ` ${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  const objects = [];
  for (const stem of ["rpa-challenge.basic-actions", "rpa-challenge.form"]) {
    const spec = JSON.parse(
      await readFile(resolve(`packages/generator/examples/${stem}.object.json`), "utf8"),
    );
    spec.name += suffix;
    for (const action of spec.actions)
      for (const step of action.steps)
        if (step.kind === "waitFor") step.onTimeout.saveScreenCapture = true;
    objects.push(spec);
  }
  const [basic, form] = objects;
  // Give each public read-back a semantic output name so all seven values can be asserted.
  for (const action of form.actions.filter((action) => action.name.startsWith("Set Field "))) {
    const outputName = `${action.name.slice("Set Field ".length)} Read Back`;
    action.outputs[0].name = outputName;
    action.steps[0].outputs["Actual Value"] = outputName;
  }
  const quote = (value) => `"${value.replaceAll('"', '""')}"`;
  const values = {
    "First Name": "Alice",
    "Last Name": "Demo",
    "Company Name": "BPDEV",
    "Role in Company": "Testeur",
    Address: "1 rue du Test",
    Email: "demo@example.com",
    "Phone Number": "0100000000",
  };
  const calls = [
    { object: basic.name, action: "Launch", inputs: { "Wait Timeout": "30" } },
    { action: "Click Button - Start" },
  ];
  for (let round = 1; round <= 3; round++) {
    for (const [field, value] of Object.entries(values))
      calls.push({
        action: `Set Field ${field}`,
        inputs: { Value: quote(value) },
        ...(round === 3 ? { expect: { [`${field} Read Back`]: value } } : {}),
      });
    if (round < 3)
      calls.push({
        action: "Click Button - Submit",
        inputs: { "Next Round XPath": quote(`//button[normalize-space(.)='Round ${round + 1}']`) },
      });
  }
  calls.push({ object: basic.name, action: "Terminate" });
  const artifact = env.BPDEMO_ARTIFACT
    ? { artifactId: env.BPDEMO_ARTIFACT }
    : await call("bp_prepare", {
        objects,
        harness: {
          name: `BPDEV MCP RPA Proof${suffix}`,
          object: form.name,
          calls,
          cleanupObject: basic.name,
          cleanupAction: "Terminate",
        },
      });
  log("prepared", { artifactId: artifact.artifactId });
  const validation = await call("bp_validate", { artifactId: artifact.artifactId });
  if (!validation.valid) throw new Error("Native XML validation failed");
  await call("bp_deploy", { artifactId: artifact.artifactId });
  const run = await call("bp_start", {
    artifactId: artifact.artifactId,
    requestKey: env.BPDEMO_REQUEST_KEY ?? `demo-rpa-${artifact.artifactId}`,
  });
  log("started", {
    runId: run.runId,
    bpSessionId: run.bpSessionId,
    state: run.state,
    launchError: run.launchError,
  });
  const directory = resolve(".bpdev/demo", artifact.artifactId);
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "artifact.json"), JSON.stringify(artifact, null, 2));
  await writeFile(resolve(directory, "run.json"), JSON.stringify(run, null, 2));
  let cursor = 0;
  for (let poll = 0; poll < 80; poll++) {
    const result = await call("bp_inspect", { runId: run.runId, cursor });
    cursor = result.nextCursor;
    await writeFile(
      resolve(directory, `observation-${poll}.json`),
      JSON.stringify(result, null, 2),
    );
    log("observed", {
      state: result.run.state,
      verification: result.run.verification.status,
      health: result.observationHealth,
      logRows: result.logs.length,
      lastStage: result.logs.at(-1)?.stageName,
    });
    if (["completed", "failed", "stopped", "unknown"].includes(result.run.state)) {
      if (result.run.state !== "completed" || result.run.verification.status !== "passed")
        throw new Error(`Native run did not pass. Inspect local evidence: ${directory}`);
      log("PASS: three rounds, seven asserted values; real BP extension execution through MCP.");
      break;
    }
    if (poll === 79)
      throw new Error(`Observation deadline reached; do not relaunch. Reconcile run ${run.runId}`);
    await new Promise((done) => setTimeout(done, 2000));
  }
} finally {
  await client.close();
  if (diagnostic) log("Server diagnostics available; review locally if startup failed.");
}

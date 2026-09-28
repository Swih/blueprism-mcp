// Run from the repository root after npm run build. No import, launch, or credentials.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { URL } from "node:url";
import { log } from "node:console";
import { env } from "node:process";
import { loadCatalog } from "@bpdev/catalog";
import {
  generateObject,
  generateTestHarness,
  parseObjectSpec,
  xpathByText,
} from "@bpdev/generator";

const catalog = loadCatalog(resolve(".bpdev/catalog"));
const output = resolve(".bpdev/generated/reference-style");
await mkdir(output, { recursive: true });
const specs = [];
for (const stem of ["rpa-challenge.basic-actions", "rpa-challenge.form"]) {
  const spec = parseObjectSpec(
    JSON.parse(await readFile(new URL(`${stem}.object.json`, import.meta.url), "utf8")),
  );
  const file = generateObject(spec, catalog, {
    robotProfileDir: resolve(env.BP_ROBOT_PROFILE_DIR ?? ".bpdev/robot-chrome-profile"),
  });
  specs.push(spec);
  const path = resolve(output, file.fileName);
  await writeFile(path, file.xml, "utf8");
  log(path);
}

// Synthetic data: this is a selector/interaction test, not the Excel challenge score.
const basic = specs[0].name;
const form = specs[1].name;
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
  { object: basic, action: "Launch", inputs: { "Wait Timeout": "30" } },
  { action: "Click Button - Start" },
];
for (let round = 1; round <= 3; round++) {
  for (const [label, value] of Object.entries(values)) {
    calls.push({
      action: `Set Field ${label}`,
      inputs: { Value: quote(value) },
      ...(round === 3 && label === "Phone Number" ? { expect: { "Actual Value": value } } : {}),
    });
  }
  if (round < 3) {
    calls.push({
      action: "Click Button - Submit",
      inputs: { "Next Round XPath": quote(xpathByText(`Round ${round + 1}`, "button")) },
    });
  }
}
calls.push({ object: basic, action: "Terminate" });
const harness = generateTestHarness(
  { object: form, calls, cleanupObject: basic, cleanupAction: "Terminate" },
  specs,
  catalog,
);
const harnessPath = resolve(output, harness.fileName);
await writeFile(harnessPath, harness.xml, "utf8");
log(harnessPath);

const negative = generateTestHarness(
  {
    name: "BPDEV RPA Challenge - Expected Timeout Test",
    object: form,
    calls: [
      { object: basic, action: "Launch", inputs: { "Wait Timeout": "30" } },
      { action: "Click Button - Start" },
      // Once started, the Start button is gone. This must fail before a second click.
      { action: "Click Button - Start", inputs: { "Wait Timeout": "0.25" } },
      { object: basic, action: "Terminate" },
    ],
    cleanupObject: basic,
    cleanupAction: "Terminate",
  },
  specs,
  catalog,
);
const negativePath = resolve(output, negative.fileName);
await writeFile(negativePath, negative.xml, "utf8");
log(negativePath);

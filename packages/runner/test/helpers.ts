import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { loadCatalog } from "@bpdev/catalog";
import { getAttr, listStages, parseBpXml } from "@bpdev/model";
import type { ListenerStatus, LogEntry, SessionStatus } from "@bpdev/bridge";
import { vi } from "vitest";
import { Runner, DEFAULT_BROWSER_PATH, type BuildSpec, type RunnerOptions } from "../src/index.js";
import { Store } from "../src/store.js";

export const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const catalog = loadCatalog(join(import.meta.dirname, "../../catalog/test/fixtures"));
export function spec(): BuildSpec {
  return {
    objects: [
      {
        name: "BPDEV Fixture",
        description: "Synthetic runner test",
        runMode: "Exclusive",
        application: {
          kind: "BrowserLaunch",
          name: "Browser",
          browserPath: DEFAULT_BROWSER_PATH,
          url: "https://example.invalid/",
        },
        elements: [],
        actions: [
          {
            name: "Observe",
            description: "",
            inputs: [],
            outputs: [{ name: "Answer", type: "text", description: "" }],
            steps: [{ kind: "calc", expression: '"ok"', into: "Answer" }],
          },
          { name: "Finish", description: "", inputs: [], outputs: [], steps: [] },
        ],
      },
    ],
    harness: {
      object: "BPDEV Fixture",
      calls: [{ action: "Observe", expect: { Answer: "ok" } }],
      cleanupAction: "Finish",
    },
  };
}
export function log(index: number): LogEntry {
  return {
    time: "2026-09-29 12:00:00",
    stageId: SESSION,
    stageName: `Stage ${index}`,
    result: `Result ${index}`,
  };
}
export function bridges() {
  return {
    automatec: {
      listProcesses: vi.fn((): Promise<string[]> => Promise.resolve([])),
      import: vi.fn((): Promise<void> => Promise.resolve()),
      publish: vi.fn((): Promise<"published"> => Promise.resolve("published")),
      export: vi.fn((): Promise<string> => Promise.reject(new Error("Not used by the runner"))),
      run: vi.fn((): Promise<string> => Promise.resolve(SESSION)),
      status: vi.fn((): Promise<SessionStatus> => Promise.resolve("Running")),
      getLog: vi.fn((): Promise<LogEntry[]> => Promise.resolve([log(0), log(1), log(2)])),
      requestStop: vi.fn((): Promise<void> => Promise.resolve()),
    },
    listener: {
      busy: vi.fn((): Promise<boolean> => Promise.resolve(false)),
      status: vi.fn((): Promise<ListenerStatus> =>
        Promise.resolve({ totalRunning: 0, sessions: [] }),
      ),
      outputs: vi.fn(() => Promise.resolve([{ name: "Answer", type: "text", value: "ok" }])),
    },
    probe: {
      validate: vi.fn(async (file: string) => {
        const root = parseBpXml(await readFile(file, "utf8")).root;
        return {
          level: "native-parse" as const,
          valid: true,
          name: getAttr(root, "name"),
          kind: getAttr(root, "type") === "object" ? "Object" : "Process",
          stages: listStages(root).length,
          expressionsChecked: 0,
        };
      }),
    },
  };
}
export async function fixture() {
  const directory = await mkdtemp(join(import.meta.dirname, ".runner-test-"));
  const fake = bridges();
  const options: RunnerOptions = {
    ...fake,
    catalog,
    dataDirectory: directory,
    resource: "TEST-ROBOT",
    robotProfileDirectory: "C:\\Robot Profiles\\Unit Test",
  };
  const runner = new Runner(options);
  await runner.initialize();
  const store = new Store(directory);
  return { directory, options, fake, runner, store };
}
export async function cleanup(directory: string): Promise<void> {
  const root = resolve(import.meta.dirname);
  const target = resolve(directory);
  const rel = relative(root, target);
  if (!target.startsWith(`${root}${sep}`) || !rel.startsWith(".runner-test-") || rel.includes(sep))
    throw new Error("Unsafe test cleanup target");
  await rm(target, { recursive: true, force: true });
}
export type Fixture = Awaited<ReturnType<typeof fixture>>;
export async function deployed(f: Fixture) {
  const artifact = await f.runner.prepare(spec());
  await f.runner.deploy(artifact.artifactId);
  return artifact;
}

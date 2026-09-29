import { resolve } from "node:path";
import { z } from "zod";
import { AutomateC, EnvCredentialProvider, NativeProbe, RuntimeListener } from "@bpdev/bridge";
import { loadCatalog } from "@bpdev/catalog";
import { Runner } from "@bpdev/runner";
import { createServer } from "./server.js";

const configSchema = z.object({
  BP_USER: z.string().min(1),
  BP_PASSWORD: z.string().min(1),
  BP_RESOURCE_NAME: z.string().min(1),
  BP_DB_CONNECTION: z.string().optional(),
  BP_AUTOMATEC_PATH: z.string().optional(),
  BP_OUTPUT_ENCODING: z.string().default("windows-1252"),
  BP_LISTENER_PORT: z.coerce.number().int().min(1).max(65535).default(8181),
  BPDEV_DATA_DIR: z.string().default(".bpdev/state"),
  BPDEV_CATALOG_DIR: z.string().default(".bpdev/catalog"),
  BP_ROBOT_PROFILE_DIR: z.string().default(".bpdev/robot-chrome-profile"),
  BP_PROBE_PATH: z.string().default("tools/bpprobe/bin/bpprobe.exe"),
});

/** Operator configuration, never model-supplied paths. */
export async function configuredRuntime(root: string, environment: NodeJS.ProcessEnv) {
  const parsed = configSchema.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      `Invalid local configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const config = parsed.data;
  const credentials = new EnvCredentialProvider({
    BP_USER: config.BP_USER,
    BP_PASSWORD: config.BP_PASSWORD,
  });
  const catalog = loadCatalog(resolve(root, config.BPDEV_CATALOG_DIR));
  const automatec = new AutomateC({
    credentials,
    path: config.BP_AUTOMATEC_PATH,
    dbConnection: config.BP_DB_CONNECTION,
    outputEncoding: config.BP_OUTPUT_ENCODING,
  });
  const listener = new RuntimeListener({
    credentials,
    port: config.BP_LISTENER_PORT,
    secrets: [config.BP_PASSWORD],
  });
  const probe = new NativeProbe({ path: resolve(root, config.BP_PROBE_PATH) });
  const runner = new Runner({
    dataDirectory: resolve(root, config.BPDEV_DATA_DIR),
    robotProfileDirectory: resolve(root, config.BP_ROBOT_PROFILE_DIR),
    resource: config.BP_RESOURCE_NAME,
    resourcePort: config.BP_LISTENER_PORT,
    catalog,
    automatec,
    listener,
    probe,
  });
  await runner.initialize();
  return { runner, catalog, secrets: [config.BP_PASSWORD] };
}

export async function configuredServer(root: string, environment: NodeJS.ProcessEnv) {
  return createServer(await configuredRuntime(root, environment));
}

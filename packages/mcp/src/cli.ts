import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { configuredServer } from "./config.js";

// Root is operator configuration in MCP args. Never log to stdout.
const root = resolve(process.argv[2] ?? process.cwd());
try {
  try {
    loadEnvFile(resolve(root, ".env"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const app = await configuredServer(root, process.env);
  const transport = new StdioServerTransport();
  const close = (): void => {
    void app.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await app.server.connect(transport);
} catch {
  process.stderr.write(
    "blueprism-mcp startup failed. Check .env, local catalog and writable BPDEV_DATA_DIR. No credentials were logged.\n",
  );
  process.exitCode = 1;
}

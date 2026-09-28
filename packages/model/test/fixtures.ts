import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURES = join(import.meta.dirname, "fixtures");

/** Every fixture file, as a path relative to the fixtures directory. */
export function listFixtures(): string[] {
  return readdirSync(FIXTURES, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(bpprocess|bpobject|bprelease|xml)$/.test(f))
    .map((f) => f.replaceAll("\\", "/"))
    .sort();
}

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

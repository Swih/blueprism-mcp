import { doc, el, serializeBpXml } from "@bpdev/model";
import { InvalidArgumentError } from "../errors.js";

/** Blue Prism data types a startup parameter can take on the command line. */
export const STARTUP_PARAM_TYPES = [
  "text",
  "number",
  "flag",
  "date",
  "datetime",
  "time",
  "timespan",
  "password",
] as const;

export type StartupParamType = (typeof STARTUP_PARAM_TYPES)[number];

/**
 * One process startup parameter. `value` is Blue Prism's own text form of the value: checked
 * here for `number` (invariant decimal, e.g. `-1.5`) and `flag` (`True` / `False`); passed
 * as is for the other types.
 */
export interface StartupParam {
  readonly name: string;
  readonly type: StartupParamType;
  readonly value: string;
}

const NUMBER = /^-?\d+(\.\d+)?$/;

/**
 * The `/startp` argument: `<inputs><input name="…" type="…" value="…" /></inputs>`, built
 * and escaped by @bpdev/model. No XML declaration and no indentation: Blue Prism reads the
 * document's top-level nodes and expects exactly one, `<inputs>`.
 */
export function buildStartupInputs(params: readonly StartupParam[]): string {
  const names = new Set<string>();
  for (const p of params) {
    if (p.name.trim() === "") throw new InvalidArgumentError("Startup parameter with no name");
    if (names.has(p.name))
      throw new InvalidArgumentError(`Duplicate startup parameter "${p.name}"`);
    names.add(p.name);
    if (!(STARTUP_PARAM_TYPES as readonly string[]).includes(p.type)) {
      throw new InvalidArgumentError(`Startup parameter "${p.name}": unknown type "${p.type}"`);
    }
    if (p.type === "number" && !NUMBER.test(p.value)) {
      throw new InvalidArgumentError(`Startup parameter "${p.name}": not a number`);
    }
    if (p.type === "flag" && p.value !== "True" && p.value !== "False") {
      throw new InvalidArgumentError(`Startup parameter "${p.name}": flag must be True or False`);
    }
  }
  const root = el(
    "inputs",
    {},
    params.map((p) => el("input", { name: p.name, type: p.type, value: p.value })),
  );
  // The serializer writes one element per line, indented, after the XML declaration. Line
  // breaks never occur inside attribute values (written `&#xA;`), so dropping the first
  // line and the indentation leaves the same document on one line.
  return serializeBpXml(doc(root))
    .split("\n")
    .slice(1)
    .map((line) => line.trimStart())
    .join("");
}

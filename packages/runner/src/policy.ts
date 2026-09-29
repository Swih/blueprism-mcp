import { win32 } from "node:path";
import {
  parseObjectSpec,
  parseTestHarnessSpec,
  type ObjectSpec,
  type ActionSpec,
} from "@bpdev/generator";
import type { BuildSpec } from "./contracts.js";
import { safeName } from "./contracts.js";
import { RunnerError } from "./errors.js";

export const DEFAULT_BROWSER_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profileArg = '--user-data-dir="{robotProfileDir}"';
const flags = new Set(["--no-first-run", "--no-default-browser-check"]);
export const SUPPORTED_BROWSER_OPERATIONS = {
  actions: ["WebClick", "WebFocus"],
  reads: ["WebGetText", "WebGetValue", "WebGetAttribute", "WebGetDocumentURL", "WebGetPageUrl"],
  conditions: ["WebCheckExists", "WebCheckValue", "WebCheckText"],
};
function reject(
  reason = "Check browser path, URL, profile arguments and BrowserAttach parameters against bp_capabilities",
): never {
  throw new RunnerError(
    "UNSUPPORTED_SPEC",
    `Plan exceeds the configured browser execution policy: ${reason}`,
  );
}
function browser(path: string, allowed: string): void {
  if (
    !/^[a-z]:[\\/]/i.test(path) ||
    /[\p{Cc}"]/u.test(path) ||
    win32.normalize(path).toLowerCase() !== win32.normalize(allowed).toLowerCase()
  )
    reject();
}

/** Limits apply to each array, before parsing or generating XML. */
function boundedInput(input: unknown): void {
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    reject("Input must be bounded JSON");
  }
  if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > 512 * 1024)
    reject("Input JSON exceeds 512 KiB");
  const pending: { key: string; value: unknown }[] = [{ key: "", value: input }];
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    const { key, value } = item;
    if (Array.isArray(value)) {
      const limit = key === "steps" || key === "elements" ? 200 : 100;
      if (value.length > limit) reject(`${key || "Input"} array exceeds ${limit} entries`);
      for (const child of value) pending.push({ key: "", value: child });
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value);
      if ((key === "inputs" || key === "outputs" || key === "args") && entries.length > 100)
        reject(`${key} exceeds 100 entries`);
      for (const [childKey, child] of entries) pending.push({ key: childKey, value: child });
    }
  }
}

function specificTitle(value: string): void {
  // A literal prefix with an optional trailing wildcard; never a wildcard-led match.
  // Title matching narrows attachment but does not prove profile/session ownership.
  if (!/^[^*?[\]"\p{Cc}]+\*?$/u.test(value) || !value.replace(/\*$/, "").trim())
    reject("Attach requires a specific literal WindowTitle, optionally ending in *");
}

function attachArgs(
  args: Record<string, string> | undefined,
  declaredTitle: string | undefined,
): void {
  if (
    !args ||
    Object.keys(args).some((key) => key !== "ProcessName" && key !== "WindowTitle") ||
    args.ProcessName !== '"chrome"'
  )
    reject('Attach accepts only literal ProcessName "chrome" and WindowTitle');
  const title = /^"([^"\r\n]+)"$/.exec(args.WindowTitle ?? "")?.[1];
  if (title === undefined) reject("Attach WindowTitle must be a literal, not an expression");
  specificTitle(title);
  if (declaredTitle !== undefined && title !== declaredTitle)
    reject("Attach WindowTitle must match the application WindowTitle");
}

export interface PolicyCall {
  readonly object: string;
  readonly action: string;
  readonly inputs?: Readonly<Record<string, string>>;
}

function inRange(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 120;
}

/** Prove the complete incoming call graph; keep the original expressions unchanged. */
function boundedWaits(
  objects: readonly ObjectSpec[],
  calls: readonly PolicyCall[] | undefined,
): void {
  for (const object of objects) {
    const proven = new Map<ActionSpec, Set<string>>();
    const checking = new Map<ActionSpec, Set<string>>();
    const expression = (action: ActionSpec, value: string): void => {
      if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && inRange(Number(value))) return;
      const name = /^\[([^\]]+)\]$/.exec(value)?.[1];
      if (name === undefined)
        reject("Wait timeout must be a bounded numeric literal or immutable numeric parameter");
      parameter(action, name);
    };
    const parameter = (action: ActionSpec, name: string): void => {
      if (proven.get(action)?.has(name)) return;
      if (checking.get(action)?.has(name))
        reject("Cyclic timeout parameter forwarding is unsupported");
      const declarations = action.inputs.filter((p) => p.name === name);
      const param = declarations[0];
      if (
        declarations.length !== 1 ||
        param?.type !== "number" ||
        !inRange(param.defaultValue) ||
        action.outputs.some((p) => p.name === name)
      )
        reject("Wait parameter needs a numeric default in (0, 120] and cannot be an output");
      for (const step of action.steps) {
        if (
          ((step.kind === "calc" || step.kind === "read") && step.into === name) ||
          (step.kind === "callPage" && Object.values(step.outputs ?? {}).includes(name))
        )
          reject("Wait parameters cannot be assigned by calculations, reads or page outputs");
      }
      if (calls === undefined && action.published !== false)
        reject("Dynamic waits on published inputs require the complete caller list");
      const active = checking.get(action) ?? new Set<string>();
      checking.set(action, active);
      active.add(name);
      for (const caller of object.actions) {
        for (const step of caller.steps) {
          if (
            step.kind === "callPage" &&
            step.page === action.name &&
            step.inputs?.[name] !== undefined
          )
            expression(caller, step.inputs[name]);
        }
      }
      for (const call of calls ?? []) {
        if (
          call.object === object.name &&
          call.action === action.name &&
          call.inputs?.[name] !== undefined
        ) {
          const value = call.inputs[name];
          if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !inRange(Number(value)))
            reject("Harness timeout overrides must be numeric literals in (0, 120]");
        }
      }
      active.delete(name);
      const done = proven.get(action) ?? new Set<string>();
      proven.set(action, done);
      done.add(name);
    };
    for (const action of object.actions) {
      for (const step of action.steps) {
        if (step.kind !== "waitFor") continue;
        if (typeof step.timeoutSeconds === "number") {
          if (!inRange(step.timeoutSeconds)) reject("Wait timeout must be in (0, 120]");
        } else {
          // The generator supports a declared data reference, not numeric expression text.
          const name = /^\[([^\]]+)\]$/.exec(step.timeoutSeconds)?.[1];
          if (name === undefined)
            reject("Dynamic wait timeout must reference a declared numeric parameter");
          parameter(action, name);
        }
      }
    }
  }
}

/** Validate before emitting any artifact. The model cannot choose an executable or flags. */
export function applyPolicy(spec: BuildSpec, browserPath: string): BuildSpec {
  boundedInput(spec);
  const harness = parseTestHarnessSpec(spec.harness);
  const calls: PolicyCall[] = harness.calls.map((call) => ({
    ...call,
    object: call.object ?? harness.object,
  }));
  calls.push({ object: harness.cleanupObject ?? harness.object, action: harness.cleanupAction });
  return { objects: applyObjectPolicy(spec.objects, browserPath, calls), harness };
}

/** Other process builders must pass every external call to qualify dynamic input waits. */
export function applyObjectPolicy(
  input: readonly ObjectSpec[],
  browserPath: string,
  calls?: readonly PolicyCall[],
): ObjectSpec[] {
  boundedInput({ objects: input });
  if (input.length < 1 || input.length > 10) reject();
  const objects = input.map((raw): ObjectSpec => {
    const object = parseObjectSpec(raw);
    safeName(object.name);
    const application = object.application;
    if (application.kind === "BrowserLaunch") {
      browser(application.browserPath, browserPath);
      let url: URL;
      try {
        url = new URL(application.url);
      } catch {
        return reject();
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        /[\s"<>\\\p{Cc}]/u.test(application.url)
      )
        reject();
      const extraArgs: string[] = [];
      let hasProfile = false;
      for (const arg of application.extraArgs ?? []) {
        if (arg === profileArg || arg === "--user-data-dir={robotProfileDir}") {
          if (hasProfile) reject();
          hasProfile = true;
        } else if (!flags.has(arg) || extraArgs.includes(arg)) reject();
        else extraArgs.push(arg);
      }
      // A local robot needs no Google sign-in. Suppress first-run onboarding and default-browser UI.
      // The profile must already contain the official BP extension; these flags do not install it.
      object.application = { ...application, extraArgs: [profileArg, ...flags] };
    } else {
      for (const [name, value] of Object.entries(application.parameters ?? {})) {
        if (name === "Path") browser(value, browserPath);
        else if (name === "WindowTitle") {
          specificTitle(value);
        } else if (name === "CommandLineParams") {
          if (value !== "") reject();
        } else if (name === "ProcessMode") {
          if (value !== "Internal") reject();
        } else if (name === "ExternalProcessTimeout") {
          if (value !== "0") reject();
        } else reject();
      }
      object.application = {
        ...application,
        parameters: { ...application.parameters, Path: browserPath, CommandLineParams: "" },
      };
    }
    for (const action of object.actions) {
      for (const step of action.steps) {
        if (step.kind === "ensureAttached")
          attachArgs(
            step.args,
            application.kind === "BrowserAttach" ? application.parameters?.WindowTitle : undefined,
          );
        if (step.kind === "act" && !SUPPORTED_BROWSER_OPERATIONS.actions.includes(step.action))
          reject(
            `Unsupported interaction. Allowed actions: ${SUPPORTED_BROWSER_OPERATIONS.actions.join(", ")}`,
          );
        if (step.kind === "read" && !SUPPORTED_BROWSER_OPERATIONS.reads.includes(step.action))
          reject(
            `Unsupported read. Allowed reads: ${SUPPORTED_BROWSER_OPERATIONS.reads.join(", ")}`,
          );
        if (
          step.kind === "waitFor" &&
          step.condition !== undefined &&
          !SUPPORTED_BROWSER_OPERATIONS.conditions.includes(step.condition)
        )
          reject(
            `Unsupported condition. Allowed conditions: ${SUPPORTED_BROWSER_OPERATIONS.conditions.join(", ")}`,
          );
      }
    }
    return object;
  });
  boundedWaits(objects, calls);
  return objects;
}

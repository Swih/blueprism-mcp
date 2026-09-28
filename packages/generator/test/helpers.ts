import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadCatalog } from "@bpdev/catalog";
import {
  childElements,
  childText,
  firstChild,
  getAttr,
  listStages,
  type BpElement,
  type StageView,
} from "@bpdev/model";
import type { ObjectSpec, TestHarnessSpec } from "../src/index.js";

/** The hand-written catalogue subset of @bpdev/catalog (no SS&C help texts). */
export const FIXTURE_CATALOG_DIR = join(import.meta.dirname, "../../catalog/test/fixtures");
export const catalog = loadCatalog(FIXTURE_CATALOG_DIR);

export const EXAMPLES = join(import.meta.dirname, "../examples");
export const OPTIONS = { robotProfileDir: "C:\\bpdev\\robot-chrome-profile" };

function readJson(name: string): unknown {
  return JSON.parse(readFileSync(join(EXAMPLES, name), "utf8")) as unknown;
}

/** A fresh copy of the RPA Challenge example, safe to modify. */
export function exampleObject(): ObjectSpec {
  return readJson("rpa-challenge.object.json") as ObjectSpec;
}

export function exampleHarness(): TestHarnessSpec {
  return readJson("rpa-challenge.harness.json") as TestHarnessSpec;
}

export function stageNamed(root: BpElement, name: string, pageId?: string): StageView {
  const stage = listStages(root).find(
    (s) => s.name === name && (pageId === undefined || s.pageId === pageId),
  );
  if (!stage) throw new Error(`No stage named "${name}"`);
  return stage;
}

export function pageId(root: BpElement, name: string): string {
  const page = childElements(root, "subsheet").find((s) => childText(s, "name") === name);
  const id = page && getAttr(page, "subsheetid");
  if (id === undefined) throw new Error(`No page named "${name}"`);
  return id;
}

export function stagesOfPage(root: BpElement, id: string | undefined): StageView[] {
  return listStages(root).filter((s) => s.pageId === id);
}

/** Descendant elements with that name, depth first. */
export function descendants(element: BpElement, name: string): BpElement[] {
  return childElements(element).flatMap((c) => [
    ...(c.name === name ? [c] : []),
    ...descendants(c, name),
  ]);
}

export function display(stage: StageView): { x: number; y: number } {
  const d = firstChild(stage.element, "display");
  return { x: Number(d && getAttr(d, "x")), y: Number(d && getAttr(d, "y")) };
}

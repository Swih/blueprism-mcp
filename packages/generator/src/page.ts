import { textEl, type BpChild, type BpElement } from "@bpdev/model";
import type { IdRegistry } from "./ids.js";
import { GeneratorError } from "./errors.js";
import { INFO_POSITION, PageLayout, type Position } from "./layout.js";
import { stageElement } from "./stages.js";

export interface Stage {
  readonly id: string;
  readonly name: string;
  readonly element: BpElement;
  readonly position: Position;
}

type Body = readonly BpChild[] | ((name: string) => readonly BpChild[]);

/**
 * Collects the stages of one page: GUIDs from `owner/page/type/name` (G6), positions from the
 * layout (G11), and `onsuccess` links along the main column. Stage names are made unique
 * within the page ("Write X", "Write X 2") so that GUID paths never collide.
 */
export class Page {
  readonly stages: BpElement[] = [];
  private readonly layout = new PageLayout();
  private readonly names = new Set<string>();
  private pending: { readonly element: BpElement; readonly tag: string } | undefined;

  constructor(
    private readonly ids: IdRegistry,
    /** Object or process name, first part of every GUID path. */
    private readonly owner: string,
    /** `Initialise` / `Main Page` for the main page. */
    readonly name: string,
    /** `undefined` for the main page. */
    readonly subsheetId: string | undefined,
  ) {}

  /** The page's info stage: ProcessInfo on the main page, SubSheetInfo on the others. */
  info(type: "ProcessInfo" | "SubSheetInfo", name: string, narrative: string, body: Body): Stage {
    return this.add(type, name, INFO_POSITION, body, narrative);
  }

  /** Next stage of the main column, linked from the previous one. */
  main(type: string, name: string, body: Body, narrative?: string): Stage {
    const position = type === "WaitStart" ? this.layout.wait() : this.layout.main();
    const stage = this.add(type, this.unique(name), position, body, narrative);
    if (this.pending) this.pending.element.children.push(textEl(this.pending.tag, stage.id));
    this.pending = { element: stage.element, tag: "onsuccess" };
    return stage;
  }

  /** A stage of the branch column (error paths, recovery); linked with `Page.link`. */
  branch(type: string, name: string, body: Body, alignY?: number): Stage {
    return this.add(type, this.unique(name), this.layout.branch(alignY), body);
  }

  /** A data item, in the data column. Names are data item names: kept as given. */
  data(name: string, body: Body, narrative?: string): Stage {
    return this.add("Data", name, this.layout.data(), body, narrative);
  }

  /** The main flow continues from `element` (e.g. `ontrue` of a Wait choice). */
  continueFrom(element: BpElement, tag: string): void {
    this.pending = { element, tag };
  }

  /** The main flow stops here (after an Exception stage). */
  endFlow(): void {
    this.pending = undefined;
  }

  static link(from: Stage, to: Stage): void {
    from.element.children.push(textEl("onsuccess", to.id));
  }

  /** XML load order can matter to Studio independently of execution links. */
  serializeBefore(stage: Stage, before: Stage): void {
    const index = this.stages.indexOf(stage.element);
    if (index < 0 || !this.stages.includes(before.element) || stage === before) {
      throw new GeneratorError("Cannot reorder stages outside this page");
    }
    this.stages.splice(index, 1);
    this.stages.splice(this.stages.indexOf(before.element), 0, stage.element);
  }

  private unique(name: string): string {
    let candidate = name;
    for (let n = 2; this.names.has(candidate); n++) candidate = `${name} ${n}`;
    this.names.add(candidate);
    return candidate;
  }

  private add(
    type: string,
    name: string,
    position: Position,
    body: Body,
    narrative?: string,
  ): Stage {
    const id = this.ids.id(this.owner, this.name, type, name);
    const children = typeof body === "function" ? body(name) : body;
    const shape =
      type === "Anchor"
        ? { w: 10, h: 10 }
        : type === "WaitEnd"
          ? { w: 30, h: 30 }
          : type === "Data"
            ? { w: 90, h: 30 }
            : [
                  "Read",
                  "Write",
                  "Navigate",
                  "SubSheet",
                  "Action",
                  "Calculation",
                  "Decision",
                  "Exception",
                ].includes(type)
              ? { w: 90, h: 40 }
              : {};
    const sizedPosition = { ...position, ...shape };
    const head = {
      id,
      name,
      type,
      subsheetId: this.subsheetId,
      position: sizedPosition,
      narrative,
    };
    const element = stageElement(head, children);
    this.stages.push(element);
    return { id, name, element, position: sizedPosition };
  }
}

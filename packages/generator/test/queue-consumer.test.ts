import {
  childElements,
  childText,
  firstChild,
  getAttr,
  listPages,
  listStages,
  parseBpXml,
  type StageView,
} from "@bpdev/model";
import { assert, describe, expect, it } from "vitest";
import {
  generateQueueConsumer,
  queueConsumerSpecSchema,
  SpecValidationError,
  type ObjectSpec,
  type QueueConsumerSpec,
} from "../src/index.js";

const spec: QueueConsumerSpec = {
  name: "BPDEV Synthetic Consumer",
  queueName: "BPDEV Synthetic Queue",
  call: {
    object: "BPDEV Synthetic Web",
    action: "Process Case",
    input: "Case",
    confirmationOutput: "Receipt",
    expectedConfirmationPrefix: "CONFIRMED:",
  },
};
function objectSpec(): ObjectSpec {
  return {
    name: spec.call.object,
    description: "Synthetic contract",
    runMode: "Exclusive",
    application: { kind: "BrowserAttach", name: "Synthetic Browser" },
    elements: [],
    actions: [
      {
        name: spec.call.action,
        description: "",
        inputs: [{ name: "Case", type: "text", description: "" }],
        outputs: [{ name: "Receipt", type: "text", description: "" }],
        steps: [{ kind: "calc", expression: '"CONFIRMED:" & [Case]', into: "Receipt" }],
      },
    ],
  };
}
function lifecycleObject(): ObjectSpec {
  return {
    ...objectSpec(),
    name: "BPDEV Synthetic Lifecycle",
    actions: ["Launch", "Terminate"].map((name) => ({
      name,
      description: "",
      inputs: [],
      outputs: [],
      steps: [],
    })),
  };
}
function lifecycleSpec(): QueueConsumerSpec {
  return {
    ...spec,
    launch: { object: "BPDEV Synthetic Lifecycle", action: "Launch" },
    cleanup: { object: "BPDEV Synthetic Lifecycle", action: "Terminate" },
  };
}
function graph(consumer: QueueConsumerSpec = lifecycleSpec()) {
  const xml = generateQueueConsumer(consumer, [objectSpec(), lifecycleObject()]).xml;
  const root = parseBpXml(xml).root,
    all = listStages(root),
    pages = listPages(root);
  const page = (name: string) => {
    if (name === "Main Page") return all.filter((stage) => stage.pageId === undefined);
    const found = pages.find((candidate) => candidate.name === name);
    assert(found, "Missing page " + name);
    return all.filter((stage) => stage.pageId === found.id);
  };
  const named = (name: string, pageName?: string) => {
    const matches = (pageName ? page(pageName) : all).filter((stage) => stage.name === name);
    assert(matches.length === 1, "Expected unique stage " + name);
    const stage = matches[0];
    assert(stage);
    return stage;
  };
  return { xml, all, pages, page, named };
}
type Graph = ReturnType<typeof graph>;
function attr(stage: StageView, tag: string, key: string): string {
  const node = firstChild(stage.element, tag);
  assert(node, "Missing " + tag + " on " + stage.name);
  const value = getAttr(node, key);
  assert(value !== undefined, "Missing " + key);
  return value;
}
function expressions(stage: StageView): string[] {
  return childElements(stage.element).flatMap((node) =>
    node.attributes
      .filter((attribute) => ["expression", "detail", "expr"].includes(attribute.name))
      .map((attribute) => attribute.value),
  );
}
function params(stage: StageView, direction: string) {
  const list = firstChild(stage.element, direction);
  return list ? childElements(list) : [];
}
function inputs(stage: StageView) {
  const result: Record<string, string | undefined> = {};
  for (const param of params(stage, "inputs")) {
    const name = getAttr(param, "name");
    assert(name, "Missing input name on " + stage.name);
    result[name] = getAttr(param, "expr");
  }
  return result;
}
function links(stage: StageView): string[] {
  return [stage.onSuccess, stage.onTrue, stage.onFalse].filter(
    (id): id is string => id !== undefined,
  );
}
/**
 * XML graph checks only: explicit branch choices and page-call expansion, no BP expression
 * evaluation or exception dispatch. These tests do not prove native-engine behavior.
 * stopAt bounds the intentional next-item cycle; any other revisit fails.
 */
function trace(
  g: Graph,
  start: StageView,
  decisions: Readonly<Record<string, boolean>>,
  stopAt?: StageView,
) {
  const visited: StageView[] = [],
    seen = new Set<string>();
  const walk = (entry: StageView): "return" | "terminal" => {
    let current = entry;
    for (;;) {
      const stop = current.id === stopAt?.id && visited.length > 0;
      visited.push(current);
      if (stop) return "terminal";
      assert(!seen.has(current.id), "Unexpected cycle at " + current.name);
      seen.add(current.id);
      if (current.type === "Exception") return "terminal";
      if (current.type === "End") return "return";
      if (current.type === "SubSheet") {
        const pageId = childText(current.element, "processid");
        const pageStart = g.all.find((stage) => stage.pageId === pageId && stage.type === "Start");
        assert(pageId && pageStart, "Unresolved page call " + current.name);
        if (walk(pageStart) === "terminal") return "terminal";
      }
      let next = current.onSuccess;
      if (current.type === "Decision") {
        assert(Object.hasOwn(decisions, current.name), "Missing branch " + current.name);
        next = decisions[current.name] ? current.onTrue : current.onFalse;
      }
      const target = g.all.find((stage) => stage.id === next);
      assert(target, "Missing next stage after " + current.name);
      current = target;
    }
  };
  walk(start);
  return visited;
}
function before(path: readonly StageView[], first: StageView, second: StageView) {
  const a = path.findIndex((stage) => stage.id === first.id),
    b = path.findIndex((stage) => stage.id === second.id);
  expect(a, first.name).toBeGreaterThanOrEqual(0);
  expect(b, second.name).toBeGreaterThan(a);
}
const success = {
  "Item Available?": true,
  "Case Key Present?": true,
  "Confirmation Matches?": true,
  "Cleanup Needed?": true,
  "Continue Processing?": true,
};

describe("bounded native queue graph (not native-engine qualification)", () => {
  it("returns to acquisition only after confirmation, finalization, cleanup and per-item reset", () => {
    const g = graph(),
      get = g.named("Get Next Item"),
      visited = trace(g, get, success, get);
    expect(visited.filter((stage) => stage.id === get.id)).toHaveLength(2);
    for (const name of ["Execute Browser Work", "Mark Completed", "Close Browser"])
      expect(visited.filter((stage) => stage.name === name)).toHaveLength(1);
    before(visited, g.named("Confirmation Matches?"), g.named("Mark Completed"));
    before(visited, g.named("Mark Completed"), g.named("Count Finalized Item"));
    before(visited, g.named("Count Finalized Item"), g.named("Close Browser"));
    before(visited, g.named("Close Browser"), g.named("Reset Global Data", "Main Page"));
    before(visited, g.named("Reset Global Data", "Main Page"), g.named("Continue Processing?"));
    expect(visited).not.toContain(g.named("Mark Exception - No Retry"));
    expect(visited).not.toContain(g.named("Reset Session Data", "Main Page"));
  });
  it.each([true, false])(
    "finalizes a recovered item once before cleanup and acquisition (business=%s)",
    (business) => {
      const g = graph(),
        get = g.named("Get Next Item");
      const visited = trace(
        g,
        g.named("Recover Item Failure"),
        {
          "Business Exception?": business,
          "Count Business Exception?": business,
          "Cleanup Needed?": true,
          "Continue Processing?": true,
        },
        get,
      );
      expect(visited.at(-1)).toBe(get);
      expect(visited.filter((stage) => stage.name === "Mark Exception - No Retry")).toHaveLength(1);
      before(visited, g.named("Resume To Finalize Item"), g.named("Mark Exception - No Retry"));
      before(visited, g.named("Mark Exception - No Retry"), g.named("Count Finalized Item"));
      before(visited, g.named("Count Finalized Item"), g.named("Close Browser"));
      before(visited, g.named("Close Browser"), g.named("Reset Global Data", "Main Page"));
      expect(
        visited.some((stage) => ["Execute Browser Work", "Mark Completed"].includes(stage.name)),
      ).toBe(false);
    },
  );
  it("an empty Item ID exits without application work or queue finalization", () => {
    const g = graph();
    expect(attr(g.named("Item Available?"), "decision", "expression")).toBe('[Item ID] <> ""');
    const visited = trace(g, g.named("Get Next Item"), {
      "Item Available?": false,
      "No Eligible Item?": true,
      "Any Items Processed?": false,
    });
    expect(visited.filter((stage) => stage.type === "Action")).toEqual([g.named("Get Next Item")]);
    expect(visited.at(-1)).toBe(g.named("End", "Main Page"));
    expect(visited).not.toContain(g.named("Read Case Key"));
    expect(visited).not.toContain(g.named("Continue Processing?"));
    const empty = g.named("No Eligible Item Returned");
    expect(attr(empty, "calculation", "stage")).toBe("No Eligible Item");
    expect(attr(empty, "calculation", "expression")).toBe("True");
    expect(
      visited.some(
        (stage) =>
          stage.type === "Calculation" &&
          attr(stage, "calculation", "stage") === "Stop Reason" &&
          attr(stage, "calculation", "expression") === '"No eligible item available"',
      ),
    ).toBe(true);
  });
  it("checks both bounds and native stop requests before acquisition", () => {
    const g = graph(),
      gate = g.named("Continue Processing?");
    expect(attr(gate, "decision", "expression")).toBe(
      "([Processed Count] < [Stop After Items]) AND ([Consecutive System Exceptions] < [System Exception Limit]) AND (IsStopRequested() = False)",
    );
    for (const [itemLimit, systemLimit, reason] of [
      [true, false, "Item Limit Reason"],
      [false, true, "System Error Limit Reason"],
      [false, false, "Operator Stop Reason"],
    ] as const) {
      const visited = trace(g, gate, {
        "Continue Processing?": false,
        "Item Limit Reached?": itemLimit,
        "System Error Limit Reached?": systemLimit,
        "No Eligible Item?": false,
      });
      expect(visited).toContain(g.named(reason));
      expect(visited.some((stage) => stage.type === "Action")).toBe(false);
      expect(visited.at(-1)).toBe(g.named("End", "Main Page"));
      expect(visited).toContain(g.named("Default Stopped Outcome"));
    }
  });
  it("encloses only Validate, Launch, Work, Verify and WorkRecover in the Work block", () => {
    const g = graph(),
      block = g.named("Work Exception");
    const bounds = (stage: StageView) =>
      Object.fromEntries(
        ["x", "y", "w", "h"].map((key) => [key, Number(attr(stage, "display", key))]),
      ) as Record<"x" | "y" | "w" | "h", number>;
    const b = bounds(block);
    // BP blocks use top-left coordinates; normal stages use centres.
    const inside = g.page("Main Page").filter((stage) => {
      if (stage.id === block.id) return false;
      const s = bounds(stage);
      return (
        s.x - s.w / 2 >= b.x &&
        s.x + s.w / 2 <= b.x + b.w &&
        s.y - s.h / 2 >= b.y &&
        s.y + s.h / 2 <= b.y + b.h
      );
    });
    expect(inside.map((stage) => stage.name).sort()).toEqual(
      [
        "Validate Item",
        "Launch Application",
        "Work Step - Submit Request",
        "Verify Result",
        "Recover Item Failure",
      ].sort(),
    );
    for (const name of [
      "Mark Item As Completed",
      "Mark Item As Exception",
      "Close Down",
      "Recover Fatal Failure",
      "Get Next Item",
    ])
      expect(inside).not.toContain(g.named(name, "Main Page"));
    expect(g.all.filter((stage) => stage.type === "Block")).toHaveLength(1);
    expect(g.all.filter((stage) => stage.type === "Recover")).toHaveLength(2);
  });
  it("keeps Main-page link segments clear of unrelated stage boxes, including the stop route", () => {
    const g = graph();
    const main = g.page("Main Page");
    const box = (stage: StageView) => {
      const x = Number(attr(stage, "display", "x"));
      const y = Number(attr(stage, "display", "y"));
      const halfWidth = Number(attr(stage, "display", "w")) / 2;
      const halfHeight = Number(attr(stage, "display", "h")) / 2;
      expect([x, y, halfWidth, halfHeight].every(Number.isFinite)).toBe(true);
      expect(halfWidth).toBeGreaterThan(0);
      expect(halfHeight).toBeGreaterThan(0);
      return { x, y, halfWidth, halfHeight };
    };
    type Box = ReturnType<typeof box>;
    const segment = (source: Box, target: Box) => {
      const dx = target.x - source.x,
        dy = target.y - source.y;
      expect(Math.abs(dx) + Math.abs(dy)).toBeGreaterThan(0);
      // Clip centre-to-centre links at both endpoint boxes, including anchor sizes.
      const extent = (bounds: Box) =>
        Math.min(
          dx === 0 ? Infinity : bounds.halfWidth / Math.abs(dx),
          dy === 0 ? Infinity : bounds.halfHeight / Math.abs(dy),
        );
      const start = extent(source),
        end = 1 - extent(target);
      expect(start, "Linked stage boxes must not overlap").toBeLessThan(end);
      return {
        x: source.x + dx * start,
        y: source.y + dy * start,
        dx: dx * (end - start),
        dy: dy * (end - start),
      };
    };
    const crosses = (line: ReturnType<typeof segment>, obstacle: Box) => {
      let enter = 0,
        exit = 1;
      // Intersect a finite segment with the open rectangle interior. A corner touch
      // or a line along the outer border does not cross the stage box.
      for (const [origin, delta, min, max] of [
        [line.x, line.dx, obstacle.x - obstacle.halfWidth, obstacle.x + obstacle.halfWidth],
        [line.y, line.dy, obstacle.y - obstacle.halfHeight, obstacle.y + obstacle.halfHeight],
      ] as const) {
        if (delta === 0) {
          if (origin <= min || origin >= max) return false;
        } else {
          const a = (min - origin) / delta,
            b = (max - origin) / delta;
          enter = Math.max(enter, Math.min(a, b));
          exit = Math.min(exit, Math.max(a, b));
          if (enter >= exit) return false;
        }
      }
      return enter < exit;
    };
    // Blocks are containment regions, anchors are routing points, and Info is annotation.
    const obstacles = main.filter(
      (stage) => !["Block", "Anchor", "ProcessInfo"].includes(stage.type),
    );
    const collisions: string[] = [];
    for (const source of main) {
      for (const id of links(source)) {
        const target = main.find((stage) => stage.id === id);
        assert(target, "Missing Main-page link target");
        const line = segment(box(source), box(target));
        for (const obstacle of obstacles) {
          if (obstacle.id === source.id || obstacle.id === target.id) continue;
          if (crosses(line, box(obstacle)))
            collisions.push(source.name + " -> " + target.name + " crosses " + obstacle.name);
        }
      }
    }
    expect(collisions).toEqual([]);
    const stop = g.named("Set Stop Reason", "Main Page");
    const route = g.named("Stop Route", "Main Page");
    expect(links(stop)).toContain(route.id);
    const stopLine = segment(box(stop), box(route));
    const fatal = box(g.named("Raise System Exception", "Main Page"));
    expect(crosses(stopLine, fatal)).toBe(false);
    // The previous fatal-stage row intersected this horizontal link. This negative
    // control proves the check detects that regression without changing the template.
    expect(crosses(stopLine, { ...fatal, y: box(stop).y })).toBe(true);
  });
  it("fatal recovery retains primary evidence and terminates without Resume or another queue write", () => {
    const g = graph(),
      visited = trace(g, g.named("Recover Fatal Failure"), { "Cleanup Needed?": true });
    expect(visited.at(-1)?.type).toBe("Exception");
    expect(visited.some((stage) => stage.type === "Resume")).toBe(false);
    expect(visited.filter((stage) => stage.type === "Action")).toEqual([g.named("Close Browser")]);
    before(visited, g.named("Preserve Fatal Failure"), g.named("Close Browser"));
    const detail = attr(g.named("Preserve Fatal Failure"), "calculation", "expression");
    for (const evidence of ["[Item Failure Detail]", "ExceptionType()", "ExceptionDetail()"])
      expect(detail).toContain(evidence);
    expect(attr(g.named("Raise System Exception"), "exception", "detail")).toBe("[Failure Detail]");
  });
  it("latches launch/cleanup before external calls and skips previously attempted cleanup", () => {
    const g = graph(),
      launch = trace(g, g.named("Start", "Launch Application"), {});
    before(launch, g.named("Record Launch Attempt"), g.named("Launch Browser"));
    const close = trace(g, g.named("Start", "Close Down"), { "Cleanup Needed?": true });
    before(close, g.named("Latch Cleanup Attempt"), g.named("Close Browser"));
    expect(attr(g.named("Cleanup Needed?"), "decision", "expression")).toBe(
      "([Browser Started] = True) AND ([Cleanup Attempted] = False)",
    );
    expect(
      trace(g, g.named("Start", "Close Down"), { "Cleanup Needed?": false }).some(
        (stage) => stage.type === "Action",
      ),
    ).toBe(false);
    expect(
      graph(spec).all.filter(
        (stage) =>
          stage.type === "Action" &&
          attr(stage, "resource", "object") === "BPDEV Synthetic Lifecycle",
      ),
    ).toEqual([]);
  });
  it("has no dangling/cross-page flow edges, recursive page calls or cycles bypassing the guard", () => {
    const g = graph();
    expect(new Set(g.all.map((stage) => stage.id)).size).toBe(g.all.length);
    expect(new Set(g.pages.map((page) => page.id)).size).toBe(g.pages.length);
    for (const stage of g.all) {
      if (stage.type === "Decision") {
        expect(stage.onTrue).toBeDefined();
        expect(stage.onFalse).toBeDefined();
        expect(stage.onSuccess).toBeUndefined();
      }
      if (["End", "Exception"].includes(stage.type)) expect(links(stage)).toEqual([]);
      for (const link of links(stage)) {
        const target = g.all.find((candidate) => candidate.id === link);
        assert(target, "Dangling " + stage.name);
        expect(target.pageId).toBe(stage.pageId);
      }
      if (stage.type === "SubSheet") {
        const id = childText(stage.element, "processid");
        expect(g.pages.some((page) => page.id === id)).toBe(true);
        expect(
          g.all.filter((candidate) => candidate.pageId === id && candidate.type === "Start"),
        ).toHaveLength(1);
      }
    }
    const gate = g.named("Continue Processing?"),
      active = new Set<string>(),
      done = new Set<string>();
    // Removing only the guarded acquisition edge must break every flow cycle on every page.
    const visit = (stage: StageView) => {
      assert(!active.has(stage.id), "Cycle bypasses loop guard: " + stage.name);
      if (done.has(stage.id)) return;
      active.add(stage.id);
      for (const id of links(stage)) {
        if (stage.id === gate.id && id === gate.onTrue) continue;
        const target = g.all.find((candidate) => candidate.id === id);
        assert(target);
        visit(target);
      }
      active.delete(stage.id);
      done.add(stage.id);
    };
    g.all.forEach(visit);
    const visitPage = (id: string | undefined, ancestors: readonly (string | undefined)[]) => {
      expect(ancestors).not.toContain(id);
      for (const call of g.all.filter((stage) => stage.pageId === id && stage.type === "SubSheet"))
        visitPage(childText(call.element, "processid"), [...ancestors, id]);
    };
    visitPage(undefined, []);
    expect(g.all.filter((stage) => stage.name === "Get Next Item")).toHaveLength(1);
    expect(g.all.filter((stage) => stage.name === "Execute Browser Work")).toHaveLength(1);
    expect(graph().xml).toBe(g.xml);
  });
});

describe("recovery and exception classification", () => {
  it("snapshots ExceptionType/Detail/Stage before Resume with no recovery functions afterward", () => {
    const native = new Set(["ExceptionType", "ExceptionDetail", "ExceptionStage"]);
    for (const consumer of [spec, lifecycleSpec()]) {
      const g = graph(consumer);
      const visited = trace(
        g,
        g.named("Recover Item Failure"),
        {
          "Business Exception?": false,
          "Count Business Exception?": false,
          "Cleanup Needed?": true,
          "Continue Processing?": true,
        },
        g.named("Get Next Item"),
      );
      const resume = visited.findIndex((stage) => stage.type === "Resume");
      expect(resume).toBeGreaterThan(0);
      const snapshot = visited.slice(0, resume).flatMap(expressions).join(" ");
      for (const fn of native) expect(snapshot).toContain(fn + "()");
      expect(attr(g.named("Capture Exception Type"), "calculation", "stage")).toBe(
        "Exception Type",
      );
      expect(attr(g.named("Capture Exception Detail"), "calculation", "stage")).toBe(
        "Item Failure Detail",
      );
      expect(
        visited
          .slice(resume + 1)
          .flatMap(expressions)
          .join(" "),
      ).not.toMatch(/\bException\w+\s*\(/);
      const used = new Set<string>();
      for (const expression of g.all.flatMap(expressions))
        for (const call of expression.matchAll(/\b(Exception\w+)\s*\(([^)]*)\)/g)) {
          expect(native.has(call[1] ?? ""), expression).toBe(true);
          expect(call[2]?.trim(), expression).toBe("");
          used.add(call[1] ?? "");
        }
      expect(used).toEqual(native);
    }
  });
  it("exposes only Business/System types and normalizes other caught types before finalization", () => {
    const g = graph({ ...spec, call: { ...spec.call, businessRejectionPrefix: "REJECTED:" } });
    expect(
      new Set(
        g.all
          .filter((stage) => stage.type === "Exception")
          .map((stage) => attr(stage, "exception", "type")),
      ),
    ).toEqual(new Set(["Business Exception", "System Exception"]));
    expect(attr(g.named("Business Exception?"), "decision", "expression")).toBe(
      '[Exception Type] = "Business Exception"',
    );
    expect(attr(g.named("Normalize System Exception"), "calculation", "expression")).toBe(
      '"System Exception"',
    );
    for (const business of [true, false]) {
      const visited = trace(g, g.named("Start", "Mark Item As Exception"), {
        "Business Exception?": business,
        "Count Business Exception?": business,
      });
      if (business) expect(visited).not.toContain(g.named("Normalize System Exception"));
      else
        before(
          visited,
          g.named("Normalize System Exception"),
          g.named("Mark Exception - No Retry"),
        );
      before(visited, g.named("Retain Primary Failure"), g.named("Mark Exception - No Retry"));
    }
  });
  it("requires exact correlated confirmation/rejection; an unexplained mismatch is a System Exception", () => {
    const g = graph({ ...spec, call: { ...spec.call, businessRejectionPrefix: "REJECTED:" } });
    expect(attr(g.named("Confirmation Matches?"), "decision", "expression")).toBe(
      '[Confirmation] = ("CONFIRMED:" & [ItemCaseKey])',
    );
    expect(attr(g.named("Explicit Business Rejection?"), "decision", "expression")).toBe(
      '[Confirmation] = ("REJECTED:" & [ItemCaseKey])',
    );
    for (const rejected of [true, false]) {
      const visited = trace(g, g.named("Start", "Verify Result"), {
        "Confirmation Matches?": false,
        "Explicit Business Rejection?": rejected,
      });
      const last = visited.at(-1);
      assert(last);
      expect(attr(last, "exception", "type")).toBe(
        rejected ? "Business Exception" : "System Exception",
      );
      expect(visited.some((stage) => stage.type === "Action")).toBe(false);
    }
    const plain = graph(spec);
    expect(plain.all.some((stage) => stage.name === "Explicit Business Rejection?")).toBe(false);
    const missing = trace(plain, plain.named("Start", "Validate Item"), {
      "Case Key Present?": false,
    }).at(-1);
    assert(missing);
    expect(attr(missing, "exception", "type")).toBe("Business Exception");
  });
});

describe("native action parameters and aggregate data", () => {
  it("preserves inspected queue parameter shapes, friendly names and literal no-retry values", () => {
    const g = graph();
    // Names/order/types from BP 7.5.1 inspection; these tests only inspect generated XML.
    const contracts = [
      {
        stage: "Get Next Item",
        action: "Get Next Item",
        inputs: [
          ["Queue Name", "text"],
          ["Key Filter", "text"],
          ["Tag Filter", "text"],
          ["Sort Order", "text"],
        ],
        outputs: [
          ["Item ID", "text"],
          ["Data", "collection"],
          ["Status", "text"],
          ["Attempts", "number"],
        ],
      },
      {
        stage: "Mark Completed",
        action: "Mark Completed",
        inputs: [["Item ID", "text"]],
        outputs: [],
      },
      {
        stage: "Mark Exception - No Retry",
        action: "Mark Exception",
        inputs: [
          ["Item ID", "text"],
          ["Exception Reason", "text"],
          ["Retry", "flag"],
          ["Keep Locked", "flag"],
        ],
        outputs: [["New Item ID", "text"]],
      },
    ];
    for (const contract of contracts) {
      const stage = g.named(contract.stage);
      expect(attr(stage, "resource", "object")).toBe("Blueprism.Automate.clsWorkQueuesActions");
      expect(attr(stage, "resource", "action")).toBe(contract.action);
      for (const direction of ["inputs", "outputs"] as const)
        expect(
          params(stage, direction).map((param) => [getAttr(param, "name"), getAttr(param, "type")]),
        ).toEqual(contract[direction]);
    }
    expect(inputs(g.named("Get Next Item"))).toEqual({
      "Queue Name": "[Queue Name]",
      "Key Filter": "",
      "Tag Filter": '"bpdev-v1"',
      "Sort Order": "",
    });
    expect(inputs(g.named("Mark Completed"))).toEqual({ "Item ID": "[Item ID]" });
    expect(inputs(g.named("Mark Exception - No Retry"))).toEqual({
      "Item ID": "[Item ID]",
      "Exception Reason": "[Failure Detail]",
      Retry: "False",
      "Keep Locked": "False",
    });
    for (const stage of g.all.filter((candidate) => candidate.type === "Action"))
      for (const direction of ["inputs", "outputs"])
        for (const param of params(stage, direction))
          expect(getAttr(param, "friendlyname")).toBe(getAttr(param, "name"));
    expect(
      g.all.filter(
        (stage) =>
          stage.type === "Action" &&
          attr(stage, "resource", "object") === "Blueprism.Automate.clsWorkQueuesActions",
      ),
    ).toHaveLength(3);
  });
  it("binds the acquired collection's CaseKey to the public work action and captures its confirmation", () => {
    const g = graph(),
      work = g.named("Execute Browser Work");
    expect(attr(g.named("Read Case Key"), "calculation", "expression")).toBe("[Data.CaseKey]");
    expect(attr(g.named("Read Case Key"), "calculation", "stage")).toBe("ItemCaseKey");
    expect(attr(work, "resource", "object")).toBe(spec.call.object);
    expect(attr(work, "resource", "action")).toBe(spec.call.action);
    expect(inputs(work)).toEqual({ Case: "[ItemCaseKey]" });
    expect(
      params(work, "outputs").map((param) => [
        getAttr(param, "name"),
        getAttr(param, "type"),
        getAttr(param, "stage"),
      ]),
    ).toEqual([["Receipt", "text", "Confirmation"]]);
    const data = g.named("Data"),
      fields = firstChild(data.element, "collectioninfo");
    assert(fields);
    expect(data.type).toBe("Collection");
    expect(
      childElements(fields).map((field) => [getAttr(field, "name"), getAttr(field, "type")]),
    ).toEqual([["CaseKey", "text"]]);
  });
  it("exposes exactly nine scalar outputs backed by unique global session data initialized once", () => {
    const g = graph(),
      expected = [
        ["Outcome", "text"],
        ["Completed Count", "number"],
        ["Business Exception Count", "number"],
        ["System Exception Count", "number"],
        ["Processed Count", "number"],
        ["Stop Reason", "text"],
        ["Last Item ID", "text"],
        ["Last Case Key", "text"],
        ["Failure Detail", "text"],
      ];
    const outputs = params(g.named("End", "Main Page"), "outputs");
    expect(outputs).toHaveLength(9);
    expect(outputs.map((param) => [getAttr(param, "name"), getAttr(param, "type")])).toEqual(
      expect.arrayContaining(expected),
    );
    for (const param of outputs) expect(getAttr(param, "stage")).toBe(getAttr(param, "name"));
    const data = g.all.filter((stage) => ["Data", "Collection"].includes(stage.type));
    expect(new Set(data.map((stage) => stage.name)).size).toBe(data.length);
    for (const item of data) {
      expect(firstChild(item.element, "private"), item.name).toBeUndefined();
      expect(g.page("Reset Session Data")).toContain(item);
    }
    for (const [name, type] of expected) {
      assert(name && type);
      const item = g.named(name, "Reset Session Data");
      expect(childText(item.element, "datatype")).toBe(type);
      expect(childText(item.element, "initialvalue") ?? "").toBe(type === "number" ? "0" : "");
    }
    const startup = trace(
      g,
      g.named("Start", "Main Page"),
      {
        "Configuration Valid?": true,
        "Continue Processing?": true,
      },
      g.named("Get Next Item"),
    );
    expect(startup.filter((stage) => stage.name === "Reset Session Data")).toHaveLength(1);
  });
  it("increments one category and Processed Count only after successful queue finalization", () => {
    const g = graph();
    for (const category of ["completed", "business", "system"]) {
      const completed = category === "completed",
        business = category === "business";
      const visited = trace(
        g,
        g.named("Start", completed ? "Mark Item As Completed" : "Mark Item As Exception"),
        {
          "Business Exception?": business,
          "Count Business Exception?": business,
        },
      );
      const writes = visited.filter((stage) => stage.type === "Action");
      expect(writes).toHaveLength(1);
      const increments = visited.filter(
        (stage) =>
          stage.type === "Calculation" &&
          attr(stage, "calculation", "expression").endsWith(" Count] + 1"),
      );
      const categoryName = completed
        ? "Completed Count"
        : business
          ? "Business Exception Count"
          : "System Exception Count";
      expect(increments.map((stage) => attr(stage, "calculation", "stage")).sort()).toEqual(
        [categoryName, "Processed Count"].sort(),
      );
      const write = writes[0];
      assert(write);
      for (const increment of increments) before(visited, write, increment);
      for (const name of ["Remember Item ID", "Remember Case Key"])
        before(visited, write, g.named(name));
      const updates = visited.filter(
        (stage) =>
          stage.type === "Calculation" &&
          attr(stage, "calculation", "stage") === "Consecutive System Exceptions",
      );
      expect(updates).toHaveLength(1);
      const update = updates[0];
      assert(update);
      expect(attr(update, "calculation", "expression")).toBe(
        category === "system" ? "[Consecutive System Exceptions] + 1" : "0",
      );
    }
  });
  it("resets per-item state without losing totals, consecutive failures, last identity or aggregate evidence", () => {
    const g = graph(),
      reset = g.page("Reset Global Data").filter((stage) => stage.type === "Calculation");
    expect(reset.map((stage) => attr(stage, "calculation", "stage")).sort()).toEqual(
      [
        "Item ID",
        "ItemCaseKey",
        "Item Status",
        "Confirmation",
        "Exception Type",
        "Item Failure Detail",
        "New Item ID",
        "Browser Started",
        "Cleanup Attempted",
        "Attempts",
      ].sort(),
    );
    for (const stage of reset) {
      const destination = attr(stage, "calculation", "stage");
      expect(attr(stage, "calculation", "expression")).toBe(
        destination === "Attempts"
          ? "0"
          : ["Browser Started", "Cleanup Attempted"].includes(destination)
            ? "False"
            : '""',
      );
    }
  });
  it.each([
    [false, false, false, "Stopped"],
    [true, false, false, "NoAvailableItem"],
    [true, true, false, "Completed"],
    [true, true, true, "CompletedWithExceptions"],
  ] as const)(
    "reports aggregate outcome for noEligible=%s processed=%s exceptions=%s",
    (noEligible, processed, exceptions, outcome) => {
      const g = graph(),
        visited = trace(g, g.named("Start", "Build Session Result"), {
          "No Eligible Item?": noEligible,
          "Any Items Processed?": processed,
          "Any Item Exceptions?": exceptions,
        });
      const final = visited
        .filter(
          (stage) =>
            stage.type === "Calculation" && attr(stage, "calculation", "stage") === "Outcome",
        )
        .at(-1);
      assert(final);
      expect(attr(final, "calculation", "expression")).toBe('"' + outcome + '"');
      expect(attr(g.named("Any Item Exceptions?"), "decision", "expression")).toBe(
        "([Business Exception Count] + [System Exception Count]) > 0",
      );
    },
  );
});

describe("bounded controls and literal safety", () => {
  it("defaults to 100 items, three consecutive system exceptions and never retry", () => {
    expect(queueConsumerSpecSchema.parse(spec)).toMatchObject({
      maxItems: 100,
      consecutiveSystemExceptionLimit: 3,
      retryPolicy: "never",
    });
    const g = graph(spec);
    expect(childText(g.named("Stop After Items").element, "initialvalue")).toBe("100");
    expect(childText(g.named("System Exception Limit").element, "initialvalue")).toBe("3");
  });
  it.each([
    [1, 1],
    [2, 2],
    [1000, 100],
  ])("accepts and serializes controls %s/%s", (maxItems, consecutiveSystemExceptionLimit) => {
    const g = graph({ ...spec, maxItems, consecutiveSystemExceptionLimit });
    expect(childText(g.named("Stop After Items").element, "initialvalue")).toBe(String(maxItems));
    expect(childText(g.named("System Exception Limit").element, "initialvalue")).toBe(
      String(consecutiveSystemExceptionLimit),
    );
  });
  it.each([
    ...[0, -1, 1001, 1.5, NaN, Infinity, "2", null].map((maxItems) => ({ maxItems })),
    ...[0, -1, 101, 1.5, NaN, Infinity, "3", null].map((consecutiveSystemExceptionLimit) => ({
      consecutiveSystemExceptionLimit,
    })),
    { retryPolicy: "automatic" },
    { retryPolicy: "always" },
    { retryBeforeSubmit: true },
  ])("rejects invalid controls or replay settings %j", (extra) => {
    const input = { ...spec, ...extra };
    expect(queueConsumerSpecSchema.safeParse(input).success).toBe(false);
    expect(() => generateQueueConsumer(input as QueueConsumerSpec, objectSpec())).toThrow(
      SpecValidationError,
    );
  });
  it("requires distinct nonempty prefixes and rejects fixed uncorrelated confirmation", () => {
    const { expectedConfirmationPrefix: _, ...call } = spec.call;
    for (const candidate of [
      { ...call, expectedConfirmation: "OK" },
      { ...spec.call, expectedConfirmationPrefix: "" },
      { ...spec.call, businessRejectionPrefix: "" },
      { ...spec.call, businessRejectionPrefix: "CONFIRMED:" },
      { ...spec.call, businessRejectionPrefix: "REJECTED:\n" },
    ])
      expect(queueConsumerSpecSchema.safeParse({ ...spec, call: candidate }).success).toBe(false);
    expect(
      queueConsumerSpecSchema.safeParse({
        ...spec,
        call: { ...spec.call, businessRejectionPrefix: "REJECTED:" },
      }).success,
    ).toBe(true);
  });
  it.each(["expectedConfirmationPrefix", "businessRejectionPrefix"] as const)(
    "quotes %s as a BP literal, not an expression",
    (field) => {
      const g = graph({ ...spec, call: { ...spec.call, [field]: 'accepted" Or True Or "x<&' } });
      const name =
        field === "expectedConfirmationPrefix"
          ? "Confirmation Matches?"
          : "Explicit Business Rejection?";
      expect(attr(g.named(name), "decision", "expression")).toBe(
        '[Confirmation] = ("accepted"" Or True Or ""x<&" & [ItemCaseKey])',
      );
    },
  );
});

describe("supplied public action contracts", () => {
  it("rejects wrong, absent, private or incompatible work actions", () => {
    const variants: ObjectSpec[] = [];
    const wrong = objectSpec();
    wrong.name = "Different object";
    variants.push(wrong);
    const absent = objectSpec();
    absent.actions = [];
    variants.push(absent);
    for (const mutation of [
      "private",
      "input type",
      "output type",
      "input name",
      "output name",
      "extra input",
      "extra output",
    ]) {
      const object = objectSpec(),
        action = object.actions[0];
      assert(action?.inputs[0] && action.outputs[0]);
      if (mutation === "private") action.published = false;
      if (mutation === "input type") action.inputs[0].type = "password";
      if (mutation === "output type") action.outputs[0].type = "flag";
      if (mutation === "input name") action.inputs[0].name = "Other";
      if (mutation === "output name") action.outputs[0].name = "Other";
      if (mutation === "extra input")
        action.inputs.push({ name: "Other", type: "text", description: "" });
      if (mutation === "extra output")
        action.outputs.push({ name: "Other", type: "text", description: "" });
      variants.push(object);
    }
    for (const object of variants)
      expect(() => generateQueueConsumer(spec, object)).toThrow(SpecValidationError);
  });
  it("requires paired lifecycle references and public actions without inputs or outputs", () => {
    for (const role of ["launch", "cleanup"] as const)
      expect(
        queueConsumerSpecSchema.safeParse({ ...spec, [role]: lifecycleSpec()[role] }).success,
      ).toBe(false);
    expect(() => generateQueueConsumer(lifecycleSpec(), objectSpec())).toThrow(SpecValidationError);
    for (const index of [0, 1])
      for (const mutation of ["private", "input", "output"]) {
        const invalid = lifecycleObject(),
          action = invalid.actions[index];
        assert(action);
        if (mutation === "private") action.published = false;
        if (mutation === "input")
          action.inputs.push({ name: "Unexpected", type: "text", description: "" });
        if (mutation === "output")
          action.outputs.push({ name: "Unexpected", type: "text", description: "" });
        expect(() => generateQueueConsumer(lifecycleSpec(), [objectSpec(), invalid])).toThrow(
          SpecValidationError,
        );
      }
    expect(() =>
      generateQueueConsumer(lifecycleSpec(), [objectSpec(), lifecycleObject(), lifecycleObject()]),
    ).toThrow(SpecValidationError);
  });
});

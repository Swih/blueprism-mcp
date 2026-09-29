import { el, textEl, type BpChild } from "@bpdev/model";
import { generatedFile, processElement, subsheetElement } from "./document.js";
import { IdRegistry } from "./ids.js";
import { Page, type Stage } from "./page.js";
import type { ParsedQueueConsumerSpec } from "./queue-spec.js";
import {
  CASE_FIELD,
  queueCollectionBody,
  queueDecision,
  queueLinkDecision,
  WORK_QUEUES_OBJECT,
} from "./queue-stages.js";
import {
  actionBody,
  calculationBody,
  dataItemBody,
  endBody,
  stageElement,
  textExpression,
  type Param,
} from "./stages.js";

export const QUEUE_RESULT_PARAMS: readonly Param[] = [
  { name: "Outcome", dataType: "text" },
  { name: "Completed Count", dataType: "number" },
  { name: "Business Exception Count", dataType: "number" },
  { name: "System Exception Count", dataType: "number" },
  { name: "Processed Count", dataType: "number" },
  { name: "Stop Reason", dataType: "text" },
  { name: "Last Item ID", dataType: "text" },
  { name: "Last Case Key", dataType: "text" },
  { name: "Failure Detail", dataType: "text" },
];

/** Original bounded template. Work recovery and finalization occupy different scopes. */
export function buildQueueTemplate(spec: ParsedQueueConsumerSpec) {
  const ids = new IdRegistry();
  const pages: Page[] = [];
  const pageIds = new Map<string, string>();
  const pageId = (name: string) => {
    let id = pageIds.get(name);
    if (!id) {
      id = ids.id(spec.name, "page", name);
      pageIds.set(name, id);
    }
    return id;
  };
  const main = new Page(ids, spec.name, "Main Page", undefined);
  const makePage = (name: string, description: string) => {
    const page = new Page(ids, spec.name, name, pageId(name));
    page.info("SubSheetInfo", "Info", description, []);
    page.main("Start", "Start", []);
    pages.push(page);
    return page;
  };
  const at = (
    page: Page,
    type: string,
    name: string,
    x: number,
    y: number,
    body: readonly BpChild[] = [],
    w = 90,
    h = 40,
  ): Stage => {
    const id = ids.id(spec.name, page.name, type, name);
    const position = { x, y, w, h };
    const element = stageElement({ id, name, type, subsheetId: page.subsheetId, position }, body);
    page.stages.push(element);
    return { id, name, position, element };
  };
  const pageBody = (name: string) => [textEl("processid", pageId(name))];
  const call = (page: Page, name: string) => page.main("SubSheet", name, pageBody(name));
  const calc = (page: Page, name: string, expression: string, into: string) =>
    page.main("Calculation", name, calculationBody(expression, into));
  const finish = (page: Page) => page.main("End", "End", []);
  const exception = (type: "Business Exception" | "System Exception", detail: string) => [
    el("exception", { localized: "yes", type, detail, savescreencapture: "yes" }),
  ];
  const branchException = (
    page: Page,
    name: string,
    detail: string,
    type: "Business Exception" | "System Exception" = "System Exception",
  ) => page.branch("Exception", name, exception(type, detail));

  const session = makePage(
    "Reset Session Data",
    "Initialize session counters once. Global items are shared with the named template pages.",
  );
  finish(session);
  const globals: (Param & { value?: string })[] = [
    ...QUEUE_RESULT_PARAMS.map((p) => ({ ...p, value: p.dataType === "number" ? "0" : "" })),
    { name: "Queue Name", dataType: "text", value: spec.queueName },
    { name: "Stop After Items", dataType: "number", value: String(spec.maxItems) },
    {
      name: "System Exception Limit",
      dataType: "number",
      value: String(spec.consecutiveSystemExceptionLimit),
    },
    { name: "Consecutive System Exceptions", dataType: "number", value: "0" },
    { name: "No Eligible Item", dataType: "flag", value: "False" },
    { name: "Item ID", dataType: "text" },
    { name: "ItemCaseKey", dataType: "text" },
    { name: "Item Status", dataType: "text" },
    { name: "Attempts", dataType: "number", value: "0" },
    { name: "Confirmation", dataType: "text" },
    { name: "Exception Type", dataType: "text" },
    { name: "Item Failure Detail", dataType: "text" },
    { name: "New Item ID", dataType: "text" },
    { name: "Browser Started", dataType: "flag", value: "False" },
    { name: "Cleanup Attempted", dataType: "flag", value: "False" },
  ];
  globals.forEach((p, i) =>
    at(
      session,
      "Data",
      p.name,
      300 + Math.floor(i / 8) * 210,
      -165 + (i % 8) * 60,
      dataItemBody(p.dataType, p.value ?? "").filter((node) => node.name !== "private"),
      150,
      35,
    ),
  );
  at(
    session,
    "Collection",
    "Data",
    930,
    405,
    queueCollectionBody([CASE_FIELD]).filter((node) => node.name !== "private"),
    180,
    90,
  );

  const reset = makePage(
    "Reset Global Data",
    "Clear only per-item state after finalization and cleanup. Session counters and last failure remain available.",
  );
  for (const name of [
    "Item ID",
    "ItemCaseKey",
    "Item Status",
    "Confirmation",
    "Exception Type",
    "Item Failure Detail",
    "New Item ID",
  ])
    calc(reset, `Reset ${name}`, '""', name);
  for (const name of ["Browser Started", "Cleanup Attempted"])
    calc(reset, `Reset ${name}`, "False", name);
  calc(reset, "Reset Attempts", "0", "Attempts");
  finish(reset);

  const startup = makePage(
    "Start Up",
    "Validate configuration before acquiring an item. Queue loading is a separate, single-batch process.",
  );
  const validConfiguration = queueDecision(
    startup,
    "Configuration Valid?",
    '([Queue Name] <> "") AND ([Stop After Items] > 0) AND ([System Exception Limit] > 0)',
  );
  startup.continueFrom(validConfiguration.element, "ontrue");
  finish(startup);
  queueLinkDecision(
    validConfiguration,
    "onfalse",
    branchException(
      startup,
      "Invalid Configuration",
      textExpression("Queue name and positive stopping limits are required."),
    ),
  );

  const validate = makePage(
    "Validate Item",
    "Read CaseKey only after Get Next Item returned an Item ID. Reject missing business data before opening the application.",
  );
  calc(validate, "Read Case Key", "[Data.CaseKey]", "ItemCaseKey");
  const validKey = queueDecision(validate, "Case Key Present?", 'Trim([ItemCaseKey]) <> ""');
  validate.continueFrom(validKey.element, "ontrue");
  finish(validate);
  queueLinkDecision(
    validKey,
    "onfalse",
    branchException(
      validate,
      "Missing Case Key",
      textExpression("CaseKey is empty."),
      "Business Exception",
    ),
  );

  const launch = makePage(
    "Launch Application",
    "One application attempt for this item. No automatic replay of business work.",
  );
  if (spec.launch) {
    // Latch before launch: a partially opened browser also needs cleanup.
    calc(launch, "Record Launch Attempt", "True", "Browser Started");
    launch.main(
      "Action",
      "Launch Browser",
      actionBody(spec.launch.object, spec.launch.action, [], []),
    );
  }
  finish(launch);

  const work = makePage(
    "Work Step - Submit Request",
    "One business call. The object owns Attach, bounded waits and interaction. A timeout after submit is never retried here.",
  );
  work.main(
    "Action",
    "Execute Browser Work",
    actionBody(
      spec.call.object,
      spec.call.action,
      [{ name: spec.call.input, dataType: "text", expression: "[ItemCaseKey]" }],
      [{ name: spec.call.confirmationOutput, dataType: "text", into: "Confirmation" }],
    ),
  );
  finish(work);

  const verify = makePage(
    "Verify Result",
    "Completion requires an exact case-correlated result. An unexplained mismatch is a System Exception, not a business rejection.",
  );
  const confirmed = queueDecision(
    verify,
    "Confirmation Matches?",
    `[Confirmation] = (${textExpression(spec.call.expectedConfirmationPrefix)} & [ItemCaseKey])`,
  );
  verify.continueFrom(confirmed.element, "ontrue");
  finish(verify);
  const mismatch = branchException(
    verify,
    "Unconfirmed Business Result",
    textExpression(
      "Confirmation does not match this case; reconcile external effects before any replay.",
    ),
  );
  if (spec.call.businessRejectionPrefix) {
    const rejected = verify.branch("Decision", "Explicit Business Rejection?", [
      el("decision", {
        expression: `[Confirmation] = (${textExpression(spec.call.businessRejectionPrefix)} & [ItemCaseKey])`,
      }),
    ]);
    queueLinkDecision(confirmed, "onfalse", rejected);
    queueLinkDecision(rejected, "onfalse", mismatch);
    queueLinkDecision(
      rejected,
      "ontrue",
      branchException(
        verify,
        "Business Rejection",
        textExpression("The target explicitly rejected this case."),
        "Business Exception",
      ),
    );
  } else queueLinkDecision(confirmed, "onfalse", mismatch);

  const record = makePage(
    "Record Item Result",
    "Count an item only after a queue finalization action returned successfully. Keep the last identity after the queue becomes empty.",
  );
  calc(record, "Count Finalized Item", "[Processed Count] + 1", "Processed Count");
  calc(record, "Remember Item ID", "[Item ID]", "Last Item ID");
  calc(record, "Remember Case Key", "[ItemCaseKey]", "Last Case Key");
  finish(record);

  const completed = makePage(
    "Mark Item As Completed",
    "Called only after Verify Result. Queue finalization failures propagate to the fatal handler, never to a second queue write.",
  );
  completed.main(
    "Action",
    "Mark Completed",
    actionBody(
      WORK_QUEUES_OBJECT,
      "Mark Completed",
      [{ name: "Item ID", dataType: "text", expression: "[Item ID]" }],
      [],
    ),
  );
  calc(completed, "Count Completed", "[Completed Count] + 1", "Completed Count");
  calc(completed, "Reset Consecutive System Exceptions", "0", "Consecutive System Exceptions");
  call(completed, "Record Item Result");
  finish(completed);

  const failed = makePage(
    "Mark Item As Exception",
    "Classify only Business Exception or System Exception. Finalize without retry, then let Main move to the next item after cleanup.",
  );
  const business = queueDecision(
    failed,
    "Business Exception?",
    '[Exception Type] = "Business Exception"',
  );
  failed.continueFrom(business.element, "onfalse");
  calc(failed, "Normalize System Exception", '"System Exception"', "Exception Type");
  const reason = calc(
    failed,
    "Retain Primary Failure",
    '[Exception Type] & ": " & [Item Failure Detail]',
    "Failure Detail",
  );
  queueLinkDecision(business, "ontrue", reason);
  // Both classifications share the same queue write.
  failed.main(
    "Action",
    "Mark Exception - No Retry",
    actionBody(
      WORK_QUEUES_OBJECT,
      "Mark Exception",
      [
        { name: "Item ID", dataType: "text", expression: "[Item ID]" },
        { name: "Exception Reason", dataType: "text", expression: "[Failure Detail]" },
        { name: "Retry", dataType: "flag", expression: "False" },
        { name: "Keep Locked", dataType: "flag", expression: "False" },
      ],
      [{ name: "New Item ID", dataType: "text", into: "New Item ID" }],
    ),
  );
  const countBusiness = queueDecision(
    failed,
    "Count Business Exception?",
    '[Exception Type] = "Business Exception"',
  );
  failed.continueFrom(countBusiness.element, "onfalse");
  calc(failed, "Count System Exception", "[System Exception Count] + 1", "System Exception Count");
  calc(
    failed,
    "Count Consecutive System Exception",
    "[Consecutive System Exceptions] + 1",
    "Consecutive System Exceptions",
  );
  const recordFailure = call(failed, "Record Item Result");
  finish(failed);
  const countRejected = failed.branch(
    "Calculation",
    "Count Business Exception",
    calculationBody("[Business Exception Count] + 1", "Business Exception Count"),
    countBusiness.position.y,
  );
  const resetConsecutive = failed.branch(
    "Calculation",
    "Reset Consecutive System Exceptions",
    calculationBody("0", "Consecutive System Exceptions"),
  );
  queueLinkDecision(countBusiness, "ontrue", countRejected);
  Page.link(countRejected, resetConsecutive);
  Page.link(resetConsecutive, recordFailure);

  const close = makePage(
    "Close Down",
    "Close once if this template attempted a launch. Cleanup failure is fatal; do not consume another item with an unknown application state.",
  );
  if (spec.cleanup) {
    const needsClose = queueDecision(
      close,
      "Cleanup Needed?",
      "([Browser Started] = True) AND ([Cleanup Attempted] = False)",
    );
    close.continueFrom(needsClose.element, "ontrue");
    calc(close, "Latch Cleanup Attempt", "True", "Cleanup Attempted");
    close.main(
      "Action",
      "Close Browser",
      actionBody(spec.cleanup.object, spec.cleanup.action, [], []),
    );
    calc(close, "Browser Closed", "False", "Browser Started");
    const closeEnd = finish(close);
    queueLinkDecision(needsClose, "onfalse", closeEnd);
  } else finish(close);

  const stop = makePage(
    "Set Stop Reason",
    "An operator request, item bound or consecutive-system-error bound ends the loop between items.",
  );
  calc(stop, "Operator Stop Reason", '"Stop requested"', "Stop Reason");
  const limit = queueDecision(
    stop,
    "Item Limit Reached?",
    "[Processed Count] >= [Stop After Items]",
  );
  stop.continueFrom(limit.element, "ontrue");
  calc(stop, "Item Limit Reason", '"Item limit reached"', "Stop Reason");
  const stopEnd = finish(stop);
  const systemLimit = stop.branch("Decision", "System Error Limit Reached?", [
    el("decision", { expression: "[Consecutive System Exceptions] >= [System Exception Limit]" }),
  ]);
  queueLinkDecision(limit, "onfalse", systemLimit);
  queueLinkDecision(systemLimit, "onfalse", stopEnd);
  const systemReason = stop.branch(
    "Calculation",
    "System Error Limit Reason",
    calculationBody('"Consecutive system exception limit reached"', "Stop Reason"),
  );
  queueLinkDecision(systemLimit, "ontrue", systemReason);
  Page.link(systemReason, stopEnd);

  const result = makePage(
    "Build Session Result",
    "Report session totals. No eligible item does not imply that deferred, locked or filtered items are completed.",
  );
  calc(result, "Default Stopped Outcome", '"Stopped"', "Outcome");
  const exhausted = queueDecision(result, "No Eligible Item?", "[No Eligible Item]");
  result.continueFrom(exhausted.element, "ontrue");
  calc(result, "No Eligible Item Reason", '"No eligible item available"', "Stop Reason");
  calc(result, "No Items Outcome", '"NoAvailableItem"', "Outcome");
  const processed = queueDecision(result, "Any Items Processed?", "[Processed Count] > 0");
  result.continueFrom(processed.element, "ontrue");
  calc(result, "Successful Outcome", '"Completed"', "Outcome");
  const exceptions = queueDecision(
    result,
    "Any Item Exceptions?",
    "([Business Exception Count] + [System Exception Count]) > 0",
  );
  result.continueFrom(exceptions.element, "ontrue");
  calc(result, "Mixed Outcome", '"CompletedWithExceptions"', "Outcome");
  const resultEnd = finish(result);
  for (const decision of [exhausted, processed, exceptions])
    queueLinkDecision(decision, "onfalse", resultEnd);

  // Hand-positioned main page: protected work in the centre, recovery on the right,
  // finalization outside the Work block, and the loop returns via the left gutter.
  at(
    main,
    "ProcessInfo",
    "Info",
    -315,
    -240,
    [
      textEl(
        "narrative",
        "Native queue loop. Finalize each item once as completed, Business Exception or System Exception. Empty Item ID ends processing. No item replay; limits stop between items.",
      ),
    ],
    210,
    160,
  );
  const start = at(main, "Start", "Start", 15, -300, [], 60, 30);
  const resetSession = at(
    main,
    "SubSheet",
    "Reset Session Data",
    15,
    -240,
    pageBody("Reset Session Data"),
  );
  const startUp = at(main, "SubSheet", "Start Up", 15, -180, pageBody("Start Up"));
  const resetItem = at(
    main,
    "SubSheet",
    "Reset Global Data",
    15,
    -120,
    pageBody("Reset Global Data"),
  );
  const mayContinue = at(main, "Decision", "Continue Processing?", 15, -60, [
    el("decision", {
      expression:
        "([Processed Count] < [Stop After Items]) AND ([Consecutive System Exceptions] < [System Exception Limit]) AND (IsStopRequested() = False)",
    }),
  ]);
  const get = at(
    main,
    "Action",
    "Get Next Item",
    15,
    0,
    actionBody(
      WORK_QUEUES_OBJECT,
      "Get Next Item",
      [
        { name: "Queue Name", dataType: "text", expression: "[Queue Name]" },
        { name: "Key Filter", dataType: "text", expression: "" },
        { name: "Tag Filter", dataType: "text", expression: '"bpdev-v1"' },
        { name: "Sort Order", dataType: "text", expression: "" },
      ],
      [
        { name: "Item ID", dataType: "text", into: "Item ID" },
        { name: "Data", dataType: "collection", into: "Data" },
        { name: "Status", dataType: "text", into: "Item Status" },
        { name: "Attempts", dataType: "number", into: "Attempts" },
      ],
    ),
  );
  const gotItem = at(main, "Decision", "Item Available?", 15, 60, [
    el("decision", { expression: '[Item ID] <> ""' }),
  ]);
  const validateItem = at(main, "SubSheet", "Validate Item", 15, 120, pageBody("Validate Item"));
  const launchApplication = at(
    main,
    "SubSheet",
    "Launch Application",
    15,
    180,
    pageBody("Launch Application"),
  );
  const workItem = at(
    main,
    "SubSheet",
    "Work Step - Submit Request",
    15,
    240,
    pageBody("Work Step - Submit Request"),
  );
  const verifyResult = at(main, "SubSheet", "Verify Result", 15, 300, pageBody("Verify Result"));
  const markComplete = at(
    main,
    "SubSheet",
    "Mark Item As Completed",
    15,
    360,
    pageBody("Mark Item As Completed"),
  );
  const closeSuccess = at(main, "SubSheet", "Close Down", 15, 420, pageBody("Close Down"));
  const returnBottom = at(main, "Anchor", "Return After Finalization", -105, 480, [], 10, 10);
  const returnTop = at(main, "Anchor", "Next Item", -105, -120, [], 10, 10);
  const chain = (items: Stage[]) => {
    for (const [i, from] of items.entries()) {
      const to = items[i + 1];
      if (to) Page.link(from, to);
    }
  };
  chain([start, resetSession, startUp, resetItem, mayContinue]);
  queueLinkDecision(mayContinue, "ontrue", get);
  chain([get, gotItem]);
  queueLinkDecision(gotItem, "ontrue", validateItem);
  chain([
    validateItem,
    launchApplication,
    workItem,
    verifyResult,
    markComplete,
    closeSuccess,
    returnBottom,
    returnTop,
    resetItem,
  ]);

  // Block coordinates are top-left, unlike ordinary stage centres.
  at(
    main,
    "Block",
    "Work Exception",
    -45,
    90,
    [el("font", { family: "Segoe UI", size: "10", style: "Regular", color: "DCEBFA" })],
    300,
    240,
  );
  const recover = at(main, "Recover", "Recover Item Failure", 195, 120, [], 60, 30);
  const snapshotType = at(
    main,
    "Calculation",
    "Capture Exception Type",
    375,
    120,
    calculationBody("ExceptionType()", "Exception Type"),
  );
  const snapshotDetail = at(
    main,
    "Calculation",
    "Capture Exception Detail",
    375,
    180,
    calculationBody('ExceptionDetail() & " | stage: " & ExceptionStage()', "Item Failure Detail"),
  );
  const resume = at(main, "Resume", "Resume To Finalize Item", 375, 240, [], 60, 30);
  const markFailure = at(
    main,
    "SubSheet",
    "Mark Item As Exception",
    375,
    300,
    pageBody("Mark Item As Exception"),
  );
  const closeFailure = at(
    main,
    "SubSheet",
    "Close Down After Exception",
    375,
    360,
    pageBody("Close Down"),
  );
  const errorReturn = at(main, "Anchor", "Return After Exception", 375, 480, [], 10, 10);
  chain([
    recover,
    snapshotType,
    snapshotDetail,
    resume,
    markFailure,
    closeFailure,
    errorReturn,
    returnBottom,
  ]);

  const fatal = at(main, "Recover", "Recover Fatal Failure", 600, -300, [], 60, 30);
  const fatalDetail = at(
    main,
    "Calculation",
    "Preserve Fatal Failure",
    600,
    -240,
    calculationBody(
      '[Item Failure Detail] & " | terminal failure: " & ExceptionType() & ": " & ExceptionDetail()',
      "Failure Detail",
    ),
  );
  const fatalCleanup = at(
    main,
    "SubSheet",
    "Close Down After Fatal Failure",
    600,
    -180,
    pageBody("Close Down"),
  );
  const fatalRaise = at(
    main,
    "Exception",
    "Raise System Exception",
    600,
    -120,
    exception("System Exception", "[Failure Detail]"),
  );
  // No Resume: a failure during fatal handling propagates; this handler cannot catch itself.
  chain([fatal, fatalDetail, fatalCleanup, fatalRaise]);

  const empty = at(
    main,
    "Calculation",
    "No Eligible Item Returned",
    600,
    60,
    calculationBody("True", "No Eligible Item"),
  );
  const buildResult = at(
    main,
    "SubSheet",
    "Build Session Result",
    600,
    480,
    pageBody("Build Session Result"),
  );
  const end = at(main, "End", "End", 600, 540, endBody(QUEUE_RESULT_PARAMS), 60, 30);
  queueLinkDecision(gotItem, "onfalse", empty);
  chain([empty, buildResult, end]);
  const stopReason = at(main, "SubSheet", "Set Stop Reason", 375, -60, pageBody("Set Stop Reason"));
  const stopTop = at(main, "Anchor", "Stop Route", 750, -60, [], 10, 10);
  const stopBottom = at(main, "Anchor", "Stopped Result", 750, 480, [], 10, 10);
  queueLinkDecision(mayContinue, "onfalse", stopReason);
  chain([stopReason, stopTop, stopBottom, buildResult]);

  return generatedFile(
    spec.name,
    processElement(
      {
        name: spec.name,
        preferredId: ids.id(spec.name),
        narrative:
          "Original bounded queue template: Get Next Item until empty, finalize each item before continuing, Business/System Exception only, no automatic item retries. Session totals and stop reason are explicit. Finalization/cleanup failures terminate instead of consuming another item.",
      },
      [
        ...main.stages,
        ...pages.flatMap((page) => [
          subsheetElement(pageId(page.name), page.name, "Normal", false),
          ...page.stages,
        ]),
      ],
    ),
    "bpprocess",
  );
}

# Qualification status — 2026-09-29

**Experimental preview qualified within the limited scope below.** This records local
evidence, not production readiness. The recorded demonstration is a replay of selected native
log events, not a browser video. The [template quality gate](11-template-quality.md) links the primary SS&C sources and
defines the acceptance checks; the [architecture](04-architecture.md) defines the v1 scope.

## Passed proofs

- RPA Challenge: artifact `b2013adb-ef03-4634-8b57-e23df3ae79f5`, session
  `409e0bd2-24de-47e0-a2aa-21e8ebb66cda`; three rounds and seven final-value assertions passed.
- Service Desk: artifact `5afed723-4305-4117-a9bf-c3b977947451`; exact confirmation, browser
  cleanup and one independently recorded attempt. The screen object had zero Studio errors.
- Queue creation and loading: three-item and four-item seeds returned confirmed counts.
  Seed Count comes from native Collections / Count Rows over the returned Item IDs.
- Native probe: built and qualified for XML plus offline expressions, using native process
  context and only justValidate. The loop candidate, seed and two Service Desk objects
  passed 64 / 7 / 3 / 25 expression checks respectively. This is not full Studio/dependency
  or runtime validation.
- The original 14-page queue loop and its objects have **zero Studio errors**. Remaining
  advisories: two blank optional-input warnings and two notices for Business Exception
  not being declared in this environment. The [Studio capture](assets/queue-loop-studio-validation.png)
  shows zero errors with business-object validation included.
- Mixed queue scenario: suite `loop-202609291256` passed all five assertions, with
  independent receipts and native queue export confirming the expected 2/1/1 outcome.
- Empty queue and item-limit scenarios passed their five assertions each, with native
  exports confirming zero rows and two completed/two untouched items respectively.
- The consecutive-System-Exception limit passed all five assertions: three System
  Exceptions, the fourth item untouched, no remaining locks and no HTTP submissions for
  this suite's keys.

The first Service Desk selector based on label-for failed before submission. The observed
label/following-sibling selector succeeded. Scanner XPath checks still do not prove
compatibility with the BP extension.

## Closed prototype defects

The Add To Queue index error was caused by explicit Batch Size 0: the installed native
batch helper throws for zero. Correcting SLA to timespan alone did not resolve it.
The seed now uses the requested batch length, bounded to 1–20, and verifies the actual
returned count. Queue loading is no longer blocked.

The earlier one-item-per-run prototype passed its happy path but failed recovery.
ExceptionText() was unavailable; mixed-case And and unary Not expressions were invalid.
Two items were left to BP's automatic session cleanup. The syntax defects were corrected,
and the prototype was replaced by the native processing loop. These historical runs and
their queue effects have been reconciled; they are retained as failed evidence, not replayed
or presented as acceptance successes.

## First native loop: completed execution, failed acceptance

Suite: `loop-202609291245`. Consumer artifact: `bb256629-571b-44a8-b64b-c35872fb4ec4`.
BP session: `95e69e97-36ae-4f53-9f6c-d0216c6fa7f8`.

The four-item seed passed. The loop finalized all four items: **3 Completed, 1 Business
Exception, 0 System Exceptions**. Native queue evidence showed no remaining locks and no
automatic session cleanup. This differs from the required **2 Completed / 1 Business /
1 System** result, so the business verification failed despite the session being Completed.

The connection-drop fixture produced **two HTTP requests for the lost-acknowledgement key
after one BP click**. The second request obtained confirmation, so that item completed
instead of exercising the intended System Exception path. Independent receipts showed one
business record per accepted key and none for the rejected key; one stored record does not
establish one HTTP attempt. The fixture's deduplication must not be confused with a proven
absence of duplicate requests. This run was reconciled using independent evidence and is
not to be replayed.

The fault fixture now finishes an HTTP 200 response containing truncated JSON after the
business effect is recorded. Its purpose is to make the acknowledgement unreadable without
a connection drop masking the fault through a transport retry. The corrected scenario
passed the native qualification below.

## Qualified mixed loop

Suite `loop-202609291256` was blocked during native publication by the trial's
published-process limit. Eight obsolete project-owned processes were unpublished while
preserving their Studio definitions and history. Publication recovery through the operator
API was tested successfully, and the suite subsequently completed its native execution.

- Consumer artifact: `4937c868-ae5b-47df-a0da-a73fef1d7fce`.
- Runner run: `b688f59d-396b-4267-9cc4-7e85683e3808`.
- BP session: `ea12f50c-97e4-4dad-b5c2-8edb345be7ce`.

**All five assertions passed:** Outcome = CompletedWithExceptions, Completed Count = 2,
Business Exception Count = 1, System Exception Count = 1, Processed Count = 4.
The 413-entry log records Business Rejection at index 169 and System Exception 2 at index 259.

Independent receipts confirm **one HTTP attempt per key** and three business records:
first, lost acknowledgement and next item. The explicit business rejection creates none.
The lost-acknowledgement record exists exactly once, its item was not replayed, and the next
item completed. Native export `queue-export-1790680581057.csv` in the suite's local evidence
directory confirms:

| Case                                             | Native finalization | Attempt | Business records |
| ------------------------------------------------ | ------------------- | ------- | ---------------- |
| First item                                       | Completed           | 1       | 1                |
| Explicit business rejection                      | Business Exception  | 1       | 0                |
| Committed submission, unreadable acknowledgement | System Exception    | 1       | 1                |
| Next item                                        | Completed           | 1       | 1                |

All four Locked fields are empty; no item was left to automatic session cleanup.
The CSV's free-text Status remains Pending: finalization is evidenced by the Completed and
Exception columns, not by that independent status label.

The loop owns acquisition through Get Next Item, item finalization and subsequent-item
continuation. It defaults to 100 items (maximum 1,000), stops at three consecutive System
Exceptions by default or an operator stop request, and performs no item retries.
An empty Item ID means **no eligible item now**; it does not prove the entire queue is empty.

## Qualified guard cases

Counts below are Completed / Business Exception / System Exception. All three BP sessions
completed normally; `Stopped` is the process's Outcome output, not a stopped BP session.

| Scenario                | Outcome and counts                        | Independent evidence                                                                                                                                                                                                                  |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `empty-202609291318`    | NoAvailableItem, 0/0/0, Processed Count 0 | Five assertions passed, 35 log entries; `queue-export-1790680711697.csv` contains only the header, zero rows.                                                                                                                         |
| `limit-202609291320`    | Stopped, 2/0/0, Processed Count 2         | Five assertions passed; `queue-export-1790680798566.csv` contains two Completed and two untouched items, all unlocked. Receipts show one HTTP attempt for each of the first two keys and none for the others.                         |
| `syslimit-202609291322` | Stopped, 0/0/3, Processed Count 3         | Five assertions passed, 269 log entries; `queue-export-1790680955368.csv` confirms three System Exceptions and one untouched pending item, all unlocked. No HTTP submission attempts or business records exist for this suite's keys. |

Empty-queue artifact: `8420ab6a-4821-4e87-8d10-c0458929f4c1`; run:
`03602419-585e-4708-913e-b3dd15ee88ef`; BP session:
`6a9c3313-6e3e-43bb-ac6f-4c3848b8a4cf`.

Item-limit consumer artifact: `2d31483d-f44e-4695-96d4-6ceae95438d3`; run:
`bbe6dabb-1ebe-44fc-977f-2040c7891dad`; BP session:
`6b242f5a-e262-421b-8a2d-5556b655cba3`. All four rows show Attempt 1, including the
untouched rows: that field alone does not prove the item was processed. Their empty
Completed/Exception/Locked fields and absence of HTTP receipts establish that distinction.

System-limit consumer artifact: `89c738ea-4374-4636-8b73-c667a69442ab`; run:
`fefcd81a-2ccb-454b-927f-ea0d0765e1d4`; BP session:
`41ff0bcc-8b14-4ebb-873c-b22c6f389bc0`. The first logged System Exception is the field
wait failure at index 56; the native CSV confirms finalization of the first three items
and leaves the fourth untouched. All four rows show Attempt 1 and empty Locked fields.

The empty-queue test does not qualify every cause of
no eligible item, such as deferred, filtered or already locked work.

## Qualified cleanup failure

Suite `cleanup-202609291328`, artifact `bcc84fbe-0b57-4a65-bed4-f43eb21f6f9a`,
run `074f9f7c-a342-4ede-84b5-44b4c677df05`, BP session
`28540854-8cd1-40d9-966e-1ca76329fdbb` injects a System Exception during cleanup.
This synthetic object calculates a confirmation without opening a browser or calling HTTP.
The ordinary two-item success assertions were retained, not adjusted to pass the fault.

The session correctly **Failed**, with verification `not_run` and reconciliation required.
Its 79 log entries show one acquisition, one work call, one successful Mark Completed,
one cleanup invocation and a false cleanup guard during fatal recovery. The marker
`BPDEV-INJECT-CLEANUP-ONCE` remains in the original and terminal exceptions.
Native export `queue-export-1790681281460.csv` confirms one Completed and one untouched
item, both unlocked. The original request key returns the same session; another key is
blocked until operator reconciliation. Independent evidence was recorded without replay.

This qualifies cleanup failure after completion; it does not simulate failure of the native
queue finalization action itself. Use `tools/demo/run-cleanup-fault.js` with a fresh suite ID
and separate deploy/run phases to reproduce it.

## Fresh-agent trial: successful result after two assisted corrections

The agent used the public skill and MCP tools to prepare v1 on its first attempt. Its 33
expressions passed native validation, it deployed, and full Studio validation including
objects reported zero errors. Run `909ccd57-f013-4570-8747-71e2db587658` completed with
all three assertions and one independent business record/HTTP attempt. However, its success
path omitted Close. It is not a fully qualified autonomous result.

After the parent clarified that harness cleanup handles exceptions only, the agent built v2
with an explicit successful Close and standard exception types. Run
`e4b7ec6f-adee-4884-8dd4-af3d8f1ca684` failed at its initial readiness wait; exception cleanup
executed. Independent receipts confirmed zero submissions/records. The run was reconciled,
not replayed. The precise cause of the selector failure is not established by one run.

For v3, the parent replaced the label-for selectors with observed label/following-sibling
selectors already qualified on the same site, keeping the explicit Close and using a new
synthetic key. Artifact `cbcd1b43-2d87-457d-b189-db30b972488a`, run
`37215c93-f12e-480b-bb4d-b5f16b956bb5`, BP session
`100a5461-78ef-4a8b-95ad-e6aa797030c4` completed. Its 63 native log entries include explicit
successful Close; all three assertions pass, with one HTTP attempt and one matching record.

**Three preparations, two assisted corrections.** The final result works, but this is not
evidence of reliable first-pass autonomy on arbitrary websites. The skill now explicitly
requires successful-path closure; scanner/native selector compatibility remains a limitation.

## Verification and publication review

The complete suite passed **823 tests, with 14 optional tests skipped**. A separate scanner
run passed **35 tests including all 14 real-Chrome tests**. Typecheck, lint and build passed.
The public-file/history audit found no known local secret exposure. Flagged synthetic
credential-URL fixtures, generic robot paths and the two screenshots were reviewed.
Private releases, .env, local evidence, browser profiles and vendor binaries/catalogues remain
excluded. MIT attribution and Codex/Claude credits are included.

The [recorded native-log demonstration](assets/demo-replay.html) presents 20 selected events
from the qualified 413-entry mixed session. It does not simulate execution or claim to be video.

**Explicit backlog:** native operator-stop and finalization-failure injection, retrieving
native exception screenshots, and broader unassisted-agent evaluations. Structural/unit
guards are covered where implemented; these native capabilities have no qualification claim.

## Reproduce and inspect

The [README](../README.md#verification-and-demonstration) separates deploy and run phases
using BPDEMO_PHASE, BPDEMO_SCENARIO and a stable BPDEMO_QUEUE_ID. Scenarios are mixed, empty,
item-limit and system-limit. Use a fresh ID for each new scenario and keep the same ID and
scenario across deploy/run phases. Deploy prepares/imports/publishes for Studio inspection
without loading items; run executes the seed when needed and the native loop only after
that review. The empty scenario does not create or run a seed.

The operator helper tools/demo/export-queue.js performs a read-only native /exportqueue
and saves a CSV under the suite's ignored local evidence directory. It neither clears nor
modifies items. Compare it with the site's /records receipts; an uncertain run requires
operator reconciliation, not a new seed. Local evidence remains outside Git.

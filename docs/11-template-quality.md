# Queue template quality gate

The first prototype ran a happy path but failed its recovery path. It is not a production
qualification. On 29 September 2026 Studio found three invalid expressions, and two locked
items were left to BP's automatic session cleanup. Those are defects, not acceptable outcomes.

## Sources and design

The supplied local reference release contains Start Up, Launch Application, Validate Item,
Work Step pages, Mark Item As Completed/Exception, Reset Global Data and Close Down. Its main
page separates acquisition, a protected work block, finalization and stopping. Its XML,
business data, names and third-party object implementations stay outside this repository.

Our original implementation follows that organization. SS&C's
[process template guide](https://documentation.blueprism.com/capture-5-0/en-us/process-template/process-template.htm)
places work in dedicated pages, catches item failures at the main work block, and separates
completion, exception marking and closing applications. Its configurable retries require
application recovery to a known state. The process itself now owns the bounded Get Next Item
loop; a new MCP launch per item is not the template. Each item is finalized before acquiring
the next. Zero automatic business retries remain: continuing to a different item does not
resubmit the failed one. A lost acknowledgement needs reconciliation before replaying that item.

The [exception hierarchy](https://documentation.blueprism.com/bp-7-5/en-us/helpExceptions.htm)
explains propagation and Recover/Resume scope. That page currently names `ExceptionText()`;
our installed 7.5.1 library and Studio reject it and expose `ExceptionType()` instead.
Installed signatures and native validation take precedence over that documentation typo.

The [work-queue guide](https://documentation.blueprism.com/bp-7-5/en-us/helpQueues.htm) makes
the process holding the item lock responsible for its workflow state. `CaseKey` is a field
of the data collection; the returned Item ID is BP's internal identity used for finalization.
The free-text Status column is separate from the Completed/Exception workflow state.

An empty Item ID ends this run because no eligible item was returned. It does not prove
that every row is completed: deferred, filtered or locked items can remain, and a paused
queue also returns no item. See [queue management](https://documentation.blueprism.com/bp-7-5/en-us/control-queues.html).

## Acceptance before execution and publication

1. Native expression validation before import, including branches not exercised by a happy path.
2. Zero Studio errors with business-object validation included. Inspect the actual layout,
   recovery block boundaries and links; an XML load alone is insufficient.
3. Independent receipts and native queue export for success, technical exception after a
   committed submission, and subsequent-item continuation. Each key has one attempt.
4. Explicit business rejection without creating a business record, no eligible item, and cleanup failure.
   No hidden retry, lost primary error, or item left to automatic session cleanup in a
   successfully handled scenario. Infrastructure failures must remain explicit failures.
5. A fresh LLM builds from the public skill and MCP evidence; record interventions and failures.

For the experimental public v1, native operator-stop and queue-finalization-failure injection
remain explicit backlog items. Their structural/unit guards are tested; no native qualification
is claimed for those two failure modes. Cleanup failure is separately qualified in the
[evidence record](10-qualification-status.md).

No production-readiness claim follows from these local tests. Environment credentials,
operational monitoring, access controls, deployment review and business-specific recovery
still need qualification in each target installation.

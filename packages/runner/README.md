# Local runner contract

`Runner` owns artifact preparation, native parsing, import/publish, launch reservations,
observation and verification. Inject bridge/probe adapters through `RunnerOptions`; tests
use fakes and do not execute Blue Prism.

`prepareQueueConsumer(QueueBuildSpec)` builds a native `GetNextItem` loop in one process
session, stopping on an empty queue, a bound or a stop request. `maxItems` is an integer
from 1 to 1000 (default 100); `consecutiveSystemExceptionLimit` is from 1 to 100 (default 3).
Items use one attempt, `retryPolicy: "never"`, and only Business Exception or System
Exception classification. Optional `call.businessRejectionPrefix` identifies a rejection
correlated with the actual `CaseKey`; completion requires the exact confirmation prefix
plus that key. No item is automatically replayed.

Callers must supply `expectedOutcome` (`Completed`, `CompletedWithExceptions`,
`NoAvailableItem` or `Stopped`) and `expectedCounts: { completed, businessExceptions,
systemExceptions }`. Each count must be an integer from 0 to 1000, with sum at most 1000.
The runner asserts `Outcome`, all three counts and their `Processed Count` sum; a completed
session alone does not prove business success. Additional scalar outputs are `Stop Reason`,
`Last Item ID`, `Last Case Key` and `Failure Detail`. Queue creation uses key field `CaseKey`
and permits one seed batch of at most 20 items per created queue.

- `prepare(BuildSpec)` returns `Artifact`. Its `files` expose `{ name, kind, sha256 }`, never
  internal XML filenames or paths. `assertions` is the generator's JSON assertion manifest.
- `validate(artifactId)` checks every file with the native parser and verifies its reported
  identity. This is not a dependency or business validation.
- `deploy(artifactId)` / `deployment(artifactId)` return `DeploymentRecord`. Each import and
  publication intent is persisted before the command. `imported` contains acknowledged
  imports; `inFlight` may have taken effect. `deploy` never replays partial/deploying states.
- `resumePublication(artifactId, evidence): Promise<DeploymentRecord>` is an operator-only
  API, not an MCP tool. It accepts only a checksummed `partial` deployment with every
  artifact file imported in the recorded order and `inFlight` set to publication of that
  exact process. The operator supplies 20–2000 characters documenting independently
  checked conditions for publication recovery, such as a resolved publication-slot limit.
  Under the store mutation lock, it verifies artifact integrity and requires an idle runtime
  with no unresolved runs. It persists an audit attempt and evidence before making exactly
  one native `publish` call. It never imports, starts a session or retries automatically.
  Both `published` and the native idempotent `already-published` acknowledgement complete
  deployment. A failed or unconfirmed attempt retains `partial` and its publication intent.
  `publicationResumes` preserves numbered, timestamped evidence and outcomes (`pending`,
  `published`, `already-published`, `unconfirmed`), capped at ten explicit recovery attempts.
  Failure to persist intent prevents publication; failure to persist an acknowledgement
  remains unconfirmed.
  A subsequent explicit request closes a previous pending audit entry as `unconfirmed`
  before recording the next attempt; its completion timestamp closes the audit, not a
  fabricated native receipt. Pending entries inside earlier history are rejected.
  Interrupted imports, incomplete evidence and legacy partial records without a publication
  intent cannot use this API. Existing store/database binding and
  crash-lock safeguards still apply; no manual journal editing is part of this workflow.
- `start(artifactId, requestKey)` durably reserves the exact key before `/run`. Reusing it
  returns the same run, including a known rejection or an ambiguous launch. A missing or
  corrupt reserved record is an integrity failure, not a new request. No automatic recovery
  removes locks or reservations. Another key cannot bypass an unresolved run.
- `inspect(runId, cursor = 0, limit = 100)` separates `run.state`, `run.verification.status`
  and `observationHealth`. Require completed execution, passed verification, fresh
  observation and no reconciliation flag when reporting a current verified success.
  Previously confirmed evidence remains historical evidence during an observation outage.
- `requestStop(runId)` reports `{ requested: true, acknowledged, runId }`. Acknowledgement
  means that BP accepted the request, not that the robot stopped or rolled back effects.
  The next inspection must confirm the final state. Uncertain requests are not reissued.

`RunRecord.verifiedAt` dates the retained verification. `logEvidence` caches the first
confirmed `ERROR: <type> : <detail>` row and subsequent distinct exception texts from the
whole fetched log, before pagination. It carries session, observation time and log hash.
Its scope is **logged exceptions only**: it neither proves preservation of BP's native
exception nor classifies a later error as cleanup merely by its wording. Identical text is
grouped. At most 20 distinct exceptions and 8192 detail characters each are retained;
`truncated` reports this limit.

Cursors are per-run offsets over verified append-only log prefixes, not native BP cursors.
Shrinkage or replacement returns no rows, `nextCursor: 0`, unavailable health and a
reconciliation flag. Missing logs leave the cursor untouched. CLI retrieval still reads
the bounded full log; the returned page is at most 200 rows with explicit field truncation.

## Browser boundary

The trusted bootstrap chooses `browserPath` (default installed Chrome) and an absolute,
dedicated `robotProfileDirectory`. Models cannot choose another executable, user profile,
debug port or extension. Launch URLs are HTTP(S), without userinfo, whitespace or command
line quoting. Only the profile placeholder, `--no-first-run` and
`--no-default-browser-check` are accepted. The profile argument is always inserted and
quoted. Attach accepts only the limited application parameters checked in `policy.ts`.
Web action/read/wait identifiers are explicitly allowlisted; JavaScript, evaluation and
generic system key operations are not exposed by this runner.

## Storage and concurrency limits

The store uses checksummed JSON envelopes, file flushes, atomic record replacement, strict
IDs/filenames and rejects symlinks/junctions. Checksums detect accidental modification,
not an adversary with the same OS account who can recompute them. Keep a private, local
data directory bound to one BP connection/resource; switching databases beneath the same
store is unsupported. Filesystem and power-loss guarantees depend on the host filesystem.

Cooperating runner instances share one fail-fast lock, including inspections that update
evidence. `MUTATION_BUSY` may be retried after the existing operation ends; a crash leaves
the lock for explicit reconciliation. CLI/database/runtime side effects are not one
transaction with the journal. This is not an exactly-once guarantee. The idle check also
requires listener `status()` and refuses pending/unresolved sessions despite `busy=false`;
it cannot lock out a concurrent human or another BP scheduler after that check.

The initial handoff's checksummed artifact/deployment records can be read without rewriting
them, only with the exact generated internal filenames and complete deployment evidence.
Other corrupt or unknown formats fail closed. No automatic overwrite, migration, restart
or reconciliation of ambiguous native outcomes is implemented.

Public boundary failures use `RunnerError.code`; raw bridge/probe errors and XML paths are
not returned. Business log text remains sensitive and must be handled as such by the caller.

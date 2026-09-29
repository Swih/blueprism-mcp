# bpprobe

Small C# console tool that loads the DLLs of the local Blue Prism install **read-only** and
answers questions about them. It never writes to the Blue Prism database, never starts a
session and never modifies the install.

## Build

Compiled with the Roslyn compiler shipped inside Blue Prism (no .NET SDK needed):

```powershell
powershell -File tools/bpprobe/build.ps1 [-BluePrismDir "C:\Program Files\Blue Prism Limited\Blue Prism Automate"]
```

Output: `tools/bpprobe/bin/bpprobe.exe` (gitignored). The install directory used at run time
defaults to the path above; override it with the `BP_INSTALL_DIR` environment variable.

## Commands

- `bpprobe catalog <out.json>`: dumps the browser-mode Application Manager catalogue from
  `AMI.dll` (element types, actions, reads, writes, wait conditions with their arguments,
  and the `w*` web identifiers).
- `bpprobe apptypes <out.json>`: dumps the application types (Launch / Attach variants) and
  the parameters each one declares.
- `bpprobe validate <file>`: loads a process or object XML with Blue Prism's own parser
  (`BluePrismProcess.FromXmlThrowsErrors`), then validates expressions in their native
  process/page context with `Expression.EvaluateExpression(..., justValidate: true)`.
- `bpprobe find <dll> <regex>`: lists public methods whose type or member name matches.
- `bpprobe il <dll> <type-regex> [method-regex]`: crude IL listing (string literals and
  called methods) of the matching methods.

The catalogue and app-type dumps contain SS&C text: keep them out of git (generate them
locally, e.g. under `.bpdev/`).

## Offline expression validation

`validate` checks the expression locations emitted by our generator: calculations,
decisions, action/subsheet inputs, exception details, browser write expressions, browser
action/condition arguments, dynamic element parameters, wait expectations and timeouts.
Declarations supply types and page/global visibility; current runtime values are not
required or initialized. Native functions are checked for availability and syntax without
running stages or sessions. Decisions must return a flag; timeouts must return a number.
Wait expectations can return text or another comparison type.
The installed application function `IsStopRequested()` is registered alongside core
functions using its native signature (zero arguments, flag), with no server provider.
Its runtime implementation is never invoked. Global data remain visible across pages;
the validator does not add `private` or otherwise alter their declared scope.

This is **not full Studio, dependency or runtime validation**. The external object catalogue
is empty: object/action existence, argument/output contracts, browser selectors and extension
connectivity, queue configuration, credentials, flow/recovery correctness, business effects
and retries still require separate qualification. Application-model values and initial data
are literals, not expressions; output destination names are bindings, not expressions.
Empty optional inputs/arguments and rethrow details are counted but not evaluated. Code
stages/nonempty code, unrecognized stage types, unresolved collection schemas and native
validation exceptions are explicitly unsupported and fail closed; no runtime evaluation is
used as a fallback.

Success emits `OK: name-sha256=<64 lowercase hex digits> type=Process|Object stages=N`,
followed by `Offline expressions: checked=N optional-empty=M unsupported=0.` and the scope
limitation. The digest is SHA-256 over the UTF-8 **native loaded process Name**, without
trimming or normalization; type also comes from the native loaded process. Consumers must
check identity against the expected name's digest and require the expression summary;
a legacy parse-only success header does not establish expression validation. No plaintext
name is emitted. Rejection starts with
`INVALID:` and exits 1; NativeProbe already treats this as invalid before import. Up to 20
diagnostics identify **zero-based XML stage indices and expression-slot indices**, using
fixed codes. Names, expression text, values and raw native errors (including stderr) are
withheld to avoid leaking credentials. Slot order follows the XML document order of the
supported expression locations listed above. No source XML is rewritten.

Limits: 4 MiB XML, 5,000 stages, 10,000 nonempty/required expressions, 16,384 characters per
expression. DTDs and external XML resolution are disabled. NativeProbe's existing process
timeout bounds the complete native check (30 seconds by default); the CLI itself does not
add an in-process execution timer.

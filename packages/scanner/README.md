# @bpdev/scanner

Local DOM exploration and XPath **prevalidation**, for LLM-assisted Blue Prism development.
This package does not execute workflows, click, fill fields, submit forms or manage queues.
BP must independently validate the resulting selectors and frame mapping.

```ts
import { BrowserScanner } from "@bpdev/scanner";

const scanner = await BrowserScanner.open("https://example.com/form");
try {
  const observation = await scanner.observe();
  for (const element of observation.elements) {
    const candidate = element.candidates[0];
    if (candidate) {
      const result = await scanner.verify(candidate.selector, element.frameId);
      // accepted requires exactly one supported element, visible in its frame chain.
      // It proves a current DOM observation, not long-term stability or BP compatibility.
    }
  }
} finally {
  await scanner.close();
}
```

## Installation and browser

Dependency: exactly `playwright@1.63.0`, installed centrally through the workspace.
Chrome must already be installed. Launch uses `channel: "chrome"`, headless by default,
and a new isolated browser context. No browser installation command, persistent profile,
CDP attachment or reuse of personal authentication is provided.

## Contract

- `BrowserScanner.open(url, options?)`: HTTP(S) only; embedded URL credentials rejected.
- `observe()`: bounded inputs, textareas, selects, buttons, links, outputs and semantic
  status/live-region targets from light DOM, including empty targets. Semantic targets
  have an `aria-live` attribute or a `status`, `alert`, `log`, `marquee`, `timer` or
  `progressbar` role token, on any HTML tag (including `span`, `div` and custom tags).
  Metadata includes labels, type, name, id, limited descriptive text and frame context.
- `verify(xpath, frameId?)`: exact XPath match count, uniqueness, current visibility and
  a reason. Without a frame ID, uses the main frame from the latest observation.
  No observation, unknown frame, detached/navigated frame, ambiguity or unsupported node
  fails closed. It never falls back to the main frame for an unknown child.
- `close()`: idempotent; closes the browser owned by this scanner.

Frame IDs are opaque and expire on the next observation. Proof binds to a live Playwright
Frame and its navigation revision, not a sanitized URL or a positional iframe index.
Cross-origin frames can be observed independently; iframe ancestors must also be visible.
Visibility means a nonempty bounding rectangle and visible computed visibility, not
absence of occlusion, enabled state, viewport intersection or actionability.

Candidates use adjacent sibling labels, label/for relationships, wrapping labels, name,
id, and button/link text. `label-sibling` is preferred only when observation records
`relation: "preceding-adjacent-sibling"`: the label and control share a parent and
`label.nextElementSibling === control`. A `label-for` alternative is retained when present.
The following-sibling XPath can match further controls or duplicate labels; verification
must still reject ambiguity, without an implicit first-match predicate.
All carry `stability: "unproven"` and `bpCompatibility: "unproven"`. Browser verification
does not certify execution in BP. Truncated strings are not used to create exact selectors.
No implicit first-match selector is generated. Shadow DOM is outside this version.

New public evidence fields (optional in TypeScript for older observation producers):
`Observation.title` and `FrameContext.title` are `string | null`, with corresponding
`titleTruncated?: boolean` fields. The scanner always emits them: an empty string means
an observed untitled document; null means unavailable. Titles come from `document.title`
in the same observation as the elements, use `maxTextLength`, and count toward `maxBytes`.
The top-level title belongs to the main document, not a guessed Chrome/BP window caption.
Byte trimming can further shorten title prefixes and sets `titleTruncated` and
`truncated.bytes`; titles are never used to construct element selectors.

`ElementMetadata` (and thus `ObservedElement`) adds `role?: string` and `ariaLive?: string`,
emitted as literal bounded attributes or empty strings when absent. No implicit role is
invented for `<output>`. `tag` now accepts any observed HTML tag; the `FormTag` export is
unchanged. `truncatedAttributes` also accepts `tag`, `role` and `ariaLive`.
`SelectorCandidate.basis` adds `role`, `aria-live` and `tag`: exact observed role/live
attributes and the observed `//output` tag are candidates, even without text or ID.
Truncated attributes/tags never generate exact selectors. Empty or duplicate targets
still require `verify()`; an empty element with no visible box is rejected as not visible.
Existing control fields, label candidates and verification rules remain available.

Observations are marked `trust: "untrusted-page-data"`: page text may contain prompt
injections and must never become agent instructions. Fixed shipped extractors are the
only browser-side functions. There is no caller-provided JavaScript API.

No input value/defaultValue, selected option, href, cookie, storage, network response,
HTML snapshot, console or screenshot is returned. Controls inside descriptive text are
excluded, including textarea contents and editable regions. Semantic targets use the same
text filtering; `body`/`html` targets expose no document-wide text. No value property is
read, including on output elements. Frame URLs omit credentials, query and fragment.
This is data minimization, not a general secret detector: page-authored labels, IDs,
names, titles, role/live attributes, text and URL paths can themselves contain sensitive material. Navigate only to
authorized sites; loading a page still executes its scripts and requests its resources.

Defaults (hard maxima): 100 elements (500), 10 frames (32), 160 characters per text
field (500), 64 KiB serialized UTF-8 response (256 KiB), 10,000 DOM elements visited per
frame (50,000), 10 s per observation/verification (30 s). XPath input: at most 2,048
characters. Truncation is explicit. Timeout closes the owned browser. Concurrent operations
are rejected with `BUSY`. Errors have stable codes and omit raw browser messages.

## Tests

Pure contract tests run with the workspace Vitest suite. Local HTTP/Chrome integration
tests are opt-in and include value exclusion, duplicate selectors, hidden targets,
dynamic IDs, cross-origin frames, stale references and output budgets:

```powershell
$env:BPDEV_SCANNER_CHROME_TEST = '1'
npm test --workspace @bpdev/scanner
```

No external site or browser download is needed. The tests bind ephemeral loopback ports.
Build/typecheck use the same strict base configuration as neighboring packages, adding
DOM types only for the shipped browser extractors. Root lockfile and project references
are managed by the parent integration task.

# @bpdev/model

Lossless document model for Blue Prism XML files (`.bpprocess`, `.bpobject`, `.bprelease`):
parse, build, serialize, plus a few thin read-only views. It knows XML, not Blue Prism rules;
those belong to the generator.

## API

- `parseBpXml(xml)` → `BpDocument` (`{ root: BpElement }`). Keeps element order, attribute
  order and values, text verbatim (CR included: no normalisation, like Blue Prism's .NET
  reader), `<x />` vs `<x></x>`, prefixes and `xmlns` attributes. Drops only indentation
  between elements; CDATA becomes text. Throws `BpXmlParseError` (with `line`, `column`) on
  malformed XML and on DOCTYPE, comments and processing instructions.
- `serializeBpXml(doc)` → deterministic UTF-8 text: XML declaration, 2-space indentation,
  LF, .NET-style escaping. Blue Prism's own exports come out byte for byte (except BOM and
  CRLF). Throws `BpXmlSerializeError` on invalid names or characters.
- `canonicalize(docOrElement)` → one-node-per-line dump for comparing trees in tests.
- Builder: `el(name, attrs?, children?)`, `textEl(name, value, attrs?)`, `text(value)`,
  `doc(root)`. `undefined` attributes and empty strings are left out.
- Helpers: `getAttr`, `setAttr`, `childElements`, `firstChild`, `childText`, `textContent`,
  `localName`.
- Views (throw `BpViewError` on unexpected shapes; each item keeps its `element`):
  - `readProcessHeader(root)`: name, type (`process` / `object`), bpversion, runmode,
    preferredid.
  - `listPages(root)`: subsheets (id, name, type).
  - `listStages(root)`: id, name, type, pageId, onSuccess / onTrue / onFalse.
  - `listAppElements(root)`: application model elements with parentId and attributes
    (name, inUse, datatype, value).
  - `listReleaseContents(root)`: processes and objects of a release, each with its inner
    `<process>` element.

All errors extend `BpModelError`.

## Example

```ts
import { readFileSync } from "node:fs";
import { el, listStages, parseBpXml, serializeBpXml, textEl } from "@bpdev/model";

const doc = parseBpXml(readFileSync("MCP Test - Echo.bpprocess", "utf8"));
const names = listStages(doc.root).map((s) => `${s.type}: ${s.name}`);
doc.root.children.push(
  el("stage", { stageid: "…", name: "Note", type: "Note" }, [textEl("narrative", "Hi")]),
);
const xml = serializeBpXml(doc); // deterministic, Blue Prism-style
```

## Fixtures (`test/fixtures/`)

Only files we produced, never third-party releases:

- `MCP Test - Echo.bpprocess`: hand-written test process (copied from `test-fixtures/`).
- `SPIKE - *.bp*`: output of `python spikes/s2s3_rpachallenge.py`.
- `bp-export/*.xml`: the same items exported by Blue Prism 7.5.1 (`AutomateC /export`).
- `MCP Test - Release.bprelease`: hand-assembled release wrapping the Echo export and the
  Ping object, following the structure of Blue Prism releases (not a Blue Prism export).

Fixtures are kept byte for byte (`.gitattributes`: `-text`).

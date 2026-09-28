# @bpdev/catalog

Loads and validates the Application Manager catalogue extracted from an installed Blue Prism.
The public API includes `loadCatalog`, `createCatalog`, catalogue types and typed errors.

From the repository root on a Blue Prism machine:

```powershell
npm run catalog:extract -w @bpdev/catalog
```

The extractor writes to `.bpdev/catalog/`. That local directory is ignored by Git; the test
fixtures are a small handwritten subset, not a copy of the extracted catalogue.

```ts
import { loadCatalog } from "@bpdev/catalog";

const catalog = loadCatalog(".bpdev/catalog");
const attachRoot = catalog.elementType("Application", "BrowserAttach");
```

BrowserLaunch and BrowserAttach have different root operations. An old catalogue without
the BrowserAttach root must be re-extracted before generating an attach object.

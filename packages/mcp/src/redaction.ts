const MASK = "[REDACTED]";
const GUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const guidFields = new Set([
  "artifactId",
  "runId",
  "bpSessionId",
  "queueId",
  "frameId",
  "mainFrameId",
  "parentId",
  "stageId",
]);
const enums: Record<string, ReadonlySet<string>> = {
  state: new Set([
    "starting",
    "running",
    "completed",
    "failed",
    "stopped",
    "unknown",
    "requesting",
    "acknowledged",
    "not_deployed",
    "deploying",
    "partial",
    "deployed",
    "creating",
    "created",
  ]),
  status: new Set(["passed", "failed", "not_run"]),
  bpStatus: new Set([
    "Pending",
    "Running",
    "Failed",
    "Stopped",
    "Completed",
    "Debugging",
    "Archived",
    "StopRequested",
    "Stalled",
    "PendingDeletion",
  ]),
  observationHealth: new Set(["fresh", "unavailable"]),
  kind: new Set(["object", "process"]),
  type: new Set([
    "text",
    "number",
    "flag",
    "date",
    "datetime",
    "password",
    "collection",
    "time",
    "timespan",
  ]),
  retryPolicy: new Set(["never"]),
  expectedOutcome: new Set(["Completed", "CompletedWithExceptions", "NoAvailableItem", "Stopped"]),
};

function decodeXml(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|amp|quot|apos|lt|gt);/g,
    (entity, code: string) => {
      if (!code.startsWith("#")) return named[code] ?? entity;
      const point = code.startsWith("#x")
        ? Number.parseInt(code.slice(2), 16)
        : Number(code.slice(1));
      return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    },
  );
}

/** Compile once per server; masks free text without ever rescanning inserted markers. */
export function publicRedactor(secrets: readonly string[]) {
  const unique = [...new Set(secrets.filter(Boolean))];
  const variants = new Set<string>();
  let withhold = unique.length > 256 || unique.reduce((n, value) => n + value.length, 0) > 16384;
  if (!withhold)
    for (const secret of unique) {
      try {
        const uri = encodeURIComponent(secret);
        for (const value of [
          secret,
          decodeXml(secret),
          uri,
          uri.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase()),
          JSON.stringify(secret).slice(1, -1),
        ])
          variants.add(value);
      } catch {
        withhold = true;
      }
    }
  const pattern = [...variants]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const matcher = pattern ? new RegExp(pattern, "g") : undefined;
  const text = (value: string): string =>
    withhold ? MASK : matcher ? decodeXml(value).replace(matcher, () => MASK) : value;
  const value = (input: unknown, key = "", depth = 0): unknown => {
    if (depth > 64) return MASK;
    if (typeof input === "string") {
      if ((guidFields.has(key) && GUID.test(input)) || enums[key]?.has(input)) return input;
      if (["sha256", "logSha256"].includes(key) && /^[a-f0-9]{64}$/i.test(input)) return input;
      if (
        [
          "createdAt",
          "updatedAt",
          "observedAt",
          "verifiedAt",
          "requestedAt",
          "acknowledgedAt",
        ].includes(key) &&
        /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(input)
      )
        return input;
      return text(input);
    }
    if (Array.isArray(input)) return input.map((entry) => value(entry, key, depth + 1));
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([name, entry]) => [
          name,
          key === "frames" && name === "id" && typeof entry === "string" && GUID.test(entry)
            ? entry
            : value(entry, name, depth + 1),
        ]),
      );
    return input;
  };
  return { text, value };
}

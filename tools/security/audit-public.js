// Local pre-publication check. Prints locations/categories only, never matched values.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { argv } from "node:process";
import process from "node:process";
import { log } from "node:console";

const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const secrets = new Set();
// Additional paths are local operator input, never committed content or MCP parameters.
for (const path of [".env", ...argv.slice(2)]) {
  try {
    const values = parseEnv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(values))
      if (/password|secret|token|api.?key/i.test(key) && value.length >= 4) secrets.add(value);
  } catch (error) {
    if (error.code !== "ENOENT") {
      log("Cannot read a local secret source; audit incomplete");
      process.exit(2);
    }
  }
}
const known = [...secrets].flatMap((value) => [
  value,
  encodeURIComponent(value),
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;"),
]);
const findings = [];
const patterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["cloud-key", /\bAKIA[0-9A-Z]{16}\b/],
  ["REVIEW_CREDENTIAL_URL", /https?:\/\/[^\s/:]+:[^\s/@]+@/],
];
const scan = (body, location, reviewPaths = false) => {
  if (known.some((secret) => body.includes(secret)))
    findings.push({ location, category: "KNOWN_LOCAL_SECRET" });
  for (const [category, pattern] of patterns)
    if (pattern.test(body)) findings.push({ location, category });
  if (
    reviewPaths &&
    /[A-Za-z]:[\\/]Users[\\/](?!example|your-user|USER|me\b|test\b)[^\\/\s<]+/i.test(body)
  )
    findings.push({ location, category: "REVIEW_PERSONAL_PATH" });
};
const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z")
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  if (/\.(?:png|jpe?g|gif|mp4|webm|pdf|zip)$/i.test(file)) {
    findings.push({ location: file, category: "REVIEW_BINARY" });
    continue;
  }
  try {
    scan(readFileSync(file, "utf8"), file, true);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
let blobs = 0;
for (const row of git("rev-list", "--objects", "--all").split("\n").filter(Boolean)) {
  const [oid] = row.split(" ");
  if (git("cat-file", "-t", oid).trim() !== "blob") continue;
  blobs++;
  scan(git("cat-file", "blob", oid), `history:${oid.slice(0, 12)}`);
}
log(
  JSON.stringify(
    { files: files.length, historyBlobs: blobs, loadedSecretCount: secrets.size, findings },
    null,
    2,
  ),
);
process.exitCode = findings.some((finding) => !finding.category.startsWith("REVIEW_")) ? 1 : 0;

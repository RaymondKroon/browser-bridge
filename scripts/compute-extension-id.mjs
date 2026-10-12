#!/usr/bin/env node
// Computes the Chrome extension ID for an unpacked extension from the
// "key" field in its manifest.json. Chrome derives the ID as the first 16
// bytes of SHA-256(DER public key), with each nibble mapped to 'a'-'p'.
//
// Usage: node scripts/compute-extension-id.mjs [path/to/manifest.json]
// Prints the 32-character extension ID to stdout.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const manifestPath =
  process.argv[2] ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "extension", "manifest.json");

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  console.error(`Could not read manifest ${manifestPath}: ${error.message}`);
  process.exit(1);
}

if (typeof manifest.key !== "string" || manifest.key.length === 0) {
  console.error(
    `No "key" field in ${manifestPath}. Without a stable key the extension ID ` +
      "depends on the directory path, so it cannot be computed here. Add a development key to the manifest."
  );
  process.exit(1);
}

let der;
try {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(manifest.key)) {
    throw new Error("not valid base64");
  }
  der = Buffer.from(manifest.key, "base64");
  if (der.length === 0) {
    throw new Error("empty key");
  }
} catch {
  console.error(`"key" in ${manifestPath} is not valid base64.`);
  process.exit(1);
}

const digest = createHash("sha256").update(der).digest();
const id = [...digest.subarray(0, 16)]
  .map((byte) => String.fromCharCode(97 + (byte >> 4)) + String.fromCharCode(97 + (byte & 0xf)))
  .join("");

console.log(id);

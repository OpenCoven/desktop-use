import { readFile, writeFile } from "node:fs/promises";
import { CANONICAL_ACTIONS } from "../src/computer-use-actions.js";

// The registry is the only editable action enumeration. Rust embeds these assets.
const root = new URL("../contracts/v1/", import.meta.url);
const schema = JSON.parse(await readFile(new URL("capabilities.schema.source.json", root), "utf8"));
schema.properties.actions.required = [...CANONICAL_ACTIONS];
schema.properties.actions.properties = Object.fromEntries(CANONICAL_ACTIONS.map(action => [action, { $ref: "#/$defs/action" }]));
const assets = {
  "canonical-actions.json": [...CANONICAL_ACTIONS],
  "canonical-actions.schema.json": { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "https://opencoven.org/contracts/v1/canonical-actions.schema.json", type: "string", enum: [...CANONICAL_ACTIONS] },
  "capabilities.schema.json": schema,
};
for (const [name, content] of Object.entries(assets)) {
  const serialized = JSON.stringify(content, null, 2) + "\n";
  const url = new URL(name, root);
  if (process.argv.includes("--check")) {
    if (await readFile(url, "utf8").catch(() => "") !== serialized) throw new Error(`Stale generated contract: ${name}; run pnpm run generate:contracts`);
  } else {
    await writeFile(url, serialized);
  }
}

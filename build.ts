/**
 * Builds dist/ with JSX compiled by the same Solid transform OpenCode uses at
 * runtime. This is required for installs from GitHub/npm: OpenCode only
 * transforms JSX outside node_modules, so published packages must ship plain JS.
 */

import { rm } from "node:fs/promises";

// Not exported through the package `exports` map, so resolve the file directly.
const solidPluginUrl = new URL(
  "./node_modules/@opentui/solid/scripts/solid-plugin.js",
  import.meta.url,
).href;
const { createSolidTransformPlugin } = (await import(solidPluginUrl)) as {
  createSolidTransformPlugin: () => Bun.BunPlugin;
};

await rm("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts", "src/tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  sourcemap: "none",
  external: [
    "@opencode/plugin",
    "@opencode/plugin/tui",
    "@opencode/plugin/tui/context",
    "@opentui/core",
    "@opentui/solid",
    "@opentui/solid/jsx-runtime",
    "@opentui/solid/jsx-dev-runtime",
    "solid-js",
    "solid-js/store",
  ],
  plugins: [createSolidTransformPlugin()],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

console.log("built", result.outputs.map((output) => output.path.replace(process.cwd(), ".")).join(", "));

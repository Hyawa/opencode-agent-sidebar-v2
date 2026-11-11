/**
 * Server part. The sidebar is TUI-only, so this is intentionally a no-op:
 * it exists so the package can be loaded from the `plugins` array in
 * opencode.json like any other plugin.
 */

import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "agent-sidebar",
  setup() {},
});

// @bun
// src/tui.tsx
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { spread as _$spread } from "@opentui/solid";
import { mergeProps as _$mergeProps } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { MouseButton, TextAttributes } from "@opentui/core";
import { createMemo, createSignal, For, Show } from "solid-js";

// src/state.ts
var TICK_INTERVAL_MS = 1000;
var COMPLETION_RETENTION_MS = 3000;
var BG_STATUS_PATTERN = /\[BACKGROUND TASK (COMPLETED|ERROR|TIMEOUT|CANCELLED|RETRYING)\]/;
var BG_ID_IN_TEXT_PATTERN = /\*\*ID:\*\*\s*`?(bg_[A-Za-z0-9]+)`?/;
var BG_ID_IN_OUTPUT_PATTERN = /Background Task ID:\s*(bg_[A-Za-z0-9]+)/;
var BG_ID_IN_METADATA_BLOCK_PATTERN = /background_task_id:\s*(bg_[A-Za-z0-9]+)/;
var DELEGATION_STARTED_PATTERN = /Delegation started:\s*([^\s]+)/;
var TASK_SUMMARY_LINE_PATTERN = /-\s+`(bg_[A-Za-z0-9]+)`:\s*([^\n]+)/g;
function readString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function isAgentToolPart(type, tool) {
  return type === "tool" && (tool === "task" || tool === "delegate");
}
function isBackgroundInvocation(tool, input, metadata) {
  return tool === "delegate" || input.background === true || input.run_in_background === true || metadata.background === true;
}
function resolveChildReference(input, metadata, output) {
  const sessionID = readString(metadata.sessionId) ?? readString(metadata.jobId) ?? readString(input.task_id);
  if (sessionID)
    return { id: sessionID, kind: "session" };
  const legacyID = readString(metadata.backgroundTaskId) ?? BG_ID_IN_METADATA_BLOCK_PATTERN.exec(output)?.[1] ?? BG_ID_IN_OUTPUT_PATTERN.exec(output)?.[1] ?? BG_ID_IN_TEXT_PATTERN.exec(output)?.[1] ?? DELEGATION_STARTED_PATTERN.exec(output)?.[1];
  return legacyID ? { id: legacyID, kind: "legacy" } : undefined;
}
function parseLegacyBackgroundUpdates(body) {
  const updates = [];
  const statusMatch = BG_STATUS_PATTERN.exec(body);
  const singleID = BG_ID_IN_TEXT_PATTERN.exec(body)?.[1];
  if (statusMatch && singleID) {
    const statusText = statusMatch[1];
    const status = statusText === "COMPLETED" ? "completed" : statusText === "RETRYING" ? "running" : "error";
    updates.push([singleID, { status }]);
  }
  if (body.includes("[ALL BACKGROUND TASKS COMPLETE") || body.includes("[ALL BACKGROUND TASKS FINISHED")) {
    for (const match of body.matchAll(TASK_SUMMARY_LINE_PATTERN)) {
      const id = match[1];
      if (id)
        updates.push([id, { status: "completed", description: match[2] ?? "" }]);
    }
  }
  return updates;
}
function resolveToolStatus(toolStatus, childStatus, followChildAfterCompletion) {
  if (toolStatus === "streaming" || toolStatus === "pending")
    return "queued";
  if (toolStatus === "running")
    return childStatus === "retry" ? "retrying" : "running";
  if (toolStatus === "error")
    return "error";
  if (toolStatus !== "completed")
    return;
  if (followChildAfterCompletion && childStatus === "busy")
    return "running";
  if (followChildAfterCompletion && childStatus === "retry")
    return "retrying";
  return "completed";
}
function resolveLegacyBackgroundStatus(status, update, wasObservedLive) {
  if (status !== "completed")
    return status;
  if (update?.status === "completed" || update?.status === "error")
    return update.status;
  return wasObservedLive ? "running" : "completed";
}
function classifyChildCompletion(messages) {
  const assistant = [...messages].reverse().find((message) => message.type === "assistant" || message.role === "assistant");
  return {
    status: assistant?.error === undefined ? "completed" : "error",
    completedAt: assistant?.time?.completed
  };
}
function isLive(status) {
  return status === "queued" || status === "running" || status === "retrying";
}
function isVisible(entry, tick) {
  return isLive(entry.status) || entry.completedAt !== undefined && tick - entry.completedAt <= COMPLETION_RETENTION_MS;
}
function compareEntries(a, b) {
  if (a.kind === "main" && b.kind !== "main")
    return -1;
  if (a.kind !== "main" && b.kind === "main")
    return 1;
  if (isLive(a.status) && !isLive(b.status))
    return -1;
  if (!isLive(a.status) && isLive(b.status))
    return 1;
  return b.startedAt - a.startedAt;
}
function deduplicateCandidates(candidates) {
  const entries = [];
  const newestByChild = new Map;
  for (const entry of candidates) {
    if (!entry.childSessionID) {
      entries.push(entry);
      continue;
    }
    const previous = newestByChild.get(entry.childSessionID);
    if (!previous || entry.startedAt >= previous.startedAt) {
      newestByChild.set(entry.childSessionID, entry);
    }
  }
  entries.push(...newestByChild.values());
  return entries;
}
function createLifecycleTracker() {
  const liveKeys = new Map;
  const completionTimes = new Map;
  const firstSeenTimes = new Map;
  const wasRecentlyLive = (key, tick) => {
    const lastObserved = liveKeys.get(key);
    return lastObserved !== undefined && tick - lastObserved <= TICK_INTERVAL_MS * 2;
  };
  return {
    observe(entries, tick) {
      for (const entry of entries) {
        if (isLive(entry.status))
          liveKeys.set(entry.key, tick);
      }
    },
    wasObservedLive(key) {
      return liveKeys.has(key);
    },
    startTime(key, status, supplied, tick) {
      if (supplied !== undefined || status !== "queued") {
        firstSeenTimes.delete(key);
        return supplied ?? tick;
      }
      const startedAt = firstSeenTimes.get(key) ?? tick;
      firstSeenTimes.set(key, startedAt);
      return startedAt;
    },
    retain(entry, tick) {
      if (isLive(entry.status)) {
        entry.completedAt = undefined;
        liveKeys.set(entry.key, tick);
        completionTimes.delete(entry.key);
        return true;
      }
      let completedAt = completionTimes.get(entry.key) ?? entry.completedAt;
      if (wasRecentlyLive(entry.key, tick)) {
        completedAt = tick;
        completionTimes.set(entry.key, tick);
      }
      liveKeys.delete(entry.key);
      if (completedAt === undefined || tick - completedAt > COMPLETION_RETENTION_MS) {
        completionTimes.delete(entry.key);
        return false;
      }
      entry.completedAt = completedAt;
      return true;
    },
    cleanup(sessionID, seen) {
      const prefix = `${sessionID}:`;
      for (const key of liveKeys.keys()) {
        if (key.startsWith(prefix) && !seen.has(key))
          liveKeys.delete(key);
      }
      for (const key of completionTimes.keys()) {
        if (key.startsWith(prefix) && !seen.has(key))
          completionTimes.delete(key);
      }
      for (const key of firstSeenTimes.keys()) {
        if (key.startsWith(prefix) && !seen.has(key))
          firstSeenTimes.delete(key);
      }
    },
    clear() {
      liveKeys.clear();
      completionTimes.clear();
      firstSeenTimes.clear();
    }
  };
}

// src/tui.tsx
var PLUGIN_ID = "agent-sidebar";
var DESCRIPTION_MAX_LEN = 26;
var STORAGE_KEY = "panel";
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}
function toolOutput(state) {
  if (!state)
    return "";
  if (state.status !== "completed" && state.status !== "error")
    return "";
  return (state.content ?? []).map((entry) => entry?.type === "text" ? entry.text ?? "" : "").join(`
`);
}
function childStatusOf(context, sessionID) {
  try {
    if (context.data.session.status(sessionID) !== "running")
      return "idle";
    const messages = context.data.session.message.list(sessionID);
    const lastAssistant = [...messages].reverse().find((message) => message.type === "assistant");
    return lastAssistant?.retry ? "retry" : "busy";
  } catch {
    return "idle";
  }
}
function collectEntries(context, sessionID, tick, lifecycle) {
  const entries = [];
  const candidates = [];
  const legacyUpdates = new Map;
  const seen = new Set;
  const messages = context.data.session.message.list(sessionID);
  const sessionStatus = context.data.session.status(sessionID);
  const lastAssistant = [...messages].reverse().find((message) => message.type === "assistant");
  if (lastAssistant?.id && lastAssistant.agent && lastAssistant.time?.completed === undefined && sessionStatus === "running") {
    entries.push({
      key: `${sessionID}:main:${lastAssistant.id}`,
      sessionID,
      kind: "main",
      agent: lastAssistant.agent,
      description: "main",
      status: lastAssistant.retry ? "retrying" : "running",
      startedAt: lastAssistant.time?.created ?? tick
    });
  }
  for (const message of messages) {
    if (message.type !== "assistant")
      continue;
    for (const part of message.content ?? []) {
      if (part.type === "text" && part.text) {
        for (const [id, update] of parseLegacyBackgroundUpdates(part.text)) {
          legacyUpdates.set(id, update);
        }
      }
      if (!isAgentToolPart(part.type, part.name) || !part.id || !part.name)
        continue;
      const state = part.state;
      if (!state?.status)
        continue;
      const input = asRecord(state.input);
      const metadata = asRecord(state.metadata);
      const output = toolOutput(state);
      const background = isBackgroundInvocation(part.name, input, metadata);
      const childReference = resolveChildReference(input, metadata, output);
      const childStatus = childReference?.kind === "session" ? childStatusOf(context, childReference.id) : undefined;
      const followsChildSession = childReference?.kind === "session";
      const status = resolveToolStatus(state.status, childStatus, background && followsChildSession);
      if (!status)
        continue;
      const key = `${sessionID}:tool:${part.id}`;
      candidates.push({
        key,
        sessionID,
        kind: background ? "background" : "foreground",
        agent: readString(input.subagent_type) ?? readString(input.agent) ?? readString(metadata.agent) ?? "agent",
        description: readString(input.description) ?? readString(metadata.description) ?? "",
        status,
        startedAt: lifecycle.startTime(key, status, part.time?.ran ?? part.time?.created, tick),
        completedAt: isLive(status) ? undefined : part.time?.completed ?? tick,
        childSessionID: childReference?.id,
        parentStatus: state.status,
        childReference,
        followsChildSession
      });
    }
  }
  for (const entry of deduplicateCandidates(candidates)) {
    const legacyUpdate = entry.childReference ? legacyUpdates.get(entry.childReference.id) : undefined;
    if (legacyUpdate?.description)
      entry.description = legacyUpdate.description;
    if (entry.kind === "background" && entry.parentStatus === "completed") {
      if (entry.followsChildSession && entry.status === "completed" && entry.childSessionID) {
        const child = classifyChildCompletion(context.data.session.message.list(entry.childSessionID));
        entry.status = child.status;
        entry.completedAt = child.completedAt ?? entry.completedAt;
      }
      if (entry.childReference?.kind === "legacy" && !entry.followsChildSession) {
        entry.status = resolveLegacyBackgroundStatus(entry.status, legacyUpdate, lifecycle.wasObservedLive(entry.key));
        if (isLive(entry.status))
          entry.completedAt = undefined;
      }
    }
    seen.add(entry.key);
    if (lifecycle.retain(entry, tick))
      entries.push(entry);
  }
  lifecycle.cleanup(sessionID, seen);
  entries.sort(compareEntries);
  return entries;
}
function buildLines(entries, tick) {
  const lines = [];
  const main = entries.filter((entry) => entry.kind === "main");
  const foreground = entries.filter((entry) => entry.kind === "foreground");
  const background = entries.filter((entry) => entry.kind === "background");
  const appendGroup = (label, group, showLabel) => {
    if (group.length === 0)
      return;
    if (showLabel)
      lines.push({
        text: `  ${label}`,
        fg: "gray"
      });
    for (const entry of group) {
      lines.push({
        text: renderAgentLine(entry, tick),
        fg: pickLineColor(entry)
      });
      const description = renderDescriptionLine(entry);
      if (description)
        lines.push({
          text: description,
          fg: "gray"
        });
    }
  };
  appendGroup("main", main, false);
  appendGroup("foreground", foreground, main.length > 0 || background.length > 0);
  appendGroup("background", background, main.length > 0 || foreground.length > 0);
  return lines;
}
function buildCountSuffix(total, live, done) {
  if (total === 0)
    return "(0)";
  if (live > 0 && done > 0)
    return `(${live} active, ${done} done)`;
  if (done > 0)
    return `(${done} done)`;
  return `(${live})`;
}
function renderAgentLine(entry, tick) {
  const elapsedMs = (entry.completedAt ?? tick) - entry.startedAt;
  return `  \u2022 ${entry.agent} ${formatStatus(entry.status)} ${formatDuration(elapsedMs)}`;
}
function renderDescriptionLine(entry) {
  if (entry.description.length === 0)
    return;
  if (entry.kind === "main" && entry.agent === entry.description)
    return;
  return `    ${truncate(entry.description, DESCRIPTION_MAX_LEN)}`;
}
function formatStatus(status) {
  if (status === "queued")
    return "Queued";
  if (status === "running")
    return "Running";
  if (status === "retrying")
    return "Retrying";
  if (status === "completed")
    return "Done";
  return "Error";
}
function pickLineColor(entry) {
  if (entry.status === "queued")
    return "gray";
  if (entry.status === "running" || entry.status === "retrying")
    return "white";
  if (entry.status === "completed")
    return "gray";
  return "red";
}
function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60)
    return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}
function truncate(value, maxLen) {
  if (value.length <= maxLen)
    return value;
  return `${value.slice(0, maxLen - 1)}\u2026`;
}
function AgentsPanel(props) {
  const visible = createMemo(() => {
    const tick = props.now();
    const entries = collectEntries(props.context, props.sessionID, tick, props.lifecycle);
    props.lifecycle.observe(entries, tick);
    return entries.filter((entry) => isVisible(entry, tick));
  });
  const header = createMemo(() => {
    const entries = visible();
    const live = entries.filter((entry) => isLive(entry.status)).length;
    const chevron = props.collapsed() ? "\u25B6" : "\u25BC";
    return `${chevron} Agents ${buildCountSuffix(entries.length, live, entries.length - live)}`;
  });
  const lines = createMemo(() => buildLines(visible(), props.now()));
  const mouseProps = {
    selectable: false,
    onMouseDown: (event) => {
      if (event?.button !== MouseButton.LEFT)
        return;
      event.stopPropagation?.();
      props.onToggle();
    }
  };
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "column");
    _$setProp(_el$, "paddingTop", 1);
    _$setProp(_el$, "paddingBottom", 1);
    _$setProp(_el$2, "fg", "white");
    _$spread(_el$2, _$mergeProps({
      get attributes() {
        return TextAttributes.BOLD;
      }
    }, mouseProps), true);
    _$insert(_el$2, header);
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return !props.collapsed();
      },
      get children() {
        return _$createComponent(Show, {
          get when() {
            return visible().length > 0;
          },
          get fallback() {
            return (() => {
              var _el$3 = _$createElement("text");
              _$insertNode(_el$3, _$createTextNode(` idle`));
              _$setProp(_el$3, "fg", "gray");
              return _el$3;
            })();
          },
          get children() {
            return _$createComponent(For, {
              get each() {
                return lines();
              },
              children: (line) => (() => {
                var _el$5 = _$createElement("text");
                _$insert(_el$5, () => line.text);
                _$effect((_$p) => _$setProp(_el$5, "fg", line.fg, _$p));
                return _el$5;
              })()
            });
          }
        });
      }
    }), null);
    return _el$;
  })();
}
var tui_default = Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const [now, setNow] = createSignal(Date.now());
    const [panel, updatePanel] = context.storage.store(STORAGE_KEY, {
      initial: {
        collapsed: false
      }
    });
    const lifecycle = createLifecycleTracker();
    const toggle = () => {
      updatePanel((draft) => {
        draft.collapsed = !draft.collapsed;
      });
    };
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [{
        id: `${PLUGIN_ID}.toggle`,
        title: panel.collapsed ? "Expand Agents panel" : "Collapse Agents panel",
        description: "Toggle the sub-agent section in the sidebar",
        group: "Agent sidebar",
        palette: true,
        slash: {
          name: "agents-toggle"
        },
        run: () => toggle()
      }],
      bindings: [`${PLUGIN_ID}.toggle`]
    }));
    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({
        sessionID
      }) => _$createComponent(AgentsPanel, {
        context,
        sessionID,
        now,
        lifecycle,
        collapsed: () => panel.collapsed,
        onToggle: toggle
      })
    });
    return () => {
      clearInterval(timer);
      unregisterSlot();
      lifecycle.clear();
    };
  }
});
export {
  tui_default as default
};

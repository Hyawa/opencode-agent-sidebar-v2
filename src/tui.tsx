/**
 * OpenCode V2 TUI plugin: live sub-agent activity in the sidebar.
 *
 * Derived from @psh4607/opencode-agent-sidebar v0.2.5 (MIT, © Seongho Bak):
 * https://github.com/psh4607/opencode-agent-sidebar
 * Ported to the OpenCode V2 plugin API (@opencode/plugin/tui).
 */

import type { Context } from "@opencode/plugin/tui/context";
import { Plugin } from "@opencode/plugin/tui";
import { MouseButton, TextAttributes } from "@opentui/core";
import { createMemo, createSignal, For, Show } from "solid-js";
import {
  TICK_INTERVAL_MS,
  classifyChildCompletion,
  compareEntries,
  createLifecycleTracker,
  deduplicateCandidates,
  isAgentToolPart,
  isBackgroundInvocation,
  isLive,
  isVisible,
  parseLegacyBackgroundUpdates,
  readString,
  resolveChildReference,
  resolveLegacyBackgroundStatus,
  resolveToolStatus,
  type AgentEntry,
  type AgentStatus,
  type ChildReference,
  type ChildStatus,
  type LegacyBackgroundUpdate,
  type LifecycleTracker,
} from "./state";

const PLUGIN_ID = "agent-sidebar";
const DESCRIPTION_MAX_LEN = 26;
const STORAGE_KEY = "panel";

type ToolStateLike = {
  status?: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  content?: ReadonlyArray<{ type?: string; text?: string }>;
  error?: unknown;
};

type PartLike = {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  state?: ToolStateLike;
  time?: { created?: number; ran?: number; completed?: number };
};

type MessageLike = {
  id?: string;
  type?: string;
  agent?: string;
  time?: { created?: number; completed?: number };
  retry?: unknown;
  error?: unknown;
  content?: ReadonlyArray<PartLike>;
};

type ToolCandidate = AgentEntry & {
  parentStatus: string;
  childSessionID?: string;
  childReference?: ChildReference;
  followsChildSession: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function toolOutput(state: ToolStateLike | undefined): string {
  if (!state) return "";
  if (state.status !== "completed" && state.status !== "error") return "";
  return (state.content ?? [])
    .map((entry) => (entry?.type === "text" ? entry.text ?? "" : ""))
    .join("\n");
}

function childStatusOf(context: Context, sessionID: string): ChildStatus {
  try {
    if (context.data.session.status(sessionID) !== "running") return "idle";
    const messages = context.data.session.message.list(sessionID) as ReadonlyArray<MessageLike>;
    const lastAssistant = [...messages].reverse().find((message) => message.type === "assistant");
    return lastAssistant?.retry ? "retry" : "busy";
  } catch {
    return "idle";
  }
}

function collectEntries(
  context: Context,
  sessionID: string,
  tick: number,
  lifecycle: LifecycleTracker,
): AgentEntry[] {
  const entries: AgentEntry[] = [];
  const candidates: ToolCandidate[] = [];
  const legacyUpdates = new Map<string, LegacyBackgroundUpdate>();
  const seen = new Set<string>();

  const messages = context.data.session.message.list(sessionID) as ReadonlyArray<MessageLike>;
  const sessionStatus = context.data.session.status(sessionID);
  const lastAssistant = [...messages].reverse().find((message) => message.type === "assistant");

  if (
    lastAssistant?.id &&
    lastAssistant.agent &&
    lastAssistant.time?.completed === undefined &&
    sessionStatus === "running"
  ) {
    entries.push({
      key: `${sessionID}:main:${lastAssistant.id}`,
      sessionID,
      kind: "main",
      agent: lastAssistant.agent,
      description: "main",
      status: lastAssistant.retry ? "retrying" : "running",
      startedAt: lastAssistant.time?.created ?? tick,
    });
  }

  for (const message of messages) {
    if (message.type !== "assistant") continue;
    for (const part of message.content ?? []) {
      if (part.type === "text" && part.text) {
        for (const [id, update] of parseLegacyBackgroundUpdates(part.text)) {
          legacyUpdates.set(id, update);
        }
      }

      if (!isAgentToolPart(part.type, part.name) || !part.id || !part.name) continue;
      const state = part.state;
      if (!state?.status) continue;

      const input = asRecord(state.input);
      const metadata = asRecord(state.metadata);
      const output = toolOutput(state);
      const background = isBackgroundInvocation(part.name, input, metadata);
      const childReference = resolveChildReference(input, metadata, output);
      const childStatus =
        childReference?.kind === "session"
          ? childStatusOf(context, childReference.id)
          : undefined;
      const followsChildSession = childReference?.kind === "session";
      const status = resolveToolStatus(state.status, childStatus, background && followsChildSession);
      if (!status) continue;

      const key = `${sessionID}:tool:${part.id}`;
      candidates.push({
        key,
        sessionID,
        kind: background ? "background" : "foreground",
        agent:
          readString(input.subagent_type) ??
          readString(input.agent) ??
          readString(metadata.agent) ??
          "agent",
        description:
          readString(input.description) ??
          readString(metadata.description) ??
          "",
        status,
        startedAt: lifecycle.startTime(
          key,
          status,
          part.time?.ran ?? part.time?.created,
          tick,
        ),
        completedAt: isLive(status) ? undefined : part.time?.completed ?? tick,
        childSessionID: childReference?.id,
        parentStatus: state.status,
        childReference,
        followsChildSession,
      });
    }
  }

  for (const entry of deduplicateCandidates(candidates)) {
    const legacyUpdate = entry.childReference
      ? legacyUpdates.get(entry.childReference.id)
      : undefined;
    if (legacyUpdate?.description) entry.description = legacyUpdate.description;

    if (entry.kind === "background" && entry.parentStatus === "completed") {
      if (entry.followsChildSession && entry.status === "completed" && entry.childSessionID) {
        const child = classifyChildCompletion(
          context.data.session.message.list(entry.childSessionID) as ReadonlyArray<MessageLike>,
        );
        entry.status = child.status;
        entry.completedAt = child.completedAt ?? entry.completedAt;
      }

      if (entry.childReference?.kind === "legacy" && !entry.followsChildSession) {
        entry.status = resolveLegacyBackgroundStatus(
          entry.status,
          legacyUpdate,
          lifecycle.wasObservedLive(entry.key),
        );
        if (isLive(entry.status)) entry.completedAt = undefined;
      }
    }

    seen.add(entry.key);
    if (lifecycle.retain(entry, tick)) entries.push(entry);
  }

  lifecycle.cleanup(sessionID, seen);
  entries.sort(compareEntries);
  return entries;
}

type Line = { text: string; fg?: string };

function buildLines(entries: AgentEntry[], tick: number): Line[] {
  const lines: Line[] = [];
  const main = entries.filter((entry) => entry.kind === "main");
  const foreground = entries.filter((entry) => entry.kind === "foreground");
  const background = entries.filter((entry) => entry.kind === "background");

  const appendGroup = (label: string, group: AgentEntry[], showLabel: boolean): void => {
    if (group.length === 0) return;
    if (showLabel) lines.push({ text: `  ${label}`, fg: "gray" });
    for (const entry of group) {
      lines.push({ text: renderAgentLine(entry, tick), fg: pickLineColor(entry) });
      const description = renderDescriptionLine(entry);
      if (description) lines.push({ text: description, fg: "gray" });
    }
  };

  appendGroup("main", main, false);
  appendGroup("foreground", foreground, main.length > 0 || background.length > 0);
  appendGroup("background", background, main.length > 0 || foreground.length > 0);

  return lines;
}

function buildCountSuffix(total: number, live: number, done: number): string {
  if (total === 0) return "(0)";
  if (live > 0 && done > 0) return `(${live} active, ${done} done)`;
  if (done > 0) return `(${done} done)`;
  return `(${live})`;
}

function renderAgentLine(entry: AgentEntry, tick: number): string {
  const elapsedMs = (entry.completedAt ?? tick) - entry.startedAt;
  return `  • ${entry.agent} ${formatStatus(entry.status)} ${formatDuration(elapsedMs)}`;
}

function renderDescriptionLine(entry: AgentEntry): string | undefined {
  if (entry.description.length === 0) return undefined;
  if (entry.kind === "main" && entry.agent === entry.description) return undefined;
  return `    ${truncate(entry.description, DESCRIPTION_MAX_LEN)}`;
}

function formatStatus(status: AgentStatus): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "retrying") return "Retrying";
  if (status === "completed") return "Done";
  return "Error";
}

function pickLineColor(entry: AgentEntry): string {
  if (entry.status === "queued") return "gray";
  if (entry.status === "running" || entry.status === "retrying") return "white";
  if (entry.status === "completed") return "gray";
  return "red";
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function truncate(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 1)}…`;
}

function AgentsPanel(props: {
  context: Context;
  sessionID: string;
  now: () => number;
  lifecycle: LifecycleTracker;
  collapsed: () => boolean;
  onToggle: () => void;
}) {
  const visible = createMemo(() => {
    const tick = props.now();
    const entries = collectEntries(props.context, props.sessionID, tick, props.lifecycle);
    props.lifecycle.observe(entries, tick);
    return entries.filter((entry) => isVisible(entry, tick));
  });

  const header = createMemo(() => {
    const entries = visible();
    const live = entries.filter((entry) => isLive(entry.status)).length;
    const chevron = props.collapsed() ? "▶" : "▼";
    return `${chevron} Agents ${buildCountSuffix(entries.length, live, entries.length - live)}`;
  });

  const lines = createMemo(() => buildLines(visible(), props.now()));

  const mouseProps = {
    selectable: false,
    onMouseDown: (event: { button?: number; stopPropagation?: () => void }) => {
      if (event?.button !== MouseButton.LEFT) return;
      event.stopPropagation?.();
      props.onToggle();
    },
  } as Record<string, unknown>;

  return (
    <box flexDirection="column" paddingTop={1} paddingBottom={1}>
      <text fg="white" attributes={TextAttributes.BOLD} {...(mouseProps as any)}>
        {header()}
      </text>
      <Show when={!props.collapsed()}>
        <Show
          when={visible().length > 0}
          fallback={
            <text fg="gray">  idle</text>
          }
        >
          <For each={lines()}>{(line) => <text fg={line.fg}>{line.text}</text>}</For>
        </Show>
      </Show>
    </box>
  );
}

export default Plugin.define({
  id: PLUGIN_ID,
  setup(context) {
    const [now, setNow] = createSignal(Date.now());
    const [panel, updatePanel] = context.storage.store(STORAGE_KEY, {
      initial: { collapsed: false },
    });
    const lifecycle = createLifecycleTracker();

    const toggle = (): void => {
      void updatePanel((draft) => {
        draft.collapsed = !draft.collapsed;
      });
    };

    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: `${PLUGIN_ID}.toggle`,
          title: panel.collapsed ? "Expand Agents panel" : "Collapse Agents panel",
          description: "Toggle the sub-agent section in the sidebar",
          group: "Agent sidebar",
          palette: true,
          slash: { name: "agents-toggle" },
          run: () => toggle(),
        },
      ],
      bindings: [`${PLUGIN_ID}.toggle`],
    }));

    const timer = setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);

    const unregisterSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <AgentsPanel
          context={context}
          sessionID={sessionID}
          now={now}
          lifecycle={lifecycle}
          collapsed={() => panel.collapsed}
          onToggle={toggle}
        />
      ),
    });

    return () => {
      clearInterval(timer);
      unregisterSlot();
      lifecycle.clear();
    };
  },
});

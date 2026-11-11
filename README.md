# opencode-agent-sidebar (V2)

Real-time sub-agent activity in the OpenCode **v2** sidebar — what every delegated
`task` / `delegate` is doing right now, with a live elapsed timer that actually ticks.

> **This is a V2 port.** The original [psh4607/opencode-agent-sidebar](https://github.com/psh4607/opencode-agent-sidebar)
> targets the OpenCode V1 TUI plugin API (`sidebar_content`, `api.slots.register`) and does not load on
> OpenCode 2.x. This repository keeps the same idea and lifecycle logic, ported to the V2 API
> (`ui.slot`, `keymap.layer`, `storage`, `data.session`).
>
> MIT licensed. Original work © 2026 Seongho Bak. See [License & credits](#license--credits).

## Preview

```
▼ Agents (2 active)
  • Sisyphus Running 1m 12s
    main
  • explore Running 34s
    find the auth middleware
  • explore Done 8s
    map the router table
```

Live entries show `Queued` / `Running` / `Retrying`; finished ones linger ~3s with
`Done` / `Error` before disappearing.

## Requirements

- **OpenCode 2.x** (built and tested against `2.2.7`).
- **Bun** (OpenCode runs on Bun; no separate runtime needed).

## Install

**Option A — local checkout (works today)**

```sh
git clone https://github.com/Hyawa/opencode-agent-sidebar-v2.git
```

Add the **directory** (not a file) to the `plugins` array in
`~/.config/opencode/opencode.json(c)`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/path/to/opencode-agent-sidebar-v2"]
}
```

Relative paths work too and resolve from the config file that contains the entry.
Then restart the TUI.

**Option B — GitHub spec**

```sh
opencode plugin add github:Hyawa/opencode-agent-sidebar-v2
# or, in opencode.json:
#   "plugins": ["github:Hyawa/opencode-agent-sidebar-v2"]
```

⚠️ **On OpenCode 2.2.x this currently fails before reaching the plugin**, with
`NpmInstallFailedError: git dep preparation failed` / `Unrecognized flag: --no-dry-run`.
That is an upstream package-manager bug in `opencode plugin add` for git
dependencies, not a problem in this repository (`bun add github:Hyawa/...` works).
Use Option A until it is fixed, or install by cloning and pinning the path.

The package ships a compiled `dist/`, so no build step is needed either way.
Only the `./tui` part renders the panel; the `./` part is a no-op server plugin so the
package can live in `plugins`. If you prefer a TUI-only setup, you can also add the
same entry to `plugins` in `~/.config/opencode/cli.json`.

## Usage

| Action | How |
| --- | --- |
| Show / hide the panel | `/agents-toggle` slash command, or click the `▼ / ▶` header |
| Collapse state | Persisted across restarts (`storage.store`) |

The panel appears in the session sidebar and only shows agents from the focused session.

## What it shows

- **Main** — the assistant's own turn, only while its session is busy.
- **Foreground** — synchronous `task(...)` sub-agent calls.
- **Background** — `task(background=true)` / `delegate(...)` jobs, following the child
  session through busy/idle states even after the parent tool call completes.
- **Live elapsed timer** — one signal ticks every second, so the seconds move without
  waiting for the next event.
- **Auto-cleanup** — completed rows fade after ~3s; nothing accumulates.

## How it works

The panel derives everything from the message content returned by
`context.data.session.message.list(sessionID)` plus `context.data.session.status(...)`.
Rows only originate from real `task` / `delegate` tool parts, so agent mentions and
subtask metadata cannot become false running work.

Legacy formats (`run_in_background`, `backgroundTaskId`, `bg_*` reminder blocks,
`Delegation started:`) are still parsed for compatibility, but their reminders only
update rows that came from a real tool part.

Internally it is a Solid component registered through `context.ui.slot({ append:
"sidebar.content" })`. State lives in `storage.store`, and the toggle is a
`keymap.layer` command.

## Differences from the original V1 plugin

- New plugin API: `Plugin.define` from `@opencode/plugin/tui`.
- Slot `sidebar.content` instead of `sidebar_content`.
- `storage.store` instead of the KV store.
- `keymap.layer` (palette + slash) instead of `command.register`.
- Inline `message.content` instead of separate part lookups.
- V2 statuses (`streaming` / `running` / `completed` / `error`, `idle` / `running`).
- The upstream "new release available" notifier was dropped, since this fork is not
  published to npm and its version is independent.

## Development

```sh
bun install
bun run build      # compiles src/ to dist/ with the Solid JSX transform
bun run typecheck
```

OpenCode only runs its Solid/JSX transform outside `node_modules`, so published
installs use the compiled `dist/`. Rebuild after editing `src/`, then restart the TUI:
there is no hot reload.

```text
src/
  index.ts   # no-op server part (package registration only)
  state.ts   # pure lifecycle + compatibility helpers
  tui.tsx    # the sidebar panel
build.ts     # Bun + Solid transform build to dist/
dist/        # committed build output (what GitHub installs run)
```

## License & credits

MIT. Original work © 2026 **Seongho Bak**
([psh4607/opencode-agent-sidebar](https://github.com/psh4607/opencode-agent-sidebar)).
V2 port and modifications © 2026 **Hyawa**. The original `LICENSE` is preserved and
extended with the port's copyright; `src/state.ts` and `src/tui.tsx` carry a header
pointing at the upstream source.

If you use this, consider starring the original project too.

---

## Português

Plugin para OpenCode **v2** que mostra, na sidebar, o que cada sub-agente
(`task` / `delegate`) está fazendo em tempo real, com cronômetro ao vivo.

Instalação (funciona hoje): clone o repositório e adicione o **diretório** ao array
`plugins` do `~/.config/opencode/opencode.json` (veja a opção A acima). Reinicie o TUI.
Use `/agents-toggle` para mostrar/ocultar.

> O `opencode plugin add github:...` está quebrado no OpenCode 2.2.x para
> dependências git (`Unrecognized flag: --no-dry-run`), então use o caminho local
> por enquanto.

Para desenvolver: `bun install && bun run build` depois de alterar `src/`.

É uma porta do projeto original (MIT, © Seongho Bak) para a API de plugins do
OpenCode v2; a licença e o crédito foram mantidos.

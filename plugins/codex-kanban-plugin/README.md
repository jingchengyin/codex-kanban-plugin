# Codex Kanban Plugin

[English](README.md) | [简体中文](README.zh.md)

A workspace for local Codex conversations, work items, and historical usage reviews.

## Quick Start

### Install

Requires the macOS desktop app and **Node.js 22.13+**. The plugin finds compatible Node installations in PATH, NVM, and common Homebrew locations. No npm dependency installation or build is needed.

In **Add plugin marketplace**, enter:

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Source       | `jingchengyin/codex-kanban-plugin` |
| Git ref      | `main`                             |
| Sparse paths | Leave empty                        |

Add the marketplace, then install **对话看板 (Conversation board)** from **Codex Kanban Plugin**.

Or install with the CLI:

```sh
codex plugin marketplace add jingchengyin/codex-kanban-plugin --ref main
codex plugin add codex-kanban-plugin@codex-kanban-plugin
```

Codex requires a marketplace selector (`@marketplace` or `-m marketplace`). Both the plugin and its marketplace are named `codex-kanban-plugin`.

### Connect live status

Open Codex normally, then open the board to sync live status. **No client restart or launcher is required.** Check the connection in **Connection & data sources**.

Conversations that are not loaded or whose status is unavailable appear as **Awaiting sync**.

Direct connection uses an internal desktop protocol that may change between client versions. If it is unavailable, use the compatibility connection below.

### Compatibility connection (shared mode)

In **Connection & data sources**, click **Open compatibility launcher**. You can also double-click `scripts/Codex Kanban.command` in the installed plugin directory. The launcher finds Node automatically, with no command to type.

For manual startup, run in a separate terminal:

```sh
cd ~/.codex/plugins/cache/codex-kanban-plugin/codex-kanban-plugin/0.2.0
npm run codex-kanban-plugin
```

If your installation directory differs, use the `installedPath` returned by the installer.

The compatibility launcher lets Codex start a shared backend through the desktop's normal initialization, preserving built-in tools such as automations and their communication pipe. If Codex is already running, press **⌘Q** when prompted; the command will continue automatically. Quitting is needed only to switch to this compatibility mode. Direct desktop connection does not require it.

Codex manages the backend. Closing the launch terminal does not affect the desktop; quitting Codex stops the backend. When upgrading from 0.1.3, quit the old shared session and stop its launch command before running the new command.

After exiting the shared session, launch Codex normally from its icon. The board will use direct desktop connection again.

## Features

- **Work items:** Group multiple conversations, add notes, acceptance checklists, and artifact links. Add a conversation to an existing work item from its card, or create a work item with that conversation linked. Click a work-item tag to open its editor. Planned, In progress, Awaiting acceptance, and Accepted are set manually; an idle conversation or completed turn does not imply acceptance.
- **Work review:** Review turns from the last 1, 7, or 30 calendar days, filter by project, and summarize known tokens, duration, completed turns, and interruptions, including archived conversations. Missing metrics and unreadable logs are reported separately.
- **Board and list layouts:** The board groups conversations by status, with each conversation in one column. Local conversations awaiting status sync are included by default. Auto layout uses a compact list at viewport widths of 900px or less; you can also select the board or list manually.
- **Confirm on the card:** Once connected, view supported pending commands, file diffs, or structured questions and submit the decisions or answers allowed by the original request. Requests handled on the desktop or cleared by the backend invalidate old buttons. Handle unsupported requests in the original conversation. Direct desktop connection returns replies to that conversation; shared mode continues to use the local confirmation relay (`19430` by default).
- **Needs attention view:** Focus on conversations awaiting your response, unread conversations, and errors, with pending-question summaries or error messages. Waiting time starts when the current connection first observes the wait, not when the question was sent.
- **Detailed cards:** Model, reasoning effort, plan/default mode, goal status, turn token usage, elapsed time, and the latest user input. Expand Run details in the list to view these metrics.
- **Search and filters:** Search titles, projects, IDs, the latest user input, and linked work-item names. Filter by project, runtime status, and read status. Only ordinary user conversations are shown. Sort by Action priority, latest user message, or title. Action priority puts waiting conversations first, then errors and unread conversations; earlier observed waits come first.
- **Saved preferences:** Reopening the workspace restores the tab, conversation scope, filters, sort order, and layout selection.
- **Direct navigation:** Click a card to open its conversation without a details dialog.
- **Monitoring relationships:** Cards and list rows show “Monitoring xx” and “Monitored by xx”. Click either link to open that conversation. Relationships come from successful waits in the latest turn, remain after it ends, and reset when the next turn starts. Ordinary reads and instant status snapshots do not count as monitoring.
- **Unread tracking:** Read saved client records and choose the matching source when multiple records exist.
- **Live updates:** Follow desktop conversation snapshots and incremental updates by default. When disconnected, retain local conversations and the last snapshot, mark the status as no longer live, and show unavailable runtime states as Awaiting sync.
- **Codex appearance:** Follow the host's light/dark theme, with English by default and a Chinese language option.
- **Local storage:** Work items are saved in `CODEX_HOME/kanban/workspace.sqlite`, defaulting to `~/.codex/kanban/workspace.sqlite`. Local Codex conversation data is accessed read-only; explicit confirmation replies are sent through the original desktop connection.

Review ranges use calendar days in the browser's timezone. A turn belongs to its start date, falling back to its latest record time if the start is unavailable. Total duration sums known turn durations, including overlapping turns; ongoing durations remain unknown. Logged token usage is not a billing total.

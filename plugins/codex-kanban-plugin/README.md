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

Open **Connection & data sources** in the board and click **Open live launcher**. You can also double-click `scripts/Codex Kanban.command` in the installed plugin directory. The launcher finds Node automatically, with no command to type.

For manual startup, run in a separate terminal:

```sh
cd ~/.codex/plugins/cache/codex-kanban-plugin/codex-kanban-plugin/0.2.0
npm run codex-kanban-plugin
```

If your installation directory differs, use the `installedPath` returned by the installer.

The command lets Codex start its backend through the desktop's normal initialization, preserving built-in tools such as automations and their communication pipe. It relays the same backend's live status to the board. If Codex is already running, press **⌘Q** when prompted; the command will continue automatically. Open the board and check for **Connected** in **Connection & data sources**.

Codex manages the backend. Closing the launch terminal does not affect the desktop; quitting Codex stops the backend. When upgrading from 0.1.3, quit the old shared session and stop its launch command before running the new command.

Switching from a normal launch to shared mode still requires you to quit Codex. The launcher waits and opens it automatically afterward. Attaching a shared listener to an already running normal backend has not been verified for this client.

A normal launch supports local conversations, unread records, work items, and historical usage reviews. After exiting the shared session, you can launch Codex normally from its icon.

## Features

- **Work items:** Group multiple conversations, add notes, acceptance checklists, and artifact links. Add a conversation to an existing work item from its card, or create a work item with that conversation linked. Click a work-item tag to open its editor. Planned, In progress, Awaiting acceptance, and Accepted are set manually; an idle conversation or completed turn does not imply acceptance.
- **Work review:** Review turns from the last 1, 7, or 30 calendar days, filter by project, and summarize known tokens, duration, completed turns, and interruptions, including archived conversations. Missing metrics and unreadable logs are reported separately.
- **Board and list layouts:** The board groups conversations by status, with each conversation in one column. Local conversations awaiting status sync are included by default. Auto layout uses a compact list at viewport widths of 900px or less; you can also select the board or list manually.
- **Needs attention view:** Focus on conversations awaiting your response, unread conversations, and errors, with pending-question summaries or error messages. Waiting time starts when the current connection first observes the wait, not when the question was sent.
- **Detailed cards:** Model, reasoning effort, plan/default mode, goal status, turn token usage, elapsed time, and the latest user input. Expand Run details in the list to view these metrics.
- **Search and filters:** Search titles, projects, IDs, the latest user input, and linked work-item names. Filter by project, runtime status, and read status. Only ordinary user conversations are shown. Sort by Action priority, latest user message, or title. Action priority puts waiting conversations first, then errors and unread conversations; earlier observed waits come first.
- **Saved preferences:** Reopening the workspace restores the tab, conversation scope, filters, sort order, and layout selection.
- **Direct navigation:** Click a card to open its conversation without a details dialog.
- **Monitoring relationships:** Cards and list rows show “Monitoring xx” and “Monitored by xx”. Click either link to open that conversation. Relationships come from successful waits in the latest turn, remain after it ends, and reset when the next turn starts. Ordinary reads and instant status snapshots do not count as monitoring.
- **Unread tracking:** Read saved client records and choose the matching source when multiple records exist.
- **Live updates:** Follow the shared backend's status. When disconnected, retain local conversations and the last snapshot, mark the status as no longer live, and show unavailable runtime states as Awaiting sync.
- **Codex appearance:** Follow the host's light/dark theme, with English by default and a Chinese language option.
- **Local storage:** Work items are saved in `CODEX_HOME/kanban/workspace.sqlite`, defaulting to `~/.codex/kanban/workspace.sqlite`. Codex conversation data is accessed read-only.

Review ranges use calendar days in the browser's timezone. A turn belongs to its start date, falling back to its latest record time if the start is unavailable. Total duration sums known turn durations, including overlapping turns; ongoing durations remain unknown. Logged token usage is not a billing total.

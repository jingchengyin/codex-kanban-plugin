# Codex-Kanban-Plugin

[English](README.md) | [简体中文](README.zh.md)

A workspace for local Codex conversations, work items, and historical usage reviews.

## Quick Start

### Install

Requires the macOS desktop app and **Node.js 22.13+**. The plugin finds compatible Node installations in PATH, NVM, and common Homebrew locations. No npm dependency installation or build is needed.

Paste this prompt into Codex to have it install the plugin for you:

```text
Please install Codex-Kanban-Plugin from https://github.com/jingchengyin/codex-kanban-plugin.
Add the plugin marketplace from the main branch, install codex-kanban-plugin@codex-kanban-plugin, and verify the installation.
```

To install manually, enter the following in **Add plugin marketplace**:

| Field        | Value                              |
| ------------ | ---------------------------------- |
| Source       | `jingchengyin/codex-kanban-plugin` |
| Git ref      | `main`                             |
| Sparse paths | Leave empty                        |

Add the marketplace, then install **Codex-Kanban-Plugin**.

Or install with the CLI. Run both commands in order for the first installation. If the marketplace is already added, run only the second command:

```sh
# Add the plugin marketplace
codex plugin marketplace add jingchengyin/codex-kanban-plugin --ref main

# Install the plugin from that marketplace
codex plugin add codex-kanban-plugin@codex-kanban-plugin
```

The install argument uses `plugin-name@marketplace-name`; you can also specify the marketplace with `-m marketplace-name`. Both the plugin and its marketplace are named `codex-kanban-plugin`.

### Update

For the Git marketplace added above, run:

```sh
# Fetch the latest main branch and update the installed plugin
codex plugin marketplace upgrade codex-kanban-plugin
```

The command uses the Git ref saved when the marketplace was added (`main` in the example above). It also updates the installed plugin, so you do not need to uninstall it or run `plugin add` again. Close and reopen the board after updating.

### Connect live status

Open Codex normally, then open the board to sync live status. **No client restart is required.** Check the connection in **Connection & data sources**.

Conversations that are not loaded or whose status is unavailable appear as **Awaiting sync**.

## Features

- **Work items:** Group multiple conversations, add notes, acceptance checklists, and artifact links. Add a conversation to an existing work item from its card, or create a work item with that conversation linked. Click a work-item tag to open its editor. Planned, In progress, Awaiting acceptance, and Accepted are set manually; an idle conversation or completed turn does not imply acceptance.
- **Work review:** Review turns from the last 1, 7, or 30 calendar days, filter by project, and summarize known tokens, duration, completed turns, and interruptions, including archived conversations. Missing metrics and unreadable logs are reported separately.
- **Board and list layouts:** The board groups conversations by status, with each conversation in one column. Local conversations awaiting status sync are included by default. Auto layout uses a compact list at viewport widths of 900px or less; you can also select the board or list manually.
- **Confirm on the card:** Once connected, view supported pending commands, file diffs, or structured questions and submit the decisions or answers allowed by the original request. Requests handled on the desktop or cleared by the backend invalidate old buttons. Handle unsupported requests in the original conversation. Replies return to the original conversation.
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

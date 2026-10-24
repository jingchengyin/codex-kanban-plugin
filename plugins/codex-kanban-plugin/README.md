# Codex Kanban Plugin

[English](README.md) | [简体中文](README.zh.md)

A kanban board for your local Codex conversations.

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

Open a separate terminal and run:

```sh
cd ~/.codex/plugins/cache/codex-kanban-plugin/codex-kanban-plugin/0.1.3
npm run codex-kanban-plugin
```

If your installation directory differs, use the `installedPath` returned by the installer.

The command starts a shared backend and opens Codex connected to it. If Codex is already running, press **⌘Q** when prompted; the command will continue automatically. Keep the terminal running, open the board, and check for **Connected** in **Connection & data sources**.

Live status requires this shared launch. Opening Codex normally still provides local conversations and unread records. After exiting the shared session, you can launch Codex normally from its icon.

## Features

- **Five columns:** Needs your input, Running, Unread, Idle, and Error. Each conversation appears in one column; Awaiting sync is available through filters.
- **Needs attention view:** Focus on conversations awaiting your response, unread conversations, and errors.
- **Detailed cards:** Model, reasoning effort, plan/default mode, goal status, turn token usage, elapsed time, and the latest user input.
- **Search and filters:** Filter by project, runtime status, read status, and conversation type, including subagents. Sort by recent activity or title.
- **Direct navigation:** Click a card to open its conversation without a details dialog.
- **Unread tracking:** Read saved client records and choose the matching source when multiple records exist.
- **Live updates:** Follow the shared backend's status and retain the last snapshot when disconnected; unavailable runtime states appear as Awaiting sync.
- **Codex appearance:** Follow the host's light/dark theme, with English by default and a Chinese language option.
- **Read-only access:** Observe local data without sending tasks, answering approvals, or modifying conversations and read states.

# Codex Kanban Plugin · 对话看板

[English](README.md) | [简体中文](README.zh.md)

集中查看本机 Codex 对话的看板插件。

## 快速开始

### 安装

需要 macOS 桌面客户端和 **Node.js 22.13+**。插件会从 PATH、NVM 和常见 Homebrew 路径中寻找兼容的 Node，无需安装 npm 依赖或运行构建命令。

在「添加插件市场」中填写：

| 字段     | 值                                 |
| -------- | ---------------------------------- |
| 来源     | `jingchengyin/codex-kanban-plugin` |
| Git 引用 | `main`                             |
| 稀疏路径 | 留空                               |

添加市场后，在 **Codex Kanban Plugin** 中安装「对话看板」。

也可以通过 CLI 安装：

```sh
codex plugin marketplace add jingchengyin/codex-kanban-plugin --ref main
codex plugin add codex-kanban-plugin@codex-kanban-plugin
```

Codex 安装插件时必须指定市场（`@市场名` 或 `-m 市场名`）。本插件和市场均命名为 `codex-kanban-plugin`。

### 接入实时状态

打开独立终端并运行：

```sh
cd ~/.codex/plugins/cache/codex-kanban-plugin/codex-kanban-plugin/0.1.3
npm run codex-kanban-plugin
```

如果安装目录不同，以安装命令返回的 `installedPath` 为准。

命令会启动共享后端，并让 Codex 连接该后端。如果 Codex 已打开，按提示用 **⌘Q** 完全退出，命令会自动继续启动。保持终端运行，打开看板，在「连接与数据源」中确认已连接。

实时状态需要通过上述命令以共享模式启动。普通启动仍可读取本地对话和未读记录。退出共享会话后，下次直接点击 Codex 图标即可普通启动。

## 功能

- **五列看板：** 需要你处理、正在运行、未读、暂时空闲、执行异常。每条对话只出现在一列；可通过筛选显示「状态待同步」。
- **需要关注视图：** 集中查看等待回复、未读和执行异常的对话。
- **完整卡片信息：** 模型、思考等级、计划/默认模式、目标状态、本轮 token 用量、耗时及最近一条用户输入。
- **搜索与筛选：** 按项目、运行状态、阅读状态和对话类型筛选，支持子 Agent，可按最近更新或标题排序。
- **直接跳转：** 点击卡片直接打开原对话，不弹出详情框。
- **未读追踪：** 读取客户端保存的记录；存在多份记录时，可明确选择对应来源。
- **实时更新：** 跟随共享后端更新状态；断线时保留最后快照，不可用的运行状态归入「状态待同步」。
- **Codex 外观：** 跟随宿主深浅色主题，默认英文，可切换中文。
- **只读访问：** 观察本地数据，不发送任务、不回答审批，也不修改对话或阅读状态。

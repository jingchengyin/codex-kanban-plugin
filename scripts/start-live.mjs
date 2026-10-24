import { runKanbanLauncher } from "./kanban-launcher.mjs";

try {
  await runKanbanLauncher();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

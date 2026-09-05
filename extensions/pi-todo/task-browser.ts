import { formatTaskRow, sanitizeTerminalText, truncateToWidth, visibleWidth } from "./format.ts";
import { classifyTask, projectActiveView, projectAll, projectArchived, projectCompleted } from "./projection.ts";
import { formatTaskDetailRich } from "./task-detail-format.ts";
import { taskActions } from "./task-actions.ts";
import { buildDependencyPresentation } from "./read-model.ts";
import type { Task, TaskRowRole, TaskState } from "./types.ts";

export type TaskBrowserView =
  | "current"
  | "ready"
  | "blocked"
  | "completed"
  | "archived"
  | "all";

export type TaskBrowserIntent =
  | { kind: "close" }
  | { kind: "create"; subject: string }
  | { kind: "edit"; id: number; subject: string }
  | {
      kind: "action";
      action: "continue" | "start" | "finish" | "reopen" | "close" | "review" | "archive" | "restore";
      id: number;
    };

export interface TaskBrowserSession {
  view: TaskBrowserView;
  query: string;
  selectedId?: number;
  selectedIndex?: number;
  offset?: number;
  detailId?: number;
  detailOffset?: number;
  notice?: { text: string; level: "info" | "error" };
}

export interface TaskBrowserTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

export interface TaskBrowserKeybindings {
  matches(data: string, id: string): boolean;
}

export interface TaskBrowserTui {
  terminal: { rows: number };
  requestRender(force?: boolean): void;
}

type BrowserMode = "list" | "detail" | "search" | "create" | "edit";
type BrowserEntry = { task: Task; role: TaskRowRole };
type BrowserAction = {
  action: "continue" | "start" | "finish" | "reopen" | "close" | "review" | "archive" | "restore" | "edit";
  label: string;
};

const PRIMARY_VIEWS: readonly TaskBrowserView[] = [
  "current",
  "completed",
  "archived",
  "all",
];

const VIEW_LABEL: Record<TaskBrowserView, string> = {
  current: "当前",
  ready: "可开始",
  blocked: "被阻塞",
  completed: "已完成",
  archived: "已归档",
  all: "全部",
};

function roleFor(state: TaskState, task: Task): TaskRowRole {
 if (task.archivedAt !== undefined) return "archived";
 if (task.closedAt !== undefined) return "closed";
  if (task.status === "completed") return "completed";
  return classifyTask(state, task) ?? "blocked";
}

function entriesFor(state: TaskState, view: TaskBrowserView): BrowserEntry[] {
  const active = projectActiveView(state);
  switch (view) {
    case "current":
      return [
        ...active.running.map((task) => ({ task, role: "running" as const })),
        ...active.ready.map((task) => ({ task, role: "ready" as const })),
        ...active.blocked.map((task) => ({ task, role: "blocked" as const })),
      ];
    case "ready":
      return active.ready.map((task) => ({ task, role: "ready" as const }));
    case "blocked":
      return active.blocked.map((task) => ({ task, role: "blocked" as const }));
    case "completed":
      return projectCompleted(state).map((task) => ({ task, role: "completed" as const }));
    case "archived":
      return projectArchived(state).map((task) => ({ task, role: "archived" as const }));
    case "all":
      return projectAll(state).map((task) => ({ task, role: roleFor(state, task) }));
  }
}

function filteredEntries(state: TaskState, session: TaskBrowserSession): BrowserEntry[] {
  const query = sanitizeTerminalText(session.query).trim().toLocaleLowerCase();
  const entries = entriesFor(state, session.view);
  if (!query) return entries;
  const idQuery = query.startsWith("#") ? query.slice(1) : query;
  return entries.filter(({ task }) =>
    task.subject.toLocaleLowerCase().includes(query) || String(task.id).includes(idQuery)
  );
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function isPrintable(data: string): boolean {
  return data.length > 0 && !/[\u0000-\u001f\u007f]/u.test(data);
}

function actionRows(state: TaskState, id: number): BrowserAction[] {
  const allowed = new Set(["continue", "start", "finish", "reopen", "close", "review", "archive", "restore", "edit"]);
  return taskActions(state, id).flatMap((row) => {
    const [rawAction, rawLabel] = row.split(/\s+—\s+/, 2);
    if (!rawAction || !allowed.has(rawAction)) return [];
    return [{
      action: rawAction as BrowserAction["action"],
      label: rawLabel || rawAction,
    }];
  });
}

/**
 * One bounded task browser for Pi's custom overlay API. It owns only
 * interaction state; projections, task actions and mutations remain in
 * their existing semantic authorities.
 */
export class TaskBrowserComponent {
  private mode: BrowserMode;
  private offset = 0;
  private detailOffset = 0;
  private actionIndex = 0;
  private inputValue = "";
  private searchBeforeEdit = "";

  constructor(
    private readonly tui: TaskBrowserTui,
    private readonly theme: TaskBrowserTheme,
    private readonly keybindings: TaskBrowserKeybindings,
    private readonly state: TaskState,
    private readonly session: TaskBrowserSession,
    private readonly done: (intent: TaskBrowserIntent) => void,
  ) {
    this.mode = session.detailId === undefined ? "list" : "detail";
    this.offset = session.offset ?? 0;
    this.detailOffset = session.detailOffset ?? 0;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width < 20) return [truncateToWidth("任务窗口需要更宽的终端", Math.max(0, width))];
    if (this.mode === "detail") return this.renderDetail(width);
    if (this.mode === "create" || this.mode === "edit") return this.renderInput(width);
    return this.renderList(width);
  }

  handleInput(data: string): void {
    if (this.mode === "search" || this.mode === "create" || this.mode === "edit") {
      this.handleTextInput(data);
      return;
    }
    if (this.mode === "detail") {
      this.handleDetailInput(data);
      return;
    }
    this.handleListInput(data);
  }

  private matches(data: string, id: string): boolean {
    try {
      return this.keybindings.matches(data, id);
    } catch {
      return false;
    }
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private terminalBudget(): number {
    const rows = Number.isFinite(this.tui.terminal.rows) ? this.tui.terminal.rows : 24;
    return Math.max(8, Math.floor(rows * 0.82));
  }

  private frame(width: number, title: string, body: string[], footer: string): string[] {
    const inner = Math.max(16, width - 2);
    const safeTitle = truncateToWidth(` ${title} `, Math.max(1, inner - 3));
    const border = (text: string): string => this.theme.fg("border", text);
    const surface = (text: string): string => this.theme.bg("customMessageBg", text);
    const top = `${border("╭─")}${this.theme.fg("accent", safeTitle)}${border(`${"─".repeat(Math.max(0, inner - 1 - visibleWidth(safeTitle)))}╮`)}`;
    return [
      surface(top),
      ...body.map((line) => surface(`${border("│")}${padToWidth(line, inner)}${border("│")}`)),
      surface(`${border("│")}${padToWidth(this.theme.fg("dim", footer), inner)}${border("│")}`),
      surface(border(`╰${"─".repeat(inner)}╯`)),
    ];
  }

  private counts(): Record<TaskBrowserView, number> {
    const active = projectActiveView(this.state);
    return {
      current: active.counts.active,
      ready: active.ready.length,
      blocked: active.blocked.length,
      completed: projectCompleted(this.state).length,
      archived: projectArchived(this.state).length,
      all: projectAll(this.state).length,
    };
  }

  private tabs(): string {
    const counts = this.counts();
    return PRIMARY_VIEWS.map((view) => {
      const label = `${VIEW_LABEL[view]} ${counts[view]}`;
      return view === this.session.view ? this.theme.fg("accent", `[${label}]`) : this.theme.fg("dim", label);
    }).join("  ");
  }

  private ensureSelection(entries: readonly BrowserEntry[]): number {
    if (entries.length === 0) {
      this.session.selectedId = undefined;
      this.session.selectedIndex = 0;
      this.offset = 0;
      this.session.offset = 0;
      return 0;
    }
    let index = this.session.selectedId === undefined
      ? -1
      : entries.findIndex(({ task }) => task.id === this.session.selectedId);
    if (index < 0) index = Math.min(this.session.selectedIndex ?? 0, entries.length - 1);
    this.session.selectedIndex = index;
    this.session.selectedId = entries[index]?.task.id;
    return index;
  }

  private visibleRows(entryCount: number): number {
    const chrome = 7;
    return Math.max(1, Math.min(14, Math.max(1, this.terminalBudget() - chrome), Math.max(1, entryCount)));
  }

  private keepVisible(index: number, visibleRows: number, count: number): void {
    const maxOffset = Math.max(0, count - visibleRows);
    if (index < this.offset) this.offset = index;
    if (index >= this.offset + visibleRows) this.offset = index - visibleRows + 1;
    this.offset = Math.max(0, Math.min(this.offset, maxOffset));
    this.session.offset = this.offset;
  }

  private renderList(width: number): string[] {
    const inner = width - 2;
    const entries = filteredEntries(this.state, this.session);
    const selected = this.ensureSelection(entries);
    const visibleRows = this.visibleRows(entries.length);
    this.keepVisible(selected, visibleRows, entries.length);
    const body: string[] = [this.tabs()];
    const searchLabel = this.mode === "search" ? "搜索" : "筛选";
    const query = this.session.query || (this.mode === "search" ? "输入名称或 #编号" : "按 / 搜索");
    body.push(`${this.theme.fg("dim", `${searchLabel}  `)}${query}`);
    body.push(this.theme.fg("dim", "─".repeat(Math.max(1, inner))));

    if (entries.length === 0) {
      body.push(this.theme.fg("dim", this.session.query ? "没有匹配的任务" : "此视图暂无任务"));
    } else {
      for (let index = this.offset; index < Math.min(entries.length, this.offset + visibleRows); index += 1) {
        const entry = entries[index] as BrowserEntry;
        const marker = index === selected ? this.theme.fg("accent", "› ") : "  ";
        const row = formatTaskRow(entry.task, {
          role: entry.role,
          width: Math.max(1, inner - 2),
          dependencies: entry.role === "blocked"
            ? buildDependencyPresentation(this.state, entry.task.id)
            : undefined,
        });
        body.push(marker + (index === selected ? this.theme.fg("text", row) : this.theme.fg("muted", row)));
      }
    }

    const range = entries.length === 0
      ? "0/0"
      : `${selected + 1}/${entries.length} · ${this.offset + 1}-${Math.min(entries.length, this.offset + visibleRows)}`;
    const notice = this.session.notice;
    body.push(notice
      ? this.theme.fg(notice.level === "error" ? "error" : "success", notice.text)
      : this.theme.fg("dim", range));
    return this.frame(width, `任务 · ${VIEW_LABEL[this.session.view]}`, body, "↑↓ 移动  Enter 详情  Tab 视图  / 搜索  n 新增  Esc 关闭");
  }

  private renderDetail(width: number): string[] {
    const id = this.session.detailId;
    const task = id === undefined ? undefined : this.state.tasks.find((candidate) => candidate.id === id);
    if (!task || id === undefined) {
      this.mode = "list";
      this.session.detailId = undefined;
      this.session.notice = { text: `任务 #${id ?? "?"} 不存在`, level: "error" };
      return this.renderList(width);
    }
    const inner = width - 2;
    const actions = actionRows(this.state, id);
    this.actionIndex = Math.max(0, Math.min(this.actionIndex, Math.max(0, actions.length - 1)));
    const detailLines = formatTaskDetailRich(this.state, id, Math.max(10, inner));
    const detailBudget = Math.max(2, this.terminalBudget() - actions.length - 6);
    const maxOffset = Math.max(0, detailLines.length - detailBudget);
    this.detailOffset = Math.min(this.detailOffset, maxOffset);
    this.session.detailOffset = this.detailOffset;
    const visible = detailLines.slice(this.detailOffset, this.detailOffset + detailBudget);
    const body = [...visible];
    if (detailLines.length > detailBudget) {
      body.push(this.theme.fg("dim", `${this.detailOffset + 1}-${Math.min(detailLines.length, this.detailOffset + detailBudget)}/${detailLines.length}`));
    }
    body.push(this.theme.fg("dim", "─".repeat(Math.max(1, inner))));
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index] as BrowserAction;
      const marker = index === this.actionIndex ? this.theme.fg("accent", "› ") : "  ";
      body.push(`${marker}${index === this.actionIndex ? this.theme.fg("text", action.label) : this.theme.fg("muted", action.label)}`);
    }
    return this.frame(width, `任务 #${id}`, body, "↑↓ 选择操作  PgUp/PgDn 阅读  Enter 执行  Esc 返回");
  }

  private renderInput(width: number): string[] {
    const editing = this.mode === "edit";
    const title = editing ? `修改任务 #${this.session.detailId ?? ""}` : "新增任务";
    const value = this.inputValue || this.theme.fg("dim", "输入任务名称…");
    return this.frame(width, title, ["", `  ${value}`, ""], "Enter 保存  Esc 返回");
  }

  private selectBy(delta: number): void {
    const entries = filteredEntries(this.state, this.session);
    if (entries.length === 0) return;
    const current = this.ensureSelection(entries);
    const next = Math.max(0, Math.min(entries.length - 1, current + delta));
    this.session.selectedIndex = next;
    this.session.selectedId = entries[next]?.task.id;
    this.session.notice = undefined;
    this.requestRender();
  }

  private changeView(delta: number): void {
    const current = PRIMARY_VIEWS.includes(this.session.view)
      ? PRIMARY_VIEWS.indexOf(this.session.view)
      : 0;
    const next = (current + delta + PRIMARY_VIEWS.length) % PRIMARY_VIEWS.length;
    this.session.view = PRIMARY_VIEWS[next] as TaskBrowserView;
    this.session.selectedId = undefined;
    this.session.selectedIndex = 0;
    this.session.notice = undefined;
    this.offset = 0;
    this.session.offset = 0;
    this.requestRender();
  }

  private handleListInput(data: string): void {
    const entries = filteredEntries(this.state, this.session);
    const page = this.visibleRows(entries.length);
    if (this.matches(data, "tui.select.cancel")) return this.done({ kind: "close" });
    if (this.matches(data, "tui.select.up")) return this.selectBy(-1);
    if (this.matches(data, "tui.select.down")) return this.selectBy(1);
    if (this.matches(data, "tui.select.pageUp")) return this.selectBy(-page);
    if (this.matches(data, "tui.select.pageDown")) return this.selectBy(page);
    if (this.matches(data, "tui.editor.cursorLineStart")) return this.selectBy(-entries.length);
    if (this.matches(data, "tui.editor.cursorLineEnd")) return this.selectBy(entries.length);
    if (data === "\t" || this.matches(data, "tui.input.tab")) return this.changeView(1);
    if (data === "/") {
      this.mode = "search";
      this.searchBeforeEdit = this.session.query;
      this.requestRender();
      return;
    }
    if (data.toLocaleLowerCase() === "n") {
      this.mode = "create";
      this.inputValue = "";
      this.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.confirm")) {
      const selected = this.ensureSelection(entries);
      const entry = entries[selected];
      if (!entry) return;
      this.session.detailId = entry.task.id;
      this.mode = "detail";
      this.actionIndex = 0;
      this.detailOffset = 0;
      this.session.detailOffset = 0;
      this.session.notice = undefined;
      this.requestRender();
    }
  }

  private handleDetailInput(data: string): void {
    const id = this.session.detailId;
    if (id === undefined) return;
    const actions = actionRows(this.state, id);
    if (this.matches(data, "tui.select.cancel")) {
      this.mode = "list";
      this.session.detailId = undefined;
      this.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.pageUp")) {
      this.detailOffset = Math.max(0, this.detailOffset - 5);
      this.session.detailOffset = this.detailOffset;
      this.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.pageDown")) {
      this.detailOffset += 5;
      this.session.detailOffset = this.detailOffset;
      this.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.up")) {
      this.actionIndex = Math.max(0, this.actionIndex - 1);
      this.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.down")) {
      this.actionIndex = Math.min(Math.max(0, actions.length - 1), this.actionIndex + 1);
      this.requestRender();
      return;
    }
    if (!this.matches(data, "tui.select.confirm")) return;
    const selected = actions[this.actionIndex];
    if (!selected) return;
    if (selected.action === "edit") {
      this.mode = "edit";
      this.inputValue = this.state.tasks.find((task) => task.id === id)?.subject ?? "";
      this.requestRender();
      return;
    }
    this.done({ kind: "action", action: selected.action, id });
  }

  private handleTextInput(data: string): void {
    if (this.matches(data, "tui.select.cancel")) {
      if (this.mode === "search") {
        this.session.query = this.searchBeforeEdit;
        this.mode = "list";
      } else if (this.mode === "edit") {
        this.mode = "detail";
      } else {
        this.mode = "list";
      }
      this.requestRender();
      return;
    }
    if (this.matches(data, "tui.editor.deleteCharBackward")) {
      if (this.mode === "search") this.session.query = Array.from(this.session.query).slice(0, -1).join("");
      else this.inputValue = Array.from(this.inputValue).slice(0, -1).join("");
      this.offset = 0;
      this.session.offset = 0;
      this.requestRender();
      return;
    }
    if (this.matches(data, "tui.select.confirm")) {
      if (this.mode === "search") {
        this.mode = "list";
        this.requestRender();
        return;
      }
      const subject = sanitizeTerminalText(this.inputValue).trim();
      if (!subject) return;
      if (this.mode === "edit" && this.session.detailId !== undefined) {
        this.done({ kind: "edit", id: this.session.detailId, subject });
      } else {
        this.done({ kind: "create", subject });
      }
      return;
    }
    if (!isPrintable(data)) return;
    if (this.mode === "search") this.session.query += sanitizeTerminalText(data);
    else this.inputValue += sanitizeTerminalText(data);
    this.offset = 0;
    this.session.offset = 0;
    this.requestRender();
  }
}

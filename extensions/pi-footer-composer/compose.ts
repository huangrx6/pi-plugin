import type { Snapshot } from "./data.ts";
import type { CellConfig, Field, ViewConfig } from "./settings.ts";
export type DisplayCell = { label: string; items: string[] };
export type DisplayRow = (DisplayCell | null)[];
const sourceOf = (field: Field) => typeof field === "string" ? field : "source" in field ? field.source : null;
const statusOf = (field: Field) => typeof field === "object" && "status" in field ? field.status : null;

/** Explicit status keys are reserved before remaining is resolved, independent of row order. */
export function composeRows(view: ViewConfig, snapshot: Snapshot): DisplayRow[] {
  const cells = view.rows.flat().filter((cell): cell is CellConfig => cell !== null);
  const reserved = new Set(cells.flatMap(cell => cell.fields.map(statusOf)).filter((key): key is string => key !== null));
  const contextVisible = cells.some(cell => !cell.hidden && cell.fields.some(field => sourceOf(field) === "context"));
  const available = snapshot.statuses.filter(status => {
    const match = status.text.match(/^(?:Context|上下文)\s+(\d+(?:\.\d+)?)%$/i);
    return !(contextVisible && match && typeof snapshot.contextPercent === "number" && Number.isFinite(snapshot.contextPercent) && Math.round(Number(match[1])) === Math.round(snapshot.contextPercent));
  });
  const consumed = new Set<string>(reserved);
  const pending: (() => void)[] = [];
  const build = (cell: CellConfig | null): { label: string; slots: string[][]; hidden: boolean } | null => {
    if (!cell) return null;
    const slots = cell.fields.map(field => {
      const source = sourceOf(field);
      const status = statusOf(field);
      const result: string[] = [];
      const fill = () => {
        let values: string[];
        if (status !== null) values = available.filter(item => item.key === status).map(item => item.text);
        else if (source === "remaining") {
          const selected = available.filter(item => !consumed.has(item.key));
          selected.forEach(s => consumed.add(s.key));
          values = selected.map(s => s.text);
        } else values = source && snapshot.fields[source] ? [snapshot.fields[source]] : [];
        if (typeof field === "string") result.push(...values);
        else if (values.length) result.push(...values.map(value => `${field.prefix || ""}${value}${field.suffix || ""}`));
        else if (field.empty) result.push(field.empty);
      };
      if (source === "remaining") pending.push(fill); else fill();
      return result;
    });
    return { label: cell.label, slots, hidden: !!cell.hidden };
  };
  const built = view.rows.map(row => row.map(build));
  pending.forEach(fill => fill());
  return built.map(row => row.map(cell => !cell || cell.hidden ? null : { label: cell.label, items: cell.slots.flat() }));
}

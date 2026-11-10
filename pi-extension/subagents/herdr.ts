/**
 * herdr surface layer — pane primitives over the herdr CLI socket API.
 *
 * Mirrors the contract of tmux.ts: create/split a pane, type a command into
 * it, read its screen, close it, and poll for exit. Keeping the herdr calls
 * isolated here means index.ts stays testable without a multiplexer running.
 *
 * Panes are identified by herdr pane ids (e.g. `w1:p2`). Spawns are placed on
 * a per-tab grid anchored on the parent pi's pane (`$HERDR_PANE_ID`) so they
 * follow the agent rather than the user's focus. herdr only splits
 * right/down natively; the left/up directions are composed as a split plus a
 * swap with the source.
 *
 * CLI conventions (herdr 0.9.x): control commands print a single-line JSON
 * envelope `{"id","result","type"}` on stdout; server errors are JSON on
 * stderr with exit status 1 (execFileSync throws, surfacing the message).
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside a herdr-managed pane with the herdr binary on
 * PATH. `HERDR_ENV=1` is injected by herdr into every process it manages.
 */
export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

export function isMuxAvailable(): boolean {
  return isHerdrAvailable();
}

export function muxSetupHint(): string {
  return "Start pi inside herdr (run `herdr` and open pi in a pane).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Parse a herdr CLI JSON envelope and return its `result` object.
 * Throws on a non-JSON body so an unexpected CLI change fails loudly
 * instead of surfacing as a bogus pane id downstream.
 */
function parseCliResult(stdout: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Unexpected herdr CLI output: ${stdout.slice(0, 200)}`);
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).result !== "object"
  ) {
    throw new Error(`Unexpected herdr CLI output: ${stdout.slice(0, 200)}`);
  }
  return (parsed as { result: Record<string, unknown> }).result;
}

// ── Pane layout planning ──
//
// Splitting the parent pane in a chain halves it on every spawn, so after a
// handful of subagents both the parent and the newest panes are a few cells
// wide. Panes are instead placed on a fixed grid inside a tab: an anchor
// column holds the parent (or the tab's first subagent) at full height, the
// remaining columns are carved out one at a time, then filled with rows.
//
// Two rows is the cap because herdr splits cut the target pane's own
// rectangle: with one pane per column every split is expressible with
// `--ratio` alone, so no already-created split has to be rewritten.

export const PANE_MIN_COL_WIDTH = 34;
/** A pane split downward below this height is unreadable. */
export const PANE_MIN_ROW_HEIGHT = 12;
export const PARENT_PANE_MIN_WIDTH = 76;
export const PARENT_PANE_WIDTH_RATIO = 0.45;
export const MAX_TAB_COLS = 4;
export const MAX_TAB_ROWS = 2;

export interface GridPlan {
  /** Cells reserved for the parent pi pane in the anchor column. */
  parentWidth: number;
  maxCols: number;
  maxRows: number;
}

/**
 * Size the grid for a tab: the parent keeps a readable share of the width and
 * the rest is packed with as many ≥PANE_MIN_COL_WIDTH subagent columns as fit.
 */
export function planTabGrid(areaWidth: number): GridPlan {
  const width = Math.max(1, Math.floor(areaWidth));
  const widestParent = Math.max(1, width - PANE_MIN_COL_WIDTH);
  const desired = Math.max(
    Math.round(width * PARENT_PANE_WIDTH_RATIO),
    Math.min(PARENT_PANE_MIN_WIDTH, widestParent),
  );
  const parentWidth = Math.min(desired, widestParent);
  const subagentWidth = Math.max(0, width - parentWidth);
  const maxCols = Math.min(
    MAX_TAB_COLS,
    Math.max(1, 1 + Math.floor(subagentWidth / PANE_MIN_COL_WIDTH)),
  );
  return { parentWidth, maxCols, maxRows: MAX_TAB_ROWS };
}

export interface PaneSize {
  width: number;
  height: number;
}

/**
 * Where the next subagent pane goes.
 *
 * `column` splits the single-pane rightmost column to the right; `row` splits
 * the deepest pane of the shallowest column downward. `full` means the grid
 * has no room left.
 */
export type InsertPlan =
  | { kind: "column"; targetPaneId: string; newCol: number; ratio: number }
  | { kind: "row"; targetPaneId: string; newCol: number; newRow: number; ratio: number }
  | { kind: "full" };

export interface InsertContext {
  /** Column-major grid; column 0 is the anchor. Holes are closed panes. */
  slots: (string | null)[][];
  /** True when the anchor column holds the parent pi pane. */
  anchorIsParent: boolean;
  plan: GridPlan;
  /** Tab size in cells. */
  area: PaneSize;
  /** Current size of a pane, or null when it is no longer in the tab. */
  measure: (paneId: string) => PaneSize | null;
}

const RATIO_MIN = 0.1;
const RATIO_MAX = 0.9;

function clampRatio(value: number): number {
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, value));
}

function deepestRow(column: (string | null)[] | undefined): number {
  if (!column) return -1;
  for (let row = column.length - 1; row >= 0; row -= 1) {
    if (column[row]) return row;
  }
  return -1;
}

function filledRows(column: (string | null)[] | undefined): number {
  if (!column) return 0;
  let count = 0;
  for (const pane of column) {
    if (pane) count += 1;
  }
  return count;
}

/**
 * Pick the next grid slot. Pure: ratios are derived from measured pane sizes
 * so a resize (or a drifted split) still lands on the intended geometry.
 */
export function planInsert(context: InsertContext): InsertPlan {
  const { slots, anchorIsParent, plan, area, measure } = context;
  const cols = slots.length;
  if (cols === 0) return { kind: "full" };

  // Columns first: herdr cuts the target pane's own rectangle, so a column can
  // only be carved from a column that still holds a single pane. Splits halve
  // the target, so a column stops qualifying once half of it would fall below
  // PANE_MIN_COL_WIDTH — the anchor's first split is the one exception, since
  // the parent keeps its planned share instead of a half.
  const rightmost = slots[cols - 1];
  const rightmostRow = deepestRow(rightmost);
  const rightmostTarget = rightmostRow >= 0 ? rightmost![rightmostRow] : null;
  if (rightmostTarget && cols < plan.maxCols && filledRows(rightmost) === 1) {
    const targetSize = measure(rightmostTarget);
    if (targetSize && targetSize.width > 0) {
      const anchorSplit = anchorIsParent && cols === 1;
      // ratio 相对目标 pane 自身：父 pane 被用户手动分割过时，它比 tab 窄得多，
      // 按 tab 宽度算比例会切出两个都过窄的 pane。
      const keep = anchorSplit
        ? Math.min(plan.parentWidth, targetSize.width - PANE_MIN_COL_WIDTH)
        : targetSize.width * 0.5;
      const carved = targetSize.width - keep;
      if (keep >= PANE_MIN_COL_WIDTH && carved >= PANE_MIN_COL_WIDTH) {
        return {
          kind: "column",
          targetPaneId: rightmostTarget,
          newCol: cols,
          ratio: clampRatio(keep / targetSize.width),
        };
      }
    }
  }

  // Rows second: stack into the shallowest column with room left. The anchor
  // column only takes rows when it is not the parent, which must keep its
  // full height.
  const firstCol = anchorIsParent ? 1 : 0;
  let best: { targetPaneId: string; col: number; row: number; ratio: number } | null = null;
  let bestRows = Number.POSITIVE_INFINITY;
  for (let col = firstCol; col < cols; col += 1) {
    const column = slots[col];
    const rows = filledRows(column);
    if (!column || rows === 0 || rows >= plan.maxRows || rows >= bestRows) continue;

    const row = deepestRow(column);
    const target = row >= 0 ? column[row] : null;
    const targetSize = target ? measure(target) : null;
    if (!target || !targetSize || targetSize.height <= 0) continue;

    const ratio = area.height / (rows + 1) / targetSize.height;
    if (targetSize.height * (1 - ratio) < PANE_MIN_ROW_HEIGHT) continue;

    best = { targetPaneId: target, col, row: row + 1, ratio };
    bestRows = rows;
  }
  if (best) {
    return {
      kind: "row",
      targetPaneId: best.targetPaneId,
      newCol: best.col,
      newRow: best.row,
      ratio: clampRatio(best.ratio),
    };
  }

  return { kind: "full" };
}

export interface LayoutRect extends PaneSize {
  x: number;
  y: number;
}

export interface LayoutPane {
  pane_id: string;
  rect: LayoutRect;
}

export interface TabLayout {
  tabId: string;
  workspaceId: string;
  zoomed: boolean;
  area: LayoutRect;
  panes: LayoutPane[];
}

export interface TabGrid {
  tabId: string;
  /** Pane that owns column 0 and spans the tab height. */
  anchorPaneId: string;
  anchorIsParent: boolean;
  slots: (string | null)[][];
  plan: GridPlan;
  /** Set when the tab's panes no longer match the recorded geometry. */
  degraded: boolean;
}

const tabGrids = new Map<string, TabGrid>();
const paneTabIndex = new Map<string, string>();

function toRect(value: unknown): LayoutRect | null {
  if (typeof value !== "object" || value === null) return null;
  const rect = value as Record<string, unknown>;
  const nums = [rect.x, rect.y, rect.width, rect.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return {
    x: rect.x as number,
    y: rect.y as number,
    width: rect.width as number,
    height: rect.height as number,
  };
}

/** Parse a `pane layout` result; throws when the payload lacks a usable grid. */
function toTabLayout(result: Record<string, unknown>): TabLayout {
  const layout = result.layout as Record<string, unknown> | undefined;
  const area = layout ? toRect(layout.area) : null;
  const rawPanes = layout && Array.isArray(layout.panes) ? layout.panes : null;
  if (!area || !rawPanes) {
    throw new Error(`Unexpected herdr pane layout output: ${JSON.stringify(result).slice(0, 200)}`);
  }

  const panes: LayoutPane[] = [];
  for (const raw of rawPanes) {
    if (typeof raw !== "object" || raw === null) continue;
    const pane = raw as Record<string, unknown>;
    const rect = toRect(pane.rect);
    if (typeof pane.pane_id !== "string" || !rect) continue;
    panes.push({ pane_id: pane.pane_id, rect });
  }

  const tabId = layout!.tab_id;
  if (typeof tabId !== "string" || tabId === "") {
    throw new Error(`herdr pane layout carried no tab_id: ${JSON.stringify(result).slice(0, 200)}`);
  }

  return {
    tabId,
    workspaceId: typeof layout!.workspace_id === "string" ? layout!.workspace_id : "",
    zoomed: layout!.zoomed === true,
    area,
    panes,
  };
}

function readTabLayout(paneId: string): TabLayout {
  const result = parseCliResult(
    execFileSync("herdr", ["pane", "layout", "--pane", paneId], { encoding: "utf8" }),
  );
  return toTabLayout(result);
}

/** Layout probe for a tab we have not touched this spawn; null when it is gone. */
function tryReadTabLayout(paneId: string): TabLayout | null {
  try {
    return readTabLayout(paneId);
  } catch (error) {
    // Only a vanished pane means "this tab is gone to us". Anything else is a
    // protocol problem and must surface instead of silently dropping the grid.
    if (isPaneNotFoundError(error)) return null;
    throw error;
  }
}

function isPaneNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("pane_not_found");
}

function splitPane(targetPaneId: string, direction: "right" | "down", ratio: number): string {
  const result = parseCliResult(
    execFileSync(
      "herdr",
      [
        "pane",
        "split",
        "--pane",
        targetPaneId,
        "--direction",
        direction,
        "--ratio",
        ratio.toFixed(4),
        "--cwd",
        process.cwd(),
        "--no-focus",
      ],
      { encoding: "utf8" },
    ),
  );
  const pane = (result as { pane?: { pane_id?: unknown } }).pane;
  const paneId = pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`Unexpected herdr pane split output: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return paneId;
}

function hasAnyPane(slots: (string | null)[][]): boolean {
  return slots.some((column) => column.some((pane) => Boolean(pane)));
}

function dropGrid(tabId: string): void {
  const grid = tabGrids.get(tabId);
  if (!grid) return;
  for (const column of grid.slots) {
    for (const pane of column) {
      if (pane) paneTabIndex.delete(pane);
    }
  }
  tabGrids.delete(tabId);
}

/**
 * Rebuild a grid from what is on screen: panes sharing an x value form a
 * column, ordered top to bottom. Used when the recorded anchor disappeared and
 * the array indices no longer say where the survivors sit.
 */
function slotsFromLayout(layout: TabLayout): string[][] {
  const ordered = [...layout.panes].sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
  const columns: LayoutPane[][] = [];
  for (const pane of ordered) {
    const current = columns[columns.length - 1];
    if (current && Math.abs(current[0]!.rect.x - pane.rect.x) <= 1) current.push(pane);
    else columns.push([pane]);
  }
  return columns.map((column) =>
    column.sort((a, b) => a.rect.y - b.rect.y).map((pane) => pane.pane_id),
  );
}

/**
 * Re-read a tab against its recorded grid: drop panes the user closed and
 * adopt a new anchor when the old one is gone. Returns null when the grid was
 * discarded (tab empty or untracked).
 */
function reconcileGrid(grid: TabGrid, layout: TabLayout): TabGrid | null {
  grid.plan = planTabGrid(layout.area.width);
  const alive = new Set(layout.panes.map((pane) => pane.pane_id));

  for (const column of grid.slots) {
    for (let row = 0; row < column.length; row += 1) {
      const pane = column[row];
      if (pane && !alive.has(pane)) {
        column[row] = null;
        paneTabIndex.delete(pane);
      }
    }
    // herdr hands a closed pane's space to its sibling, so the survivors of a
    // column always sit flush: compact the holes and keep the record aligned
    // with what is on screen.
    const survivors = column.filter((pane): pane is string => Boolean(pane));
    column.length = 0;
    column.push(...survivors);
  }

  if (!alive.has(grid.anchorPaneId)) {
    // The anchor held a whole column, and herdr handed its width to a sibling:
    // slice the screen again rather than trusting indices that just shifted.
    const rebuilt = slotsFromLayout(layout);
    if (rebuilt.length === 0) {
      dropGrid(grid.tabId);
      return null;
    }
    bindRebuiltSlots(grid, rebuilt);
    return grid;
  }

  // Columns that lost every pane no longer occupy space — herdr handed their
  // width to a sibling — so drop them and keep column order aligned with the
  // screen.
  for (let col = grid.slots.length - 1; col >= 1; col -= 1) {
    if (grid.slots[col]!.length === 0) grid.slots.splice(col, 1);
  }

  if (!hasAnyPane(grid.slots)) {
    dropGrid(grid.tabId);
    return null;
  }
  return grid;
}

/** Replace a grid's slots with a fresh reading of the screen. */
function bindRebuiltSlots(grid: TabGrid, rebuilt: string[][]): void {
  const kept = new Set(rebuilt.flat());
  for (const pane of grid.slots.flat()) {
    if (pane && !kept.has(pane)) paneTabIndex.delete(pane);
  }
  grid.slots = rebuilt;
  grid.anchorPaneId = rebuilt[0]![0]!;
  grid.anchorIsParent = false;
  grid.degraded = false;
  for (const pane of kept) paneTabIndex.set(pane, grid.tabId);
}

/** Record the parent's tab as a grid, or adopt the existing one. */
function ensureParentGrid(layout: TabLayout, parentPane: string): TabGrid {
  const existing = tabGrids.get(layout.tabId);
  if (existing) {
    return reconcileGrid(existing, layout) ?? createParentGrid(layout, parentPane);
  }
  return createParentGrid(layout, parentPane);
}

function createParentGrid(layout: TabLayout, parentPane: string): TabGrid {
  const grid: TabGrid = {
    tabId: layout.tabId,
    anchorPaneId: parentPane,
    anchorIsParent: true,
    slots: [[parentPane]],
    plan: planTabGrid(layout.area.width),
    // A tab already holding other panes was laid out before this process began
    // tracking grids; leave that geometry alone instead of guessing at it.
    degraded: layout.panes.length > 1,
  };
  tabGrids.set(grid.tabId, grid);
  paneTabIndex.set(parentPane, grid.tabId);
  return grid;
}

/** Split for the next grid slot. Returns null when the grid is full. */
function insertIntoGrid(grid: TabGrid, layout: TabLayout): string | null {
  const sizes = new Map<string, PaneSize>();
  for (const pane of layout.panes) {
    sizes.set(pane.pane_id, { width: pane.rect.width, height: pane.rect.height });
  }

  const insert = planInsert({
    slots: grid.slots,
    anchorIsParent: grid.anchorIsParent,
    plan: grid.plan,
    area: { width: layout.area.width, height: layout.area.height },
    measure: (paneId) => sizes.get(paneId) ?? null,
  });
  if (insert.kind === "full") return null;

  const paneId = splitPane(
    insert.targetPaneId,
    insert.kind === "column" ? "right" : "down",
    insert.ratio,
  );

  if (insert.kind === "column") {
    grid.slots.push([paneId]);
  } else {
    const column = grid.slots[insert.newCol];
    if (!column) {
      throw new Error(`herdr grid lost column ${insert.newCol} while inserting ${paneId}`);
    }
    column[insert.newRow] = paneId;
  }
  paneTabIndex.set(paneId, grid.tabId);
  return paneId;
}

/** Open a new tab whose first pane is the subagent (nothing is split yet). */
function createOverflowTab(parentLayout: TabLayout): string {
  const args = ["tab", "create", "--cwd", process.cwd(), "--label", "subagents", "--no-focus"];
  const workspaceId = process.env.HERDR_WORKSPACE_ID || parentLayout.workspaceId;
  if (workspaceId) args.push("--workspace", workspaceId);

  const result = parseCliResult(execFileSync("herdr", args, { encoding: "utf8" }));
  const pane = (result as { root_pane?: { pane_id?: unknown } }).root_pane;
  const tab = (result as { tab?: { tab_id?: unknown } }).tab;
  const paneId = pane?.pane_id;
  const tabId = tab?.tab_id;
  if (typeof paneId !== "string" || paneId === "" || typeof tabId !== "string" || tabId === "") {
    throw new Error(`Unexpected herdr tab create output: ${JSON.stringify(result).slice(0, 200)}`);
  }

  const layout = tryReadTabLayout(paneId);
  tabGrids.set(tabId, {
    tabId,
    anchorPaneId: paneId,
    anchorIsParent: false,
    slots: [[paneId]],
    plan: planTabGrid(layout?.area.width ?? parentLayout.area.width),
    degraded: false,
  });
  paneTabIndex.set(paneId, tabId);
  return paneId;
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent on the parent tab's grid, spilling into a
 * new tab once the grid is full. Panes follow the agent rather than the user's
 * focus because every split targets a pane this process created.
 *
 * Returns the new pane id (e.g. `w1:p2`).
 */
export function createSurface(name: string): string {
  void name; // herdr panes carry display metadata; the pi process inside shows its own title.
  requireHerdr();

  const parentPane = process.env.HERDR_PANE_ID;
  if (!parentPane) {
    throw new Error(`herdr did not export HERDR_PANE_ID. ${muxSetupHint()}`);
  }

  const parentLayout = readTabLayout(parentPane);
  if (parentLayout.zoomed) {
    // herdr drops zoom on the first split, so this costs one chain step rather
    // than rebuilding the narrow-pane ladder this module replaced.
    return splitPane(parentPane, "right", 0.5);
  }

  const grid = ensureParentGrid(parentLayout, parentPane);
  if (!grid.degraded) {
    const inserted = insertIntoGrid(grid, parentLayout);
    if (inserted) return inserted;
  }

  // Reuse spare room in a tab this process opened earlier before spilling.
  for (const candidate of [...tabGrids.values()]) {
    if (candidate.tabId === grid.tabId) continue;
    const layout = tryReadTabLayout(candidate.anchorPaneId);
    if (!layout) {
      dropGrid(candidate.tabId);
      continue;
    }
    const live = reconcileGrid(candidate, layout);
    if (!live || live.degraded) continue;
    const inserted = insertIntoGrid(live, layout);
    if (inserted) return inserted;
  }

  // A tab laid out before this process started tracking grids is left alone:
  // any split would land in an already-collapsed arrangement, so new subagents
  // go to a tab with a known-good grid instead.
  return createOverflowTab(parentLayout);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `w1:p2`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireHerdr();

  // herdr splits right/down only; left/up are built as split + swap with
  // the source pane, which yields the same final geometry.
  const nativeDirection = direction === "down" || direction === "up" ? "down" : "right";
  const needsSwap = direction === "left" || direction === "up";

  const args = [
    "pane",
    "split",
    "--direction",
    nativeDirection,
    "--cwd",
    process.cwd(),
    "--no-focus",
  ];
  if (fromSurface) {
    args.push("--pane", fromSurface);
  } else {
    args.push("--current");
  }

  const result = parseCliResult(execFileSync("herdr", args, { encoding: "utf8" }));
  const pane = (result as { pane?: { pane_id?: unknown } }).pane;
  const paneId = pane?.pane_id;
  if (typeof paneId !== "string" || paneId === "") {
    throw new Error(`Unexpected herdr pane split output: ${JSON.stringify(result).slice(0, 200)}`);
  }

  if (needsSwap) {
    const swapSource = fromSurface ?? process.env.HERDR_PANE_ID;
    if (swapSource) {
      try {
        execFileSync(
          "herdr",
          ["pane", "swap", "--source-pane", paneId, "--target-pane", swapSource],
          { encoding: "utf8" },
        );
      } catch {
        // Swapping is positional only; a failed swap leaves the pane on the
        // native side, which still works — never block the spawn on it.
      }
    }
  }

  // herdr keeps split geometry proportional on its own (no layout rebalance
  // primitive like tmux select-layout exists, so none is applied here).
  return paneId;
}

/** Forget a pane that was closed outside this module (or by the user). */
function forgetPane(
  paneId: string,
  readLayout: (paneId: string) => TabLayout | null = tryReadTabLayout,
): void {
  const tabId = paneTabIndex.get(paneId);
  if (tabId === undefined) return;
  paneTabIndex.delete(paneId);

  const grid = tabGrids.get(tabId);
  if (!grid) return;

  let removed = false;
  for (const column of grid.slots) {
    for (let row = 0; row < column.length; row += 1) {
      if (column[row] === paneId) {
        column[row] = null;
        removed = true;
      }
    }
  }
  if (!removed) return;

  if (grid.anchorPaneId === paneId) {
    const next = grid.slots.flat().find((pane): pane is string => Boolean(pane));
    if (!next) {
      dropGrid(tabId);
      return;
    }
    // Cleanup follows a successful close, so a failed probe must not replace
    // that outcome; the grid falls back to `degraded` instead.
    let layout: TabLayout | null = null;
    try {
      layout = readLayout(next);
    } catch {
      layout = null;
    }
    const rebuilt = layout ? slotsFromLayout(layout) : [];
    if (rebuilt.length > 0) {
      bindRebuiltSlots(grid, rebuilt);
      return;
    }
    // Without a readable layout the survivors still work; just stop trusting
    // the recorded geometry.
    grid.slots = [[next]];
    grid.anchorPaneId = next;
    grid.anchorIsParent = false;
    grid.degraded = true;
    return;
  }

  if (!hasAnyPane(grid.slots)) {
    dropGrid(tabId);
  }
}

/**
 * Send a command string to a pane and execute it.
 * `pane run` queues the literal text and Enter together as one submission
 * and stays silent on success (non-zero exit surfaces as an exception).
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execFileSync("herdr", ["pane", "run", surface, command], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids the terminal's canonical line-input limit, which `pane run`
 * enforces on macOS by rejecting over-long submissions before queuing.
 *
 * By default the script is written to a temp directory, but callers can
 * pass a stable path (for example under session artifacts) so the exact
 * invocation is preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

// ── Screen reading ──

function readArgs(surface: string, lines: number): string[] {
  return [
    "pane",
    "read",
    surface,
    "--source",
    "recent-unwrapped",
    "--lines",
    String(Math.max(1, lines)),
    "--format",
    "text",
  ];
}

function extractText(stdout: string): string {
  // `pane read --format text` prints the pane text directly on stdout.
  return stdout;
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return extractText(execFileSync("herdr", readArgs(surface, lines), { encoding: "utf8" }));
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync("herdr", readArgs(surface, lines), {
    encoding: "utf8",
  });
  return extractText(stdout);
}

/**
 * Close a pane and drop it from the layout bookkeeping so the freed slot is
 * reused by the next spawn.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  try {
    execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
  } finally {
    forgetPane(surface);
  }
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write an `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

export const __herdrGridTest__ = {
  reset(): void {
    tabGrids.clear();
    paneTabIndex.clear();
  },
  seed(grid: TabGrid): void {
    tabGrids.set(grid.tabId, grid);
    for (const column of grid.slots) {
      for (const pane of column) if (pane) paneTabIndex.set(pane, grid.tabId);
    }
  },
  tabs(): TabGrid[] {
    return [...tabGrids.values()];
  },
  ownerOf(paneId: string): string | undefined {
    return paneTabIndex.get(paneId);
  },
  forget(paneId: string, readLayout: (paneId: string) => TabLayout | null): void {
    forgetPane(paneId, readLayout);
  },
  reconcile(tabId: string, layout: TabLayout): TabGrid | null {
    const grid = tabGrids.get(tabId);
    return grid ? reconcileGrid(grid, layout) : null;
  },
  slotsFromLayout(layout: TabLayout): string[][] {
    return slotsFromLayout(layout);
  },
  parseLayout(result: Record<string, unknown>): TabLayout {
    return toTabLayout(result);
  },
};

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

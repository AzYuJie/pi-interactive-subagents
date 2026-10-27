/**
 * herdr surface layer — pane primitives over the herdr CLI socket API.
 *
 * Mirrors the contract of tmux.ts: create/split a pane, type a command into
 * it, read its screen, close it, and poll for exit. Keeping the herdr calls
 * isolated here means index.ts stays testable without a multiplexer running.
 *
 * Panes are identified by herdr pane ids (e.g. `w1:p2`). Splits always
 * target the parent pi's pane (`$HERDR_PANE_ID`) so they follow the agent
 * rather than the user's focus. herdr only splits right/down natively; the
 * left/up directions are composed as a split plus a swap with the source.
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

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * so new panes follow the agent rather than the user's focus.
 *
 * Returns the new pane id (e.g. `w1:p2`).
 */
export function createSurface(name: string): string {
  void name; // herdr panes carry display metadata; the pi process inside shows its own title.
  return createSurfaceSplit(name, "right", process.env.HERDR_PANE_ID);
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
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  execFileSync("herdr", ["pane", "close", surface], { encoding: "utf8" });
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

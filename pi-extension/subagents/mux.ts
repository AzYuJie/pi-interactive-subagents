/**
 * Multiplexer dispatch — picks the surface backend at module load.
 *
 * The extension supports one backend per environment: herdr when running
 * inside a herdr-managed pane (`HERDR_ENV=1`), tmux when running inside
 * tmux (`TMUX`). Environment variables are fixed for the process lifetime,
 * so the choice is made once here and every consumer gets the same backend
 * through the same contract the old tmux-only module exposed.
 *
 * shellEscape is backend-independent and lives here.
 */
import * as herdr from "./herdr.ts";
import * as tmux from "./tmux.ts";

type SurfaceBackend = {
  isMuxAvailable: () => boolean;
  muxSetupHint: () => string;
  createSurface: (name: string) => string;
  createSurfaceSplit: (
    name: string,
    direction: "left" | "right" | "up" | "down",
    fromSurface?: string,
  ) => string;
  sendCommand: (surface: string, command: string) => void;
  sendLongCommand: (
    surface: string,
    command: string,
    options?: { scriptPath?: string; scriptPreamble?: string },
  ) => string;
  readScreen: (surface: string, lines?: number) => string;
  readScreenAsync: (surface: string, lines?: number) => Promise<string>;
  closeSurface: (surface: string) => void;
  pollForExit: (
    surface: string,
    signal: AbortSignal,
    options: {
      interval: number;
      sessionFile?: string;
      sentinelFile?: string;
      onTick?: (elapsed: number) => void;
    },
  ) => Promise<herdr.PollResult>;
};

const backend: SurfaceBackend = herdr.isHerdrAvailable() ? herdr : tmux;

/** Name of the active backend, for diagnostics. */
export const muxBackend: "herdr" | "tmux" = backend === herdr ? "herdr" : "tmux";

export const isMuxAvailable = backend.isMuxAvailable;
export const muxSetupHint = backend.muxSetupHint;
export const createSurface = backend.createSurface;
export const createSurfaceSplit = backend.createSurfaceSplit;
export const sendCommand = backend.sendCommand;
export const sendLongCommand = backend.sendLongCommand;
export const readScreen = backend.readScreen;
export const readScreenAsync = backend.readScreenAsync;
export const closeSurface = backend.closeSurface;
export const pollForExit = backend.pollForExit;

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

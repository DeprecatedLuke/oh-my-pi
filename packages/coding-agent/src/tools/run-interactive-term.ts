import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { type Component, matchesKey, padding, Text, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { type Static, Type } from "@sinclair/typebox";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
// @xterm/headless default export is { Terminal }
import xtermModule from "@xterm/headless";
import type { IDisposable, IExitEvent, IPty } from "bun-pty";
import { spawn as spawnPty } from "bun-pty";
import { renderPromptTemplate } from "../config/prompt-templates";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import runInteractiveTermDescription from "../prompts/tools/run-interactive-term.md" with { type: "text" };
import { getStateIcon, renderStatusLine } from "../tui";
import type { ToolSession } from ".";
import type { OutputMeta } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { replaceTabs, wrapBrackets } from "./render-utils";
import { ToolAbortError, ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";
import { DEFAULT_MAX_BYTES, truncateTail } from "./truncate";

const XtermTerminal = (xtermModule as { Terminal?: new (options: object) => XtermTerminalType }).Terminal;

type XtermBufferLine = any; // eslint-disable-line @typescript-eslint/no-explicit-any
type XtermBufferCell = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const runInteractiveTermSchema = Type.Object({
	command: Type.String({ description: "Command to execute" }),
	cwd: Type.Optional(Type.String({ description: "Working directory" })),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional)" })),
	size: Type.Optional(
		Type.Object(
			{
				cols: Type.Optional(Type.Number({ description: "Number of columns" })),
				rows: Type.Optional(Type.Number({ description: "Number of rows" })),
			},
			{ description: "PTY size override (defaults to ~90% of terminal)" },
		),
	),
});

const MAX_TIMEOUT_SECONDS = 3600;
const SCROLLBACK_MAX_LINES = 2000;
const SCREEN_SNAPSHOT_MAX_LINES = 200;
const SCREEN_SNAPSHOT_MAX_BYTES = 40 * 1024;
const CAPTURE_MAX_BYTES = DEFAULT_MAX_BYTES;

type RunInteractiveTermParams = Static<typeof runInteractiveTermSchema>;

interface InteractiveTermExecutionResult {
	exitCode: number | null;
	scrollback: string;
	screenSnapshot: string;
	timedOut: boolean;
	dismissedByUser: boolean;
	scrollbackTruncated: boolean;
	abortedBySignal: boolean;
}

export interface RunInteractiveTermToolDetails {
	exitCode: number | null;
	timedOut: boolean;
	dismissedByUser: boolean;
	scrollbackTruncated: boolean;
	meta?: OutputMeta;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function parseOptionalTimeout(rawTimeout: number | undefined): number | undefined {
	if (rawTimeout === undefined) return undefined;
	if (!Number.isFinite(rawTimeout)) {
		throw new ToolError("timeout must be a finite number");
	}
	if (rawTimeout <= 0) {
		throw new ToolError("timeout must be greater than 0 seconds");
	}
	return clamp(Math.floor(rawTimeout), 1, MAX_TIMEOUT_SECONDS);
}

// ---------------------------------------------------------------------------
// Status label
// ---------------------------------------------------------------------------

function statusIcon(
	uiTheme: Theme,
	state: "running" | "complete" | "timed_out" | "killed",
	exitCode: number | null,
): string {
	if (state === "running") return getStateIcon("running", uiTheme);
	if (state === "timed_out") return getStateIcon("warning", uiTheme);
	if (state === "killed") return getStateIcon("warning", uiTheme);
	if (exitCode === 0) return getStateIcon("success", uiTheme);
	return getStateIcon("error", uiTheme);
}

function statusText(
	uiTheme: Theme,
	state: "running" | "complete" | "timed_out" | "killed",
	exitCode: number | null,
): string {
	if (state === "running") return uiTheme.fg("warning", "running");
	if (state === "timed_out") return uiTheme.fg("warning", "timed out");
	if (state === "killed") return uiTheme.fg("warning", "killed");
	if (exitCode === 0) return uiTheme.fg("success", "exit 0");
	if (exitCode === null) return uiTheme.fg("warning", "exited");
	return uiTheme.fg("error", `exit ${exitCode}`);
}

// ---------------------------------------------------------------------------
// xterm buffer → ANSI string renderer
// ---------------------------------------------------------------------------

function renderBufferLineAnsi(line: XtermBufferLine | undefined, nullCell: XtermBufferCell, width: number): string {
	let out = "\x1b[0m";
	let prevKey = "d";

	for (let x = 0; x < width; ) {
		const cell = line?.getCell ? line.getCell(x, nullCell) : null;
		if (!cell) {
			if (prevKey !== "d") {
				out += "\x1b[0m";
				prevKey = "d";
			}
			out += " ";
			x += 1;
			continue;
		}
		const w = typeof cell.getWidth === "function" ? cell.getWidth() : 1;
		if (w <= 0) {
			x += 1;
			continue;
		}
		if (x + w > width) {
			if (prevKey !== "d") {
				out += "\x1b[0m";
				prevKey = "d";
			}
			out += " ";
			x += 1;
			continue;
		}
		const key = cellStyleKey(cell);
		if (key !== prevKey) {
			out += cellSgr(cell);
			prevKey = key;
		}
		let chars = typeof cell.getChars === "function" ? cell.getChars() : "";
		if (!chars) chars = w > 1 ? " ".repeat(w) : " ";
		if (typeof cell.isInvisible === "function" && cell.isInvisible()) chars = " ".repeat(w);
		out += chars;
		x += w;
	}
	out += "\x1b[0m";
	return out;
}

function cellStyleKey(cell: XtermBufferCell): string {
	if (!cell) return "d";
	if (typeof cell.isAttributeDefault === "function" && cell.isAttributeDefault()) return "d";
	const fgMode = typeof cell.getFgColorMode === "function" ? cell.getFgColorMode() : 0;
	const bgMode = typeof cell.getBgColorMode === "function" ? cell.getBgColorMode() : 0;
	const fg = typeof cell.getFgColor === "function" ? cell.getFgColor() : 0;
	const bg = typeof cell.getBgColor === "function" ? cell.getBgColor() : 0;
	const flags = [
		typeof cell.isBold === "function" && cell.isBold() ? 1 : 0,
		typeof cell.isDim === "function" && cell.isDim() ? 1 : 0,
		typeof cell.isItalic === "function" && cell.isItalic() ? 1 : 0,
		typeof cell.isUnderline === "function" && cell.isUnderline() ? 1 : 0,
		typeof cell.isInverse === "function" && cell.isInverse() ? 1 : 0,
		typeof cell.isStrikethrough === "function" && cell.isStrikethrough() ? 1 : 0,
	].join("");
	return `${fgMode}:${fg}:${bgMode}:${bg}:${flags}`;
}

function cellSgr(cell: XtermBufferCell): string {
	if (!cell) return "\x1b[0m";
	if (typeof cell.isAttributeDefault === "function" && cell.isAttributeDefault()) return "\x1b[0m";
	const codes: string[] = ["0"];
	if (typeof cell.isBold === "function" && cell.isBold()) codes.push("1");
	if (typeof cell.isDim === "function" && cell.isDim()) codes.push("2");
	if (typeof cell.isItalic === "function" && cell.isItalic()) codes.push("3");
	if (typeof cell.isUnderline === "function" && cell.isUnderline()) codes.push("4");
	if (typeof cell.isBlink === "function" && cell.isBlink()) codes.push("5");
	if (typeof cell.isInverse === "function" && cell.isInverse()) codes.push("7");
	if (typeof cell.isStrikethrough === "function" && cell.isStrikethrough()) codes.push("9");
	if (typeof cell.isFgRGB === "function" && cell.isFgRGB()) {
		const c = typeof cell.getFgColor === "function" ? cell.getFgColor() : 0;
		codes.push(`38;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
	} else if (typeof cell.isFgPalette === "function" && cell.isFgPalette()) {
		codes.push(`38;5;${typeof cell.getFgColor === "function" ? cell.getFgColor() : 0}`);
	}
	if (typeof cell.isBgRGB === "function" && cell.isBgRGB()) {
		const c = typeof cell.getBgColor === "function" ? cell.getBgColor() : 0;
		codes.push(`48;2;${(c >> 16) & 0xff};${(c >> 8) & 0xff};${c & 0xff}`);
	} else if (typeof cell.isBgPalette === "function" && cell.isBgPalette()) {
		codes.push(`48;5;${typeof cell.getBgColor === "function" ? cell.getBgColor() : 0}`);
	}
	return `\x1b[${codes.join(";")}m`;
}

// ---------------------------------------------------------------------------
// Overlay component
// ---------------------------------------------------------------------------
class InteractiveTermOverlayComponent implements Component {
	#term: XtermTerminalType;
	#state: "running" | "complete" | "timed_out" | "killed" = "running";
	#exitCode: number | null = null;
	#onInput: (data: string) => void = () => {};
	#onDismiss: () => void = () => {};
	#onDispose: () => void = () => {};

	constructor(
		private readonly command: string,
		private readonly uiTheme: Theme,
		private readonly getTerminalRows: () => number,
		cols: number,
		rows: number,
	) {
		if (!XtermTerminal) {
			throw new ToolError("@xterm/headless Terminal class not found");
		}
		this.#term = new XtermTerminal({
			allowProposedApi: true,
			cols: Math.max(1, cols),
			rows: Math.max(1, rows),
			convertEol: true,
			scrollback: 2000,
		});
	}

	get cols(): number {
		return this.#term.cols;
	}

	get rows(): number {
		return this.#term.rows;
	}

	setInputHandlers(onInput: (data: string) => void, onDismiss: () => void): void {
		this.#onInput = onInput;
		this.#onDismiss = onDismiss;
	}

	setDisposeHandler(handler: () => void): void {
		this.#onDispose = handler;
	}

	appendOutput(chunk: string): void {
		this.#term.write(chunk);
	}

	setComplete(options: { exitCode: number | null; timedOut: boolean; dismissedByUser: boolean }): void {
		this.#exitCode = options.exitCode;
		if (options.timedOut) {
			this.#state = "timed_out";
			return;
		}
		if (options.dismissedByUser) {
			this.#state = "killed";
			return;
		}
		this.#state = "complete";
	}

	getScrollback(maxLines: number): { text: string; truncated: boolean } {
		const buf = this.#term.buffer.active;
		const totalLines = buf.baseY + this.#term.rows;
		const truncated = totalLines > maxLines;
		const startY = Math.max(0, totalLines - maxLines);
		const lines: string[] = [];
		for (let y = startY; y < totalLines; y += 1) {
			const line = buf.getLine(y);
			lines.push(line ? line.translateToString(true).replace(/\s+$/u, "") : "");
		}
		// Trim leading/trailing blank lines
		while (lines.length > 0 && lines[0]?.trim().length === 0) lines.shift();
		while (lines.length > 0 && lines[lines.length - 1]?.trim().length === 0) lines.pop();
		return { text: lines.join("\n"), truncated };
	}

	getSnapshot(maxLines: number): string {
		const lines = this.#getPlainLines(maxLines);
		return lines.join("\n");
	}

	#getPlainLines(maxLines: number): string[] {
		if (maxLines <= 0) return [];
		try {
			const buf = this.#term.buffer.active;
			const lastAbsY = Math.max(0, buf.baseY + this.#term.rows - 1);
			const startAbsY = Math.max(0, lastAbsY - maxLines + 1);
			const out: string[] = [];
			for (let y = startAbsY; y <= lastAbsY; y += 1) {
				const line = buf.getLine(y);
				const text = line ? line.translateToString(true).replace(/\s+$/u, "") : "";
				out.push(text);
			}
			// Trim leading blank lines
			while (out.length > 0 && out[0]?.trim().length === 0) {
				out.shift();
			}
			// Trim trailing blank lines
			while (out.length > 0 && out[out.length - 1]?.trim().length === 0) {
				out.pop();
			}
			return out.slice(-maxLines);
		} catch {
			return [];
		}
	}

	resize(cols: number, rows: number): void {
		this.#term.resize(Math.max(1, cols), Math.max(1, rows));
	}

	/**
	 * Flush pending xterm writes, then invoke callback.
	 *
	 * **Workaround for bun-pty / xterm-headless timing mismatch:**
	 *
	 * bun-pty's read loop (`_startReadLoop`) is a tight `while` loop over a
	 * synchronous FFI `bun_pty_read` call.  When the child process exits the
	 * loop fires `onData` (with the last chunk) and `onExit` in the *same*
	 * microtask — there is no `await` between a `n > 0` read and the
	 * subsequent `n === -2` (CHILD_EXITED) read.
	 *
	 * Meanwhile `@xterm/headless`'s `Terminal.write()` is *asynchronous*: it
	 * pushes data into an internal write buffer and schedules parsing via
	 * `setTimeout`.  So by the time `onExit` fires the final payload (e.g.
	 * `"root\n"` from `sudo whoami`) is still queued — reading
	 * `buffer.active` at that point returns stale content.
	 *
	 * `terminal.write("", callback)` enqueues an empty write whose callback
	 * is guaranteed to fire *after* all previously queued data has been
	 * parsed, giving us a reliable synchronisation point.
	 */
	flush(callback: () => void): void {
		this.#term.write("", callback);
	}

	// -- Box drawing --------------------------------------------------------

	#boxLine(line: string, innerWidth: number): string {
		const border = this.uiTheme.fg("border", this.uiTheme.boxSharp.vertical);
		const fill = Math.max(0, innerWidth - visibleWidth(line));
		return `${border}${line}${padding(fill)}${border}`;
	}

	#header(innerWidth: number): string {
		const icon = statusIcon(this.uiTheme, this.#state, this.#exitCode);
		const title = this.uiTheme.fg("accent", "InteractiveTerm");
		const status = statusText(this.uiTheme, this.#state, this.#exitCode);
		const statusBadge = this.uiTheme.fg("dim", wrapBrackets(status, this.uiTheme));
		const prefix = `${icon} ${title} `;
		const suffix = ` ${statusBadge}`;
		const available = Math.max(1, innerWidth - visibleWidth(prefix) - visibleWidth(suffix));
		const cmd = truncateToWidth(this.uiTheme.fg("muted", replaceTabs(this.command)), available);
		return truncateToWidth(`${prefix}${cmd}${suffix}`, innerWidth);
	}

	#footer(innerWidth: number): string {
		if (this.#state === "running") {
			const esc = this.uiTheme.fg("warning", "esc");
			const hint = this.uiTheme.fg("dim", "force-kill");
			const sep = this.uiTheme.fg("dim", " · ");
			const input = this.uiTheme.fg("dim", "input forwarded to PTY");
			return truncateToWidth(`${esc} ${hint}${sep}${input}`, innerWidth);
		}
		return truncateToWidth(this.uiTheme.fg("dim", "session finished"), innerWidth);
	}

	handleInput(data: string): void {
		if (this.#state === "running" && (matchesKey(data, "escape") || matchesKey(data, "esc"))) {
			this.#onDismiss();
			return;
		}
		if (this.#state !== "running") {
			return;
		}
		this.#onInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const innerWidth = Math.max(1, safeWidth - 2);
		const maxOverlayRows = Math.max(5, Math.floor(this.getTerminalRows() * 0.8));
		const chromeRows = 4; // top border + header + footer + bottom border
		const maxContentRows = Math.max(1, maxOverlayRows - chromeRows);

		// Render xterm buffer cells with ANSI color preservation
		const buf = this.#term.buffer.active;
		const startY = buf.viewportY;
		const nullCell = buf.getNullCell();
		const contentRows = Math.min(maxContentRows, this.#term.rows);

		const content: string[] = [];
		for (let row = 0; row < contentRows; row++) {
			const line = buf.getLine(startY + row);
			content.push(renderBufferLineAnsi(line, nullCell, innerWidth));
		}
		if (content.length === 0) {
			content.push(padding(innerWidth));
		}

		const border = this.uiTheme.fg("border", this.uiTheme.boxSharp.horizontal.repeat(innerWidth));
		const top = `${this.uiTheme.fg("border", this.uiTheme.boxSharp.topLeft)}${border}${this.uiTheme.fg("border", this.uiTheme.boxSharp.topRight)}`;
		const bottom = `${this.uiTheme.fg("border", this.uiTheme.boxSharp.bottomLeft)}${border}${this.uiTheme.fg("border", this.uiTheme.boxSharp.bottomRight)}`;
		return [
			top,
			this.#boxLine(this.#header(innerWidth), innerWidth),
			...content.map(line => this.#boxLine(line, innerWidth)),
			this.#boxLine(this.#footer(innerWidth), innerWidth),
			bottom,
		];
	}

	invalidate(): void {}

	dispose(): void {
		this.#term.dispose();
		this.#onDispose();
	}
}

// ---------------------------------------------------------------------------
// Response formatting
// ---------------------------------------------------------------------------

function formatInteractiveTermResponse(result: InteractiveTermExecutionResult): string {
	const lines: string[] = [
		`Exit code: ${result.exitCode === null ? "null" : result.exitCode}`,
		`Timed out: ${result.timedOut ? "true" : "false"}`,
		`Dismissed by user: ${result.dismissedByUser ? "true" : "false"}`,
	];
	if (result.scrollbackTruncated) {
		lines.push("Output truncated: true");
	}
	lines.push("", "Captured stdout:", result.scrollback.length > 0 ? result.scrollback : "(no stdout captured)");
	lines.push(
		"",
		"Final screen snapshot:",
		result.screenSnapshot.length > 0 ? result.screenSnapshot : "(empty screen)",
	);
	return lines.join("\n");
}

function formatCommandForCall(command: string, cwd: string | undefined): string {
	if (!cwd) {
		return `$ ${command}`;
	}
	const currentCwd = process.cwd();
	const resolvedCurrent = path.resolve(currentCwd);
	const resolvedTarget = path.resolve(cwd);
	if (resolvedCurrent === resolvedTarget) {
		return `$ ${command}`;
	}
	const relativePath = path.relative(resolvedCurrent, resolvedTarget);
	const isWithinCurrent =
		relativePath.length > 0 && !relativePath.startsWith("..") && !relativePath.startsWith(`..${path.sep}`);
	if (isWithinCurrent) {
		return `$ cd ${relativePath} && ${command}`;
	}
	return `$ cd ${cwd} && ${command}`;
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export class RunInteractiveTermTool
	implements AgentTool<typeof runInteractiveTermSchema, RunInteractiveTermToolDetails>
{
	readonly name = "run_interactive_term";
	readonly label = "InteractiveTerm";
	readonly description: string;
	readonly parameters = runInteractiveTermSchema;
	readonly concurrency = "exclusive";

	constructor(private readonly session: ToolSession) {
		this.description = renderPromptTemplate(runInteractiveTermDescription);
	}

	static createIf(session: ToolSession): RunInteractiveTermTool | null {
		return session.hasUI ? new RunInteractiveTermTool(session) : null;
	}

	async execute(
		_toolCallId: string,
		{ command, cwd, timeout: rawTimeout, size }: RunInteractiveTermParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RunInteractiveTermToolDetails>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<RunInteractiveTermToolDetails>> {
		if (!context?.hasUI || !context.ui) {
			throw new ToolError("run_interactive_term requires interactive mode");
		}
		if (process.platform === "win32") {
			throw new ToolError("run_interactive_term is not supported on Windows");
		}

		const resolvedCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : this.session.cwd;
		let cwdStat: fs.Stats;
		try {
			cwdStat = await fs.promises.stat(resolvedCwd);
		} catch (err) {
			if (isEnoent(err)) {
				throw new ToolError(`Working directory does not exist: ${resolvedCwd}`);
			}
			throw err;
		}
		if (!cwdStat.isDirectory()) {
			throw new ToolError(`Working directory is not a directory: ${resolvedCwd}`);
		}

		const timeoutSeconds = parseOptionalTimeout(rawTimeout);
		const timeoutMs = timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000;

		const execution = await context.ui.custom<InteractiveTermExecutionResult>(
			(tui, uiTheme, _keybindings, done) => {
				// PTY size: user override clamped to terminal bounds, else ~90% of terminal
				const maxCols = Math.max(20, tui.terminal.columns - 2);
				const maxRows = Math.max(5, tui.terminal.rows - 4);
				const initialCols = size?.cols
					? clamp(size.cols, 20, maxCols)
					: Math.max(20, Math.floor(tui.terminal.columns * 0.9) - 2);
				const initialRows = size?.rows
					? clamp(size.rows, 5, maxRows)
					: Math.max(5, Math.floor(tui.terminal.rows * 0.8) - 4);

				const component = new InteractiveTermOverlayComponent(
					command,
					uiTheme,
					() => tui.terminal.rows,
					initialCols,
					initialRows,
				);

				let dismissedByUser = false;
				let timedOut = false;
				let finished = false;
				let pty: IPty | null = null;
				const disposables: IDisposable[] = [];

				const finish = (result: InteractiveTermExecutionResult) => {
					if (finished) return;
					finished = true;
					for (const d of disposables.splice(0)) {
						try {
							d.dispose();
						} catch {
							// ignore
						}
					}
					done(result);
				};

				const killPty = (sig = "SIGTERM") => {
					if (!pty) return;
					try {
						pty.kill(sig);
					} catch {
						// ignore — already exited
					}
					pty = null;
				};

				// Build env — strip variables that interfere with the child PTY
				const env: Record<string, string> = {};
				for (const [k, v] of Object.entries(Bun.env)) {
					if (typeof v === "string") env[k] = v;
				}
				env.TERM = env.TERM ?? "xterm-256color";

				try {
					pty = spawnPty("sh", ["-lc", command], {
						name: env.TERM,
						cwd: resolvedCwd,
						env,
						cols: initialCols,
						rows: initialRows,
					});
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					finish({
						exitCode: null,
						scrollback: `Failed to spawn PTY: ${msg}`,
						screenSnapshot: "",
						timedOut: false,
						dismissedByUser: false,
						scrollbackTruncated: false,
						abortedBySignal: false,
					});
					component.appendOutput(`\nFailed to spawn PTY: ${msg}\n`);
					component.setComplete({ exitCode: null, timedOut: false, dismissedByUser: false });
					tui.requestRender();
					return component;
				}

				// Wire PTY output → component + capture
				disposables.push(
					pty.onData(data => {
						component.appendOutput(data);
						tui.requestRender();
					}),
				);

				// Wire PTY exit
				// NOTE: bun-pty fires onData and onExit in the same microtask (no await
				// between reads in the read loop). xterm.write() is async — it queues
				// data for batch processing via setTimeout. So the final onData payload
				// (e.g. "root\n" from sudo whoami) may not have been parsed into the
				// xterm buffer by the time onExit fires. Flush the xterm write queue
				// before reading the buffer to capture all output.
				disposables.push(
					pty.onExit((e: IExitEvent) => {
						const exitCode = timedOut ? null : e.exitCode;
						const abortedBySignal = signal?.aborted === true && !dismissedByUser && !timedOut;
						component.setComplete({ exitCode, timedOut, dismissedByUser });
						tui.requestRender();
						component.flush(() => {
							if (finished) return;
							const snapshot = truncateTail(component.getSnapshot(SCREEN_SNAPSHOT_MAX_LINES), {
								maxLines: SCREEN_SNAPSHOT_MAX_LINES,
								maxBytes: SCREEN_SNAPSHOT_MAX_BYTES,
							}).content;
							const sb = component.getScrollback(SCROLLBACK_MAX_LINES);
							finish({
								exitCode,
								scrollback: truncateTail(sb.text, { maxBytes: CAPTURE_MAX_BYTES }).content,
								screenSnapshot: snapshot,
								timedOut,
								dismissedByUser,
								scrollbackTruncated: sb.truncated,
								abortedBySignal,
							});
						});
					}),
				);

				// Input: forward keystrokes to PTY
				component.setInputHandlers(
					data => {
						if (!pty) return;
						try {
							pty.write(data);
						} catch {
							// ignore writes after exit
						}
					},
					() => {
						if (dismissedByUser) return;
						dismissedByUser = true;
						killPty("SIGKILL");
					},
				);
				component.setDisposeHandler(() => {
					killPty("SIGKILL");
				});

				// Timeout
				let timeoutTimer: Timer | undefined;
				if (timeoutMs !== undefined) {
					timeoutTimer = setTimeout(() => {
						if (finished) return;
						timedOut = true;
						killPty("SIGKILL");
						// killPty fires onExit synchronously, which sees timedOut=true
						// and flushes xterm before capturing output
					}, timeoutMs);
					disposables.push({ dispose: () => clearTimeout(timeoutTimer) });
				}

				// External abort signal
				if (signal) {
					const onAbort = () => {
						if (finished) return;
						killPty("SIGKILL");
					};
					signal.addEventListener("abort", onAbort, { once: true });
					disposables.push({ dispose: () => signal.removeEventListener("abort", onAbort) });
				}

				return component;
			},
			{ overlay: true },
		);

		if (execution.abortedBySignal) {
			throw new ToolAbortError("Interactive terminal aborted.");
		}

		const details: RunInteractiveTermToolDetails = {
			exitCode: execution.exitCode,
			timedOut: execution.timedOut,
			dismissedByUser: execution.dismissedByUser,
			scrollbackTruncated: execution.scrollbackTruncated,
		};
		return toolResult(details).text(formatInteractiveTermResponse(execution)).done();
	}
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

interface RunInteractiveTermRenderArgs {
	command?: string;
	cwd?: string;
	timeout?: number;
	size?: { cols?: number; rows?: number };
}

export const runInteractiveTermToolRenderer = {
	renderCall(args: RunInteractiveTermRenderArgs, uiTheme: Theme): Component {
		const command = args.command ?? "…";
		const description = formatCommandForCall(command, args.cwd);
		const text = renderStatusLine({ icon: "pending", title: "InteractiveTerm", description }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: RunInteractiveTermToolDetails;
			isError?: boolean;
		},
		_options: RenderResultOptions,
		uiTheme: Theme,
		args?: RunInteractiveTermRenderArgs,
	): Component {
		const details = result.details;
		const nonZeroExit = details?.exitCode !== null && details?.exitCode !== 0;
		const isWarning = nonZeroExit || details?.timedOut || details?.dismissedByUser;
		const header = renderStatusLine(
			{ icon: result.isError ? "error" : isWarning ? "warning" : "success", title: "InteractiveTerm" },
			uiTheme,
		);
		const lines: string[] = [header];
		if (args?.command) {
			lines.push(uiTheme.fg("dim", formatCommandForCall(args.command, args.cwd)));
		}
		const body = result.content.find(item => item.type === "text")?.text ?? "";
		if (body.length > 0) {
			lines.push(...body.split("\n").map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
		}
		return new Text(lines.join("\n"), 0, 0);
	},
	mergeCallAndResult: true,
	inline: true,
};

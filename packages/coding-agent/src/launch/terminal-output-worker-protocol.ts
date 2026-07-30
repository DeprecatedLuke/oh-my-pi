import type { TerminalOutputOptions } from "./terminal-output";

/** Hidden CLI selector for legacy PTY replay outside the client process. */
export const TERMINAL_OUTPUT_WORKER_ARG = "__omp_worker_terminal_output";

export interface TerminalOutputWorkerRequest {
	type: "render";
	id: string;
	output: string;
	options: TerminalOutputOptions;
}

export type TerminalOutputWorkerResult =
	| { type: "result"; id: string; rows: string[] | undefined }
	| { type: "error"; id: string; error: string };

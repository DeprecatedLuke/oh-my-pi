import { withTimeout } from "@oh-my-pi/pi-utils";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import type { TerminalOutputOptions } from "./terminal-output";
import {
	TERMINAL_OUTPUT_WORKER_ARG,
	type TerminalOutputWorkerRequest,
	type TerminalOutputWorkerResult,
} from "./terminal-output-worker-protocol";

const TERMINAL_OUTPUT_TIMEOUT_MS = 30_000;

/** Replay legacy broker PTY bytes in a child process, never in the client address space. */
export async function renderTerminalOutputIsolated(
	output: string,
	options: TerminalOutputOptions,
): Promise<string[] | undefined> {
	const spawned = createWorkerSubprocess<TerminalOutputWorkerResult>({
		spawnCommand: resolveWorkerSpawnCmd(TERMINAL_OUTPUT_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "terminal output subprocess",
		reportCleanExit: true,
		unref: false,
	});
	const worker = createWorkerHandle<TerminalOutputWorkerRequest, TerminalOutputWorkerResult>(spawned, message =>
		safeSend(spawned.proc, message, "terminal-output"),
	);
	const id = "render";
	const pending = Promise.withResolvers<string[] | undefined>();
	const unsubscribeMessage = worker.onMessage(message => {
		if (message.id !== id) return;
		if (message.type === "result") pending.resolve(message.rows);
		else pending.reject(new Error(message.error));
	});
	const unsubscribeError = worker.onError(error => pending.reject(error));
	try {
		worker.send({ type: "render", id, output, options });
		return await withTimeout(
			pending.promise,
			TERMINAL_OUTPUT_TIMEOUT_MS,
			"Timed out replaying launch terminal output",
		);
	} finally {
		unsubscribeMessage();
		unsubscribeError();
		await worker.terminate();
	}
}

/** Distribution smoke for source, npm-bundle, and compiled worker routing. */
export async function smokeTestTerminalOutputWorker(): Promise<void> {
	const rows = await renderTerminalOutputIsolated("old\r\x1b[2K\x1b[1;32mready\x1b[0m", {
		head: false,
		maxRows: 10,
	});
	if (rows?.length !== 1 || rows[0] !== "\x1b[0m\x1b[1;38;5;2mready") {
		throw new Error("terminal output worker smoke mismatch");
	}
}

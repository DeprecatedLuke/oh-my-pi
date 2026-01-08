import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { nanoid } from "nanoid";
import stripAnsi from "strip-ansi";
import { killProcessTree, sanitizeBinaryOutput } from "../../utils/shell";
import { logger } from "../logger";
import { DEFAULT_MAX_BYTES, truncateTail } from "../tools/truncate";
import { ScopeSignal } from "../utils";
import { buildRemoteCommand, ensureConnection, ensureHostInfo, type SSHConnectionTarget } from "./connection-manager";
import { hasSshfs, mountRemote } from "./sshfs-mount";

export interface SSHExecutorOptions {
	/** Timeout in milliseconds */
	timeout?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Remote path to mount when sshfs is available */
	remotePath?: string;
	/** Wrap commands in a POSIX shell for compat mode */
	compatEnabled?: boolean;
}

export interface SSHResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

function createSanitizer(): TransformStream<Uint8Array, string> {
	const decoder = new TextDecoder();
	return new TransformStream({
		transform(chunk, controller) {
			const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(chunk, { stream: true }))).replace(/\r/g, "");
			controller.enqueue(text);
		},
	});
}

function createOutputSink(
	spillThreshold: number,
	maxBuffer: number,
	onChunk?: (text: string) => void,
): WritableStream<string> & {
	dump: (annotation?: string) => { output: string; truncated: boolean; fullOutputPath?: string };
} {
	const chunks: string[] = [];
	let chunkBytes = 0;
	let totalBytes = 0;
	let fullOutputPath: string | undefined;
	let fullOutputStream: WriteStream | undefined;

	const sink = new WritableStream<string>({
		write(text) {
			totalBytes += text.length;

			if (totalBytes > spillThreshold && !fullOutputPath) {
				fullOutputPath = join(tmpdir(), `omp-${nanoid()}.buffer`);
				const ts = createWriteStream(fullOutputPath);
				chunks.forEach((c) => {
					ts.write(c);
				});
				fullOutputStream = ts;
			}
			fullOutputStream?.write(text);

			chunks.push(text);
			chunkBytes += text.length;
			while (chunkBytes > maxBuffer && chunks.length > 1) {
				chunkBytes -= chunks.shift()!.length;
			}

			onChunk?.(text);
		},
		close() {
			fullOutputStream?.end();
		},
	});

	return Object.assign(sink, {
		dump(annotation?: string) {
			if (annotation) {
				chunks.push(`\n\n${annotation}`);
			}
			const full = chunks.join("");
			const { content, truncated } = truncateTail(full);
			return { output: truncated ? content : full, truncated, fullOutputPath };
		},
	});
}

function quoteForCompatShell(command: string): string {
	if (command.length === 0) {
		return "''";
	}
	const escaped = command.replace(/'/g, "'\\''");
	return `'${escaped}'`;
}

function buildCompatCommand(shell: "bash" | "sh", command: string): string {
	return `${shell} -c ${quoteForCompatShell(command)}`;
}

export async function executeSSH(
	host: SSHConnectionTarget,
	command: string,
	options?: SSHExecutorOptions,
): Promise<SSHResult> {
	await ensureConnection(host);
	if (hasSshfs()) {
		try {
			await mountRemote(host, options?.remotePath ?? "/");
		} catch (err) {
			logger.warn("SSHFS mount failed", { host: host.name, error: String(err) });
		}
	}

	using signal = new ScopeSignal(options);

	let resolvedCommand = command;
	if (options?.compatEnabled) {
		const info = await ensureHostInfo(host);
		if (info.compatShell) {
			resolvedCommand = buildCompatCommand(info.compatShell, command);
		} else {
			logger.warn("SSH compat enabled without detected compat shell", { host: host.name });
		}
	}
	const child: Subprocess = Bun.spawn(["ssh", ...buildRemoteCommand(host, resolvedCommand)], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	signal.catch(() => {
		killProcessTree(child.pid);
	});

	const sink = createOutputSink(DEFAULT_MAX_BYTES, DEFAULT_MAX_BYTES * 2, options?.onChunk);

	const writer = sink.getWriter();
	try {
		async function pumpStream(readable: ReadableStream<Uint8Array>) {
			const reader = readable.pipeThrough(createSanitizer()).getReader();
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					await writer.write(value);
				}
			} finally {
				reader.releaseLock();
			}
		}
		await Promise.all([
			pumpStream(child.stdout as ReadableStream<Uint8Array>),
			pumpStream(child.stderr as ReadableStream<Uint8Array>),
		]);
	} finally {
		await writer.close();
	}

	const exitCode = await child.exited;
	const cancelled = exitCode === null || (exitCode !== 0 && (options?.signal?.aborted ?? false));

	if (signal.timedOut()) {
		const secs = Math.round(options!.timeout! / 1000);
		return {
			exitCode: undefined,
			cancelled: true,
			...sink.dump(`SSH command timed out after ${secs} seconds`),
		};
	}

	return {
		exitCode: cancelled ? undefined : exitCode,
		cancelled,
		...sink.dump(),
	};
}

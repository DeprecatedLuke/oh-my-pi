import { renderTerminalOutput } from "./terminal-output";
import type { TerminalOutputWorkerRequest, TerminalOutputWorkerResult } from "./terminal-output-worker-protocol";

function isTerminalOutputWorkerRequest(value: unknown): value is TerminalOutputWorkerRequest {
	if (!value || typeof value !== "object") return false;
	if (!("type" in value) || value.type !== "render") return false;
	if (!("id" in value) || typeof value.id !== "string") return false;
	if (!("output" in value) || typeof value.output !== "string") return false;
	if (!("options" in value) || !value.options || typeof value.options !== "object") return false;
	const options = value.options;
	return (
		"head" in options &&
		typeof options.head === "boolean" &&
		"maxRows" in options &&
		typeof options.maxRows === "number"
	);
}

export function startTerminalOutputWorker(transport: {
	sendAndFlush(message: TerminalOutputWorkerResult): Promise<void>;
	onMessage(handler: (message: unknown) => void): () => void;
}): void {
	transport.onMessage(message => {
		void (async () => {
			if (!isTerminalOutputWorkerRequest(message)) {
				const id =
					message && typeof message === "object" && "id" in message && typeof message.id === "string"
						? message.id
						: "";
				await transport.sendAndFlush({ type: "error", id, error: "terminal-output-worker: invalid request" });
				return;
			}
			try {
				const rows = await renderTerminalOutput(message.output, message.options);
				await transport.sendAndFlush({ type: "result", id: message.id, rows });
			} catch (error) {
				await transport.sendAndFlush({
					type: "error",
					id: message.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	});
}

import { Agent, type AgentMessage, type AgentOptions } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { commitKnowledgeFiles } from "./commit-knowledge";
import type { SessionEntry, SessionMessageEntry } from "./session-entries";

export const KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE = "knowledge-auto-update";

export interface SessionKnowledgeSource {
	/** Primary session messages after the latest automatic-update marker. */
	messages: SessionMessageEntry[];
	/** Positive finite non-cached assistant work tokens (`input + output + cacheWrite`) in {@link messages}; cache reads and `totalTokens` are excluded. */
	totalTokens: number;
}

/** Return positive finite provider work that was not replayed from the prompt cache. */
function getNonCachedAssistantWorkTokens(message: AgentMessage): number {
	if (message.role !== "assistant") return 0;
	const usage = message.usage;
	const tokens = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
	return Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
}

/**
 * Collect the unprocessed primary session messages and their non-cached provider-work total.
 *
 * A completion marker may be appended after newer messages arrive while a
 * distill runs; its `throughEntryId` therefore defines the real boundary.
 * A referenced marker whose boundary is absent from the scanned branch — a
 * stale or malformed cross-branch watermark — is ignored rather than treated
 * as a reset, so pending source is never erased. Plain markers retain the
 * historical "everything after marker" behavior.
 */
export function collectKnowledgeAutoUpdateSource(entries: SessionEntry[]): SessionKnowledgeSource {
	const messages: SessionMessageEntry[] = [];
	let totalTokens = 0;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === KNOWLEDGE_AUTO_UPDATE_CUSTOM_TYPE) {
			const markerData = entry.data;
			const throughEntryId =
				markerData !== null &&
				typeof markerData === "object" &&
				"throughEntryId" in markerData &&
				typeof markerData.throughEntryId === "string"
					? markerData.throughEntryId
					: undefined;
			if (throughEntryId !== undefined) {
				let boundaryIndex = -1;
				for (let index = messages.length - 1; index >= 0; index--) {
					if (messages[index].id === throughEntryId) {
						boundaryIndex = index;
						break;
					}
				}
				if (boundaryIndex >= 0) {
					let removedTokens = 0;
					for (let index = 0; index <= boundaryIndex; index++) {
						removedTokens += getNonCachedAssistantWorkTokens(messages[index].message);
					}
					const retainedCount = messages.length - boundaryIndex - 1;
					if (retainedCount > 0) messages.copyWithin(0, boundaryIndex + 1);
					messages.length = retainedCount;
					totalTokens -= removedTokens;
				}
				// A referenced marker whose boundary is absent from the scanned
				// branch is stale or malformed (e.g. a cross-branch watermark):
				// ignore it instead of clearing pending source.
			} else {
				// Plain legacy marker: reset at its physical position.
				messages.length = 0;
				totalTokens = 0;
			}
			continue;
		}
		if (entry.type !== "message") continue;
		messages.push(entry);
		totalTokens += getNonCachedAssistantWorkTokens(entry.message);
	}
	return { messages, totalTokens };
}

/**
 * Everything required to drive one headless knowledge pass.
 *
 * `agent` mirrors the originating session's request shape so the provider
 * prompt-cache prefix stays warm and secrets round-trip: it carries the seeded
 * `initialState` (systemPrompt + full converted message history + model + the
 * SAME tool instances the parent sent), the parent `streamFn`/`getApiKey`/
 * `convertToLlm`, the outbound `transformProviderContext` (secret mask) and
 * inbound `transformToolCallArguments` (secret de-mask), the
 * `sessionId`/`promptCacheKey`/`providerSessionState` cache keys, and the
 * thinking/temperature config.
 *
 * `agent.getToolContext` is the BASE per-call tool context (e.g. the session's
 * `ToolContextStore.getContext`).
 */
export interface RunSessionKnowledgeAgentConfig {
	/** Working directory whose `.omp/knowledge` subtree is updated and committed. */
	cwd: string;
	/** Human label recorded on the knowledge commit and in debug logs. */
	sourceTitle: string;
	/** Developer instruction appended as the final turn that drives the pass (save vs compact). */
	instruction: string;
	/** Aborts both the agent loop and the commit. */
	signal?: AbortSignal;
	/**
	 * Commit the knowledge subtree after the pass (default `true`). Set `false`
	 * when an outer flow captures the edits as a native patch and owns the
	 * commit — the agent then writes `.omp/knowledge` but leaves it staged for
	 * the caller.
	 */
	commit?: boolean;
	/** Agent options cloned from the parent session. */
	agent: AgentOptions;
	/** Static request metadata forwarded to the provider (e.g. Anthropic session attribution). */
	metadata?: Record<string, unknown>;
}

export interface RunSessionKnowledgeAgentResult {
	committed: boolean;
	/** True when the headless agent pass completed without abort or failure. */
	completed: boolean;
	/** Abbreviated SHA of the knowledge commit, when one was made. */
	sha?: string;
}

/**
 * Run a real headless agent loop that edits `.omp/knowledge/**` through the
 * `read`/`write`/`edit` tools on `knowledge://` URLs, then commits ONLY the
 * knowledge subtree.
 *
 * The loop appends a developer instruction to the seeded session context and
 * runs to turn-end (the model stops calling tools). Designed for fire-and-forget
 * callers: it NEVER throws — any failure or abort surfaces as
 * `{ committed: false, completed: false }`.
 */
export async function runSessionKnowledgeAgent(
	config: RunSessionKnowledgeAgentConfig,
): Promise<RunSessionKnowledgeAgentResult> {
	const { cwd, sourceTitle, signal } = config;
	if (signal?.aborted) return { committed: false, completed: false };

	const seededMessages = config.agent.initialState?.messages ?? [];

	const agent = new Agent({
		...config.agent,
	});
	// Static metadata already resolved for this provider by the caller; setting
	// it clears any inherited resolver, which is correct for a one-shot pass.
	if (config.metadata) agent.metadata = config.metadata;

	const onAbort = () => agent.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const instruction: Message = {
			role: "developer",
			content: [{ type: "text", text: config.instruction }],
			attribution: "agent",
			timestamp: Date.now(),
		};
		logger.debug("Session knowledge update started", { sourceTitle, messageCount: seededMessages.length });
		await agent.prompt(instruction);
		await agent.waitForIdle();
		if (signal?.aborted) return { committed: false, completed: false };
		// Provider, agent, or tool failures can resolve `prompt` normally instead
		// of throwing: stream failures surface through `agent.state.error` and/or
		// a terminal assistant `stopReason: "error"`, while tool failures append
		// a `toolResult` with `isError: true`. Treat any as an incomplete pass —
		// never report `completed: true` for it.
		let terminalAssistant: AssistantMessage | undefined;
		let hasFailedToolResult = false;
		const runMessages = agent.state.messages;
		for (let index = seededMessages.length; index < runMessages.length; index++) {
			const message = runMessages[index];
			if (message.role === "assistant") {
				terminalAssistant = message;
			} else if (message.role === "toolResult" && message.isError === true) {
				hasFailedToolResult = true;
			}
		}
		if (agent.state.error || terminalAssistant?.stopReason === "error" || hasFailedToolResult) {
			return { committed: false, completed: false };
		}

		// Patch-based callers capture the written edits themselves and own the
		// commit; the agent only writes the subtree here.
		if (config.commit === false) return { committed: false, completed: true };

		const result = await commitKnowledgeFiles(cwd, { sourceTitle, signal });
		logger.debug("Session knowledge update complete", {
			sourceTitle,
			committed: result.committed,
			sha: result.sha,
			reason: result.reason,
		});
		return { committed: result.committed, completed: true, sha: result.sha };
	} catch (error) {
		if (signal?.aborted) return { committed: false, completed: false };
		logger.debug("Failed to update session knowledge", {
			sourceTitle,
			error: error instanceof Error ? error.message : String(error),
		});
		return { committed: false, completed: false };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

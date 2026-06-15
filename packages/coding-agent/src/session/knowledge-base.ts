import { Agent, type AgentOptions, type AgentToolContext, type ToolCallContext } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { commitKnowledgeFiles } from "./commit-knowledge";

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
 * `ToolContextStore.getContext`). The loop wraps it non-mutatingly to force
 * `canWriteKnowledge: true`, so the shared tool instances may write
 * `.omp/knowledge` for the duration of this pass only.
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
	/** Agent options cloned from the parent session. Its `getToolContext` is the base context the loop layers `canWriteKnowledge` onto. */
	agent: AgentOptions;
	/** Static request metadata forwarded to the provider (e.g. Anthropic session attribution). */
	metadata?: Record<string, unknown>;
}

export interface RunSessionKnowledgeAgentResult {
	committed: boolean;
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
 * `{ committed: false }`.
 */
export async function runSessionKnowledgeAgent(
	config: RunSessionKnowledgeAgentConfig,
): Promise<RunSessionKnowledgeAgentResult> {
	const { cwd, sourceTitle, signal } = config;
	if (signal?.aborted) return { committed: false };

	const seededMessages = config.agent.initialState?.messages ?? [];

	const baseGetToolContext = config.agent.getToolContext;
	const agent = new Agent({
		...config.agent,
		// Force write capability for the SAME tool instances during this pass
		// only, non-mutatingly per call so the parent session's shared tool
		// context is never flipped writable underneath it.
		getToolContext: (toolCall?: ToolCallContext): AgentToolContext =>
			({ ...baseGetToolContext?.(toolCall), canWriteKnowledge: true }) as AgentToolContext,
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
		if (signal?.aborted) return { committed: false };

		const result = await commitKnowledgeFiles(cwd, { sourceTitle, signal });
		logger.debug("Session knowledge update complete", {
			sourceTitle,
			committed: result.committed,
			sha: result.sha,
			reason: result.reason,
		});
		return { committed: result.committed, sha: result.sha };
	} catch (error) {
		if (signal?.aborted) return { committed: false };
		logger.debug("Failed to update session knowledge", {
			sourceTitle,
			error: error instanceof Error ? error.message : String(error),
		});
		return { committed: false };
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

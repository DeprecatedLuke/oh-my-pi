/**
 * In-process benchmark client.
 *
 * Replaces RpcClient subprocess spawning with direct AgentSession usage.
 * Eliminates ~2-3s CLI startup overhead per task by creating sessions
 * in-process and sharing auth/model infrastructure across tasks.
 */
import type { AgentEvent, AgentMessage, ResolvedThinkingLevel, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { AgentSession, AgentSessionEvent, AuthStorage, SessionStats } from "@oh-my-pi/pi-coding-agent";
import {
	AgentRegistry,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	SessionManager,
	Settings,
} from "@oh-my-pi/pi-coding-agent";

export type InProcessEventListener = (event: AgentEvent) => void;

export interface InProcessClientOptions {
	cwd: string;
	model: string;
	/** Extra system prompt to append */
	appendSystemPrompt?: string;
	/** Tool names to enable */
	tools?: string[];
	/** Edit tool settings (passed via Settings, not env vars) */
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
	/** Shared infra (pass to avoid re-discovery per task) */
	shared?: SharedInfra;
}

/** Shared infrastructure that can be reused across tasks. */
export interface SharedInfra {
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
}

export interface DiscoverSharedInfraOptions {
	cwd?: string;
	editVariant?: string;
	editFuzzy?: boolean | "auto";
	editFuzzyThreshold?: number | "auto";
}

/** Discover shared infrastructure once for the entire benchmark run. */
export async function discoverSharedInfra(options: DiscoverSharedInfraOptions = {}): Promise<SharedInfra> {
	const authStorage = await discoverAuthStorage();
	try {
		const modelRegistry = new ModelRegistry(authStorage);

		// Initialize global Settings singleton (required by code paths that use the global `settings` proxy)
		const overrides: Record<string, unknown> = { "advisor.enabled": false };
		if (options.editVariant && options.editVariant !== "auto") {
			overrides["edit.mode"] = options.editVariant;
		}
		if (options.editFuzzy !== undefined && options.editFuzzy !== "auto") {
			overrides["edit.fuzzyMatch"] = options.editFuzzy;
		}
		if (options.editFuzzyThreshold !== undefined && options.editFuzzyThreshold !== "auto") {
			overrides["edit.fuzzyThreshold"] = options.editFuzzyThreshold;
		}
		await Settings.init({ cwd: options.cwd, overrides });

		return { authStorage, modelRegistry };
	} catch (error) {
		authStorage.close();
		throw error;
	}
}

/**
 * In-process client that wraps AgentSession with the same interface
 * that the benchmark runner expects from RpcClient.
 */
export class InProcessClient {
	#session: AgentSession | null = null;
	#sessionResult: CreateAgentSessionResult | null = null;
	#eventListeners: InProcessEventListener[] = [];
	#unsubscribe: (() => void) | null = null;
	#options: InProcessClientOptions;

	constructor(options: InProcessClientOptions) {
		this.#options = options;
	}

	async start(): Promise<void> {
		const shared = this.#options.shared;

		const result = await createAgentSession({
			cwd: this.#options.cwd,
			modelPattern: this.#options.model,
			authStorage: shared?.authStorage,
			modelRegistry: shared?.modelRegistry,
			sessionManager: SessionManager.inMemory(this.#options.cwd),
			// Benchmark tasks run many top-level sessions concurrently in one
			// process. The global registry admits only one "Main" per process
			// generation (later registrations replace earlier refs, which then
			// fail session initialization), so each client gets its own registry.
			agentRegistry: new AgentRegistry(),
			systemPrompt: this.#options.appendSystemPrompt
				? (_defaultPrompt: string[]) => [this.#options.appendSystemPrompt!]
				: undefined,
			toolNames: this.#options.tools ?? ["read", "edit", "write"],
			hasUI: false,
			enableMCP: false,
			enableLsp: false,
			skills: [],
			rules: [],
			contextFiles: [],
			disableExtensionDiscovery: true,
		});

		this.#sessionResult = result;
		this.#session = result.session;
		// Force-exclude custom tools (generate_image, etc.) that createAgentSession
		// force-includes via alwaysInclude, regardless of the toolNames filter.
		// This rebuilds the system prompt without their descriptions, saving ~300 tokens.
		await this.#session.setActiveToolsByName(this.#options.tools ?? ["read", "edit", "write"]);

		// Disable structural summary for read tool — benchmark tasks need to see
		// full file content with line numbers on the first read. The structural
		// summary elides function bodies with `…`, forcing the model to re-read
		// with a range selector (double-read pattern wastes ~2K-10K tokens on 003 tasks).
		this.#session.settings.override("read.summarize.enabled", false);

		// Strip irrelevant sections from the read tool's API description to save ~590
		// tokens/turn. For a local file-edit benchmark, Documents/Images/Archives/SQLite/
		// URLs/Internal-URIs sections are dead weight — the model only reads local source
		// files. The proxy getter from applyToolProxy is configurable, so we shadow it.
		const readTool = this.#session.agent.state.tools.find(t => t.name === "read");
		if (readTool) {
			const trimmed = readTool.description
				.replace(/^Read files,[^\n]*\n/, "Read files and directories via one `path`.\n")
				.replace(
					/- `path` — required\.[^\n]*\n/,
					"- `path` — required. Local path. Append `:<sel>` for ranges/modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`).\n",
				)
				.replace(
					/- SHOULD use `read` \(not a browser tool\) for web content; browser only when `read` can't deliver\.\n/,
					"",
				)
				.replace(/# Documents & Notebooks[\s\S]*?(?=<critical>)/, "")
				// Structural summary is disabled in benchmark mode — remove its
				// description so the model doesn't expect elided output or try to
				// re-read elided ranges that will never appear.
				.replace(/- Parseable code, no selector.*?re-issue ONLY those ranges\.\n/g, "")
				.replace(/- Summary footer names elided ranges\?.*?NEVER guess.*?\n/g, "")
				.replace(
					/- _\(none\)_ — parseable code → structural summary;[^\n]*\n/,
					"- _(none)_ — full file with line numbers + tag (up to 300 lines).\n",
				)
				.trim();
			Object.defineProperty(readTool, "description", {
				value: trimmed,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		}

		// Strip archive/SQLite conditions from the write tool's description.
		// Benchmark tasks never create archives or SQLite files (~40 tokens/turn saved).
		const writeTool = this.#session.agent.state.tools.find(t => t.name === "write");
		if (writeTool) {
			const trimmed = writeTool.description
				.replace(/- Supports \.tar.*\n/g, "")
				.replace(/- Supports SQLite.*\n/g, "")
				.trim();
			Object.defineProperty(writeTool, "description", {
				value: trimmed,
				writable: true,
				configurable: true,
				enumerable: true,
			});
		}

		// Subscribe to events and forward to listeners
		this.#unsubscribe = this.#session.subscribe((event: AgentSessionEvent) => {
			// Only forward AgentEvent types (not session-specific ones)
			if (isAgentEvent(event)) {
				for (const listener of this.#eventListeners) {
					listener(event);
				}
			}
		});
	}

	async setThinkingLevel(level: ResolvedThinkingLevel): Promise<void> {
		this.#session!.setThinkingLevel(level);
	}

	onEvent(listener: InProcessEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	async prompt(text: string): Promise<void> {
		await this.#session!.prompt(text, { expandPromptTemplates: false });
		await this.#session!.waitForIdle();
	}

	async followUp(text: string): Promise<void> {
		await this.#session!.followUp(text);
		await this.#session!.waitForIdle();
	}

	abort(): void {
		this.#session?.abort();
	}

	async getSessionStats(): Promise<SessionStats> {
		return this.#session!.getSessionStats();
	}

	async getLastAssistantText(): Promise<string | null> {
		return this.#session!.getLastAssistantText() ?? null;
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.#session!.messages;
	}

	async getState(): Promise<{
		sessionFile?: string;
		systemPrompt?: string[];
		model?: Model;
		thinkingLevel?: ThinkingLevel | undefined;
		dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	}> {
		const session = this.#session!;
		return {
			sessionFile: undefined,
			systemPrompt: session.systemPrompt,
			model: session.model,
			thinkingLevel: session.thinkingLevel,
			dumpTools: session.agent.state.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				examples: tool.examples,
			})),
		};
	}

	async dispose(): Promise<void> {
		this.#unsubscribe?.();
		this.#unsubscribe = null;
		if (this.#session) {
			await this.#session.dispose();
			this.#session = null;
		}
		if (this.#sessionResult?.mcpManager) {
			await (this.#sessionResult.mcpManager as { dispose?: () => Promise<void> }).dispose?.();
		}
		this.#sessionResult = null;
		this.#eventListeners = [];
	}

	[Symbol.dispose](): void {
		this.dispose().catch(() => {});
	}
}

const AGENT_EVENT_TYPES = new Set([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function isAgentEvent(event: AgentSessionEvent): event is AgentEvent {
	return AGENT_EVENT_TYPES.has(event.type);
}

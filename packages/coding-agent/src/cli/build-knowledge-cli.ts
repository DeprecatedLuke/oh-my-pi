import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Api, type Message, type Model, streamSimple, type TextContent } from "@oh-my-pi/pi-ai";
import { getProjectDir, isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { resolveModelRoleValue, resolveRoleSelection } from "../config/model-resolver";
import { Settings } from "../config/settings";
import { EditTool } from "../edit";
import sessionKnowledgeTemplate from "../prompts/system/session-knowledge.md" with { type: "text" };
import { discoverAuthStorage } from "../sdk";
import { type RunSessionKnowledgeAgentResult, runSessionKnowledgeAgent } from "../session/knowledge-base";
import {
	fingerprintKnowledgeRoot,
	getKnowledgeRoot,
	loadKnowledgeSummaries,
	normalizeKnowledgePath,
} from "../session/knowledge-index";
import { convertToLlm } from "../session/messages";
import { buildSessionContext } from "../session/session-context";
import type { FileEntry, SessionEntry } from "../session/session-entries";
import type { SessionInfo } from "../session/session-listing";
import { loadEntriesFromFile } from "../session/session-loader";
import { SessionManager } from "../session/session-manager";
import { migrateSessionEntries } from "../session/session-migrations";
import { buildSystemPrompt } from "../system-prompt";
import type { ToolSession } from "../tools";
import { ReadTool } from "../tools/read";
import { shortenPath } from "../tools/render-utils";
import { WriteTool } from "../tools/write";

const DEFAULT_LAST = "30d";
const STATE_VERSION = 1;
const KNOWLEDGE_MODEL_ROLES = ["task", "smol", "default", "slow"] as const;

export interface BuildKnowledgeCommandArgs {
	last?: string;
	model?: string;
	force?: boolean;
}

interface KnowledgeExportRecord {
	sessionId: string;
	path: string;
	cwd: string;
	modifiedMs: number;
	size: number;
	messageCount: number;
	exportedAt: string;
	status: "exported" | "empty";
	committed: boolean;
	sha?: string;
}

interface KnowledgeExportState {
	version: typeof STATE_VERSION;
	knowledgeFingerprint?: string;
	sessions: Record<string, KnowledgeExportRecord>;
}

export interface SessionKnowledgeExportJob {
	session: SessionInfo;
	sourceTitle: string;
	messages: readonly Message[];
}

export type SessionKnowledgeExporter = (
	job: SessionKnowledgeExportJob,
) => Promise<RunSessionKnowledgeAgentResult | undefined>;

interface BuildKnowledgeDeps {
	listSessions?: () => Promise<SessionInfo[]>;
	exportSession?: SessionKnowledgeExporter;
	statePath?: string;
	write?: (text: string) => void;
	now?: () => Date;
	cwdExists?: (cwd: string) => Promise<boolean>;
}

export interface BuildKnowledgeResult {
	matched: number;
	processed: number;
	exported: number;
	empty: number;
	skippedAlreadyExported: number;
	skippedMissingCwd: number;
	failed: number;
	committed: number;
}

function defaultStatePath(cwd: string): string {
	return path.join(SessionManager.getDefaultSessionDir(cwd), "knowledge-exports.json");
}

function legacyProjectStatePath(cwd: string): string {
	return path.join(cwd, ".omp", "knowledge", ".exported-sessions.json");
}

function emptyState(): KnowledgeExportState {
	return { version: STATE_VERSION, sessions: {} };
}

function parseExportState(value: unknown): KnowledgeExportState | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as { version?: unknown; sessions?: unknown };
	if (record.version !== STATE_VERSION || !record.sessions || typeof record.sessions !== "object") {
		return undefined;
	}
	return record as KnowledgeExportState;
}

async function readStateFile(statePath: string): Promise<KnowledgeExportState | undefined> {
	try {
		return parseExportState((await Bun.file(statePath).json()) as unknown);
	} catch (error) {
		if (isEnoent(error)) return undefined;
		throw error;
	}
}

function mergeStates(current: KnowledgeExportState | undefined, legacy: KnowledgeExportState): KnowledgeExportState {
	return {
		version: STATE_VERSION,
		sessions: { ...legacy.sessions, ...(current?.sessions ?? {}) },
		knowledgeFingerprint: current?.knowledgeFingerprint,
	};
}

async function loadState(statePath: string, legacyStatePath?: string): Promise<KnowledgeExportState> {
	const current = await readStateFile(statePath);
	if (!legacyStatePath) return current ?? emptyState();

	const legacy = await readStateFile(legacyStatePath);
	if (!legacy) return current ?? emptyState();

	const migrated = mergeStates(current, legacy);
	await saveState(statePath, migrated);
	await fs.rm(legacyStatePath, { force: true });
	return migrated;
}

async function saveState(statePath: string, state: KnowledgeExportState): Promise<void> {
	await Bun.write(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function recordedKnowledgeOutputsExist(cwd: string, state: KnowledgeExportState): Promise<boolean> {
	const root = getKnowledgeRoot(cwd);
	for (const record of Object.values(state.sessions)) {
		if (record.status === "empty") continue;
		const written = (record as { written?: unknown }).written;
		if (!Array.isArray(written) || written.length === 0) return false;
		for (const item of written) {
			if (typeof item !== "string") return false;
			const relativePath = normalizeKnowledgePath(item);
			if (!relativePath) return false;
			if (!(await Bun.file(path.join(root, ...relativePath.split("/"))).exists())) {
				return false;
			}
		}
	}
	return true;
}

async function alignStateWithKnowledgeRoot(
	cwd: string,
	statePath: string,
	state: KnowledgeExportState,
	write: (text: string) => void,
): Promise<KnowledgeExportState> {
	await loadKnowledgeSummaries({ cwd });
	const currentFingerprint = await fingerprintKnowledgeRoot(cwd);
	if (state.knowledgeFingerprint === currentFingerprint) return state;

	if (!state.knowledgeFingerprint && (await recordedKnowledgeOutputsExist(cwd, state))) {
		const nextState = { ...state, knowledgeFingerprint: currentFingerprint };
		await saveState(statePath, nextState);
		return nextState;
	}

	const cached = Object.keys(state.sessions).length;
	if (cached > 0) {
		write(
			`Knowledge files changed since the last export; invalidating ${cached} cached session fingerprint${cached === 1 ? "" : "s"}.\n`,
		);
	}
	const nextState: KnowledgeExportState = {
		version: STATE_VERSION,
		knowledgeFingerprint: currentFingerprint,
		sessions: {},
	};
	await saveState(statePath, nextState);
	return nextState;
}

export function parseLastDurationMs(value: string | undefined): number {
	const raw = (value ?? DEFAULT_LAST).trim().toLowerCase();
	if (raw === "all") return Number.POSITIVE_INFINITY;
	const match = /^(\d+)(ms|m|h|d|w)?$/.exec(raw);
	if (!match) {
		throw new Error(`Invalid --last value "${value}". Use a duration like 30d, 72h, 2w, or all.`);
	}
	const amount = Number(match[1]);
	const unit = match[2] ?? "d";
	switch (unit) {
		case "ms":
			return amount;
		case "m":
			return amount * 60_000;
		case "h":
			return amount * 60 * 60_000;
		case "d":
			return amount * 24 * 60 * 60_000;
		case "w":
			return amount * 7 * 24 * 60 * 60_000;
		default:
			throw new Error(`Invalid --last unit "${unit}".`);
	}
}

function sessionStateKey(session: SessionInfo): string {
	return session.id;
}

function isAlreadyExported(session: SessionInfo, record: KnowledgeExportRecord | undefined): boolean {
	if (!record) return false;
	return (
		record.path === path.resolve(session.path) &&
		record.modifiedMs === session.modified.getTime() &&
		record.size === session.size &&
		record.messageCount === session.messageCount &&
		(record.status === "exported" || record.status === "empty")
	);
}

function titleForSession(session: SessionInfo): string {
	const title = session.title?.trim() || session.firstMessage.trim();
	if (!title || title === "(no messages)") return session.id;
	const singleLine = title.replace(/\s+/g, " ");
	return singleLine.length > 96 ? `${singleLine.slice(0, 93)}...` : singleLine;
}

function sourceTitleForSession(session: SessionInfo): string {
	const title = titleForSession(session);
	return title === session.id ? `session ${session.id}` : `${title} (${session.id})`;
}

function formatProgressSession(session: SessionInfo): string {
	const cwd = session.cwd ? shortenPath(session.cwd) : "(unknown cwd)";
	return `${session.id.slice(0, 8)} ${cwd}`;
}

async function defaultCwdExists(cwd: string): Promise<boolean> {
	if (!cwd) return false;
	try {
		return (await fs.stat(cwd)).isDirectory();
	} catch {
		return false;
	}
}

function fileEntriesToSessionEntries(entries: readonly FileEntry[]): SessionEntry[] {
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

function textOnlyMessage(message: Message): Message | undefined {
	if (typeof message.content === "string") {
		return message.content.trim().length > 0 ? message : undefined;
	}
	const content = message.content.filter(
		(block): block is TextContent => block.type === "text" && block.text.length > 0,
	);
	if (content.length === 0) return undefined;
	if (content.length === message.content.length) return message;
	return { ...message, content };
}

async function loadSessionKnowledgeJob(session: SessionInfo): Promise<SessionKnowledgeExportJob> {
	const entries = await loadEntriesFromFile(session.path);
	migrateSessionEntries(entries);
	const context = buildSessionContext(fileEntriesToSessionEntries(entries));
	const messages = convertToLlm(context.messages)
		.map(textOnlyMessage)
		.filter((message): message is Message => message !== undefined);
	return {
		session,
		sourceTitle: sourceTitleForSession(session),
		messages,
	};
}

interface KnowledgeModelRuntime {
	model: Model<Api>;
	apiKey: string;
	baseSystemPromptForCwd: (cwd: string) => Promise<string[]>;
	settings: Settings;
}

async function resolveKnowledgeRuntime(modelOverride: string | undefined): Promise<KnowledgeModelRuntime> {
	const cwd = getProjectDir();
	const [settings, authStorage] = await Promise.all([Settings.init({ cwd }), discoverAuthStorage()]);
	const modelRegistry = new ModelRegistry(authStorage);
	await modelRegistry.refresh();
	const available = modelRegistry.getAvailable();
	const matchPreferences = { usageOrder: settings.getStorage()?.getModelUsageOrder() };
	const selected = modelOverride
		? resolveModelRoleValue(modelOverride, available, { settings, matchPreferences })
		: (resolveRoleSelection(KNOWLEDGE_MODEL_ROLES, settings, available) ?? { model: available[0] });
	const model = selected.model;
	if (!model) {
		throw new Error("No model available for knowledge building");
	}
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new Error(`No API key available for model ${model.provider}/${model.id}`);
	}
	const promptCache = new Map<string, Promise<string[]>>();
	return {
		model,
		apiKey,
		settings,
		async baseSystemPromptForCwd(projectCwd: string) {
			const fingerprint = await fingerprintKnowledgeRoot(projectCwd);
			const key = `${path.resolve(projectCwd)}\0${fingerprint}`;
			let cached = promptCache.get(key);
			if (!cached) {
				cached = buildSystemPrompt({
					cwd: projectCwd,
					tools: new Map(),
					skills: [],
					contextFiles: [],
					workspaceTree: {
						rootPath: projectCwd,
						rendered: "",
						truncated: false,
						totalLines: 0,
						agentsMdFiles: [],
					},
				}).then(result => result.systemPrompt);
				promptCache.set(key, cached);
			}
			return cached;
		},
	};
}

/**
 * Minimal {@link ToolSession} for the standalone CLI knowledge pass. The
 * read/write/edit tools resolve `knowledge://` against `cwd` (their bound
 * session), so only the required fields plus `settings` are needed; LSP is off.
 */
function createKnowledgeToolSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		enableLsp: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
	};
}

function createProductionExporter(modelOverride: string | undefined): SessionKnowledgeExporter {
	let runtimePromise: Promise<KnowledgeModelRuntime> | undefined;
	return async job => {
		runtimePromise ??= resolveKnowledgeRuntime(modelOverride);
		const runtime = await runtimePromise;
		const baseSystemPrompt = await runtime.baseSystemPromptForCwd(job.session.cwd);
		const toolSession = createKnowledgeToolSession(job.session.cwd, runtime.settings);
		const tools: AgentTool<any>[] = [
			new ReadTool(toolSession),
			new WriteTool(toolSession),
			new EditTool(toolSession),
		];
		// No live parent here (separate process): cache inheritance is best-effort
		// and secrets are identity (saved session messages are stored raw).
		return await runSessionKnowledgeAgent({
			cwd: job.session.cwd,
			sourceTitle: job.sourceTitle,
			instruction: prompt.render(sessionKnowledgeTemplate, { sourceTitle: job.sourceTitle }),
			metadata: { source: "build-knowledge", sessionId: job.session.id },
			agent: {
				initialState: {
					systemPrompt: baseSystemPrompt,
					messages: [...job.messages],
					model: runtime.model,
					tools,
				},
				streamFn: streamSimple,
				getApiKey: () => runtime.apiKey,
				convertToLlm,
				sessionId: job.session.id,
			},
		});
	};
}

function filterSessionsByAge(sessions: SessionInfo[], now: Date, lastMs: number): SessionInfo[] {
	const cutoffMs = Number.isFinite(lastMs) ? now.getTime() - lastMs : Number.NEGATIVE_INFINITY;
	return sessions
		.filter(session => session.modified.getTime() >= cutoffMs)
		.sort((a, b) => a.modified.getTime() - b.modified.getTime());
}

function makeRecord(
	session: SessionInfo,
	now: Date,
	status: KnowledgeExportRecord["status"],
	result: RunSessionKnowledgeAgentResult | undefined,
): KnowledgeExportRecord {
	return {
		sessionId: session.id,
		path: path.resolve(session.path),
		cwd: session.cwd,
		modifiedMs: session.modified.getTime(),
		size: session.size,
		messageCount: session.messageCount,
		exportedAt: now.toISOString(),
		status,
		committed: result?.committed ?? false,
		sha: result?.sha,
	};
}

export async function runBuildKnowledgeCommand(
	args: BuildKnowledgeCommandArgs,
	deps: BuildKnowledgeDeps = {},
): Promise<BuildKnowledgeResult> {
	const write = deps.write ?? (text => process.stdout.write(text));
	const now = deps.now?.() ?? new Date();
	const lastMs = parseLastDurationMs(args.last);
	const cwd = getProjectDir();
	const statePath = deps.statePath ?? defaultStatePath(cwd);
	let state = await loadState(statePath, deps.statePath ? undefined : legacyProjectStatePath(cwd));
	const sessions = filterSessionsByAge(await (deps.listSessions?.() ?? SessionManager.list(cwd)), now, lastMs);
	const result: BuildKnowledgeResult = {
		matched: sessions.length,
		processed: 0,
		exported: 0,
		empty: 0,
		skippedAlreadyExported: 0,
		skippedMissingCwd: 0,
		failed: 0,
		committed: 0,
	};

	write(
		`Building project knowledge for ${shortenPath(cwd)} from ${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
	);
	write(Number.isFinite(lastMs) ? ` modified in the last ${args.last ?? DEFAULT_LAST}.\n` : ".\n");
	state = await alignStateWithKnowledgeRoot(cwd, statePath, state, write);
	if (sessions.length === 0) {
		write("No matching sessions found.\n");
		return result;
	}

	const exporter = deps.exportSession ?? createProductionExporter(args.model);
	const cwdExists = deps.cwdExists ?? defaultCwdExists;

	for (let index = 0; index < sessions.length; index++) {
		const rawSession = sessions[index];
		const session = rawSession.cwd ? rawSession : { ...rawSession, cwd };
		const label = formatProgressSession(session);
		const prefix = `[${index + 1}/${sessions.length}] ${label}`;
		const key = sessionStateKey(session);
		const record = state.sessions[key];

		if (!args.force && isAlreadyExported(session, record)) {
			result.skippedAlreadyExported += 1;
			write(`${prefix} — already exported\n`);
			continue;
		}

		if (!(await cwdExists(session.cwd))) {
			result.skippedMissingCwd += 1;
			write(`${prefix} — skipped, missing cwd\n`);
			continue;
		}

		try {
			const job = await loadSessionKnowledgeJob(session);
			if (job.messages.length === 0) {
				state.sessions[key] = makeRecord(session, deps.now?.() ?? new Date(), "empty", undefined);
				state.knowledgeFingerprint = await fingerprintKnowledgeRoot(cwd);
				await saveState(statePath, state);
				result.empty += 1;
				write(`${prefix} — no context messages\n`);
				continue;
			}

			result.processed += 1;
			write(`${prefix} — spawning knowledge agent\n`);
			const exportResult = await exporter(job);
			if (!exportResult) throw new Error("knowledge extraction failed");
			state.sessions[key] = makeRecord(session, deps.now?.() ?? new Date(), "exported", exportResult);
			state.knowledgeFingerprint = await fingerprintKnowledgeRoot(cwd);
			await saveState(statePath, state);
			result.exported += 1;
			if (exportResult.committed) result.committed += 1;
			write(
				exportResult.committed
					? `${prefix} — done, committed ${exportResult.sha ?? "knowledge"}\n`
					: `${prefix} — done, no knowledge changes\n`,
			);
		} catch (error) {
			result.failed += 1;
			logger.warn("build-knowledge session export failed", {
				sessionId: session.id,
				path: session.path,
				error: error instanceof Error ? error.message : String(error),
			});
			write(`${prefix} — failed: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}

	write(
		`Done. Exported ${result.exported}, already exported ${result.skippedAlreadyExported}, empty ${result.empty}, missing cwd ${result.skippedMissingCwd}, failed ${result.failed}, committed ${result.committed}.\n`,
	);
	return result;
}

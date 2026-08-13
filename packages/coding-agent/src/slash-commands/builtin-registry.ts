import type { AutocompleteItem } from "@oh-my-pi/pi-tui";
import { COLLAB_GUEST_ALLOWED_COMMANDS } from "../collab/guest";
import { BUILTIN_COLLABORATION_SLASH_COMMANDS } from "./builtin-collaboration";
import {
	buildArgumentCompletions,
	buildDirectoryArgumentCompletions,
	buildMcpArgumentCompletions,
	buildStaticInlineHint,
	buildSubcommandInlineHint,
} from "./builtin-completions";
import { BUILTIN_CONTROL_SLASH_COMMANDS } from "./builtin-control";
import { BUILTIN_LIFECYCLE_SLASH_COMMANDS } from "./builtin-lifecycle";
import { BUILTIN_MARKETPLACE_SLASH_COMMANDS, reloadTuiPluginState } from "./builtin-marketplace";
import { BUILTIN_MODE_SLASH_COMMANDS } from "./builtin-modes";
import { BUILTIN_SESSION_SLASH_COMMANDS } from "./builtin-session";
import { createTuiFixRefusalUi, executeFixRefusal } from "./helpers/fix-refusal";
import { commandConsumed, errorMessage, parseSlashCommand, parseSubcommand, usage } from "./helpers/parse";
import type {
	BuiltinSlashCommand,
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export type { BuiltinSlashCommand, SubcommandDef } from "./types";

/** TUI-specific runtime accepted by `executeBuiltinSlashCommand`. */
export type BuiltinSlashCommandRuntime = TuiSlashCommandRuntime;

export interface TuiBuiltinSlashCommand extends BuiltinSlashCommand {
	getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	getInlineHint?: (argumentText: string) => string | null;
	getAutocompleteDescription?: () => string | undefined;
}

const FORK_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "knowledge",
		description: "Save, build, update, or compact the project knowledge base",
		subcommands: [
			{ name: "save", description: "Save durable knowledge from the current session to .omp/knowledge" },
			{
				name: "build",
				description:
					"Background agent: explore the project and author the knowledge base from scratch (`/knowledge build [focus]`)",
			},
			{
				name: "update",
				description:
					"Background agent: read every knowledge file, confirm/correct facts against the repo, and resolve conflicts (`/knowledge update [focus]`)",
			},
			{
				name: "compact",
				description:
					"Background agent: prune duplicate/outdated knowledge files, or pursue a goal (`/knowledge compact <goal>`)",
			},
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb === "build") {
				const focus = rest.trim() || undefined;
				const result = runtime.session.buildKnowledge({
					sourceTitle: focus ? `/knowledge build ${focus}` : "/knowledge build",
					focus,
				});
				if (result.started) {
					await runtime.output(`Knowledge build started in the background (job ${result.jobId ?? "?"}).`);
				} else {
					await runtime.output(`Knowledge build unavailable: ${result.reason ?? "unknown"}.`);
				}
				return commandConsumed();
			}
			if (verb === "update") {
				const focus = rest.trim() || undefined;
				const result = runtime.session.updateKnowledge({
					sourceTitle: focus ? `/knowledge update ${focus}` : "/knowledge update",
					focus,
				});
				if (result.started) {
					await runtime.output(`Knowledge update started in the background (job ${result.jobId ?? "?"}).`);
				} else {
					await runtime.output(`Knowledge update unavailable: ${result.reason ?? "unknown"}.`);
				}
				return commandConsumed();
			}
			if (verb === "compact") {
				const goal = rest.trim() || undefined;
				const result = runtime.session.compactKnowledge({
					sourceTitle: goal ? `/knowledge compact ${goal}` : "/knowledge compact",
					goal,
				});
				if (result.started) {
					await runtime.output(`Knowledge compaction started in the background (job ${result.jobId ?? "?"}).`);
				} else {
					await runtime.output(`Knowledge compaction unavailable: ${result.reason ?? "unknown"}.`);
				}
				return commandConsumed();
			}
			if (verb && verb !== "save") {
				return usage("Usage: /knowledge <save|build|update|compact>", runtime);
			}
			const result = await runtime.session.saveKnowledge();
			await runtime.output(
				result.committed ? `Knowledge saved${result.sha ? ` (${result.sha})` : ""}.` : "Knowledge save failed.",
			);
			return commandConsumed();
		},
	},
	{
		name: "fix-refusal",
		description: "Mask whatever made the model refuse, then save the redaction patterns",
		handleTui: async (_command, runtime) => {
			const ctx = runtime.ctx;
			ctx.editor.setText("");
			const ui = createTuiFixRefusalUi(ctx);
			const signal = ctx.beginFixRefusal?.();
			try {
				await executeFixRefusal({
					session: ctx.session,
					settings: ctx.settings,
					cwd: ctx.sessionManager.getCwd(),
					keyDir: ctx.session.getSecretPlaceholderKeyDir(),
					signal,
					ui,
				});
			} catch (err) {
				ui.step(`Failed: ${errorMessage(err)}`);
			} finally {
				ui.done();
				ctx.endFixRefusal?.();
			}
			return commandConsumed();
		},
		handle: async (_command, runtime) => {
			try {
				await executeFixRefusal({
					session: runtime.session,
					settings: runtime.settings,
					cwd: runtime.cwd,
					keyDir: runtime.session.getSecretPlaceholderKeyDir(),
					ui: { step: line => void runtime.output(line), working: () => {} },
				});
				return commandConsumed();
			} catch (err) {
				return usage(`Failed: ${errorMessage(err)}`, runtime);
			}
		},
	},
	{
		name: "git",
		description: "Git checkpoint / status via the git tool",
		subcommands: [
			{ name: "checkpoint", description: "Commit outstanding work with the git tool", usage: "[reason]" },
			{ name: "status", description: "Show working-tree status" },
		],
		allowArgs: true,
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			if (verb !== "checkpoint" && verb !== "status") {
				return usage("Usage: /git <checkpoint [reason]|status>", runtime);
			}
			const tool = runtime.session.getToolByName("git");
			if (!tool) {
				await runtime.output("git is unavailable. Run inside a top-level Git-backed session.");
				return commandConsumed();
			}
			if (verb === "checkpoint") {
				const reason = rest.trim() || "slash-invoked checkpoint";
				try {
					const result = await tool.execute("slash-git-checkpoint", { op: "checkpoint", reason });
					const text = result.content
						.map(c => (c.type === "text" ? c.text : ""))
						.join("\n")
						.trim();
					await runtime.output(text || "Checkpoint complete.");
				} catch (err) {
					await runtime.output(`Checkpoint failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				return commandConsumed();
			}
			try {
				const result = await tool.execute("slash-git-status", { op: "status" });
				const text = result.content
					.map(c => (c.type === "text" ? c.text : ""))
					.join("\n")
					.trim();
				await runtime.output(text || "Working tree clean.");
			} catch (err) {
				await runtime.output(`Status failed: ${err instanceof Error ? err.message : String(err)}`);
			}
			return commandConsumed();
		},
	},
];

const BUILTIN_SLASH_COMMAND_REGISTRY: ReadonlyArray<SlashCommandSpec> = [
	...BUILTIN_MODE_SLASH_COMMANDS,
	...BUILTIN_COLLABORATION_SLASH_COMMANDS,
	...BUILTIN_SESSION_SLASH_COMMANDS,
	...BUILTIN_LIFECYCLE_SLASH_COMMANDS,
	...BUILTIN_MARKETPLACE_SLASH_COMMANDS,
	...BUILTIN_CONTROL_SLASH_COMMANDS,
	...FORK_SLASH_COMMANDS,
];

const BUILTIN_SLASH_COMMAND_LOOKUP = new Map<string, SlashCommandSpec>();
for (const command of BUILTIN_SLASH_COMMAND_REGISTRY) {
	BUILTIN_SLASH_COMMAND_LOOKUP.set(command.name, command);
	for (const alias of command.aliases ?? []) {
		BUILTIN_SLASH_COMMAND_LOOKUP.set(alias, command);
	}
}

export const BUILTIN_SLASH_COMMAND_RESERVED_NAMES: ReadonlySet<string> = new Set(BUILTIN_SLASH_COMMAND_LOOKUP.keys());

/** Builtin command metadata used for slash-command autocomplete and help text. */
export const BUILTIN_SLASH_COMMAND_DEFS: ReadonlyArray<BuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_REGISTRY.map(
	command => ({
		name: command.name,
		aliases: command.aliases,
		allowArgs: command.allowArgs === true,
		description: command.description,
		subcommands: command.subcommands,
		inlineHint: command.inlineHint,
		getTuiAutocompleteDescription: command.getTuiAutocompleteDescription,
	}),
);

function materializeTuiBuiltinSlashCommand(
	cmd: BuiltinSlashCommand,
	runtime?: TuiSlashCommandRuntime,
): TuiBuiltinSlashCommand {
	const materialized: TuiBuiltinSlashCommand = { ...cmd };
	if (cmd.subcommands) {
		materialized.getArgumentCompletions =
			cmd.name === "mcp" && runtime
				? buildMcpArgumentCompletions(cmd.subcommands, runtime)
				: buildArgumentCompletions(cmd.subcommands);
		materialized.getInlineHint = buildSubcommandInlineHint(cmd.subcommands);
	} else if (cmd.name === "move") {
		materialized.getArgumentCompletions = buildDirectoryArgumentCompletions();
		if (cmd.inlineHint) materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	} else if (cmd.inlineHint) {
		materialized.getInlineHint = buildStaticInlineHint(cmd.inlineHint);
	}
	if (runtime && cmd.getTuiAutocompleteDescription) {
		materialized.getAutocompleteDescription = () => cmd.getTuiAutocompleteDescription?.(runtime);
	}
	return materialized;
}

/**
 * Materialized builtin slash commands with completion functions derived from
 * declarative subcommand/hint definitions.
 */
export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<TuiBuiltinSlashCommand> = BUILTIN_SLASH_COMMAND_DEFS.map(cmd =>
	materializeTuiBuiltinSlashCommand(cmd),
);

export function buildTuiBuiltinSlashCommands(runtime: TuiSlashCommandRuntime): ReadonlyArray<TuiBuiltinSlashCommand> {
	return BUILTIN_SLASH_COMMAND_DEFS.map(cmd => materializeTuiBuiltinSlashCommand(cmd, runtime));
}

/**
 * Unified registry exposed for cross-mode tooling. Each spec carries at least
 * one of `handle` / `handleTui`. The TUI dispatcher prefers `handleTui`; the
 * ACP dispatcher requires `handle` and skips TUI-only entries.
 */
export const BUILTIN_SLASH_COMMANDS_INTERNAL: ReadonlyArray<SlashCommandSpec> = BUILTIN_SLASH_COMMAND_REGISTRY;

/**
 * Execute a builtin slash command in the interactive TUI.
 *
 * Returns `false` when no builtin matched. Returns `true` when a command
 * consumed the input entirely. Returns a `string` when the command was handled
 * but remaining text should be sent as a prompt.
 */
export async function executeBuiltinSlashCommand(
	text: string,
	runtime: BuiltinSlashCommandRuntime,
): Promise<string | boolean> {
	const parsed = parseSlashCommand(text);
	if (!parsed) return false;

	const command = BUILTIN_SLASH_COMMAND_LOOKUP.get(parsed.name);
	if (!command) return false;
	if (parsed.args.length > 0 && !command.allowArgs) {
		return false;
	}
	// Collab guests run a read-mostly replica: session-mutating builtins are
	// host-only; the allowlist covers purely local/read-only commands.
	if (runtime.ctx.collabGuest && !COLLAB_GUEST_ALLOWED_COMMANDS[command.name]) {
		runtime.ctx.showStatus(`/${command.name} is host-only during a collab session`);
		runtime.ctx.editor.setText("");
		return true;
	}
	if (command.handleTui) {
		const result = await command.handleTui(parsed, runtime);
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	if (command.handle) {
		// No TUI-specific override → adapt the ACP/text-mode `handle` to the
		// TUI by routing `runtime.output` through `ctx.showStatus`, clearing
		// the editor after the call, and reusing the active session's plugin
		// reload pipeline. Spec authors get a single body usable from either
		// dispatcher without forcing every TUI test to construct the full
		// `SlashCommandRuntime` shape.
		const ctx = runtime.ctx;
		const adapted: SlashCommandRuntime = {
			session: ctx.session,
			sessionManager: ctx.sessionManager,
			settings: ctx.settings,
			cwd: ctx.sessionManager.getCwd(),
			output: (text: string) => {
				ctx.showStatus(text);
			},
			refreshCommands: () => ctx.refreshSlashCommandState(),
			reloadPlugins: () => reloadTuiPluginState(ctx),
		};
		const result = await command.handle(parsed, adapted);
		ctx.editor.setText("");
		if (result && typeof result === "object" && "prompt" in result) return result.prompt;
		return true;
	}
	return false;
}

/** Look up a unified spec by name or alias. Used by the ACP dispatcher. */
export function lookupBuiltinSlashCommand(name: string): SlashCommandSpec | undefined {
	return BUILTIN_SLASH_COMMAND_LOOKUP.get(name);
}

export type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime, SlashCommandSpec, TuiSlashCommandRuntime };

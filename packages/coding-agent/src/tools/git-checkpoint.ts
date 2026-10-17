/**
 * `git_checkpoint` tool — the agent-facing form of the two-stage WIP checkpoint
 * flow shared with `omp git checkpoint`: bare it lists the dirty repos and commits
 * nothing, so the caller must name exactly the repos it is responsible for; with
 * names it commits only those, each with a locally generated message.
 *
 * Stage two runs through {@link runCheckpointStage} so the CLI and the tool can never
 * drift on matching rules, ordering, or failure isolation.
 */
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text, replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { TRUNCATE_LENGTHS } from "@oh-my-pi/pi-tui/render/render-utils";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import type { OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { prompt, untilAborted } from "@oh-my-pi/pi-utils";
import type { CheckpointCommitDeps, CheckpointRepoEntry, DirtyRepo } from "../commit/checkpoint";
import {
	createStandaloneCommitDeps,
	formatCheckpointResult,
	formatDirtyRepoList,
	runCheckpointStage,
} from "../commit/checkpoint";
import gitCheckpointDescription from "../prompts/tools/git-checkpoint.md" with { type: "text" };
import type { ToolSession } from "./index";
import { toolResult } from "./tool-result";

const gitCheckpointSchema = type({
	"repos?": type("string[]").describe(
		"stage-2 repo names, exactly as listed by a bare git_checkpoint call; omit to list dirty repos",
	),
});

export type GitCheckpointToolParams = typeof gitCheckpointSchema.infer;

export interface GitCheckpointToolDetails {
	stage: "clean" | "listed" | "unmatched" | "committed";
	/** Dirty repos the stage saw; these labels are what stage two accepts. */
	dirty: DirtyRepo[];
	/** Requested names that matched no dirty repo (nothing was committed). */
	unmatched?: string[];
	/** Per-repo commit outcomes, in selection order. */
	entries?: CheckpointRepoEntry[];
	meta?: OutputMeta;
}

/**
 * Commit-stage model access: the live session's registry when it has one, otherwise a
 * standalone registry built exactly like the CLI's.
 */
async function acquireCommitDeps(session: ToolSession): Promise<CheckpointCommitDeps> {
	const sessionId = session.getSessionId?.() ?? undefined;
	const registry = session.modelRegistry;
	if (registry) return { modelRegistry: registry, settings: session.settings, sessionId };
	const deps = await createStandaloneCommitDeps(session.cwd, session.settings);
	return { ...deps, sessionId };
}

export class GitCheckpointTool implements AgentTool<typeof gitCheckpointSchema, GitCheckpointToolDetails, Theme> {
	readonly name = "git_checkpoint";
	readonly label = "Git Checkpoint";
	readonly approval = "write" as const;
	readonly summary = "List dirty repos, then commit only the named ones as local WIP checkpoints";
	readonly description = prompt.render(gitCheckpointDescription);
	readonly parameters = gitCheckpointSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<GitCheckpointToolParams>) =>
		args.repos && args.repos.length > 0 ? `checkpointing: ${args.repos.join(", ")}` : "listing dirty repos";

	constructor(private readonly session: ToolSession) {}

	static createIf(session: ToolSession): GitCheckpointTool | null {
		return new GitCheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: GitCheckpointToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<GitCheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<GitCheckpointToolDetails>> {
		return untilAborted(signal, async () => {
			const names = params.repos ?? [];
			const result = await runCheckpointStage(this.session.cwd, names, () => acquireCommitDeps(this.session));
			switch (result.stage) {
				case "clean":
					return toolResult<GitCheckpointToolDetails>({ stage: "clean", dirty: [] })
						.text("Nothing to commit — all repos are clean.")
						.useless()
						.done();
				case "listed":
					return toolResult<GitCheckpointToolDetails>({ stage: "listed", dirty: result.dirty })
						.text(
							[
								`Detected repos with changes:\n${formatDirtyRepoList(result.dirty)}`,
								"Call git_checkpoint again with `repos` naming only the repos you are responsible for.",
							].join("\n\n"),
						)
						.done();
				case "unmatched":
					return toolResult<GitCheckpointToolDetails>({
						stage: "unmatched",
						dirty: result.dirty,
						unmatched: result.unmatched,
					})
						.text(
							[
								`No dirty repo matches: ${result.unmatched.join(", ")}`,
								`Detected repos with changes:\n${formatDirtyRepoList(result.dirty)}`,
								"Nothing was committed.",
							].join("\n\n"),
						)
						.error()
						.done();
				case "committed":
					return toolResult<GitCheckpointToolDetails>({
						stage: "committed",
						dirty: result.dirty,
						entries: result.entries,
					})
						.text(formatCheckpointResult(result.entries))
						.error(result.entries.some(entry => entry.status === "failed"))
						.done();
			}
		});
	}

	renderCall(args: Partial<GitCheckpointToolParams>, _options: unknown, theme: Theme): Component {
		const repos = (args.repos ?? []).map(name => replaceTabs(name));
		const detail = repos.length > 0 ? repos.join(", ") : "list dirty repos";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("git_checkpoint "))}${theme.fg("dim", truncateToWidth(detail, TRUNCATE_LENGTHS.CONTENT))}`,
			0,
			0,
		);
	}

	renderResult(result: AgentToolResult<GitCheckpointToolDetails>, _options: unknown, _theme: Theme): Component {
		const text = result.content[0];
		const message = text?.type === "text" ? text.text : "";
		return new Text(replaceTabs(message), 0, 0);
	}
}

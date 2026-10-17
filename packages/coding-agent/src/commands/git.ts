/**
 * Fullscreen interactive git TUI: split-pane diff viewer with minimap, file
 * staging sidebar, and generated or manual commit composer.
 *
 * `omp git checkpoint` is the non-interactive, two-stage WIP commit flow:
 * bare it lists the dirty repos; with repo names it commits only those. The
 * `git_checkpoint` agent tool runs the same stages through the shared
 * `runCheckpointStage`, so neither surface can drift from the other.
 */

import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { gitHelp as commandHelp } from "../cli/command-help";
import { runGitTui } from "../cli/git-tui";
import {
	createStandaloneCommitDeps,
	formatCheckpointResult,
	formatDirtyRepoList,
	runCheckpointStage,
} from "../commit/checkpoint";
import { Settings, settings } from "../config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

import { cfgColorBlindMode, cfgSymbolPreset, cfgThemeDark, cfgThemeLight } from "../modes/settings";

export default class Git extends Command {
	static description = commandHelp.description;

	static args = {
		revision: Args.string({
			description: "Pin the view to one commit (any revision, e.g. HEAD~2 or a sha), or `checkpoint`",
			required: false,
		}),
		repos: Args.string({
			description: "checkpoint: repos to commit, as listed by a bare `omp git checkpoint`",
			required: false,
			multiple: true,
		}),
	};

	static flags = {
		dir: Flags.string({ char: "C", description: "Run in another directory instead of the current one" }),
	};

	static examples = [
		"omp git",
		"omp git HEAD~2",
		"omp git -C ~/projects/app",
		"omp git checkpoint",
		"omp git checkpoint . packages/lib",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Git);
		if (args.revision === "checkpoint") {
			process.exitCode = await runCheckpoint(path.resolve(flags.dir ?? getProjectDir()), args.repos ?? []);
			return;
		}
		if (args.repos) {
			console.error("omp git accepts a single revision");
			process.exit(1);
		}
		if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) {
			console.error("omp git is interactive and requires a TTY");
			process.exit(1);
		}
		// Load settings first so the user's configured theme/symbol preset apply
		// exactly like interactive mode (bare initTheme falls back to built-ins).
		await Settings.init({ cwd: getProjectDir() });
		await initTheme(
			false,
			cfgSymbolPreset.get(settings),
			cfgColorBlindMode.get(settings),
			cfgThemeDark.get(settings),
			cfgThemeLight.get(settings),
		);
		await runGitTui({ cwd: flags.dir, revision: args.revision });
	}
}

/**
 * Two-stage checkpoint: without names, list the dirty repos and commit nothing, so the
 * caller must name exactly the repos it is responsible for. With names, every name must
 * match a dirty repo before anything is committed.
 */
async function runCheckpoint(cwd: string, names: readonly string[]): Promise<number> {
	const result = await runCheckpointStage(cwd, names, async () => {
		const settingsInstance = await Settings.init({ cwd });
		return createStandaloneCommitDeps(cwd, settingsInstance);
	});
	switch (result.stage) {
		case "clean":
			process.stdout.write("Nothing to commit — all repos are clean.\n");
			return 0;
		case "listed":
			process.stdout.write(
				`Detected repos with changes:\n${formatDirtyRepoList(result.dirty)}\n\nCommit only the repos you are responsible for: omp git checkpoint <repo>...\n`,
			);
			return 0;
		case "unmatched":
			process.stderr.write(
				`No dirty repo matches: ${result.unmatched.join(", ")}\nDetected repos with changes:\n${formatDirtyRepoList(result.dirty)}\n`,
			);
			return 1;
		case "committed":
			process.stdout.write(`${formatCheckpointResult(result.entries)}\n`);
			return result.entries.some(entry => entry.status === "failed") ? 1 : 0;
	}
}

import { Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { type BuildKnowledgeCommandArgs, runBuildKnowledgeCommand } from "../cli/build-knowledge-cli";
import { initTheme } from "../modes/theme/theme";

export default class BuildKnowledge extends Command {
	static description = "Backfill project-local knowledge from saved sessions";

	static flags = {
		last: Flags.string({
			description: "How far back to scan sessions (default: 30d; also supports 72h, 2w, all)",
			default: "30d",
		}),
		model: Flags.string({ description: "Model or model role to use for extraction" }),
		force: Flags.boolean({ description: "Re-export sessions even when their latest version was already recorded" }),
	};

	static examples = [
		"# Export knowledge from sessions modified in the last 30 days\n  omp build-knowledge --last 30d",
	];

	async run(): Promise<void> {
		const { flags } = await this.parse(BuildKnowledge);
		const cmd: BuildKnowledgeCommandArgs = {
			last: flags.last,
			model: flags.model,
			force: flags.force,
		};
		await initTheme();
		await runBuildKnowledgeCommand(cmd);
	}
}

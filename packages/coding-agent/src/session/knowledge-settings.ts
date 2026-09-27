/**
 * Settings declared by the project-knowledge domain (see `config/registry.ts`). Declaration order is
 * the settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

export const cfgKnowledgeAutoUpdateThresholdTokens = register({
	id: "knowledge.autoUpdateThresholdTokens",
	type: "number",
	default: 100_000,
	ui: {
		tab: "memory",
		group: "General",
		label: "Project Knowledge Auto-Update",
		description: "Counts primary-session provider tokens between automatic project-knowledge updates; 0 disables.",
		options: [
			{ value: "0", label: "Off", description: "Disable automatic project-knowledge updates" },
			{ value: "50000", label: "50K" },
			{ value: "100000", label: "100K", description: "Default" },
			{ value: "250000", label: "250K" },
			{ value: "500000", label: "500K" },
		],
	},
});

/**
 * Built-in model roles and role metadata helpers.
 */

import { isValidThemeColor, type ThemeColor } from "../modes/theme/theme";
import type { Settings } from "./settings";

/** Canonical prefix for a configured model role selector. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";

/** Legacy prefix accepted for backwards-compatible role selectors. */
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";

/** Shorthand selector for the default model role. */
export const DEFAULT_MODEL_ROLE_ALIAS = "*";

/** Format a model role as its canonical selector. */
export function formatModelRoleAlias(role: string): string {
	return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}

export type ModelRole =
	| "default"
	| "smol"
	| "slow"
	| "vision"
	| "plan"
	| "designer"
	| "review"
	| "commit"
	| "tiny"
	| "task"
	| "uncensored"
	| "advisor";

export interface ModelRoleInfo {
	tag?: string;
	name: string;
	color?: ThemeColor;
	/** If true, the role is functional but not shown in the model selector UI. */
	hidden?: boolean;
}

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	default: { tag: "DEFAULT", name: "Default", color: "success" },
	smol: { tag: "SMOL", name: "Fast", color: "warning" },
	slow: { tag: "SLOW", name: "Thinking", color: "accent" },
	vision: { tag: "VISION", name: "Vision", color: "error" },
	plan: { tag: "PLAN", name: "Architect", color: "muted" },
	designer: { tag: "DESIGNER", name: "Designer", color: "muted" },
	review: { tag: "REVIEW", name: "Reviewer", color: "muted" },
	commit: { tag: "COMMIT", name: "Commit", color: "dim" },
	tiny: { tag: "TINY", name: "Tiny", color: "dim" },
	task: { tag: "TASK", name: "Subtask", color: "muted" },
	uncensored: { tag: "UNCENS", name: "Uncensored", color: "error" },
	advisor: { tag: "ADVISOR", name: "Advisor", color: "accent" },
};

export const MODEL_ROLE_IDS: ModelRole[] = [
	"default",
	"smol",
	"slow",
	"vision",
	"plan",
	"designer",
	"review",
	"commit",
	"tiny",
	"task",
	"uncensored",
	"advisor",
];

/**
 * Display metadata for fork-specific roles configured dynamically (via
 * `modelRoles`) rather than living in `MODEL_ROLE_IDS`. Looked up by
 * `getRoleInfo` so they render with a proper `TAG (Name)` badge/label in the
 * selector instead of falling back to the bare lowercase role id.
 */
export const CUSTOM_ROLE_INFO: Record<string, ModelRoleInfo> = {
	compaction: { tag: "COMPACT", name: "Compaction", color: "muted" },
};

export type RoleInfo = ModelRoleInfo;

/**
 * Return the canonical set of known roles for selector/carousel UI.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles = MODEL_ROLE_IDS.filter(role => !MODEL_ROLES[role as ModelRole]?.hidden) as string[];
	const seen = new Set<string>(roles);
	const addRole = (role: string) => {
		if (seen.has(role)) return;
		seen.add(role);
		roles.push(role);
	};

	for (const role of settings.get("cycleOrder")) addRole(role);
	for (const role of Object.keys(settings.getModelRoles())) addRole(role);
	for (const role of Object.keys(settings.get("modelTags"))) addRole(role);

	return roles;
}

/**
 * Get role info for a role name (built-in or custom).
 * Configured metadata overrides built-in defaults when present.
 */
export function getRoleInfo(role: string, settings: Settings): RoleInfo {
	const builtIn = (role in MODEL_ROLES ? MODEL_ROLES[role as ModelRole] : undefined) ?? CUSTOM_ROLE_INFO[role];
	const configured = settings.get("modelTags")[role];

	if (configured) {
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color && isValidThemeColor(configured.color) ? configured.color : builtIn?.color,
			hidden: configured.hidden ?? builtIn?.hidden,
		};
	}

	if (builtIn) return builtIn;

	return { name: role, color: "muted" };
}

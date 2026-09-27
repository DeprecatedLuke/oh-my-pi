import type { Settings } from "../config/settings";
import type { SettingValueOf } from "../config/registry";
import { cfgToolsDiscoveryMode } from "../tools/settings";
import { cfgMcpDiscoveryMode } from "../mcp/settings";

export const TOOL_DISCOVERY_AUTO_THRESHOLD = 40;
export const TOOL_DISCOVERY_SEARCH_TOOL_NAME = "search_tool_bm25";

export type ToolDiscoveryModeSetting = SettingValueOf<typeof cfgToolsDiscoveryMode>;
export type EffectiveToolDiscoveryMode = Exclude<ToolDiscoveryModeSetting, "auto">;

export function countToolsForAutoDiscovery(toolNames: Iterable<string>): number {
	let count = 0;
	for (const name of toolNames) {
		if (name !== TOOL_DISCOVERY_SEARCH_TOOL_NAME) count++;
	}
	return count;
}

export function resolveEffectiveToolDiscoveryMode(settings: Settings, toolCount: number): EffectiveToolDiscoveryMode {
	const configuredMode = cfgToolsDiscoveryMode.get(settings);
	if (configuredMode === "all" || configuredMode === "mcp-only") return configuredMode;
	if (cfgMcpDiscoveryMode.get(settings)) return "mcp-only";
	if (configuredMode === "auto" && toolCount > TOOL_DISCOVERY_AUTO_THRESHOLD) return "mcp-only";
	return "off";
}

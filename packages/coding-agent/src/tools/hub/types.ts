import { type CoordinationDetails, type HubDetails } from "@oh-my-pi/pi-tui/tools/hub";

import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";

export function hubErrorResult(text: string, details: CoordinationDetails): AgentToolResult<HubDetails> {
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}

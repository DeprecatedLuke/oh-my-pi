/**
 * Review tools - report_finding for structured code review.
 *
 * Used by the reviewer agent to report findings in a structured way.
 * Hidden by default - only enabled when explicitly listed in agent's tools.
 * Reviewers finish via `complete` tool with SubmitReviewDetails schema.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme";

const PRIORITY_LABELS: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
};

const PRIORITY_META: Record<number, { symbol: "status.error" | "status.warning" | "status.info"; color: ThemeColor }> =
	{
		0: { symbol: "status.error", color: "error" },
		1: { symbol: "status.warning", color: "warning" },
		2: { symbol: "status.warning", color: "muted" },
		3: { symbol: "status.info", color: "accent" },
	};

function getPriorityDisplay(priority: number, theme: Theme): { label: string; icon: string; color: ThemeColor } {
	const label = PRIORITY_LABELS[priority] ?? "P?";
	const meta = PRIORITY_META[priority] ?? { symbol: "status.info", color: "muted" as const };
	return {
		label,
		icon: theme.styledSymbol(meta.symbol, meta.color),
		color: meta.color,
	};
}

// report_finding schema
const ReportFindingParams = Type.Object({
	title: Type.String({
		description: "≤80 chars, imperative, prefixed with [P0-P3]. E.g., '[P1] Un-padding slices along wrong dimension'",
	}),
	body: Type.String({
		description: "Markdown explaining why this is a problem. One paragraph max.",
	}),
	priority: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
		description: "0=P0 (critical), 1=P1 (urgent), 2=P2 (normal), 3=P3 (low)",
	}),
	confidence: Type.Number({
		minimum: 0,
		maximum: 1,
		description: "Confidence score 0.0-1.0",
	}),
	file_path: Type.String({ description: "Absolute path to the file" }),
	line_start: Type.Number({ description: "Start line of the issue" }),
	line_end: Type.Number({ description: "End line of the issue" }),
});

interface ReportFindingDetails {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

export const reportFindingTool: AgentTool<typeof ReportFindingParams, ReportFindingDetails, Theme> = {
	name: "report_finding",
	label: "Report Finding",
	description: "Report a code review finding. Use this for each issue found. Call complete when done.",
	parameters: ReportFindingParams,
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { title, body, priority, confidence, file_path, line_start, line_end } = params;
		const location = `${file_path}:${line_start}${line_end !== line_start ? `-${line_end}` : ""}`;

		return {
			content: [
				{
					type: "text",
					text: `Finding recorded: ${PRIORITY_LABELS[priority]} ${title}\nLocation: ${location}\nConfidence: ${(
						confidence * 100
					).toFixed(0)}%`,
				},
			],
			details: { title, body, priority, confidence, file_path, line_start, line_end },
		};
	},

	renderCall(args, theme): Component {
		const { label, icon, color } = getPriorityDisplay(args.priority as number, theme);
		const titleText = String(args.title).replace(/^\[P\d\]\s*/, "");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("report_finding "))}${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg(
				"dim",
				titleText,
			)}`,
			0,
			0,
		);
	},

	renderResult(result, _options, theme): Component {
		const { details } = result;
		if (!details) {
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		}

		const { label, icon, color } = getPriorityDisplay(details.priority, theme);
		const location = `${details.file_path}:${details.line_start}${
			details.line_end !== details.line_start ? `-${details.line_end}` : ""
		}`;

		return new Text(
			`${theme.fg("success", theme.status.success)} ${icon} ${theme.fg(color, `[${label}]`)} ${theme.fg(
				"dim",
				location,
			)}`,
			0,
			0,
		);
	},
};

/** SubmitReviewDetails - used for rendering review results from complete tool */
export interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

// Re-export types for external use
export type { ReportFindingDetails };

// ─────────────────────────────────────────────────────────────────────────────
// Subprocess tool handlers - registered for extraction/rendering in task tool
// ─────────────────────────────────────────────────────────────────────────────

import path from "node:path";
import { subprocessToolRegistry } from "./task/subprocess-tool-registry";

// Register report_finding handler
subprocessToolRegistry.register<ReportFindingDetails>("report_finding", {
	extractData: (event) => event.result?.details as ReportFindingDetails | undefined,

	renderInline: (data, theme) => {
		const { label, icon, color } = getPriorityDisplay(data.priority, theme);
		const titleText = data.title.replace(/^\[P\d\]\s*/, "");
		const loc = `${path.basename(data.file_path)}:${data.line_start}`;
		return new Text(`${icon} ${theme.fg(color, `[${label}]`)} ${titleText} ${theme.fg("dim", loc)}`, 0, 0);
	},

	renderFinal: (allData, theme, expanded) => {
		const container = new Container();
		const displayCount = expanded ? allData.length : Math.min(3, allData.length);

		for (let i = 0; i < displayCount; i++) {
			const data = allData[i];
			const { label, icon, color } = getPriorityDisplay(data.priority, theme);
			const titleText = data.title.replace(/^\[P\d\]\s*/, "");
			const loc = `${path.basename(data.file_path)}:${data.line_start}`;

			container.addChild(
				new Text(`  ${icon} ${theme.fg(color, `[${label}]`)} ${titleText} ${theme.fg("dim", loc)}`, 0, 0),
			);

			if (expanded && data.body) {
				container.addChild(new Text(`    ${theme.fg("dim", data.body)}`, 0, 0));
			}
		}

		if (allData.length > displayCount) {
			container.addChild(
				new Text(
					theme.fg("dim", `  ${theme.format.ellipsis} ${allData.length - displayCount} more findings`),
					0,
					0,
				),
			);
		}

		return container;
	},
});

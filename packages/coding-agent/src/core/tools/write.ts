import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import { Type } from "@sinclair/typebox";
import { getLanguageFromPath, highlightCode, type Theme } from "../../modes/interactive/theme/theme";
import writeDescription from "../../prompts/tools/write.md" with { type: "text" };
import type { RenderResultOptions } from "../custom-tools/types";
import type { ToolSession } from "../sdk";
import { untilAborted } from "../utils";
import { createLspWritethrough, type FileDiagnosticsResult } from "./lsp/index";
import { resolveToCwd } from "./path-utils";
import { formatDiagnostics, replaceTabs, shortenPath } from "./render-utils";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

/** Details returned by the write tool for TUI rendering */
export interface WriteToolDetails {
	diagnostics?: FileDiagnosticsResult;
}

export function createWriteTool(session: ToolSession): AgentTool<typeof writeSchema, WriteToolDetails> {
	const enableFormat = session.settings?.getLspFormatOnWrite() ?? true;
	const enableDiagnostics = session.settings?.getLspDiagnosticsOnWrite() ?? true;
	const writethrough = createLspWritethrough(session.cwd, { enableFormat, enableDiagnostics });
	return {
		name: "write",
		label: "Write",
		description: writeDescription,
		parameters: writeSchema,
		execute: async (
			_toolCallId: string,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
		) => {
			return untilAborted(signal, async () => {
				const absolutePath = resolveToCwd(path, session.cwd);

				const diagnostics = await writethrough(absolutePath, content, signal);

				let resultText = `Successfully wrote ${content.length} bytes to ${path}`;
				if (!diagnostics) {
					return {
						content: [{ type: "text", text: resultText }],
						details: {},
					};
				}

				const messages = diagnostics?.messages;
				if (messages && messages.length > 0) {
					resultText += `\n\nLSP Diagnostics (${diagnostics.summary}):\n`;
					resultText += messages.map((d) => `  ${d}`).join("\n");
				}
				return {
					content: [{ type: "text", text: resultText }],
					details: { diagnostics },
				};
			});
		},
	};
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface WriteRenderArgs {
	path?: string;
	file_path?: string;
	content?: string;
}

function countLines(text: string): number {
	if (!text) return 0;
	return text.split("\n").length;
}

function formatMetadataLine(lineCount: number | null, language: string | undefined, uiTheme: Theme): string {
	const icon = uiTheme.getLangIcon(language);
	if (lineCount !== null) {
		return uiTheme.fg("dim", `${icon} ${lineCount} lines`);
	}
	return uiTheme.fg("dim", `${icon}`);
}

export const writeToolRenderer = {
	renderCall(args: WriteRenderArgs, uiTheme: Theme): Component {
		const rawPath = args.file_path || args.path || "";
		const filePath = shortenPath(rawPath);
		const pathDisplay = filePath ? uiTheme.fg("accent", filePath) : uiTheme.fg("toolOutput", uiTheme.format.ellipsis);
		const text = `${uiTheme.fg("toolTitle", uiTheme.bold("Write"))} ${pathDisplay}`;
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: WriteToolDetails },
		{ expanded }: RenderResultOptions,
		uiTheme: Theme,
		args?: WriteRenderArgs,
	): Component {
		const rawPath = args?.file_path || args?.path || "";
		const fileContent = args?.content || "";
		const lang = getLanguageFromPath(rawPath);
		const contentLines = fileContent
			? lang
				? highlightCode(replaceTabs(fileContent), lang)
				: fileContent.split("\n")
			: [];
		const totalLines = contentLines.length;
		const outputLines: string[] = [];

		outputLines.push(formatMetadataLine(countLines(fileContent), lang ?? "text", uiTheme));

		if (fileContent) {
			const maxLines = expanded ? contentLines.length : 10;
			const displayLines = contentLines.slice(0, maxLines);
			const remaining = contentLines.length - maxLines;

			outputLines.push(
				"",
				...displayLines.map((line: string) =>
					lang ? replaceTabs(line) : uiTheme.fg("toolOutput", replaceTabs(line)),
				),
			);
			if (remaining > 0) {
				outputLines.push(
					uiTheme.fg(
						"toolOutput",
						`${uiTheme.format.ellipsis} (${remaining} more lines, ${totalLines} total) ${uiTheme.format.bracketLeft}Ctrl+O to expand${uiTheme.format.bracketRight}`,
					),
				);
			}
		}

		// Show LSP diagnostics if available
		if (result.details?.diagnostics) {
			outputLines.push(
				formatDiagnostics(result.details.diagnostics, expanded, uiTheme, (fp) =>
					uiTheme.getLangIcon(getLanguageFromPath(fp)),
				),
			);
		}

		return new Text(outputLines.join("\n"), 0, 0);
	},
};

/**
 * Shared regex parsing and compilation for secret regex entries.
 */

interface ParsedSecretRegex {
	pattern: string;
	flags: string;
}

/**
 * Parse a regex entry into literal pattern + flags.
 *
 * Supports legacy bare patterns and JS-style one-liner regex literals.
 * - Legacy: "pattern" (no delimiter)
 * - One-liner: "/pattern/flags" (supports escaped "/" in pattern)
 */
function parseSecretRegex(content: string): ParsedSecretRegex {
	if (!content.startsWith("/")) {
		return { pattern: content, flags: "" };
	}

	let patternEnd = -1;
	let escaped = false;

	for (let i = 1; i < content.length; i++) {
		const char = content[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "/") {
			patternEnd = i;
			break;
		}
	}

	if (patternEnd === -1) {
		throw new Error("unterminated regex literal");
	}

	return {
		pattern: content.slice(1, patternEnd),
		flags: content.slice(patternEnd + 1),
	};
}

/** Add global flag while preserving user-provided flags. */
function enforceGlobalFlag(flags: string): string {
	return flags.includes("g") ? flags : `${flags}g`;
}

/** Compile a secret regex entry with global scanning enabled by default. */
export function compileSecretRegex(content: string): RegExp {
	const { pattern, flags } = parseSecretRegex(content);
	return new RegExp(pattern, enforceGlobalFlag(flags));
}

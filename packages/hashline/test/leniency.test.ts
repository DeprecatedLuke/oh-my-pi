import { describe, expect, it } from "bun:test";
import { applyEdits, Patch, parsePatch } from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

const FILE = "a\nb\nc\nd\ne";

describe("hashline section headers", () => {
	it("accepts paths with spaces in anchored section headers", () => {
		const section = Patch.parseSingle("[dir with spaces/file.ts#1a2b]\nSWAP 1.=1:\n+after");

		expect(section.path).toBe("dir with spaces/file.ts");
		expect(section.fileHash).toBe("1A2B");
		expect(section.applyTo("before").text).toBe("after");
	});

	it("recovers apply_patch-contaminated headers whose paths contain spaces", () => {
		const section = Patch.parseSingle("[*** Update File: dir with spaces/file.ts#1A2B]\nSWAP 1.=1:\n+after");

		expect(section.path).toBe("dir with spaces/file.ts");
		expect(section.fileHash).toBe("1A2B");
		expect(section.applyTo("before").text).toBe("after");
	});

	it("rejects trailing junk after a snapshot tag", () => {
		expect(() => Patch.parse("[src/a.ts#1A2B copied from read]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
		expect(() => Patch.parse("[src/a.ts#1A2B:812]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("rejects trailing junk after a snapshot tag even with apply_patch noise", () => {
		expect(() => Patch.parse("[Update File: src/a.ts#1A2B copied from read]\nSWAP 1.=1:\n+after")).toThrow(
			/Input header must be/,
		);
		expect(() => Patch.parse("[Update File: src/a.ts#1A2B:812]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("rejects malformed snapshot tags", () => {
		expect(() => Patch.parse("[src/a.ts#1A2]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
		expect(() => Patch.parse("[src/a.ts#1A2G]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
		expect(() => Patch.parse("[src/a.ts#1A2B5]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("rejects malformed snapshot tags even with apply_patch noise", () => {
		expect(() => Patch.parse("[Update File: src/a.ts#1A2G]\nSWAP 1.=1:\n+after")).toThrow(/Input header must be/);
	});

	it("reports bracket syntax with a 4-hex example when the header is missing", () => {
		try {
			Patch.parse("DEL 38.=40");
			throw new Error("expected missing-header error");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('input must begin with "[PATH#HASH]"');
			expect(message).toContain('Example: "[src/foo.ts#1A2B]"');
			expect(message).not.toContain("#0A3");
		}
	});
});

describe("hashline core — verb header forms", () => {
	it("rejects a bare single-number hunk header with verb guidance", () => {
		expect(() => parsePatch("2\n+B")).toThrow(/hunk headers need a verb/);
	});
	it("rejects a bare numeric range with verb guidance", () => {
		expect(() => parsePatch("2 3\n+X")).toThrow(/Hunk headers need a verb/);
	});

	it("accepts canonical replace/delete/insert forms", () => {
		expect(applyPatch(FILE, "SWAP 2.=3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "DEL 2.=3")).toBe("a\nd\ne");
		expect(applyPatch(FILE, "INS.PRE 2:\n+X")).toBe("a\nX\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.POST 2:\n+X")).toBe("a\nb\nX\nc\nd\ne");
		expect(applyPatch(FILE, "INS.HEAD:\n+X")).toBe("X\na\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.TAIL:\n+X")).toBe("a\nb\nc\nd\ne\nX");
	});

	it("accepts single-number replace and delete shorthand", () => {
		expect(applyPatch(FILE, "SWAP 2:\n+X")).toBe("a\nX\nc\nd\ne");
		expect(applyPatch(FILE, "DEL 2")).toBe("a\nc\nd\ne");
	});

	it("accepts alternate replace range separators and missing colon", () => {
		expect(applyPatch(FILE, "SWAP 2-3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2\u20263:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2 3:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2..3:\n+X")).toBe("a\nX\nd\ne"); // legacy `..` still accepted
		expect(applyPatch(FILE, "SWAP 2.=3\n+X")).toBe("a\nX\nd\ne"); // missing colon
		expect(applyPatch(FILE, "SWAP 2=3:\n+X")).toBe("a\nX\nd\ne"); // bare `=` (GLM drops dot from `.=`)
	});

	it("accepts missing colon on insert headers", () => {
		expect(applyPatch(FILE, "INS.PRE 2\n+X")).toBe("a\nX\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.HEAD\n+X")).toBe("X\na\nb\nc\nd\ne");
	});

	it("tolerates GLM 5.2 stray dot before the trailing colon", () => {
		// GLM 5.2 inserts a `.` between the line number/range and `:`,
		// e.g. `SWAP 2.=3.:` instead of `SWAP 2.=3:`.
		expect(applyPatch(FILE, "SWAP 2.=3.:\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2.=2.:\n+X")).toBe("a\nX\nc\nd\ne");
		// `INS.POST 2.:` instead of `INS.POST 2:`
		expect(applyPatch(FILE, "INS.POST 2.:\n+X")).toBe("a\nb\nX\nc\nd\ne");
		expect(applyPatch(FILE, "INS.PRE 2.:\n+X")).toBe("a\nX\nb\nc\nd\ne");
		// `DEL 2.=3.` instead of `DEL 2.=3` (stray dot, no colon)
		expect(applyPatch(FILE, "DEL 2.=3.")).toBe("a\nd\ne");
		// `INS.HEAD.:` and `INS.TAIL.:` with stray dot
		expect(applyPatch(FILE, "INS.HEAD.:\n+X")).toBe("X\na\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.TAIL.:\n+X")).toBe("a\nb\nc\nd\ne\nX");
	});

	it("tolerates GLM 5.2 stray equals after the trailing colon (N:=M:=)", () => {
		// GLM 5.2 merges range separator with header colon: `SWAP 293-301:=`
		// instead of `SWAP 293-301:` — trailing `=` after colon.
		expect(applyPatch(FILE, "SWAP 2.=3:=\n+X")).toBe("a\nX\nd\ne");
		expect(applyPatch(FILE, "SWAP 2.=2:=\n+X")).toBe("a\nX\nc\nd\ne");
		expect(applyPatch(FILE, "INS.POST 2:=\n+X")).toBe("a\nb\nX\nc\nd\ne");
		expect(applyPatch(FILE, "INS.PRE 2:=\n+X")).toBe("a\nX\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.HEAD:=\n+X")).toBe("X\na\nb\nc\nd\ne");
		expect(applyPatch(FILE, "INS.TAIL:=\n+X")).toBe("a\nb\nc\nd\ne\nX");
	});
});

describe("hashline body contracts", () => {
	it("auto-pipes a bare body row while warning", () => {
		const result = parsePatch("SWAP 2.=2:\n  hello");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n  hello\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("strips read-output line number prefix from auto-piped bare body rows", () => {
		const result = parsePatch("SWAP 2.=2:\n2:hello");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nhello\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});
	it("preserves `+N:` literal payloads without stripping", () => {
		const result = parsePatch("SWAP 2.=2:\n+3:keep");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n3:keep\nc\nd\ne");
		expect(result.warnings.some(w => /Auto-prefixed/.test(w))).toBe(false);
	});
	it("strips only one N: prefix from bare body rows (preserves nested digits:colon)", () => {
		// "2:42:hello" → should yield "42:hello", NOT "hello" (recursive would over-strip)
		const result = parsePatch("SWAP 2.=2:\n2:42:hello");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n42:hello\nc\nd\ne");
	});

	it("strips N: prefixes only when every bare body row carries one", () => {
		const result = parsePatch("SWAP 2.=3:\n2:foo\n3:bar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\nbar\nd\ne");
	});

	it("leaves bare body rows untouched when only some carry an N: prefix", () => {
		// "3:keep" looks like a snapshot prefix but "plain" does not, so the body
		// is genuine content (not a pasted snapshot) — strip nothing.
		const result = parsePatch("SWAP 2.=3:\n3:keep\nplain");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n3:keep\nplain\nd\ne");
	});

	it("keeps interior blank rows in a bare replace body", () => {
		const result = parsePatch("SWAP 2.=3:\nfoo\n\nbar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\n\nbar\nd\ne");
	});

	it("drops trailing blank rows between a bare body and the next hunk", () => {
		const result = parsePatch("SWAP 2.=2:\nfoo\n\nSWAP 4.=4:\nbaz");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\nc\nbaz\ne");
	});

	it("skips blank rows when checking N: prefix uniformity", () => {
		const result = parsePatch("SWAP 2.=3:\n2:foo\n\n3:bar");
		expect(applyEdits(FILE, result.edits).text).toBe("a\nfoo\n\nbar\nd\ne");
	});

	it("leaves numeric-keyed literal bodies untouched (dict/YAML shape)", () => {
		const result = parsePatch('SWAP 2.=3:\n1: "one",\n2: "two",');
		expect(applyEdits(FILE, result.edits).text).toBe('a\n1: "one",\n2: "two",\nd\ne');
	});

	it("rejects `-` body rows with a teaching error", () => {
		expect(() => parsePatch("SWAP 2.=2:\n-old\n+new")).toThrow(/`-` rows are not valid/);
	});
	it("auto-pipes a fully bare Markdown bullet body with a warning", () => {
		const result = parsePatch("SWAP 2.=2:\n- item\n  - nested");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n- item\n  - nested\nc\nd\ne");
		expect(result.warnings.some(w => /bullet row/.test(w))).toBe(true);
	});

	it("auto-pipes a bare bullet row next to explicit `+- item` siblings", () => {
		const result = parsePatch("SWAP 2.=2:\n+### Fixed\n+- one\n- two");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n### Fixed\n- one\n- two\nc\nd\ne");
		expect(result.warnings.some(w => /bullet row/.test(w))).toBe(true);
	});

	it("still rejects non-bullet bare `-` rows even in a fully bare body", () => {
		expect(() => parsePatch("SWAP 2.=2:\n-old()")).toThrow(/`-` rows are not valid/);
	});

	it("still rejects bullet-shaped `-` rows beside a plain `+new` row (diff paste)", () => {
		expect(() => parsePatch("SWAP 2.=2:\n- x\n+new()")).toThrow(/`-` rows are not valid/);
	});

	it("allows literal text that begins with `-` or `+` when prefixed with `+`", () => {
		expect(applyPatch(FILE, "SWAP 2.=2:\n+-literal\n++plus")).toBe("a\n-literal\n+plus\nc\nd\ne");
	});

	it("treats empty replace as delete and still rejects empty insert", () => {
		expect(applyPatch(FILE, "SWAP 2.=2:")).toBe("a\nc\nd\ne");
		expect(() => parsePatch("INS.TAIL:")).toThrow(/`INS` needs/);
	});

	it("rejects delete with a body", () => {
		expect(() => parsePatch("DEL 2\n+X")).toThrow(/does not take body rows/);
	});

	it("rejects delete with a colon", () => {
		expect(() => parsePatch("DEL 2:\n+X")).toThrow(/has no colon/);
	});
});

describe("hashline — apply_patch / unified-diff contamination", () => {
	it("rejects apply_patch sentinels as contamination", () => {
		expect(() => parsePatch("*** Update File: a.ts\nSWAP 2.=2:\n+X")).toThrow(/apply_patch sentinel/);
		expect(() => parsePatch("*** Add File: a.ts\nSWAP 2.=2:\n+X")).toThrow(/apply_patch sentinel/);
	});

	it("rejects unified-diff hunk headers as contamination", () => {
		expect(() => parsePatch("@@ -1,3 +1,3 @@\nSWAP 2.=2:\n+X")).toThrow(/unified-diff hunk header/);
	});

	it("detects read-tool line-number prefix without hunk header", () => {
		// Model pasted `38:if (foo)` — a read-tool snapshot line — without SWAP above
		expect(() => parsePatch("38:if (foo)")).toThrow(/line 38 content was pasted without a hunk header/);
		expect(() => parsePatch("45:  if (!pythonCmd) {")).toThrow(/Add `SWAP 45/);
		// With a pending hunk, `N:content` is a bare body row (existing leniency), not contamination
		expect(() => parsePatch("SWAP 2.=2:\n3:not_a_line_number_prefix")).not.toThrow(/pasted without a hunk header/);
	});

	it("detects truncated range header missing end number", () => {
		// Model wrote `86.=` then body on next line — separator but no end number
		expect(() => parsePatch("86.=\n+    const x = 1;")).toThrow(/truncated range .* missing the end line number/);
		expect(() => parsePatch("86.=\n+X")).toThrow(/SWAP 86/);
	});

	it("auto-recovers range header with inline content after colon", () => {
		// Model wrote `5.=5:import {...}` — range header + body on same line, no verb.
		// Auto-recover: split into `SWAP 5.=5:` + `+import {...}` body row.
		const patch = Patch.parse("[foo.ts#ABCD]\n5.=5:import { formatMoreItems } from '../tools/render-utils';");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits("a\nb\nc\nd\ne", patch.sections[0].edits).text).toBe(
			"a\nb\nc\nd\nimport { formatMoreItems } from '../tools/render-utils';",
		);
		// Also recovers `3.=3:const x = 1;`
		const patch2 = Patch.parse("[foo.ts#ABCD]\n3.=3:const x = 1;");
		expect(applyEdits("a\nb\nc\nd\ne", patch2.sections[0].edits).text).toBe("a\nb\nconst x = 1;\nd\ne");
		// Preserves indentation: `4.=4:    const y = 2;` keeps the 4-space indent
		const patch3 = Patch.parse("[foo.ts#ABCD]\n4.=4:    const y = 2;");
		expect(applyEdits("a\nb\nc\nd\ne", patch3.sections[0].edits).text).toBe("a\nb\nc\n    const y = 2;\ne");
	});

	it("splits merged `[path#TAG] OP` header onto separate lines", () => {
		// Model wrote `[foo.ts#ABCD] SWAP 2.=2:` on one line — split into header + op
		const patch = Patch.parse("[foo.ts#ABCD] SWAP 2.=2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("wraps missing brackets around path#TAG header", () => {
		// Model wrote `foo.ts#ABCD` without brackets — auto-wrap to [foo.ts#ABCD]
		const patch = Patch.parse("foo.ts#ABCD\nSWAP 2.=2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("does not wrap body rows that look like path#TAG", () => {
		// Body row `+config.ts#ABCD` should NOT be wrapped in brackets
		const patch = Patch.parse("[foo.ts#ABCD]\nSWAP 1.=1:\n++config.ts#ABCD");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("+config.ts#ABCD\nb\nc\nd\ne");
	});

	it("auto-prepends SWAP to bare range followed by body content", () => {
		// Model wrote `2.=2:` then body — auto-recover to SWAP 2.=2:
		const patch = Patch.parse("[foo.ts#ABCD]\n2.=2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("auto-prepends SWAP to N:=M: pattern (colon-equals separator)", () => {
		// Model wrote `2:=2:` — `:=` instead of `.=` — auto-recover to SWAP 2.=2:
		const patch = Patch.parse("[foo.ts#ABCD]\n2:=2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("auto-prepends SWAP to range with stray trailing dot (N.=M.:)", () => {
		// Model wrote `2.=2.:` — stray dot before colon — auto-recover to SWAP 2.=2:
		const patch = Patch.parse("[foo.ts#ABCD]\n2.=2.:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("auto-recovers misplaced verb (N SWAP M: → SWAP N.=M:)", () => {
		// Model wrote `2 SWAP 2:` — verb between numbers — auto-recover to SWAP 2.=2:
		const patch = Patch.parse("[foo.ts#ABCD]\n2 SWAP 2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("drops read-tool paste when SWAP for same line follows", () => {
		// Model wrote `2:old content` then `SWAP 2.=2:` — drop the paste, keep SWAP
		const patch = Patch.parse("[foo.ts#ABCD]\n2:b\nSWAP 2.=2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("drops multi-line paste block when SWAP for the same start line follows", () => {
		// Model pasted lines 2-4 then wrote SWAP 2.=4: — drop all paste lines
		const patch = Patch.parse("[foo.ts#ABCD]\n2:b\n3:c\n4:d\nSWAP 2.=4:\n+X\n+Y\n+Z");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nY\nZ\ne");
	});

	it("strips N: prefix when paste and SWAP header are merged on one line", () => {
		// Model wrote `2:SWAP 2.=2:` — paste + verb header on same line
		const patch = Patch.parse("[foo.ts#ABCD]\n2:SWAP 2.=2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("drops redundant bare range when next line is SWAP for the same range", () => {
		// Model wrote both `2.=2:` AND `SWAP 2.=2:` — drop the bare range, keep SWAP
		const patch = Patch.parse("[foo.ts#ABCD]\n2.=2:\nSWAP 2.=2:\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits(FILE, patch.sections[0].edits).text).toBe("a\nX\nc\nd\ne");
	});

	it("does not drop bare range when next line is verb for a DIFFERENT range", () => {
		// Model wrote `2.=2:` then `SWAP 3.=3:` — different ranges, keep bare range error
		expect(() => parsePatch("[foo.ts#ABCD]\n2.=2:\nSWAP 3.=3:\n+X")).toThrow(/bare range/);
	});

	it("recovers apply_patch === separator: paste + old/new → SWAP + new", () => {
		// Model wrote `3:old\n===\nnew` — old/new pair with === separator.
		// Recovery: convert paste to SWAP 3.=3:, drop old content and ===.
		const patch = Patch.parse("[cli.ts#BEE4]\n3:if (x !== 1) {\n===\nif (x !== 0) {");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits("a\nb\nif (x !== 1) {\n}", patch.sections[0].edits).text).toBe("a\nb\nif (x !== 0) {\n}");
	});

	it("recovers apply_patch === separator: multi-line paste → SWAP range + new", () => {
		// Model wrote `3:old\n4:old2\n===\nnew` — multiple paste lines before ===.
		// Recovery: pop both paste lines, synthesize SWAP 3.=4: covering the range.
		const patch = Patch.parse("[app.ts#BEE4]\n3:const a = 1;\n4:const b = 2;\n===\nconst x = 3;");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits("a\nb\nconst a = 1;\nconst b = 2;\nc", patch.sections[0].edits).text).toBe(
			"a\nb\nconst x = 3;\nc",
		);
	});

	it("recovers apply_patch === separator inside SWAP body: drop old, keep new", () => {
		// Model wrote SWAP with old content, ===, then new content.
		// Recovery: drop old content + ===, keep only new content as body.
		const patch = Patch.parse("[segs.ts#A104]\nSWAP 2.=2:\noldValue\n===\nnewValue");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits("a\noldValue\nc", patch.sections[0].edits).text).toBe("a\nnewValue\nc");
	});

	it("leaves === with no preceding verb as a no-op (guard preserves section header)", () => {
		// `===` right after section header with no op — guard prevents
		// popping the `[path#TAG]` header. The === is dropped; +X becomes
		// an orphan payload (no op header) which errors on edit access.
		const patch = Patch.parse("[foo.ts#ABCD]\n===\n+X");
		expect(patch.sections).toHaveLength(1);
		expect(patch.sections[0].path).toBe("foo.ts");
	});

	it("recovers bare `:` separator: paste + `:` + new → SWAP + new", () => {
		// Model wrote `3:old\n:\nnew` — old/new pair with bare `:` separator
		// (instead of `===`). Same recovery: convert paste to SWAP 3.=3:.
		const patch = Patch.parse("[cli.ts#BEE4]\n3:if (x !== 1) {\n:\nif (x !== 0) {");
		expect(patch.sections).toHaveLength(1);
		expect(applyEdits("a\nb\nif (x !== 1) {\n}", patch.sections[0].edits).text).toBe("a\nb\nif (x !== 0) {\n}");
	});

	it("treats top-level `+TEXT` as an orphan literal payload", () => {
		expect(() => parsePatch("+const X = 1;\nSWAP 2.=2:")).toThrow(/payload line has no preceding hunk header/);
	});
});

describe("hashline apply — duplicate boundary payloads", () => {
	it("keeps replacement boundary echoes literal unless balance repair applies", () => {
		const text = ["// one", "// two", "old();"].join("\n");
		const diff = "SWAP 3.=3:\n+// one\n+// two\n+new();";
		expect(applyPatch(text, diff)).toBe(["// one", "// two", "// one", "// two", "new();"].join("\n"));
	});

	it("keeps pure-insert context echoes literal", () => {
		const text = ["aaa", "bbb", "ccc"].join("\n");
		const diff = "INS.TAIL:\n+bbb\n+ccc\n+NEW";
		expect(applyPatch(text, diff)).toBe("aaa\nbbb\nccc\nbbb\nccc\nNEW");
	});
});

describe("hashline — truncated verb recovery", () => {
	it("recovers SWAP N.= as single-line swap", () => {
		const text = ["line1", "line2", "line3"].join("\n");
		const section = Patch.parseSingle("[f.ts#1A2B]\nSWAP 2.=\n+replaced");
		expect(section.applyTo(text).text).toBe("line1\nreplaced\nline3");
	});

	it("recovers DEL N.= as single-line delete", () => {
		const text = ["line1", "line2", "line3"].join("\n");
		const section = Patch.parseSingle("[f.ts#1A2B]\nDEL 2.=");
		expect(section.applyTo(text).text).toBe("line1\nline3");
	});

	it("recovers SWAP N.=: with trailing colon", () => {
		const text = ["line1", "line2", "line3"].join("\n");
		const section = Patch.parseSingle("[f.ts#1A2B]\nSWAP 2.=:\n+replaced");
		expect(section.applyTo(text).text).toBe("line1\nreplaced\nline3");
	});

	it("does not regress SWAP N.=M: (valid range)", () => {
		const text = ["line1", "line2", "line3"].join("\n");
		const section = Patch.parseSingle("[f.ts#1A2B]\nSWAP 1.=2:\n+replaced1\n+replaced2");
		expect(section.applyTo(text).text).toBe("replaced1\nreplaced2\nline3");
	});
});

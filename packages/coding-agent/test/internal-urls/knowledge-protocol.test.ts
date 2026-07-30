import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	InternalUrlRouter,
	IssuesProtocolHandler,
	KnowledgeProtocolHandler,
	PatchProtocolHandler,
	parseInternalUrl,
} from "@oh-my-pi/pi-coding-agent/internal-urls";
import { getKnowledgeRoot } from "@oh-my-pi/pi-coding-agent/session/knowledge-index";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-protocol-"));
	try {
		return await fn(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("InternalUrlRouter native protocol registrations", () => {
	beforeEach(() => {
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
	});

	it("registers knowledge://, issues://, and patch:// as native handlers", () => {
		const router = InternalUrlRouter.instance();
		const protocols = [
			["knowledge", KnowledgeProtocolHandler],
			["issues", IssuesProtocolHandler],
			["patch", PatchProtocolHandler],
		] as const;

		for (const [scheme, handlerClass] of protocols) {
			const handler = router.getHandler(scheme);
			expect(handler).toBeInstanceOf(handlerClass);
			expect(handler?.scheme).toBe(scheme);
			expect(router.canHandle(`${scheme}://`)).toBe(true);
		}
	});
});

describe("KnowledgeProtocolHandler", () => {
	beforeEach(() => {
		InternalUrlRouter.resetForTests();
	});

	afterEach(() => {
		InternalUrlRouter.resetForTests();
	});

	it("reads project knowledge files through knowledge://", async () => {
		await withTempDir(async dir => {
			const knowledgePath = path.join(getKnowledgeRoot(dir), "runtime", "background-jobs.md");
			await Bun.write(
				knowledgePath,
				"---\ndescription: runtime, background jobs\n---\n\n# Background Jobs\n\n- Durable fact.\n",
			);

			const resource = await InternalUrlRouter.instance().resolve("knowledge://runtime/background-jobs.md", {
				cwd: dir,
			});

			expect(resource.content).toContain("# Background Jobs");
			expect(resource.contentType).toBe("text/markdown");
			expect(resource.sourcePath).toBe(knowledgePath);
			expect(resource.immutable).toBe(false);
		});
	});

	it("lists knowledge notes at the root and category URLs", async () => {
		await withTempDir(async dir => {
			await Bun.write(
				path.join(getKnowledgeRoot(dir), "runtime", "background-jobs.md"),
				"---\ndescription: runtime, background jobs\n---\n\n# Background Jobs\n",
			);

			const root = await InternalUrlRouter.instance().resolve("knowledge://", { cwd: dir });
			const category = await InternalUrlRouter.instance().resolve("knowledge://runtime", { cwd: dir });

			expect(root.content).toContain("knowledge://runtime/background-jobs.md");
			expect(category.content).toContain("knowledge://runtime/background-jobs.md");
			expect(root.immutable).toBe(true);
			expect(root.sourcePath).toBe(getKnowledgeRoot(dir));
			expect(category.sourcePath).toBe(path.join(getKnowledgeRoot(dir), "runtime"));
		});
	});

	it("writes knowledge files and normalizes retrieval-tag frontmatter", async () => {
		await withTempDir(async dir => {
			const handler = InternalUrlRouter.instance().getHandler("knowledge");
			if (!handler?.write) throw new Error("knowledge handler must be writable");

			const result = await handler.write(
				parseInternalUrl("knowledge://runtime/background-jobs.md"),
				"# Background Jobs\n\n- Completion deliveries wait for pending async work.\n",
				{ cwd: dir },
			);

			expect(result?.text).toContain("Wrote knowledge://runtime/background-jobs.md");
			const written = await Bun.file(path.join(getKnowledgeRoot(dir), "runtime", "background-jobs.md")).text();
			const { frontmatter } = parseFrontmatter(written, { source: "knowledge://runtime/background-jobs.md" });
			expect(frontmatter.description).toBe(
				"runtime, background jobs, Completion deliveries wait, pending async work",
			);
			expect(written).toContain("# Background Jobs");
		});
	});

	it("rejects traversal and non-note paths", async () => {
		await withTempDir(async dir => {
			await expect(
				InternalUrlRouter.instance().resolve("knowledge://runtime/nested/topic.md", { cwd: dir }),
			).rejects.toThrow("knowledge:// path must be <category>/<topic>.md");
			await expect(InternalUrlRouter.instance().resolve("knowledge://../secret.md", { cwd: dir })).rejects.toThrow(
				"knowledge:// category must be a non-hidden relative path segment",
			);
		});
	});
});

/**
 * `secrets-managed.yml` is no longer written by any command, but files written
 * by earlier versions must keep loading alongside hand-authored secrets.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSecrets } from "@oh-my-pi/pi-coding-agent/secrets/index";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";

describe("existing managed secrets files", () => {
	it("merge with hand-authored secrets", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-agent-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-cwd-"));
		try {
			await Bun.write(path.join(agentDir, "secrets.yml"), '- { type: plain, content: "HANDWRITTEN" }\n');
			await Bun.write(
				path.join(agentDir, "secrets-managed.yml"),
				`- { type: regex, content: "SecretCorp", mode: obfuscate, friendlyName: Company }
- { type: regex, content: "OtherTerm" }
`,
			);

			const merged = await loadSecrets(cwd, agentDir);
			expect(merged.map(entry => entry.content).sort()).toEqual(["HANDWRITTEN", "OtherTerm", "SecretCorp"]);
			expect(merged.find(entry => entry.content === "SecretCorp")?.friendlyName).toBe("Company");
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("load when the project .omp directory is absent", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-agent-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-cwd-"));
		const projectDir = path.join(cwd, ".omp");
		try {
			await fs.rm(projectDir, { recursive: true, force: true });
			await Bun.write(path.join(agentDir, "secrets-managed.yml"), '- { type: regex, content: "AGENT_ONLY" }\n');

			const loaded = await loadSecrets(cwd, agentDir);
			expect(loaded.map(entry => entry.content)).toEqual(["AGENT_ONLY"]);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("load once when agentDir is the project .omp directory", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-cwd-"));
		const agentDir = path.join(cwd, ".omp");
		try {
			await fs.mkdir(agentDir, { recursive: true });
			await Bun.write(
				path.join(agentDir, "secrets-managed.yml"),
				`- { type: regex, content: "SAME_PATH_FIRST" }
- { type: plain, content: "SAME_PATH_SECOND" }
`,
			);

			const loaded = await loadSecrets(cwd, agentDir);
			expect(loaded.map(entry => ({ type: entry.type, content: entry.content }))).toEqual([
				{ type: "regex", content: "SAME_PATH_FIRST" },
				{ type: "plain", content: "SAME_PATH_SECOND" },
			]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("wait for the managed-file lock before reading a partial write", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-agent-"));
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-cwd-"));
		const managedPath = path.join(agentDir, "secrets-managed.yml");
		const lockHeld = Promise.withResolvers<void>();
		const releaseLock = Promise.withResolvers<void>();
		let lockTask: Promise<void> | undefined;
		try {
			lockTask = withFileLock(managedPath, async () => {
				await fs.writeFile(managedPath, '[{ type: regex, content: "partial');
				lockHeld.resolve();
				await releaseLock.promise;
				await fs.writeFile(managedPath, '- { type: regex, content: "LOCKED_VALID" }\n');
			});
			await lockHeld.promise;

			let settled = false;
			const loaded = loadSecrets(cwd, agentDir).then(secrets => {
				settled = true;
				return secrets;
			});
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(settled).toBe(false);

			releaseLock.resolve();
			await lockTask;
			const secrets = await loaded;
			expect(secrets.some(entry => entry.type === "regex" && entry.content === "LOCKED_VALID")).toBe(true);
		} finally {
			releaseLock.resolve();
			await lockTask?.catch(() => {});
			await fs.rm(agentDir, { recursive: true, force: true });
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});

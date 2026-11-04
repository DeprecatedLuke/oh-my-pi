/**
 * Tests for dotenv-file secret collection in the session cwd.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSecretObfuscator, collectDotenvFileSecrets } from "@oh-my-pi/pi-coding-agent/secrets";
import { obfuscateProviderContext } from "@oh-my-pi/pi-coding-agent/secrets/message-transform";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

/** Unique per call so values autoloaded into process.env from the repo's own `.env` cannot collide. */
function uniqueSecret(prefix: string): string {
	return `${prefix}${crypto.randomBytes(16).toString("hex")}`;
}

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter(c => c.type === "text" && typeof c.text === "string")
		.map(c => c.text as string)
		.join("\n");
}

function createReadTool(cwd: string, obfuscator: SecretObfuscator, enabled = true): ReadTool {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getSessionSpawns: () => "*",
		getArtifactsDir: () => path.join(cwd, "session"),
		getObfuscator: () => obfuscator,
		settings: Settings.isolated({ "secrets.enabled": enabled }),
	};
	return new ReadTool(session);
}

function outboundReadText(obfuscator: SecretObfuscator, text: string): string {
	const context = obfuscateProviderContext(obfuscator, {
		messages: [
			{
				role: "toolResult",
				toolCallId: "dotenv-read",
				toolName: "read",
				content: [{ type: "text", text }],
				isError: false,
				timestamp: 1,
			},
		],
	});
	const message = context.messages[0];
	if (message?.role !== "toolResult") throw new Error("expected a read tool result");
	return getTextOutput(message);
}

describe("dotenv file secrets", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-secrets-dotenv-"));
		cwd = path.join(root, "cwd");
		agentDir = path.join(root, "agent");
		await fs.mkdir(cwd);
		await fs.mkdir(agentDir);
	});

	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it("masks secret-named .env values in the session obfuscator while leaving ordinary config intact", async () => {
		const token = uniqueSecret("tok");
		await fs.writeFile(path.join(cwd, ".env"), `API_TOKEN=${token}\nNODE_ENV=development-long\n`);

		const obfuscator = await buildSecretObfuscator(cwd, agentDir, agentDir);
		if (!obfuscator) throw new Error("expected an obfuscator for a cwd with dotenv secrets");
		const masked = obfuscator.obfuscate(`auth header uses ${token} in development-long mode`);

		expect(masked).not.toContain(token);
		expect(masked).toContain("development-long");
	});

	it("reads only top-level non-template dotenv files and dedupes repeated values", async () => {
		const prodKey = uniqueSecret("prod");
		const localSecret = uniqueSecret("local");
		const exampleKey = uniqueSecret("example");
		const nestedKey = uniqueSecret("nested");
		const dirFileKey = uniqueSecret("dirfile");
		await fs.writeFile(path.join(cwd, "prod.env"), `STRIPE_KEY=${prodKey}\n`);
		// The same value repeated in a second file must surface once.
		await fs.writeFile(path.join(cwd, ".env.local"), `CLIENT_SECRET=${localSecret}\nDUP_KEY=${prodKey}\n`);
		await fs.writeFile(path.join(cwd, ".env.example"), `API_KEY=${exampleKey}\n`);
		await fs.mkdir(path.join(cwd, "sub"));
		await fs.writeFile(path.join(cwd, "sub", ".env"), `API_KEY=${nestedKey}\n`);
		// A directory with a dotenv-shaped name is not a file to parse.
		await fs.mkdir(path.join(cwd, "dir.env"));
		await fs.writeFile(path.join(cwd, "dir.env", ".env"), `API_KEY=${dirFileKey}\n`);

		const contents = (await collectDotenvFileSecrets(cwd)).map(entry => entry.content);

		expect(contents.sort()).toEqual([localSecret, prodKey].sort());
	});

	it("collects connection-URL passwords from non-secret-named variables, raw and percent-decoded", async () => {
		const password = uniqueSecret("pw");
		const encodedPassword = `${uniqueSecret("enc")}%40x`;
		await fs.writeFile(
			path.join(cwd, ".env"),
			`DATABASE_URL=postgres://user:${password}@db.internal:5432/app\nCACHE_URL=redis://u:${encodedPassword}@cache/0\n`,
		);

		const contents = (await collectDotenvFileSecrets(cwd)).map(entry => entry.content);

		expect(contents.sort()).toEqual([password, encodedPassword, decodeURIComponent(encodedPassword)].sort());
	});

	it("returns no entries when cwd does not exist", async () => {
		await expect(collectDotenvFileSecrets(path.join(root, "missing"))).resolves.toEqual([]);
	});

	it("masks nested dotenv reads and later-created files at provider egress without changing local output", async () => {
		const firstSecret = "fixture-singapore-two-auth-9416";
		const secondSecret = "fixture-singapore-three-password-5827";
		const region = "fixture-singapore-region";
		const firstPath = ".secrets/vpn/singapore-2.env";
		const secondPath = ".secrets/vpn/singapore-3.env";
		await fs.mkdir(path.join(cwd, ".secrets", "vpn"), { recursive: true });
		await fs.writeFile(path.join(cwd, firstPath), `VPN_AUTH=${firstSecret}\nVPN_REGION=${region}\n`);
		const obfuscator = new SecretObfuscator([], "dotenv-runtime-test-key");
		const tool = createReadTool(cwd, obfuscator);

		// Opening a nested file discovers the first secret even without preconfigured entries.
		expect(outboundReadText(obfuscator, firstSecret)).toBe(firstSecret);
		const first = await tool.execute("nested-dotenv", { path: firstPath });
		const firstText = getTextOutput(first);
		const firstOutbound = outboundReadText(obfuscator, firstText);
		expect(firstText).toContain(`VPN_AUTH=${firstSecret}`);
		expect(firstOutbound).not.toContain(firstSecret);
		expect(firstOutbound).toContain(`VPN_REGION=${region}`);
		expect(obfuscator.deobfuscate(firstOutbound)).toBe(firstText);
		expect(getTextOutput(first)).toBe(firstText);

		await fs.writeFile(
			path.join(cwd, secondPath),
			`VPN_PASSWORD=${secondSecret}\nDUPLICATE_TOKEN=${firstSecret}\nVPN_REGION=${region}\n`,
		);
		const second = await tool.execute("late-dotenv", { path: secondPath });
		const secondText = getTextOutput(second);
		const secondOutbound = outboundReadText(obfuscator, secondText);
		expect(secondText).toContain(`VPN_PASSWORD=${secondSecret}`);
		expect(secondOutbound).not.toContain(secondSecret);
		expect(secondOutbound).not.toContain(firstSecret);
		expect(secondOutbound).toContain(`VPN_REGION=${region}`);
		expect(obfuscator.deobfuscate(secondOutbound)).toBe(secondText);
		expect(getTextOutput(second)).toBe(secondText);

		await tool.execute("nested-dotenv-again", { path: firstPath });
		expect(outboundReadText(obfuscator, firstText)).toBe(firstOutbound);
		expect(obfuscator.deobfuscate(firstOutbound)).toBe(firstText);
	});

	it("registers secrets outside a selected dotenv line before subsequent provider-bound reads", async () => {
		const visibleSecret = "fixture-selected-vpn-token-3691";
		const hiddenSecret = "fixture-unselected-vpn-password-8274";
		const relativePath = ".secrets/vpn/singapore-2.env";
		await fs.mkdir(path.join(cwd, ".secrets", "vpn"), { recursive: true });
		await fs.writeFile(
			path.join(cwd, relativePath),
			`VPN_TOKEN=${visibleSecret}\nVPN_REGION=fixture-singapore-region\nVPN_PASSWORD=${hiddenSecret}\n`,
		);
		await fs.writeFile(path.join(cwd, "connection.txt"), `connect using ${hiddenSecret}\n`);
		const obfuscator = await buildSecretObfuscator(cwd, agentDir, agentDir);
		if (!obfuscator) throw new Error("expected the session obfuscator");
		const tool = createReadTool(cwd, obfuscator);

		const selected = await tool.execute("partial-dotenv", { path: `${relativePath}:1:raw` });
		const selectedText = getTextOutput(selected);
		expect(selectedText).toBe(`VPN_TOKEN=${visibleSecret}`);
		const selectedOutbound = outboundReadText(obfuscator, selectedText);
		expect(selectedOutbound).not.toContain(visibleSecret);
		expect(obfuscator.deobfuscate(selectedOutbound)).toBe(selectedText);

		const connection = await tool.execute("connection-note", { path: "connection.txt" });
		const connectionText = getTextOutput(connection);
		const connectionOutbound = outboundReadText(obfuscator, connectionText);
		expect(connectionText).toContain(hiddenSecret);
		expect(connectionOutbound).not.toContain(hiddenSecret);
		expect(obfuscator.deobfuscate(connectionOutbound)).toBe(connectionText);
	});

	it("leaves dotenv read output raw and does not register values while Hide Secrets is disabled", async () => {
		const secret = "fixture-disabled-vpn-password-1748";
		const priorSecret = "fixture-existing-auth-3841";
		const relativePath = ".secrets/vpn/singapore-3.env";
		await fs.mkdir(path.join(cwd, ".secrets", "vpn"), { recursive: true });
		await fs.writeFile(path.join(cwd, relativePath), `VPN_AUTH=${priorSecret}\nVPN_PASSWORD=${secret}\n`);
		const obfuscator = new SecretObfuscator([{ type: "plain", content: priorSecret }], "dotenv-runtime-test-key");
		obfuscator.setObfuscating(false);
		const tool = createReadTool(cwd, obfuscator, false);

		const result = await tool.execute("disabled-dotenv", { path: relativePath });
		const text = getTextOutput(result);
		expect(text).toContain(`VPN_PASSWORD=${secret}`);
		expect(text).toContain(`VPN_AUTH=${priorSecret}`);
		expect(outboundReadText(obfuscator, text)).toBe(text);

		obfuscator.setObfuscating(true);
		const enabledOutbound = outboundReadText(obfuscator, text);
		expect(enabledOutbound).not.toContain(priorSecret);
		expect(enabledOutbound).toContain(`VPN_PASSWORD=${secret}`);
		expect(obfuscator.deobfuscate(enabledOutbound)).toBe(text);
	});

	it("registers context-bound regex secrets as literals without losing batch mappings or replacements", () => {
		const regexSecret = "runtime-regex-1947";
		const addedSecret = "runtime-added-8624";
		const replacedSecret = "runtime-replace-6293";
		const replacement = "neutral-replacement";
		const obfuscator = new SecretObfuscator(
			[
				{ type: "regex", content: "runtime-regex-[0-9]+(?=;)", friendlyName: "existing" },
				{ type: "plain", content: replacedSecret, mode: "replace", replacement },
			],
			"dotenv-runtime-test-key",
		);
		const originalToken = obfuscator.obfuscate(`${regexSecret};`).slice(0, -1);
		expect(originalToken).not.toContain(regexSecret);
		expect(obfuscator.obfuscate(regexSecret)).toBe(regexSecret);
		expect(obfuscator.obfuscate(replacedSecret)).toBe(replacement);
		const additions = [addedSecret, regexSecret, replacedSecret].map(content => ({
			type: "plain" as const,
			content,
		}));

		obfuscator.batch(() => {
			expect(obfuscator.obfuscate(addedSecret)).toBe(addedSecret);
			obfuscator.registerPlainSecrets(additions);
			const addedToken = obfuscator.obfuscate(addedSecret);
			expect(addedToken).not.toContain(addedSecret);
			expect(obfuscator.deobfuscate(addedToken)).toBe(addedSecret);
			expect(obfuscator.obfuscate(regexSecret)).toBe(originalToken);
			expect(obfuscator.deobfuscate(originalToken)).toBe(regexSecret);
			expect(obfuscator.obfuscate(replacedSecret)).toBe(replacement);

			obfuscator.registerPlainSecrets(additions);
			expect(obfuscator.obfuscate(addedSecret)).toBe(addedToken);
			expect(obfuscator.deobfuscate(addedToken)).toBe(addedSecret);
			expect(obfuscator.obfuscate(regexSecret)).toBe(originalToken);
			expect(obfuscator.deobfuscate(originalToken)).toBe(regexSecret);
			expect(obfuscator.obfuscate(replacedSecret)).toBe(replacement);
		});
	});
});

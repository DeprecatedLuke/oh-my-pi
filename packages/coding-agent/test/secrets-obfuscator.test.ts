/**
 * Tests for secrets regex parsing, compilation, and obfuscation.
 */

import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "../src/secrets/obfuscator";
import { compileSecretRegex } from "../src/secrets/regex";

describe("compileSecretRegex", () => {
	it("parses regex literals with flags and enforces global scanning", () => {
		const regex = compileSecretRegex("/api[_-]?key\\s*=\\s*\\w+/gi");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("gi");
	});

	it("handles escaped / in regex literals", () => {
		const regex = compileSecretRegex("/foo\\/bar/i");
		expect(regex.source).toBe("foo\\/bar");
		expect(regex.flags).toBe("gi");
	});

	it("preserves legacy bare patterns", () => {
		const regex = compileSecretRegex("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.source).toBe("api[_-]?key\\s*=\\s*\\w+");
		expect(regex.flags).toBe("g");
	});

	it("rejects unterminated regex literal syntax", () => {
		expect(() => compileSecretRegex("/unterminated")).toThrow("unterminated regex literal");
	});

	it("rejects invalid regex flags", () => {
		expect(() => compileSecretRegex("/x/zz")).toThrow();
	});
});

describe("SecretObfuscator regex behavior", () => {
	it("obfuscates and deobfuscates one-liner regex matches", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "/api[_-]?key\\s*=\\s*\\w+/i" }]);

		const original = "API_KEY=abc and api-key=def";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toEqual(original);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(original);
	});

	it("supports legacy bare regex patterns without delimiters", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "api[_-]?key\\s*=\\s*\\w+" }]);

		const original = "api_key=abc and API_KEY=def";
		const obfuscated = obfuscator.obfuscate(original);
		expect(obfuscated).not.toEqual(original);
		expect(obfuscator.deobfuscate(obfuscated)).toEqual(original);
	});

	it("deobfuscates placeholders through object payloads", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "/api[_-]?key\\s*=\\s*\\w+/i" }]);
		const original = {
			cmd: "API_KEY=abc and api-key=def",
			status: "ok",
		};

		const obfuscated = {
			cmd: obfuscator.obfuscate(original.cmd),
			status: original.status,
		};

		expect(obfuscator.deobfuscateObject(obfuscated)).toEqual({
			cmd: original.cmd,
			status: original.status,
		});
	});
});

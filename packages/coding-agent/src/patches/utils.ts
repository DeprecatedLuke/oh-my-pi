import * as fs from "node:fs/promises";
import * as path from "node:path";
import { pathIsWithin } from "@oh-my-pi/pi-utils";
import type { NativePatchManifest } from "./types";

const HASH_RE = /^[0-9a-f]{64}$/;
const WINDOWS_SEP_RE = /\\/g;

export function toPosixPath(value: string): string {
	return value.replace(WINDOWS_SEP_RE, "/");
}

export function normalizeRelativePath(value: string): string {
	const normalized = path.posix.normalize(toPosixPath(value).replace(/^\/+/, ""));
	if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
		throw new Error(`invalid patch path: ${value}`);
	}
	return normalized;
}

export function isPathInsideOrEqual(root: string, candidate: string): boolean {
	return pathIsWithin(path.resolve(root), path.resolve(candidate));
}

export function comparePaths(a: string, b: string): number {
	return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

export function hasGitSegment(relativePath: string): boolean {
	return toPosixPath(relativePath)
		.split("/")
		.some(segment => segment === ".git");
}

export function isHash(value: string | undefined): value is string {
	return typeof value === "string" && HASH_RE.test(value);
}

export function nowIso(): string {
	return new Date().toISOString();
}

export function cloneManifest(manifest: NativePatchManifest): NativePatchManifest {
	return JSON.parse(JSON.stringify(manifest)) as NativePatchManifest;
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
	return JSON.parse(await Bun.file(filePath).text()) as T;
}

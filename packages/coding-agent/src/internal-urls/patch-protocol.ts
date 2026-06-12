import * as path from "node:path";
import {
	formatRepoLabel,
	type NativePatchManifest,
	readNativePatch,
	readPatchVirtualFile,
	resolveNativePatchStore,
	validateNativePatch,
	writePatchVirtualFile,
} from "../patches";
import type {
	InternalResource,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	WriteContext,
	WriteResult,
} from "./types";

interface PatchUrlParts {
	patchId: string;
	relativePath?: string;
}

function contextCwd(context: ResolveContext | WriteContext | undefined): string {
	return context?.cwd ?? process.cwd();
}

function decodeUrlComponent(value: string, label: string, href: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		throw new Error(`Invalid URL encoding in patch://${label}: ${href}`);
	}
}

function validatePatchRelativePath(relativePath: string): void {
	if (!relativePath || relativePath.endsWith("/")) {
		throw new Error("patch:// file URL must target a file inside the patch");
	}
	if (path.posix.isAbsolute(relativePath)) {
		throw new Error("Absolute paths are not allowed in patch:// URLs");
	}
	const normalized = path.posix.normalize(relativePath);
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new Error("Path traversal (..) is not allowed in patch:// URLs");
	}
}

function extractPatchUrl(url: InternalUrl): PatchUrlParts {
	const rawHost = url.rawHost || url.hostname;
	const rawPathname = url.rawPathname ?? url.pathname ?? "";
	if (rawHost) {
		const patchId = decodeUrlComponent(rawHost, "patch id", url.href).trim();
		if (!patchId) throw new Error("patch:// URL requires a patch id: patch://<patchId>");
		const relativePath = extractRelativePath(rawPathname, url.href);
		return relativePath ? { patchId, relativePath } : { patchId };
	}

	const pathname = rawPathname.startsWith("/") ? rawPathname.slice(1) : rawPathname;
	const slash = pathname.indexOf("/");
	const rawPatchId = slash === -1 ? pathname : pathname.slice(0, slash);
	const patchId = decodeUrlComponent(rawPatchId, "patch id", url.href).trim();
	if (!patchId) throw new Error("patch:// URL requires a patch id: patch://<patchId>");
	const rawRelativePath = slash === -1 ? "" : pathname.slice(slash + 1);
	const relativePath = rawRelativePath ? decodeUrlComponent(rawRelativePath, "file path", url.href) : undefined;
	if (relativePath) validatePatchRelativePath(relativePath);
	return relativePath ? { patchId, relativePath } : { patchId };
}

function extractRelativePath(rawPathname: string, href: string): string | undefined {
	if (!rawPathname || rawPathname === "/") return undefined;
	const rawPath = rawPathname.startsWith("/") ? rawPathname.slice(1) : rawPathname;
	const relativePath = decodeUrlComponent(rawPath.replaceAll("\\", "/"), "file path", href);
	validatePatchRelativePath(relativePath);
	return relativePath;
}

function encodePatchFileUrl(patchId: string, relativePath: string): string {
	return `patch://${encodeURIComponent(patchId)}/${relativePath.split("/").map(encodeURIComponent).join("/")}`;
}

function getContentType(filePath: string): InternalResource["contentType"] {
	const ext = path.extname(filePath).toLowerCase();
	if (ext === ".md") return "text/markdown";
	if (ext === ".json") return "application/json";
	return "text/plain";
}

function firstLine(value: string | undefined): string | undefined {
	const line = value?.trim().split("\n")[0]?.trim();
	return line || undefined;
}

function manifestFiles(manifest: NativePatchManifest): string[] {
	return manifest.files.map(file => file.path).filter(file => file.length > 0);
}

function renderPatchManifest(cwd: string, manifest: NativePatchManifest, validationText: string | undefined): string {
	const repoPath = manifest.repoRoot ?? manifest.targetRoot ?? cwd;
	const label = `${formatRepoLabel(cwd, repoPath)}/${manifest.id}`;
	const lines: string[] = [`# ${label}`, ""];
	lines.push(`Status: ${manifest.status}`);
	const description = firstLine(manifest.description);
	if (description) lines.push(`Description: ${description}`);
	if (manifest.taskId) lines.push(`Task: ${manifest.taskId}`);
	const message = firstLine(manifest.message);
	if (message) lines.push(`Message: ${message}`);
	if (manifest.createdAt) lines.push(`Created: ${manifest.createdAt}`);
	if (manifest.updatedAt) lines.push(`Updated: ${manifest.updatedAt}`);
	if (manifest.appliedAt) lines.push(`Applied: ${manifest.appliedAt}`);
	if (manifest.droppedAt) lines.push(`Dropped: ${manifest.droppedAt}`);
	if (validationText) lines.push(`Validation: ${validationText}`);

	const files = manifestFiles(manifest);
	lines.push("", `Files (${files.length}):`);
	if (files.length === 0) {
		lines.push("- none");
	} else {
		for (const file of files) lines.push(`- [${file}](${encodePatchFileUrl(manifest.id, file)})`);
	}

	const conflicts = Array.isArray(manifest.conflicts) ? manifest.conflicts : [];
	if (conflicts.length > 0) {
		lines.push("", `Conflicts (${conflicts.length}):`);
		for (const conflict of conflicts) {
			const pathValue =
				typeof conflict === "object" && conflict && "path" in conflict ? String(conflict.path) : String(conflict);
			const reason =
				typeof conflict === "object" && conflict && "reason" in conflict ? ` — ${String(conflict.reason)}` : "";
			lines.push(`- [${pathValue}](${encodePatchFileUrl(manifest.id, pathValue)})${reason}`);
		}
	}
	lines.push("");
	return lines.join("\n");
}

export class PatchProtocolHandler implements ProtocolHandler {
	readonly scheme = "patch";
	readonly immutable = false;

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const cwd = contextCwd(context);
		const { patchId, relativePath } = extractPatchUrl(url);
		const store = await resolveNativePatchStore(cwd, patchId);

		if (relativePath) {
			const content = await readPatchVirtualFile(store, patchId, relativePath);
			const sourcePath = encodePatchFileUrl(patchId, relativePath);
			return {
				url: sourcePath,
				content,
				contentType: getContentType(relativePath),
				size: Buffer.byteLength(content, "utf-8"),
				sourcePath,
				notes: [
					"Edit patch://<patchId>/<file> only when this patch is in `pending`/`conflicted` state without conflict markers materialized in the target. For markers-written conflicts (most common), resolve the target file via conflict://<N> and re-run the patch tool with op apply.",
				],
			};
		}

		const manifest = await readNativePatch(store, patchId);
		let validationText: string | undefined;
		try {
			const validation = await validateNativePatch(store, patchId, { cwd, signal: context?.signal });
			validationText = validation.valid
				? "valid"
				: `${validation.conflicts.length} ${validation.conflicts.length === 1 ? "conflict" : "conflicts"}`;
		} catch (error) {
			validationText = `unavailable (${error instanceof Error ? error.message : String(error)})`;
		}
		const content = renderPatchManifest(cwd, manifest, validationText);
		return {
			url: `patch://${encodeURIComponent(patchId)}`,
			content,
			contentType: "text/markdown",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [
				"For conflicts where markers were materialized in target files, resolve each conflict region via conflict://<N> and re-run the patch tool with op apply. Edit patch://<patchId>/<file> only for plain conflicts that cannot be merged (binary, missing target, etc.).",
			],
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<WriteResult> {
		const cwd = contextCwd(context);
		const { patchId, relativePath } = extractPatchUrl(url);
		const store = await resolveNativePatchStore(cwd, patchId);
		if (!relativePath) {
			throw new Error("patch:// root is read-only; write patch://<patchId>/<file> to edit patch content.");
		}
		const text = await writePatchVirtualFile(store, patchId, relativePath, content, {
			cwd,
			signal: context?.signal,
		});
		return { text };
	}
}

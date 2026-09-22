import type { default as PuppeteerInstance, Puppeteer as PuppeteerClass } from "puppeteer-core";
import "./page-dom-types";

interface QueryDocument {
	getElementById(id: string): QueryElement | null;
	querySelectorAll(selector: string): readonly QueryElement[];
}

interface QueryElement {
	readonly textContent: string | null;
	readonly id: string;
	readonly tagName: string;
	readonly type?: string;
	readonly value?: string;
	readonly multiple?: boolean;
	readonly size?: number;
	getAttribute(name: string): string | null;
	hasAttribute(name: string): boolean;
	readonly ownerDocument?: QueryDocument;
	querySelector(selector: string): QueryElement | null;
	closest(selector: string): QueryElement | null;
}

interface QueryRoot {
	querySelectorAll(selector: string): readonly QueryElement[];
	contains(element: QueryElement): boolean;
}

/** Register the browser tool's semantic selector prefixes on a worker-local Puppeteer instance. */
export function registerSemanticQueryHandlers(puppeteer: typeof PuppeteerInstance): void {
	const Puppeteer = puppeteer.constructor as typeof PuppeteerClass;
	const registered = new Set(Puppeteer.customQueryHandlerNames());
	if (!registered.has("label")) {
		Puppeteer.registerCustomQueryHandler("label", {
			queryAll(node, selector) {
				const root = node as unknown as QueryRoot;
				const wanted = selector.trim().toLocaleLowerCase();
				const matches = (value: string | null | undefined): boolean =>
					(value ?? "").trim().toLocaleLowerCase().includes(wanted);
				const elements = Array.from(root.querySelectorAll("*"));
				const result: QueryElement[] = [];
				const seen = new Set<QueryElement>();
				const add = (element: QueryElement | null): void => {
					if (element && !seen.has(element)) {
						seen.add(element);
						result.push(element);
					}
				};
				for (const label of root.querySelectorAll("label")) {
					if (!matches(label.textContent)) continue;
					const htmlFor = label.getAttribute("for");
					if (htmlFor) {
						const target = label.ownerDocument?.getElementById(htmlFor) ?? null;
						if (target && (node === target || root.contains(target))) {
							add(target);
						}
					} else {
						const control = label.querySelector("button,input,meter,output,progress,select,textarea");
						add(control);
					}
				}
				for (const element of elements) {
					if (matches(element.getAttribute("aria-label"))) add(element);
					const labelledBy = element.getAttribute("aria-labelledby");
					if (!labelledBy) continue;
					const labelText = labelledBy
						.split(/\s+/)
						.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
						.join(" ");
					if (matches(labelText)) add(element);
				}
				return result;
			},
		});
	}
	if (!registered.has("placeholder")) {
		Puppeteer.registerCustomQueryHandler("placeholder", {
			queryAll(node, selector) {
				const wanted = selector.trim().toLocaleLowerCase();
				const root = node as unknown as QueryRoot;
				return Array.from(root.querySelectorAll("[placeholder]")).filter(element =>
					(element.getAttribute("placeholder") ?? "").trim().toLocaleLowerCase().includes(wanted),
				);
			},
		});
	}
	if (!registered.has("testid")) {
		Puppeteer.registerCustomQueryHandler("testid", {
			queryAll(node, selector) {
				const wanted = selector.trim();
				const root = node as unknown as QueryRoot;
				return Array.from(root.querySelectorAll("[data-testid]")).filter(
					element => element.getAttribute("data-testid") === wanted,
				);
			},
		});
	}
	if (!registered.has("alt")) {
		Puppeteer.registerCustomQueryHandler("alt", {
			queryAll(node, selector) {
				const wanted = selector.trim().toLocaleLowerCase();
				const root = node as unknown as QueryRoot;
				return Array.from(root.querySelectorAll("[alt]")).filter(element =>
					(element.getAttribute("alt") ?? "").trim().toLocaleLowerCase().includes(wanted),
				);
			},
		});
	}
	if (!registered.has("title")) {
		Puppeteer.registerCustomQueryHandler("title", {
			queryAll(node, selector) {
				const wanted = selector.trim().toLocaleLowerCase();
				const root = node as unknown as QueryRoot;
				return Array.from(root.querySelectorAll("[title]")).filter(element =>
					(element.getAttribute("title") ?? "").trim().toLocaleLowerCase().includes(wanted),
				);
			},
		});
	}
	if (!registered.has("role")) {
		Puppeteer.registerCustomQueryHandler("role", {
			queryAll(node, selector) {
				const root = node as unknown as QueryRoot;
				const roleMatch = /^\s*([^\s[]+)/.exec(selector);
				const wantedRole = (roleMatch?.[1] ?? "").toLocaleLowerCase();
				const nameMatch = /\[\s*name\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))(?:\s+(exact))?\s*\]/i.exec(selector);
				const wantedName = (nameMatch?.[1] ?? nameMatch?.[2] ?? nameMatch?.[3])?.trim().toLocaleLowerCase();
				const exact = nameMatch?.[4]?.toLocaleLowerCase() === "exact";
				const implicitRole = (element: QueryElement): string | null => {
					const tag = element.tagName.toLocaleLowerCase();
					if (tag === "a" && element.hasAttribute("href")) return "link";
					if (tag === "button") return "button";
					if (tag === "textarea") return "textbox";
					if (tag === "select") {
						return element.multiple === true || (element.size ?? 0) > 1 ? "listbox" : "combobox";
					}
					if (tag === "option") return "option";
					if (tag === "img") return "img";
					if (tag === "ul" || tag === "ol") return "list";
					if (tag === "li") return "listitem";
					if (tag === "nav") return "navigation";
					if (tag === "main") return "main";
					if (tag === "form") return "form";
					if (tag === "article") return "article";
					if (/^h[1-6]$/.test(tag)) return "heading";
					if (tag === "table") return "table";
					if (tag === "tr") return "row";
					if (tag === "th") return element.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
					if (tag === "td") return "cell";
					if (tag !== "input") return null;
					const type = (element.type ?? "text").toLocaleLowerCase();
					if (type === "checkbox") return "checkbox";
					if (type === "radio") return "radio";
					if (type === "range") return "slider";
					if (type === "number") return "spinbutton";
					if (type === "search") return "searchbox";
					if (["button", "submit", "reset", "image"].includes(type)) return "button";
					if (!["hidden", "file", "color", "date", "datetime-local", "month", "time", "week"].includes(type)) {
						return "textbox";
					}
					return null;
				};
				const accessibleName = (element: QueryElement): string => {
					const ariaLabel = element.getAttribute("aria-label");
					if (ariaLabel) return ariaLabel.trim();
					const labelledBy = element.getAttribute("aria-labelledby");
					if (labelledBy) {
						const value = labelledBy
							.split(/\s+/)
							.map(id => element.ownerDocument?.getElementById(id)?.textContent ?? "")
							.join(" ")
							.trim();
						if (value) return value;
					}
					if (element.id) {
						for (const label of element.ownerDocument?.querySelectorAll("label") ?? []) {
							if (label.getAttribute("for") === element.id) return (label.textContent ?? "").trim();
						}
					}
					const wrappingLabel = element.closest("label");
					if (wrappingLabel) return (wrappingLabel.textContent ?? "").trim();
					const isActionInput =
						element.tagName.toLocaleLowerCase() === "input" &&
						["button", "submit", "reset"].includes(element.type?.toLocaleLowerCase() ?? "");
					const fallbackName = isActionInput ? element.value : element.textContent;
					return (
						element.getAttribute("alt") ??
						element.getAttribute("title") ??
						fallbackName ??
						element.getAttribute("placeholder") ??
						""
					).trim();
				};
				return Array.from(root.querySelectorAll("*")).filter(element => {
					const role = (
						element.getAttribute("role")?.trim().split(/\s+/)[0] ?? implicitRole(element)
					)?.toLocaleLowerCase();
					if (role !== wantedRole) return false;
					if (wantedName === undefined) return true;
					const name = accessibleName(element).toLocaleLowerCase();
					return exact ? name === wantedName : name.includes(wantedName);
				});
			},
		});
	}
}

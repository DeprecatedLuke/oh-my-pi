/**
 * Minimal DOM names for browser worker modules imported from projects without
 * the DOM library. Individual modules narrow page values to the exact surface
 * they use.
 */
declare global {
	interface Node {}
	interface Element {
		textContent: string | null;
		innerHTML: string;
		getAttribute(qualifiedName: string): string | null;
		matches(selectors: string): boolean;
		readonly isConnected: boolean;
	}
	interface HTMLIFrameElement extends Element {}
}

export {};

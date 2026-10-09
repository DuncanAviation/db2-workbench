import * as vscode from 'vscode';

export class WebviewHtmlUtils {
	private static readonly NONCE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

	static getNonce(): string {
		let nonce = '';

		for(let i = 0; i < 32; i++) {
			nonce += WebviewHtmlUtils.NONCE_CHARS.charAt(Math.floor(Math.random() * WebviewHtmlUtils.NONCE_CHARS.length));
		}

		return nonce;
	}

	static getContentSecurityPolicy(webview: vscode.Webview, nonce: string): string {
		return [
			`default-src 'none'`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`font-src ${webview.cspSource}`,
			`img-src ${webview.cspSource} data:`,
			`script-src 'nonce-${nonce}'`
		].join('; ');
	}

	/**
	 * Builds the HTML shell for a webview whose UI is a React app bundled by esbuild into
	 * dist/webviews/{bundleName}/index.js. Mounts to a `<div id="root">` under a CSP that only
	 * allows that one nonce'd script and inline styles (required by emotion/MUI's runtime style injection).
	 *
	 * `initialState`, if provided, is embedded as `window.__INITIAL_STATE__` in an inline script that
	 * shares the bundle's nonce, so the React entry point can read it synchronously on first render
	 * instead of round-tripping a postMessage for data the extension already has when building this HTML.
	 */
	static getReactWebviewHtml(options: WebviewHtmlUtils.ReactWebviewHtmlOptions): string {
		let nonce = WebviewHtmlUtils.getNonce();
		let csp = WebviewHtmlUtils.getContentSecurityPolicy(options.webview, nonce);
		let scriptUri = options.webview.asWebviewUri(
			vscode.Uri.joinPath(options.extensionUri, 'dist', 'webviews', options.bundleName, 'index.js')
		);
		let initialStateScript = options.initialState === undefined
			? ''
			: `<script nonce="${nonce}">window.__INITIAL_STATE__ = ${WebviewHtmlUtils.toInlineJson(options.initialState)};</script>`;

		// Only a handful of bundles import a third-party stylesheet alongside their JS (e.g. the
		// diagram bundle's @xyflow/react/dist/style.css) - esbuild emits it as index.css next to
		// index.js only when the bundle actually imports one, so this is opt-in per bundle rather than
		// always linked.
		let stylesheetLink = options.stylesheet
			? `<link rel="stylesheet" href="${options.webview.asWebviewUri(vscode.Uri.joinPath(options.extensionUri, 'dist', 'webviews', options.bundleName, 'index.css')).toString()}">`
			: '';

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<meta http-equiv="Content-Security-Policy" content="${csp}">
		${stylesheetLink}
		<style nonce="${nonce}">
			body {
				margin: 0;
				padding: 0;
			}
		</style>
	</head>
	<body>
		<div id="root"></div>
		${initialStateScript}
		<script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
	</body>
</html>`;
	}

	private static toInlineJson(value: unknown): string {
		return JSON.stringify(value).replace(/</g, '\\u003c');
	}

	/**
	 * A minimal, dependency-free placeholder shown while a webview panel is waiting on something
	 * async (e.g. establishing a connection) before there's a real bundle/initial state to render.
	 * No script at all (not even the React bundle) - just inline CSS under a strict CSP - so it can
	 * be swapped in immediately on panel creation, before any awaited work has even started.
	 */
	static getLoadingHtml(message: string): string {
		let nonce = WebviewHtmlUtils.getNonce();
		let csp = [
			`default-src 'none'`,
			`style-src 'nonce-${nonce}'`
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<meta http-equiv="Content-Security-Policy" content="${csp}">
		<style nonce="${nonce}">
			body {
				display: flex;
				align-items: center;
				justify-content: center;
				height: 100vh;
				margin: 0;
				padding: 0;
				font-family: var(--vscode-font-family, sans-serif);
				font-size: var(--vscode-font-size, 13px);
				color: var(--vscode-foreground);
				background-color: var(--vscode-editor-background);
			}
			.loading {
				display: flex;
				align-items: center;
				gap: 10px;
			}
			.spinner {
				width: 16px;
				height: 16px;
				border: 2px solid var(--vscode-progressBar-background, currentColor);
				border-top-color: transparent;
				border-radius: 50%;
				animation: spin 0.8s linear infinite;
			}
			@keyframes spin {
				to { transform: rotate(360deg); }
			}
		</style>
	</head>
	<body>
		<div class="loading">
			<div class="spinner"></div>
			<span>${WebviewHtmlUtils.escapeHtml(message)}</span>
		</div>
	</body>
</html>`;
	}

	// The one place this file interpolates a caller-provided string directly into HTML (everywhere
	// else, page content goes through JSON.stringify into a script, which is inherently safe) - a
	// connection name is user-editable text, so it needs escaping here to avoid it being interpreted
	// as markup.
	private static escapeHtml(text: string): string {
		return text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}
}

export namespace WebviewHtmlUtils {
	export type ReactBundleName = 'connections' | 'results' | 'formatting' | 'schemas' | 'diagram';

	export interface ReactWebviewHtmlOptions {
		webview: vscode.Webview;
		extensionUri: vscode.Uri;
		bundleName: ReactBundleName;
		initialState?: unknown;
		// True when the bundle imports its own CSS (e.g. a third-party library's stylesheet) that
		// esbuild emits as dist/webviews/{bundleName}/index.css - see the stylesheetLink comment above.
		stylesheet?: boolean;
	}
}

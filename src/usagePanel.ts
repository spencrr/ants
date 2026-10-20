import { readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { UsageLog } from './usageLog.js';

/** The Claude Usage panel: a webview that reads the usage log and lets you slice it. */
export class UsagePanel {
	private static current: UsagePanel | undefined;

	static show(context: vscode.ExtensionContext, log: UsageLog) {
		if (UsagePanel.current) {
			UsagePanel.current.panel.reveal();
			return;
		}
		UsagePanel.current = new UsagePanel(context, log);
	}

	private readonly panel: vscode.WebviewPanel;
	private readonly disposables: vscode.Disposable[] = [];

	private constructor(
		context: vscode.ExtensionContext,
		private readonly log: UsageLog,
	) {
		const media = vscode.Uri.joinPath(context.extensionUri, 'media');
		this.panel = vscode.window.createWebviewPanel('ants.usage', 'Claude Usage', vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [media],
		});

		this.disposables.push(
			this.panel.onDidDispose(() => this.dispose()),
			this.panel.webview.onDidReceiveMessage(message => this.onMessage(message)),
			// Live update: a request finished somewhere, so hand it to the page.
			log.onDidAppend(record => this.panel.webview.postMessage({ type: 'append', record })),
		);
		this.render(media).catch(error => {
			this.panel.webview.html = `<p>Couldn't open the usage view: ${String(error)}</p>`;
		});
	}

	private async render(media: vscode.Uri) {
		const html = await readFile(vscode.Uri.joinPath(media, 'usage.html').fsPath, 'utf8');
		const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
		const { webview } = this.panel;
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'usage.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'usage.css'));
		webview.html = html
			.replaceAll('{{cspSource}}', webview.cspSource)
			.replaceAll('{{nonce}}', nonce)
			.replaceAll('{{script}}', scriptUri.toString())
			.replaceAll('{{style}}', styleUri.toString());
	}

	private async onMessage(message: { type: string }) {
		if (message.type === 'load') {
			this.panel.webview.postMessage({ type: 'records', records: await this.log.readAll(), path: this.log.path });
		} else if (message.type === 'openLog') {
			await vscode.window.showTextDocument(vscode.Uri.file(this.log.path));
		}
	}

	private dispose() {
		UsagePanel.current = undefined;
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

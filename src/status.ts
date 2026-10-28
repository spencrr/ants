import * as vscode from 'vscode';
import { credentialsSavedAt, type Identity, profilesOnDisk } from './identity.js';
import { agentSessionSettings, EXTENSION_ID } from './onboarding.js';

/** What the provider knows about one profile that a Manage Models group names. */
export interface ProfileStatus {
	/** The profile the group asked for; undefined when it left the field blank. */
	readonly named: string | undefined;
	/** The profile actually in use, once a client has been made for it. */
	readonly profile?: string;
	readonly identity?: Identity;
	readonly lastError?: string;
}

export interface StatusContext {
	readonly profiles: () => Promise<ProfileStatus[]>;
	readonly useProposedApi: boolean;
	readonly usageLogPath: string;
	readonly version: string;
}

const AUTH_TYPES: Record<string, string> = {
	user_oauth: 'browser sign-in',
	oidc_federation: 'workload identity federation',
};

/**
 * The **Ants: Connection Status** command: a Markdown page saying which organization and
 * workspace each group bills, where the sign-in comes from, and what the last error was.
 * Nothing here reads a token.
 */
export function registerStatus(context: vscode.ExtensionContext, status: StatusContext) {
	const uri = vscode.Uri.from({ scheme: 'ants', path: '/Connection Status.md' });
	const changed = new vscode.EventEmitter<vscode.Uri>();
	let report = '';
	context.subscriptions.push(
		changed,
		vscode.workspace.registerTextDocumentContentProvider('ants', {
			onDidChange: changed.event,
			provideTextDocumentContent: () => report,
		}),
		vscode.commands.registerCommand('ants.showStatus', async () => {
			report = await statusReport(status);
			changed.fire(uri);
			try {
				await vscode.commands.executeCommand('markdown.showPreview', uri);
			} catch {
				// No Markdown preview (the built-in extension is off), so show the text.
				await vscode.window.showTextDocument(uri, { preview: true });
			}
			return report;
		}),
	);
}

export async function statusReport(status: StatusContext): Promise<string> {
	const profiles = await status.profiles();
	const lines = ['# Claude (Console): connection status', '', `Checked ${when(new Date())}.`, ''];

	if (profiles.length === 0) {
		lines.push(
			'No group in Manage Models has asked for models yet. Add one under **Manage Models → Add Models → Claude (Console)**.',
			'',
		);
	}
	for (const entry of profiles) {
		lines.push(...(await describe(entry)), '');
	}

	const inUse = new Set(profiles.map(p => p.profile ?? p.named));
	const unused = (await profilesOnDisk()).filter(name => !inUse.has(name));
	if (unused.length > 0) {
		lines.push(
			'## Profiles with no group',
			'',
			`${unused.map(code).join(', ')}. To use one, add a group for it under **Manage Models → Add Models → Claude (Console)** and enter its name as the profile.`,
			'',
		);
	}

	const settings = agentSessionSettings();
	const missing = [
		settings.byok ? '' : '`chat.agentHost.byokModels.enabled` is off',
		settings.allowed ? '' : `\`extensions.supportAgentsWindow\` doesn't list ${EXTENSION_ID}`,
	].filter(Boolean);
	lines.push(
		'## VS Code',
		'',
		`- **Proposed APIs:** ${
			status.useProposedApi
				? 'on, so the effort picker, context size, and thinking are available'
				: `off. Add \`"enable-proposed-api": ["${EXTENSION_ID}"]\` to argv.json for the effort picker, context size, and thinking.`
		}`,
		`- **Copilot agent sessions:** ${
			missing.length === 0
				? 'allowed, in this window and in the Agents window'
				: `not yet: ${missing.join(', and ')}. Run **Ants: Allow Claude in Copilot Agent Sessions**.`
		}`,
		`- **Usage log:** ${code(status.usageLogPath)}`,
		`- **Ants** ${status.version}`,
		'',
	);
	return lines.join('\n');
}

async function describe(entry: ProfileStatus): Promise<string[]> {
	const { named, identity } = entry;
	const profile = entry.profile ?? named;
	const title = named ? `## Profile ${code(named)}` : `## Active sign-in${profile ? ` (${code(profile)})` : ''}`;
	const lines = [title, ''];
	if (!named) {
		lines.push(
			'Used by groups that leave the profile empty. Follows `active_config`, so it moves when you sign in elsewhere.',
			'',
		);
	}

	if (identity?.source === 'environment') {
		lines.push(`- **Sign-in:** ${plain(identity.note ?? '')}`, `- **API:** ${code(identity.baseURL)}`);
	} else if (identity) {
		const org = identity.organizationName
			? `${plain(identity.organizationName)}${identity.organizationId ? ` (${code(identity.organizationId)})` : ''}`
			: identity.organizationId
				? code(identity.organizationId)
				: 'unknown';
		const saved = profile ? await credentialsSavedAt(profile) : undefined;
		const auth = identity.authType ? (AUTH_TYPES[identity.authType] ?? plain(identity.authType)) : 'unknown';
		lines.push(
			`- **Organization:** ${org}`,
			`- **Workspace:** ${identity.workspaceId ? code(identity.workspaceId) : 'the organization default'}`,
			`- **Account:** ${identity.account ? plain(identity.account) : 'unknown'}`,
			`- **Sign-in:** ${auth}${saved ? `; credentials last saved ${when(saved)} (the sign-in, or the last token refresh)` : ''}`,
			`- **API:** ${code(identity.baseURL)}`,
		);
		if (identity.note) {
			lines.push(`- **Note:** ${plain(identity.note)}`);
		}
	} else {
		lines.push('- Not connected yet: no call through it has succeeded.');
	}
	lines.push(`- **Last error:** ${entry.lastError ? plain(entry.lastError) : 'none'}`);
	return lines;
}

/**
 * Text from outside (the API's names for things, error messages) shown as nothing but text: on one
 * line, cut to a sensible length, with every character Markdown would otherwise act on escaped.
 */
function plain(value: string) {
	const oneLine = value.replace(/\s+/g, ' ').trim();
	const cut = oneLine.length > 200 ? `${oneLine.slice(0, 199)}…` : oneLine;
	return cut.replace(/[\\`*_{}[\]()#+\-!<>|~]/g, '\\$&');
}

/** An identifier or path in a code span, which can't contain the backtick that would end it. */
function code(value: string) {
	return `\`${value.replace(/[`\r\n]/g, '').slice(0, 200)}\``;
}

function when(date: Date) {
	return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

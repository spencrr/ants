import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type AnthropicConfig, getCredentialsPath, loadConfig } from '@anthropic-ai/sdk/core/credentials';
import * as vscode from 'vscode';
import { activeProfileName, anthropicConfigDir, environmentKey, profilesOnDisk } from './identity.js';

export const EXTENSION_ID = 'spencrr.ants';

const SIGN_IN_STEPS =
	'Run `claude` in a terminal, type /login, and choose "Anthropic Console account", then ' +
	'"Sign in with your Console account". (`ant auth login` works too.) Then reopen Manage Models.';

/**
 * Explains why the sign-in didn't work, in terms of what the user actually did. The SDK's own
 * message only says which credential it couldn't find. Nothing here reads a token.
 *
 * `named` is the profile a Manage Models group asked for; without one, the active profile is meant.
 */
export async function signInHelp(named: string | undefined): Promise<string> {
	// An explicit profile makes the SDK ignore these, so they only matter for the active one.
	const key = named ? undefined : environmentKey();
	if (key) {
		return (
			`${key} is set in the environment VS Code was started from, and it takes precedence over your ` +
			'sign-in. Check that it is valid, or unset it and restart VS Code.'
		);
	}

	const profile = named ?? (await activeProfileName());
	let config: AnthropicConfig | null;
	try {
		config = await loadConfig(profile);
	} catch (error) {
		// The file is there but can't be used; the SDK says what is wrong with it.
		return `Your Anthropic profile "${profile}" can't be used: ${messageOf(error)}`;
	}
	if (!config) {
		if (named) {
			const others = await profilesOnDisk();
			const known = others.length > 0 ? ` The profiles on this machine are: ${others.join(', ')}.` : '';
			return (
				`No Anthropic profile named "${named}".${known} ` +
				`Run \`ant auth login --profile ${named}\` to create it, or change the profile in Manage Models.`
			);
		}
		// Claude Code's "Create an API key" choice keeps the key to itself; the shared profile is never written.
		const claudeCode = await readJson(claudeCodeConfigFile());
		if (claudeCode?.primaryApiKey) {
			return (
				"Claude Code is signed in with an API key it made for itself, which this extension can't use. " +
				`${SIGN_IN_STEPS} Don't pick "Create an API key".`
			);
		}
		return `No Anthropic sign-in found in ${anthropicConfigDir()}. ${SIGN_IN_STEPS}`;
	}

	if (config.authentication.type !== 'user_oauth') {
		return (
			`Your Anthropic profile "${profile}" signs in with ${config.authentication.type}, and that ` +
			"didn't work this time. The details below are the SDK's."
		);
	}
	const credentials = await getCredentialsPath(config, profile);
	if (!(credentials && (await exists(credentials)))) {
		return `Your Anthropic profile "${profile}" has no saved credentials. Sign in again: ${SIGN_IN_STEPS}`;
	}
	return `Your sign-in for profile "${profile}" has expired or was revoked. Sign in again: ${SIGN_IN_STEPS}`;
}

/** Claude Code's own settings file, which moves with CLAUDE_CONFIG_DIR the way its other files do. */
function claudeCodeConfigFile() {
	return join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
}

/**
 * Points out, once, the settings that agent sessions need, and the runtime argument for the
 * proposed APIs. Both have to be changed by hand and neither is discoverable from chat.
 */
export async function offerSetup(context: vscode.ExtensionContext, useProposedApi: boolean) {
	const dismissed = context.globalState.get<string[]>('setupDismissed', []);

	if (!(agentSessionsAllowed() || dismissed.includes('agentSessions'))) {
		const enable = 'Enable';
		const later = "Don't ask again";
		const choice = await vscode.window.showInformationMessage(
			'Claude (Console) models can also run Copilot agent sessions, including in the Agents window. ' +
				'That takes two settings.',
			enable,
			'Learn more',
			later,
		);
		if (choice === enable) {
			await allowAgentSessions();
			await offerQuit(
				'Agent sessions in this window can use your Claude models now. The Agents window reads its ' +
					'allow-list when VS Code starts, so quit VS Code and open it again for that one.',
			);
		} else if (choice === 'Learn more') {
			await openReadme('copilot-agent-sessions-and-the-agents-window');
		} else if (choice === later) {
			await dismiss(context, 'agentSessions');
		}
	}

	if (!(useProposedApi || dismissed.includes('proposedApi'))) {
		const open = 'Open argv.json';
		const later = "Don't ask again";
		const choice = await vscode.window.showInformationMessage(
			"The effort picker, context size, and Claude's thinking need VS Code's proposed APIs. " +
				`Add "enable-proposed-api": ["${EXTENSION_ID}"] to argv.json, then quit every VS Code window, the Agents window included, and reopen.`,
			open,
			'Learn more',
			later,
		);
		if (choice === open) {
			await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
		} else if (choice === 'Learn more') {
			await openReadme('effort-picker-context-size-and-thinking');
		} else if (choice === later) {
			await dismiss(context, 'proposedApi');
		}
	}
}

/** Remembers a "Don't ask again". Reads the list afresh: the other prompt may have added to it meanwhile. */
async function dismiss(context: vscode.ExtensionContext, prompt: string) {
	const dismissed = context.globalState.get<string[]>('setupDismissed', []);
	await context.globalState.update('setupDismissed', [...new Set([...dismissed, prompt])]);
}

/**
 * Every model comes from a group in Manage Models, so a fresh install shows nothing until the
 * first one exists. Say so once, when VS Code asks for models and no group answers.
 */
export async function offerFirstGroup(context: vscode.ExtensionContext, log: vscode.LogOutputChannel) {
	if (context.globalState.get<boolean>('firstGroupOffered')) {
		return;
	}
	await context.globalState.update('firstGroupOffered', true);
	log.info('No group in Manage Models yet, so there are no models. Offering to add the first one.');
	const add = 'Add Models';
	const choice = await vscode.window.showInformationMessage(
		'To use Claude (Console), add it under Manage Models. Name the group after your organization and ' +
			'leave the profile empty to use your active Anthropic sign-in. Add one group per organization.',
		add,
	);
	if (choice === add) {
		await vscode.commands.executeCommand('workbench.action.chat.manage', 'Claude (Console)');
	}
}

/** Whether Copilot agent sessions, in this window and in the Agents window, may use the models. */
export function agentSessionsAllowed() {
	const { byok, allowed } = agentSessionSettings();
	return byok && allowed;
}

/** The two settings agent sessions need: the bring-your-own-key switch and the Agents window allow-list. */
export function agentSessionSettings() {
	return {
		byok: vscode.workspace.getConfiguration('chat').get<boolean>('agentHost.byokModels.enabled') === true,
		allowed: allowedInAgentsWindow()[EXTENSION_ID] === true,
	};
}

/** Turns on the two settings agent sessions need. The `ants.allowAgentSessions` command. */
export async function allowAgentSessions() {
	await vscode.workspace
		.getConfiguration('chat')
		.update('agentHost.byokModels.enabled', true, vscode.ConfigurationTarget.Global);
	await vscode.workspace
		.getConfiguration('extensions')
		.update(
			'supportAgentsWindow',
			{ ...allowedInAgentsWindow(), [EXTENSION_ID]: true },
			vscode.ConfigurationTarget.Global,
		);
}

function allowedInAgentsWindow() {
	return vscode.workspace.getConfiguration('extensions').get<Record<string, boolean>>('supportAgentsWindow', {});
}

// VS Code has no command that quits and comes back, so the most it can do is quit.
async function offerQuit(message: string) {
	const quit = 'Quit VS Code';
	if ((await vscode.window.showInformationMessage(message, quit)) === quit) {
		await vscode.commands.executeCommand('workbench.action.quit');
	}
}

async function openReadme(anchor: string) {
	await vscode.env.openExternal(vscode.Uri.parse(`https://github.com/spencrr/ants#${anchor}`));
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch {
		return undefined;
	}
}

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

async function exists(file: string) {
	try {
		await access(file);
		return true;
	} catch {
		return false;
	}
}

import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { getCredentialsPath, loadConfig } from '@anthropic-ai/sdk/core/credentials';

/**
 * Who requests through a profile are billed to, as far as the extension can tell without
 * reading a token: the ids come from the profile's config file, the names from the API.
 */
export interface Identity {
	/** The profile as resolved: the named one, or the one that was active when the client was made. */
	readonly profile: string;
	/** `environment` when ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set and the group left the profile blank. */
	readonly source: 'profile' | 'environment';
	readonly organizationId?: string;
	readonly organizationName?: string;
	readonly workspaceId?: string;
	/** The email address of the signed-in account. */
	readonly account?: string;
	readonly authType?: string;
	readonly baseURL: string;
	/** Why there is no organization name, when there isn't one. */
	readonly note?: string;
}

/** The folder where Claude Code and the `ant` CLI keep the sign-in, the same way the SDK finds it. */
export function anthropicConfigDir() {
	if (process.env.ANTHROPIC_CONFIG_DIR) {
		return process.env.ANTHROPIC_CONFIG_DIR;
	}
	if (process.platform === 'win32') {
		return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Anthropic');
	}
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'anthropic');
}

/**
 * The profile `new Anthropic()` uses, resolved in the order the SDK documents: ANTHROPIC_PROFILE,
 * then the `active_config` file, then "default". Cheap enough to check before every request.
 */
export async function activeProfileName(): Promise<string> {
	const fromEnv = process.env.ANTHROPIC_PROFILE?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const active = await readFile(join(anthropicConfigDir(), 'active_config'), 'utf8').catch(() => '');
	return active.trim() || 'default';
}

/** The names of the Anthropic profiles on this machine, from the config files alone. */
export async function profilesOnDisk(): Promise<string[]> {
	try {
		const files = await readdir(join(anthropicConfigDir(), 'configs'));
		return files
			.filter(file => file.endsWith('.json'))
			.map(file => file.slice(0, -'.json'.length))
			.sort();
	} catch {
		return [];
	}
}

/** The environment variable the SDK would use instead of a profile, if one is set. */
export function environmentKey(): string | undefined {
	return ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].find(name => process.env[name]);
}

/**
 * Works out who `client` bills. `named` is the profile the group asked for, `resolved` the one
 * the client was actually built for. Never throws: without the API's help, the ids still stand.
 */
export async function identityOf(client: Anthropic, named: string | undefined, resolved: string): Promise<Identity> {
	const key = named ? undefined : environmentKey();
	if (key) {
		return {
			profile: resolved,
			source: 'environment',
			baseURL: client.baseURL,
			note: `${key} is set in the environment VS Code was started from, so the SDK uses it instead of the profile.`,
		};
	}
	const config = await loadConfig(resolved).catch(() => null);
	const identity: Identity = {
		profile: resolved,
		source: 'profile',
		organizationId: config?.organization_id,
		workspaceId: config?.workspace_id,
		authType: config?.authentication.type,
		baseURL: client.baseURL,
	};
	try {
		const who = await whoAmI(client);
		return { ...identity, organizationName: who.organization, account: who.account };
	} catch (error) {
		const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
		return { ...identity, note: `Couldn't look up the organization's name: ${message}` };
	}
}

/**
 * The account and organization behind a sign-in, from the endpoint Claude Code uses to show who
 * you are. It isn't documented, so a failure here means "no name", not a broken sign-in.
 */
async function whoAmI(client: Anthropic): Promise<{ account?: string; organization?: string }> {
	const profile = await client.get<{ account?: { email?: unknown }; organization?: { name?: unknown } }>(
		'/api/oauth/profile',
	);
	return { account: text(profile.account?.email), organization: text(profile.organization?.name) };
}

/** When the profile's credentials file was last written: at sign-in, and at every token refresh since. */
export async function credentialsSavedAt(profile: string): Promise<Date | undefined> {
	const config = await loadConfig(profile).catch(() => null);
	const file = await getCredentialsPath(config, profile).catch(() => null);
	if (!file) {
		return undefined;
	}
	try {
		return (await stat(file)).mtime;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

import Anthropic from '@anthropic-ai/sdk';
import * as vscode from 'vscode';
import { activeProfileName, type Identity, identityOf } from './identity.js';
import { allowAgentSessions, offerFirstGroup, offerSetup, signInHelp } from './onboarding.js';
import { type ProfileStatus, registerStatus } from './status.js';
import { estimateCost, sessionOf, surfaceOf, UsageLog, type UsageRecord } from './usageLog.js';
import { UsagePanel } from './usagePanel.js';

// The prompt and the reply have to fit in the context window together, so reserve
// a fixed slice for the reply and give the rest to the prompt.
const MAX_OUTPUT_TOKENS = 32_000;
const DEFAULT_CONTEXT_WINDOW = 200_000;

const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' };
type Effort = keyof typeof EFFORT_LABELS;

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

/** What a request that never got an answer used, as far as anyone knows. */
const NO_TOKENS = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** A model as VS Code sees it, plus what this extension offers for it. */
interface ClaudeModel extends vscode.LanguageModelChatInformation {
	/** Effort levels offered in the model picker. */
	readonly efforts: Effort[];
	/** Whether to turn on adaptive thinking and show it in chat. */
	readonly thinking: boolean;
	/** The Anthropic profile this model is reached through; undefined for the active one. */
	readonly profile?: string;
}

/**
 * What VS Code passes when it asks for models: `configuration` is one group's settings from
 * Manage Models, and is missing for the groupless call. The field is typed only in the
 * proposed API, but VS Code sends it either way.
 */
interface ModelListOptions extends vscode.PrepareLanguageModelChatModelOptions {
	readonly configuration?: { readonly profile?: unknown };
}

/** The SDK client for one Anthropic profile, and who it bills. */
interface Connection {
	readonly client: Anthropic;
	/** The profile the client was built for: the named one, or the active one at the time. */
	readonly profile: string;
	/** Looked up after the first successful call. Never rejects. */
	identity?: Promise<Identity>;
}

/** What the extension knows about one profile that groups in Manage Models name. */
interface ProfileState {
	/** The profile the group asked for; undefined when it left the field blank. */
	readonly named: string | undefined;
	connection?: Connection;
	lastError?: string;
}

export function activate(context: vscode.ExtensionContext) {
	const log = vscode.window.createOutputChannel('Ants', { log: true });

	// The effort picker and Claude's thinking need proposed VS Code APIs. VS Code only allows those
	// when it's started with `--enable-proposed-api spencrr.ants` (or the same setting in argv.json).
	// Without it, the models still work everywhere, just without those two.
	const proposals: string[] = context.extension.packageJSON.enabledApiProposals ?? [];
	const useProposedApi = proposals.includes('chatProvider') && proposals.includes('languageModelThinkingPart');
	log.info(
		useProposedApi
			? 'Proposed APIs are on, so the effort picker and thinking are available.'
			: 'Proposed APIs are off, so there is no effort picker and thinking stays hidden. See the README to turn them on.',
	);

	// Every request is appended to a log file, which the Claude Usage panel reads.
	const usage = new UsageLog(context.globalStorageUri);

	const provider = new ClaudeChatProvider(log, useProposedApi, usage, () => {
		offerFirstGroup(context, log).catch(error =>
			log.warn(`Couldn't offer to add the first group: ${messageOf(error)}`),
		);
	});
	context.subscriptions.push(log, provider, vscode.lm.registerLanguageModelChatProvider('ants', provider));
	context.subscriptions.push(
		vscode.commands.registerCommand('ants.showUsage', () => UsagePanel.show(context, usage)),
		vscode.commands.registerCommand('ants.allowAgentSessions', allowAgentSessions),
	);
	registerStatus(context, {
		profiles: () => provider.profileStatuses(),
		useProposedApi,
		usageLogPath: usage.path,
		version: context.extension.packageJSON.version,
	});

	// Agent sessions and the proposed APIs each need a setting changed by hand. Say so once.
	offerSetup(context, useProposedApi).catch(error => log.warn(`Setup prompt failed: ${messageOf(error)}`));
}

class ClaudeChatProvider implements vscode.LanguageModelChatProvider<ClaudeModel>, vscode.Disposable {
	// One SDK client per Anthropic profile, keyed by the name the group gave ('' for none). With
	// no profile named, the SDK uses your active one (the one Claude Code and the `ant` CLI
	// share). It refreshes tokens as needed, and reads the profile when it's created, so after
	// a failure the client is dropped in case you've signed in since.
	private readonly profiles = new Map<string, ProfileState>();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changed.event;
	// VS Code asks for models without a group first and then once per group, so a group call
	// arriving within a moment of the groupless one means there are groups after all.
	private noGroupsTimer: NodeJS.Timeout | undefined;
	private sawGroup = false;

	constructor(
		private readonly log: vscode.LogOutputChannel,
		private readonly useProposedApi: boolean,
		private readonly usage: UsageLog,
		private readonly onNoGroups: () => void,
	) {}

	dispose() {
		this.changed.dispose();
		clearTimeout(this.noGroupsTimer);
	}

	async provideLanguageModelChatInformation(options: ModelListOptions): Promise<ClaudeModel[]> {
		// Every model belongs to a group from Manage Models, one per profile (organization or
		// workspace). VS Code also asks once without a group; answering that too would list
		// the active profile's models twice.
		if (!options.configuration) {
			if (!this.sawGroup) {
				this.noGroupsTimer ??= setTimeout(() => this.onNoGroups(), 3000);
			}
			return [];
		}
		this.sawGroup = true;
		clearTimeout(this.noGroupsTimer);
		const profile = profileOf(options.configuration);

		const models: Anthropic.ModelInfo[] = [];
		try {
			const connection = await this.connect(profile);
			for await (const model of connection.client.models.list()) {
				models.push(model);
			}
			this.worked(connection, profile);
		} catch (error) {
			const explained = await this.failed(profile, error);
			this.log.error(
				`Couldn't list models${profile ? ` for profile "${profile}"` : ''}: ${messageOf(explained)}`,
			);
			throw explained;
		}

		return models.filter(model => model.lifecycle !== 'retired').map(model => this.toChatModel(model, profile));
	}

	/** The connection for a group's profile, made on first use or after a failure. */
	private async connect(named: string | undefined): Promise<Connection> {
		const key = named ?? '';
		let state = this.profiles.get(key);
		if (!state) {
			state = { named };
			this.profiles.set(key, state);
		}
		// A blank profile follows the active sign-in, which `ant profile activate` or a new login
		// can change underneath a client that has already read the old one.
		const profile = named ?? (await activeProfileName());
		if (state.connection && state.connection.profile !== profile) {
			this.log.info(`The active Anthropic profile changed from "${state.connection.profile}" to "${profile}".`);
			state.connection = undefined;
			this.changed.fire();
		}
		if (!state.connection) {
			state.connection = { client: named ? new Anthropic({ profile: named }) : new Anthropic(), profile };
		}
		return state.connection;
	}

	/** Drops the profile's client, remembers the error, and swaps in an explanation. */
	private async failed(named: string | undefined, error: unknown): Promise<unknown> {
		const state = this.profiles.get(named ?? '');
		const explained = await explain(error, named, state?.connection?.client.baseURL);
		if (state) {
			state.connection = undefined;
			state.lastError = messageOf(explained).split('\n')[0];
		}
		return explained;
	}

	/** A call through the connection succeeded: the last error is history, and the identity is worth looking up. */
	private worked(connection: Connection, named: string | undefined): Promise<Identity> {
		const state = this.profiles.get(named ?? '');
		if (state) {
			state.lastError = undefined;
		}
		connection.identity ??= identityOf(connection.client, named, connection.profile);
		return connection.identity;
	}

	/** One entry per profile a group has asked for, for the connection status page. */
	profileStatuses(): Promise<ProfileStatus[]> {
		return Promise.all(
			[...this.profiles.values()].map(async ({ named, connection, lastError }) => ({
				named,
				profile: connection?.profile,
				identity: await connection?.identity,
				lastError,
			})),
		);
	}

	private toChatModel(model: Anthropic.ModelInfo, profile: string | undefined): ClaudeModel {
		const contextWindow = model.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW;
		const maxOutputTokens = Math.min(model.max_tokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS);
		const chatModel: ClaudeModel = {
			id: model.id,
			name: model.display_name,
			family: model.id,
			version: model.id,
			maxInputTokens: contextWindow - maxOutputTokens,
			maxOutputTokens,
			capabilities: {
				toolCalling: true,
				imageInput: model.capabilities?.image_input?.supported ?? false,
			},
			efforts: [],
			thinking: false,
			profile,
		};
		if (!this.useProposedApi) {
			return chatModel;
		}

		const effort = model.capabilities?.effort;
		const efforts = effort?.supported
			? (Object.keys(EFFORT_LABELS) as Effort[]).filter(level => effort[level]?.supported)
			: [];
		const settings: Record<string, object> = {};
		if (efforts.length > 0) {
			settings.reasoningEffort = effortSetting(model.id, efforts);
		}
		const contextSize = contextSizeSetting(model.id, contextWindow, chatModel.maxInputTokens);
		if (contextSize) {
			settings.contextSize = contextSize;
		}
		return {
			...chatModel,
			efforts,
			thinking: model.capabilities?.thinking?.types?.adaptive?.supported ?? false,
			configurationSchema: Object.keys(settings).length > 0 ? { properties: settings } : undefined,
		};
	}

	async provideLanguageModelChatResponse(
		model: ClaudeModel,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const started = Date.now();
		const { system, conversation } = toClaudeMessages(messages);
		const tools = options.tools?.length
			? options.tools.map(tool => ({
					name: tool.name,
					description: tool.description,
					input_schema: { type: 'object', ...tool.inputSchema } as Anthropic.Tool.InputSchema,
				}))
			: undefined;
		const forceToolUse = tools !== undefined && options.toolMode === vscode.LanguageModelChatToolMode.Required;
		// Chat fills this in from the effort picker, and agent sessions from their thinking level.
		const effort = model.efforts.find(level => level === options.modelConfiguration?.reasoningEffort);

		const body: Anthropic.MessageStreamParams = {
			model: model.id,
			// Agent sessions ask for their own output limit.
			max_tokens: Math.min(options.modelOptions?.max_tokens ?? model.maxOutputTokens, model.maxOutputTokens),
			// Agent mode resends the whole conversation every turn, so let Claude cache it.
			cache_control: { type: 'ephemeral' },
			system: system || undefined,
			messages: conversation,
			tools,
			tool_choice: forceToolUse ? { type: 'any' } : undefined,
			// The newest models think by default but hide the text, so ask to see it.
			// Forcing a tool call rules out thinking.
			thinking: model.thinking && !forceToolUse ? { type: 'adaptive', display: 'summarized' } : undefined,
			output_config: effort ? { effort } : undefined,
		};

		const request = {
			model: model.id,
			profile: model.profile,
			surface: surfaceOf(options.modelOptions, options.requestInitiator),
			session: sessionOf(options.modelOptions, messages),
			effort,
		};
		let connection: Connection | undefined;
		let reply: Anthropic.Message;
		try {
			connection = await this.connect(model.profile);
			reply = await this.streamWithRetry(connection.client, body, progress, token);
		} catch (error) {
			if (token.isCancellationRequested) {
				// The user stopped the reply before anything arrived; nothing is wrong with the sign-in.
				this.record(request, started, 'cancelled', NO_TOKENS, await connection?.identity);
				throw error;
			}
			const identity = await connection?.identity;
			const explained = await this.failed(model.profile, error);
			this.log.error(`${model.id} failed: ${messageOf(explained)}`);
			this.record(request, started, 'error', NO_TOKENS, identity);
			throw explained;
		}

		const { usage } = reply;
		const cachedTokens = usage.cache_read_input_tokens ?? 0;
		const tokenCounts = {
			input: usage.input_tokens,
			cacheRead: cachedTokens,
			cacheWrite: usage.cache_creation_input_tokens ?? 0,
			output: usage.output_tokens,
		};
		const promptTokens = tokenCounts.input + tokenCounts.cacheWrite + cachedTokens;
		if (token.isCancellationRequested) {
			// Stopped part-way: what had arrived is still billed, so it still counts.
			this.log.info(`${model.id}: stopped after ${promptTokens} tokens in, about ${usage.output_tokens} out`);
			this.record(request, started, 'cancelled', tokenCounts, await this.worked(connection, model.profile));
			return;
		}

		// Copilot Chat and agent sessions read token counts from a 'usage' part, in OpenAI's format.
		progress.report(
			new vscode.LanguageModelDataPart(
				Buffer.from(
					JSON.stringify({
						prompt_tokens: promptTokens,
						completion_tokens: usage.output_tokens,
						total_tokens: promptTokens + usage.output_tokens,
						prompt_tokens_details: { cached_tokens: cachedTokens },
					}),
				),
				'usage',
			),
		);

		const seconds = ((Date.now() - started) / 1000).toFixed(1);
		const cutOff = reply.stop_reason === 'max_tokens' ? ', cut off at the output limit' : '';
		const cost = estimateCost(model.id, tokenCounts);
		this.log.info(
			`${model.id}${model.profile ? ` [${model.profile}]` : ''}${effort ? ` (${effort} effort)` : ''}: ${seconds}s, ${promptTokens} tokens in (${cachedTokens} cached), ${usage.output_tokens} out${cutOff}${cost ? `, about $${cost.toFixed(cost < 0.1 ? 3 : 2)}` : ''}`,
		);
		this.record(request, started, undefined, tokenCounts, await this.worked(connection, model.profile));
	}

	/** Appends one request to the usage log, with who it was billed to when that is known. */
	private record(
		request: Pick<UsageRecord, 'model' | 'profile' | 'surface' | 'session' | 'effort'>,
		started: number,
		outcome: UsageRecord['outcome'],
		tokens: Pick<UsageRecord, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>,
		identity: Identity | undefined,
	) {
		this.usage
			.append({
				time: new Date().toISOString(),
				...request,
				organization: identity?.organizationName ?? identity?.organizationId,
				workspace: identity?.workspaceId,
				outcome,
				...tokens,
				ms: Date.now() - started,
				cost: outcome === 'error' ? undefined : estimateCost(request.model, tokens),
			})
			.catch(error => this.log.warn(`Couldn't write the usage log: ${messageOf(error)}`));
	}

	/** Streams Claude's reply into chat, retrying once without earlier thinking if Claude refuses it. */
	private async streamWithRetry(
		client: Anthropic,
		body: Anthropic.MessageStreamParams,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<Anthropic.Message> {
		try {
			return await this.stream(client, body, progress, token);
		} catch (error) {
			const refusedThinking = error instanceof Anthropic.BadRequestError && /thinking/i.test(error.message);
			if (!(refusedThinking && body.messages.some(hasThinking))) {
				throw error;
			}
			// The newest models only accept earlier thinking while everything before it is unchanged,
			// and chat sometimes rewrites earlier turns, for example when it summarizes a long session.
			this.log.warn(`Retrying without earlier thinking, which Claude refused: ${messageOf(error)}`);
			return this.stream(client, { ...body, messages: withoutThinking(body.messages) }, progress, token);
		}
	}

	/**
	 * Streams one request. When the user stops it part-way, resolves to what Claude had sent so
	 * far, with the output count estimated from the text, since the API only reports it at the end.
	 */
	private async stream(
		client: Anthropic,
		body: Anthropic.MessageStreamParams,
		progress: vscode.Progress<vscode.LanguageModelResponsePart2>,
		token: vscode.CancellationToken,
	): Promise<Anthropic.Message> {
		const stream = client.messages.stream(body);
		token.onCancellationRequested(() => stream.abort());
		let soFar: Anthropic.Message | undefined;
		let streamed = 0;

		stream.on('streamEvent', (event, reply) => {
			soFar = reply;
			if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
				streamed += event.delta.text.length;
				progress.report(new vscode.LanguageModelTextPart(event.delta.text));
			} else if (
				event.type === 'content_block_delta' &&
				event.delta.type === 'thinking_delta' &&
				this.useProposedApi
			) {
				progress.report(
					new vscode.LanguageModelThinkingPart(event.delta.thinking, `${reply.id}/${event.index}`),
				);
			} else if (event.type === 'content_block_stop') {
				const block = reply.content[event.index];
				if (block.type === 'tool_use') {
					progress.report(new vscode.LanguageModelToolCallPart(block.id, block.name, block.input as object));
				} else if ((block.type === 'thinking' || block.type === 'redacted_thinking') && this.useProposedApi) {
					// Claude only reads its earlier thinking if each block comes back exactly as it was sent.
					// Chat and agent sessions carry these metadata keys over to the next request.
					const metadata =
						block.type === 'thinking'
							? { signature: block.signature, _completeThinking: block.thinking }
							: { redactedData: block.data };
					progress.report(new vscode.LanguageModelThinkingPart('', `${reply.id}/${event.index}`, metadata));
				}
			}
		});

		try {
			return await stream.finalMessage();
		} catch (error) {
			if (token.isCancellationRequested && soFar) {
				const output = Math.max(soFar.usage.output_tokens, Math.ceil(streamed / 4));
				return { ...soFar, usage: { ...soFar.usage, output_tokens: output } };
			}
			throw error;
		}
	}

	provideTokenCount(_model: ClaudeModel, input: string | vscode.LanguageModelChatRequestMessage): Thenable<number> {
		// VS Code only uses this to budget prompts, so a rough estimate is enough.
		const text = typeof input === 'string' ? input : input.content.map(textOf).join('');
		return Promise.resolve(Math.ceil(text.length / 4));
	}
}

function toClaudeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]) {
	const system: string[] = [];
	const conversation: Anthropic.MessageParam[] = [];

	for (const message of messages) {
		if (message.role === vscode.LanguageModelChatMessageRole.User) {
			addTurn(conversation, 'user', message.content.flatMap(toContentBlocks));
		} else if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
			addTurn(conversation, 'assistant', message.content.flatMap(toContentBlocks));
		} else {
			// Copilot sends its system prompt with a role that isn't in the stable API yet.
			system.push(message.content.map(textOf).join(''));
		}
	}

	return { system: system.join('\n\n').trim(), conversation };
}

// VS Code sends each tool result as its own user message, but Claude wants every
// result for a turn in a single user message. So merge back-to-back messages.
function addTurn(
	conversation: Anthropic.MessageParam[],
	role: Anthropic.MessageParam['role'],
	content: Anthropic.ContentBlockParam[],
) {
	const previous = conversation.at(-1);
	if (previous?.role === role && Array.isArray(previous.content)) {
		previous.content.push(...content);
	} else if (content.length > 0) {
		conversation.push({ role, content });
	}
}

function toContentBlocks(part: unknown): Anthropic.ContentBlockParam[] {
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return [{ type: 'tool_use', id: part.callId, name: part.name, input: part.input }];
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return [{ type: 'tool_result', tool_use_id: part.callId, content: part.content.flatMap(toTextOrImage) }];
	}
	if (part instanceof vscode.LanguageModelThinkingPart) {
		// Only the last part of each thinking block has what Claude needs to read it again.
		const { signature, redactedData, _completeThinking } = part.metadata ?? {};
		if (redactedData) {
			return [{ type: 'redacted_thinking', data: redactedData }];
		}
		return signature
			? [{ type: 'thinking', signature, thinking: _completeThinking ?? [part.value].flat().join('') }]
			: [];
	}
	return toTextOrImage(part);
}

function toTextOrImage(part: unknown): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] {
	if (part instanceof vscode.LanguageModelTextPart) {
		// Claude rejects blank text blocks.
		return part.value.trim() ? [{ type: 'text', text: part.value }] : [];
	}
	if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/')) {
		if (!IMAGE_TYPES.includes(part.mimeType)) {
			return [
				{ type: 'text', text: `[An image was left out because Claude can't read ${part.mimeType} files.]` },
			];
		}
		const mediaType = part.mimeType as Anthropic.Base64ImageSource['media_type'];
		return [
			{
				type: 'image',
				source: { type: 'base64', media_type: mediaType, data: Buffer.from(part.data).toString('base64') },
			},
		];
	}
	// Cache hints, history pointers, and other markers from chat have no Claude equivalent.
	return [];
}

function textOf(part: unknown): string {
	if (part instanceof vscode.LanguageModelTextPart) {
		return part.value;
	}
	if (part instanceof vscode.LanguageModelToolCallPart) {
		return JSON.stringify(part.input);
	}
	if (part instanceof vscode.LanguageModelToolResultPart) {
		return part.content.map(textOf).join('');
	}
	return '';
}

function isThinking(block: Anthropic.ContentBlockParam) {
	return block.type === 'thinking' || block.type === 'redacted_thinking';
}

function hasThinking(message: Anthropic.MessageParam) {
	return Array.isArray(message.content) && message.content.some(isThinking);
}

function withoutThinking(conversation: Anthropic.MessageParam[]) {
	const stripped: Anthropic.MessageParam[] = [];
	for (const { role, content } of conversation) {
		addTurn(
			stripped,
			role,
			(content as Anthropic.ContentBlockParam[]).filter(block => !isThinking(block)),
		);
	}
	return stripped;
}

/** The effort picker VS Code shows for a model. */
function effortSetting(modelId: string, efforts: Effort[]) {
	// Anthropic's defaults: medium on Opus 5.5 and Haiku 5.5, high on everything else.
	const preferred = /^claude-(opus|haiku)-5-5/.test(modelId) ? 'medium' : 'high';
	return {
		type: 'string',
		title: 'Thinking Effort',
		enum: efforts,
		enumItemLabels: efforts.map(level => EFFORT_LABELS[level]),
		default: efforts.find(level => level === preferred) ?? efforts[0],
		group: 'navigation',
	};
}

/**
 * The context size picker VS Code shows for a model in chat. Copilot's agent summarizes the
 * conversation once it outgrows the size you pick, which keeps each turn cheaper.
 */
function contextSizeSetting(modelId: string, contextWindow: number, maxInputTokens: number) {
	// Prompts over 100K tokens cost five times as much on Haiku 5.5. Other models charge the same at any length.
	const longPromptsCostMore = /^claude-haiku-5-5/.test(modelId);
	const smaller = longPromptsCostMore ? 100_000 : 200_000;
	if (maxInputTokens <= smaller) {
		return;
	}
	return {
		type: 'number',
		title: 'Context Size',
		// The values are prompt sizes, so the larger one leaves room for the reply.
		enum: [smaller, maxInputTokens],
		enumItemLabels: [formatTokens(smaller), formatTokens(contextWindow)],
		enumDescriptions: [
			longPromptsCostMore ? 'Stays below the price for long prompts' : 'Summarizes sooner, so turns cost less',
			'Longer sessions',
		],
		default: longPromptsCostMore ? smaller : maxInputTokens,
		group: 'tokens',
	};
}

function formatTokens(count: number) {
	return count >= 1_000_000 ? `${count / 1_000_000}M` : `${Math.round(count / 1000)}K`;
}

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/** The profile a Manage Models group names, or undefined for the active one. */
function profileOf(configuration: { readonly profile?: unknown }): string | undefined {
	const { profile } = configuration;
	if (profile !== undefined && profile !== null && typeof profile !== 'string') {
		throw new Error(
			'The profile in Manage Models has to be a name, like "acme". Leave it empty for the active sign-in.',
		);
	}
	return profile?.trim() || undefined;
}

/** Replaces the SDK's errors, where they are vague, with what went wrong and what to do about it. */
async function explain(error: unknown, profile: string | undefined, baseURL: string | undefined): Promise<unknown> {
	if (error instanceof Anthropic.APIConnectionError) {
		const cause = error.cause instanceof Error ? ` (${error.cause.message})` : '';
		return new Error(`Couldn't reach ${baseURL ?? 'the Anthropic API'}: ${error.message}${cause}`);
	}
	// The API answered, and not about the sign-in: a rate limit, say, or a model it doesn't know.
	if (error instanceof Anthropic.APIError && error.status !== 401) {
		return error;
	}
	return new Error(`${await signInHelp(profile)}\n\nDetails: ${messageOf(error)}`);
}

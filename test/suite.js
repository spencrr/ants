// Runs inside the VS Code extension host. Lives under the extension folder so that
// require('vscode') returns the API object bound to the extension under test.
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const proposedApi = process.env.PROPOSED_API === '1';
const LOG = path.join(__dirname, '..', '..', 'results.log');
const log = line => fs.appendFileSync(LOG, `[proposed API ${proposedApi ? 'on ' : 'off'}] ${line}\n`);

const api = process.env.FAKE_ANTHROPIC_URL;
const configDir = process.env.ANTHROPIC_CONFIG_DIR;
const credentialsFile = path.join(configDir, 'credentials', 'default.json');
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
	'base64',
);
const BMP = Buffer.from('Qk06AAAAAAAAADYAAAAoAAAAAQAAAAEAAAABABgAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAD/AA==', 'base64');
const { Assistant } = vscode.LanguageModelChatMessageRole;
const SYSTEM = 3;

const weatherTool = {
	name: 'get_weather',
	description: 'Weather for a city',
	inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
};
// Agent sessions turn freeform tools into a single `input` string like this.
const patchTool = {
	name: 'apply_patch',
	description: 'Apply a patch',
	inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
};
const bareTool = { name: 'list_files', description: 'List files' };

const now = () => Math.floor(Date.now() / 1000);
const token = () => new vscode.CancellationTokenSource().token;

async function serverRequests() {
	return (await fetch(`${api}/__requests`)).json();
}

async function sentMessages() {
	return (await serverRequests()).filter(r => r.path === '/v1/messages');
}

async function queueMessages(...modes) {
	await fetch(`${api}/__queue`, { method: 'POST', body: JSON.stringify(modes) });
}

// What `claude` /login or `ant auth login` leaves behind, pointed at the fake API.
function writeProfile(credentials) {
	fs.mkdirSync(path.join(configDir, 'configs'), { recursive: true });
	fs.mkdirSync(path.join(configDir, 'credentials'), { recursive: true });
	fs.writeFileSync(path.join(configDir, 'active_config'), 'default');
	fs.writeFileSync(
		path.join(configDir, 'configs', 'default.json'),
		JSON.stringify({
			version: '1.0',
			organization_id: '00000000-0000-0000-0000-000000000000',
			workspace_id: 'wrkspc_test',
			base_url: api,
			authentication: { type: 'user_oauth', client_id: 'test-client-id' },
			created_by: 'claude-code',
		}),
	);
	// Owner-only, like the real sign-in writes it; on Linux and macOS the SDK refuses anything looser.
	fs.writeFileSync(
		credentialsFile,
		JSON.stringify({ version: '1.0', type: 'oauth_token', scope: 'user:inference user:profile', ...credentials }),
		{ mode: 0o600 },
	);
}

async function collect(response) {
	const reply = { text: '', thinking: [], toolCalls: [], usage: undefined, parts: [] };
	for await (const part of response.stream) {
		reply.parts.push(part);
		if (part instanceof vscode.LanguageModelTextPart) {
			reply.text += part.value;
		} else if (part instanceof vscode.LanguageModelThinkingPart) {
			reply.thinking.push(part);
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			reply.toolCalls.push(part);
		} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === 'usage') {
			reply.usage = JSON.parse(Buffer.from(part.data).toString());
		}
	}
	return reply;
}

async function waitFor(fn, label, timeout = 15_000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const value = await fn();
		if (value) {
			return value;
		}
		await new Promise(r => setTimeout(r, 250));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

// The agent host logs (at trace level) which extension models it offers to Copilot agent sessions.
function agentHostCatalog() {
	const logsDir = process.env.LOGS_DIR;
	const files = fs.existsSync(logsDir)
		? fs
				.readdirSync(logsDir, { recursive: true })
				.map(f => path.join(logsDir, f))
				.filter(f => f.endsWith('.log'))
		: [];
	let latest;
	for (const file of files) {
		for (const match of fs
			.readFileSync(file, 'utf8')
			.matchAll(/\[Copilot\] Found (\d+) BYOK models(?:: ([^\r\n]*))?/g)) {
			latest = { count: Number(match[1]), names: match[2] ?? '', file: path.relative(logsDir, file) };
		}
	}
	return { latest, files: files.map(f => path.relative(logsDir, f)) };
}

// What the extension wrote to its own output channel.
function antsLog() {
	const logsDir = process.env.LOGS_DIR;
	const files = fs.existsSync(logsDir)
		? fs
				.readdirSync(logsDir, { recursive: true })
				.filter(f => f.endsWith('Ants.log'))
				.map(f => path.join(logsDir, f))
		: [];
	return files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
}

// VS Code logs (at trace level) every model it gets from the extension, settings included.
function modelsSeenByVsCode() {
	const logsDir = process.env.LOGS_DIR;
	const files = fs.existsSync(logsDir)
		? fs
				.readdirSync(logsDir, { recursive: true })
				.map(f => path.join(logsDir, f))
				.filter(f => f.endsWith('renderer.log'))
		: [];
	let latest;
	for (const file of files) {
		for (const match of fs
			.readFileSync(file, 'utf8')
			.matchAll(/\[LM\] Resolved language models for vendor ants (\[.*\])\r?$/gm)) {
			const models = JSON.parse(match[1]);
			if (models.length > 0) {
				latest = models;
			}
		}
	}
	return latest && Object.fromEntries(latest.map(({ metadata }) => [metadata.id, metadata]));
}

async function withProposedApi() {
	assert.deepStrictEqual(await vscode.lm.selectChatModels({ vendor: 'ants' }), []);
	const firstError = await waitFor(() => antsLog().match(/Couldn't list models: [^\n]*/)?.[0], 'the sign-in error');
	assert.match(firstError, /No Anthropic sign-in found in .*anthropic-config/);
	assert.match(firstError, /type \/login/);
	log('ok - no models, and no crash, before anyone signs in; the error says where it looked');

	// Sign in elsewhere after VS Code started. The access token is already stale.
	writeProfile({ access_token: 'sk-ant-oat01-stale', refresh_token: 'refresh-1', expires_at: now() - 3600 });
	const models = await vscode.lm.selectChatModels({ vendor: 'ants' });
	assert.deepStrictEqual(
		models.map(m => m.id),
		['claude-test-1', 'claude-haiku-5-5', 'claude-small'],
		'retired models are hidden',
	);
	assert.strictEqual(models[0].maxInputTokens, 1_000_000 - 32_000);
	assert.strictEqual(models[2].maxInputTokens, 200_000 - 8192);
	const [model, , small] = models;

	const requests = await serverRequests();
	assert.deepStrictEqual(
		requests.filter(r => r.path === '/v1/oauth/token').map(r => r.body),
		[{ grant_type: 'refresh_token', refresh_token: 'refresh-1', client_id: 'test-client-id' }],
	);
	const list = requests.find(r => r.path === '/v1/models');
	assert.strictEqual(list.headers.authorization, 'Bearer sk-ant-oat01-fresh-1');
	assert.strictEqual(list.headers['anthropic-workspace-id'], 'wrkspc_test');
	assert.match(list.headers['anthropic-beta'], /oauth-2025-04-20/);
	assert.strictEqual(
		JSON.parse(fs.readFileSync(credentialsFile, 'utf8')).refresh_token,
		'refresh-2',
		'new tokens are saved to the profile',
	);
	log('ok - picks up a sign-in made after startup, refreshes the stale token, and saves it');

	const seen = await waitFor(modelsSeenByVsCode, 'VS Code to log the models');
	assert.deepStrictEqual(seen['claude-test-1'].configurationSchema.properties.contextSize, {
		type: 'number',
		title: 'Context Size',
		enum: [200_000, 968_000],
		enumItemLabels: ['200K', '1M'],
		enumDescriptions: ['Summarizes sooner, so turns cost less', 'Longer sessions'],
		default: 968_000,
		group: 'tokens',
	});
	const haikuContext = seen['claude-haiku-5-5'].configurationSchema.properties.contextSize;
	assert.deepStrictEqual(
		[haikuContext.enum, haikuContext.enumItemLabels, haikuContext.default],
		[[100_000, 968_000], ['100K', '1M'], 100_000],
	);
	assert.strictEqual(seen['claude-haiku-5-5'].configurationSchema.properties.reasoningEffort.default, 'medium');
	assert.strictEqual(seen['claude-small'].configurationSchema, undefined, 'a 200K model has nothing to pick');
	log('ok - offers 200K or 1M context (1M by default), and 100K or 1M on Haiku 5.5 (100K by default)');

	// A request shaped the way agent sessions send it: a history pointer, a system prompt, earlier thinking,
	// a mid-conversation reminder, tool results with images, an output limit, and an effort level.
	// The API rejects the first attempt with 401, as if the token had been revoked.
	await queueMessages('401', 'thinking');
	const replyA = await collect(
		await model.sendRequest(
			[
				new vscode.LanguageModelChatMessage(Assistant, [
					new vscode.LanguageModelDataPart(Buffer.from('claude-test-1\\resp_0'), 'stateful_marker'),
				]),
				new vscode.LanguageModelChatMessage(SYSTEM, 'You are a test.'),
				vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelTextPart('What is the weather?'),
					new vscode.LanguageModelTextPart('   '),
					new vscode.LanguageModelDataPart(PNG, 'image/png'),
					new vscode.LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control'),
				]),
				new vscode.LanguageModelChatMessage(Assistant, [
					new vscode.LanguageModelThinkingPart('Let me think', 'think-0'),
					new vscode.LanguageModelThinkingPart('', 'think-0', {
						signature: 'sig-0',
						_completeThinking: 'Let me think about the weather.',
					}),
					new vscode.LanguageModelThinkingPart('', 'think-1', { redactedData: 'redacted-0' }),
					new vscode.LanguageModelTextPart('Let me check.'),
					new vscode.LanguageModelToolCallPart('toolu_0', 'get_weather', { city: 'Oslo' }),
				]),
				vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart('toolu_0', [
						new vscode.LanguageModelTextPart('Rainy'),
						new vscode.LanguageModelDataPart(PNG, 'image/png'),
						new vscode.LanguageModelDataPart(BMP, 'image/bmp'),
					]),
				]),
				new vscode.LanguageModelChatMessage(SYSTEM, 'Reminder: keep it short.'),
				vscode.LanguageModelChatMessage.User('And Paris?'),
			],
			{
				tools: [weatherTool, patchTool, bareTool],
				modelOptions: { max_tokens: 1000 },
				configuration: { reasoningEffort: 'medium' },
			},
			token(),
		),
	);

	assert.strictEqual(replyA.text, 'Sunny ✓');
	assert.deepStrictEqual(
		replyA.toolCalls.map(c => [c.callId, c.name, c.input]),
		[['toolu_1', 'get_weather', { city: 'Paris' }]],
	);
	assert.deepStrictEqual(
		replyA.thinking.map(p => [p.value, p.id, p.metadata]),
		[
			['Consider ', 'msg_think/0', undefined],
			['Paris.', 'msg_think/0', undefined],
			['', 'msg_think/0', { signature: 'sig-1', _completeThinking: 'Consider Paris.' }],
			['', 'msg_think/1', { redactedData: 'redacted-1' }],
		],
	);
	log('ok - streams thinking (text, then the signed block), redacted thinking, text, and a tool call');

	assert.deepStrictEqual(replyA.usage, {
		prompt_tokens: 1110,
		completion_tokens: 42,
		total_tokens: 1152,
		prompt_tokens_details: { cached_tokens: 1000 },
	});
	log('ok - reports token usage, cache reads included, the way chat and agent sessions read it');

	let sent = await sentMessages();
	assert.strictEqual(sent.length, 2, 'one retry after the 401');
	assert.strictEqual(sent[1].headers.authorization, 'Bearer sk-ant-oat01-fresh-2');
	const body = sent[1].body;
	assert.strictEqual(body.model, 'claude-test-1');
	assert.strictEqual(body.max_tokens, 1000, 'honors the output limit the caller asked for');
	assert.strictEqual(body.stream, true);
	assert.deepStrictEqual(body.cache_control, { type: 'ephemeral' });
	assert.strictEqual(body.system, 'You are a test.\n\nReminder: keep it short.');
	assert.deepStrictEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
	assert.deepStrictEqual(body.output_config, { effort: 'medium' });
	assert.strictEqual(body.tool_choice, undefined);
	assert.deepStrictEqual(body.tools, [
		{ name: 'get_weather', description: 'Weather for a city', input_schema: weatherTool.inputSchema },
		{ name: 'apply_patch', description: 'Apply a patch', input_schema: patchTool.inputSchema },
		{ name: 'list_files', description: 'List files', input_schema: { type: 'object' } },
	]);
	const userImage = body.messages[0].content[1];
	assert.strictEqual(userImage.type, 'image');
	assert.match(userImage.source.media_type, /^image\/(png|jpeg|gif|webp)$/);
	const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } };
	assert.deepStrictEqual(body.messages, [
		{ role: 'user', content: [{ type: 'text', text: 'What is the weather?' }, userImage] },
		{
			role: 'assistant',
			content: [
				{ type: 'thinking', signature: 'sig-0', thinking: 'Let me think about the weather.' },
				{ type: 'redacted_thinking', data: 'redacted-0' },
				{ type: 'text', text: 'Let me check.' },
				{ type: 'tool_use', id: 'toolu_0', name: 'get_weather', input: { city: 'Oslo' } },
			],
		},
		{
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_0',
					content: [
						{ type: 'text', text: 'Rainy' },
						png,
						{ type: 'text', text: "[An image was left out because Claude can't read image/bmp files.]" },
					],
				},
				{ type: 'text', text: 'And Paris?' },
			],
		},
	]);
	log('ok - request matches the Messages API: system prompt, thinking, effort, tools, images, merged tool results');

	// Hand the reply back as the next turn, the way chat does. The newest models refuse earlier
	// thinking when something before it changed, so the first attempt fails and is retried without it.
	await queueMessages('reject-thinking', 'stream');
	const replyB = await collect(
		await model.sendRequest(
			[
				vscode.LanguageModelChatMessage.User('What is the weather in Paris?'),
				new vscode.LanguageModelChatMessage(
					Assistant,
					replyA.parts.filter(part => !(part instanceof vscode.LanguageModelDataPart)),
				),
				vscode.LanguageModelChatMessage.User([
					new vscode.LanguageModelToolResultPart('toolu_1', [
						new vscode.LanguageModelTextPart('Sunny, 25°C'),
					]),
				]),
			],
			{},
			token(),
		),
	);
	assert.strictEqual(replyB.text, 'Hello world ✓');

	sent = (await sentMessages()).slice(-2);
	assert.deepStrictEqual(
		sent[0].body.messages[1].content,
		[
			{ type: 'thinking', signature: 'sig-1', thinking: 'Consider Paris.' },
			{ type: 'redacted_thinking', data: 'redacted-1' },
			{ type: 'text', text: 'Sunny ✓' },
			{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
		],
		'thinking comes back exactly as Claude sent it',
	);
	log('ok - thinking survives the round trip through chat unchanged');

	assert.deepStrictEqual(sent[1].body.messages[1].content, [
		{ type: 'text', text: 'Sunny ✓' },
		{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
	]);
	log('ok - when Claude refuses earlier thinking, retries once without it');

	assert.deepStrictEqual(
		sent[0].body.output_config,
		{ effort: 'high' },
		"the picker's default effort applies when nothing was chosen",
	);
	log("ok - uses the effort picker's default (high) when nothing was chosen");

	// Forcing a tool call: no thinking. A model with no effort or thinking support gets neither.
	await queueMessages('stream', 'stream');
	await collect(
		await model.sendRequest(
			[vscode.LanguageModelChatMessage.User('Hi')],
			{ tools: [weatherTool], toolMode: vscode.LanguageModelChatToolMode.Required },
			token(),
		),
	);
	await collect(
		await small.sendRequest(
			[vscode.LanguageModelChatMessage.User('Hi')],
			{ tools: [weatherTool], configuration: { reasoningEffort: 'medium' } },
			token(),
		),
	);
	const [forced, plain] = (await sentMessages()).slice(-2).map(r => r.body);
	assert.deepStrictEqual(forced.tool_choice, { type: 'any' });
	assert.strictEqual(forced.thinking, undefined);
	assert.deepStrictEqual(forced.output_config, { effort: 'high' });
	assert.strictEqual(plain.thinking, undefined);
	assert.strictEqual(plain.output_config, undefined);
	assert.strictEqual(plain.max_tokens, 8192);
	log('ok - forced tool calls skip thinking, and models without effort or thinking get neither');

	// The sign-in has expired for good: the API says 401 and the refresh token is revoked.
	writeProfile({ access_token: 'sk-ant-oat01-stale', refresh_token: 'revoked-1', expires_at: now() - 3600 });
	await queueMessages('401');
	await assert.rejects(
		async () => collect(await model.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token())),
		error => {
			assert.match(error.message, /sign-in for profile "default" has expired or was revoked/);
			assert.match(error.message, /type \/login/);
			assert.match(error.message, /Details: .*revoked/, 'keeps the underlying reason');
			return true;
		},
	);
	log('ok - an expired sign-in fails with instructions for signing in again');

	// A profile that isn't a browser sign-in, like a federated one from CI, gets a different hint.
	fs.writeFileSync(
		path.join(configDir, 'configs', 'default.json'),
		JSON.stringify({ version: '1.0', base_url: api, authentication: { type: 'oidc_federation' } }),
	);
	await assert.rejects(
		async () => collect(await model.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token())),
		/profile "default" uses oidc_federation authentication, which this extension doesn't support/,
	);
	log('ok - a profile this extension cannot use is named as the problem');

	// Signing in again fixes it without reloading. Then cancel a slow reply.
	writeProfile({ access_token: 'sk-ant-oat01-new-login', refresh_token: 'refresh-new', expires_at: now() + 3600 });
	await queueMessages('slow');
	const cts = new vscode.CancellationTokenSource();
	const slow = await model.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, cts.token);
	const parts = slow.stream[Symbol.asyncIterator]();
	assert.strictEqual((await parts.next()).value.value, 'Hello');
	cts.cancel();
	await Promise.race([
		(async () => {
			try {
				let next = await parts.next();
				while (!next.done) {
					next = await parts.next();
				}
			} catch {
				// A cancelled stream may end with an error instead of `done`; either way it stopped.
			}
		})(),
		new Promise((_, reject) => setTimeout(() => reject(new Error('stream kept going after cancel')), 5000)),
	]);
	await waitFor(async () => (await serverRequests()).some(r => r.closedByClient), 'the connection to close');
	assert.strictEqual(
		(await sentMessages()).at(-1).headers.authorization,
		'Bearer sk-ant-oat01-new-login',
		'uses the new sign-in from disk',
	);
	log('ok - signing in again works without a reload, and cancelling closes the connection');

	assert.strictEqual(await model.countTokens('abcdefghi'), 3);
	log('ok - token count estimate');

	// This run started with the Agents window allow-list empty (and the agent-session setting at
	// VS Code's default, which was off until 1.142), so the extension offered to set them up. Take the
	// offer the way its Enable button does: through the command.
	const settings = () => ({
		byok: vscode.workspace.getConfiguration('chat').get('agentHost.byokModels.enabled'),
		allowed: vscode.workspace.getConfiguration('extensions').get('supportAgentsWindow'),
	});
	assert.deepStrictEqual(settings().allowed, {});
	await vscode.commands.executeCommand('ants.allowAgentSessions');
	assert.deepStrictEqual(settings(), { byok: true, allowed: { 'spencrr.ants': true } });
	log('ok - "Allow Claude in Copilot Agent Sessions" turns on both settings');

	await expectAgentSessionsToOfferModels();
}

// VS Code treats models from any extension except Copilot Chat as bring-your-own-key models, which
// Copilot agent sessions can use once chat.agentHost.byokModels.enabled is on. No proposed API needed.
async function expectAgentSessionsToOfferModels() {
	const catalog = await waitFor(
		() => {
			const found = agentHostCatalog();
			return found.latest?.count === 3 ? found : undefined;
		},
		`the agent host to offer the models (logs: ${JSON.stringify(agentHostCatalog())})`,
	);
	assert.strictEqual(catalog.latest.names, 'Claude Test, Claude Haiku 5.5, Claude Small');
	log(`ok - the agent host offers all three models to Copilot agent sessions (${catalog.latest.file})`);
}

async function withoutProposedApi() {
	writeProfile({ access_token: 'sk-ant-oat01-valid', refresh_token: 'refresh-1', expires_at: now() + 3600 });
	const models = await vscode.lm.selectChatModels({ vendor: 'ants' });
	assert.deepStrictEqual(
		models.map(m => m.id),
		['claude-test-1', 'claude-haiku-5-5', 'claude-small'],
	);
	const seen = await waitFor(modelsSeenByVsCode, 'VS Code to log the models');
	assert.deepStrictEqual(
		Object.values(seen).map(m => m.configurationSchema),
		[undefined, undefined, undefined],
	);
	log('ok - lists models, with no effort or context size pickers');

	// The newest models think even when nobody asks. Without the proposed API that thinking stays hidden.
	await queueMessages('thinking');
	const reply = await collect(
		await models[0].sendRequest(
			[vscode.LanguageModelChatMessage.User('And Paris?')],
			{ tools: [weatherTool], configuration: { reasoningEffort: 'medium' } },
			token(),
		),
	);
	assert.strictEqual(reply.text, 'Sunny ✓');
	assert.deepStrictEqual(
		reply.toolCalls.map(c => c.callId),
		['toolu_1'],
	);
	assert.deepStrictEqual(reply.thinking, []);
	assert.deepStrictEqual(reply.usage, {
		prompt_tokens: 1110,
		completion_tokens: 42,
		total_tokens: 1152,
		prompt_tokens_details: { cached_tokens: 1000 },
	});
	const body = (await sentMessages()).at(-1).body;
	assert.strictEqual(body.thinking, undefined);
	assert.strictEqual(body.output_config, undefined);
	log('ok - chat works, and no thinking or effort is sent or shown');

	await expectAgentSessionsToOfferModels();
}

exports.run = async () => {
	try {
		// Copilot Chat sets this from the account's BYOK policy (always on for signed-out and internal
		// users). VS Code checks it before handing extension models to agent sessions.
		await vscode.commands.executeCommand('setContext', 'github.copilot.clientByokEnabled', true);
		await (proposedApi ? withProposedApi() : withoutProposedApi());
	} catch (error) {
		log(`FAIL: ${error?.stack || require('node:util').inspect(error, { depth: 5 })}`);
		throw error;
	}
};

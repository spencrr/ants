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

// What `claude` /login or `ant auth login` leaves behind, pointed at the fake API. The default
// profile is the active one; `ant auth login --profile other` adds a second, for another workspace
// in another organization.
function writeProfile(credentials, { name = 'default', workspace = 'wrkspc_test' } = {}) {
	fs.mkdirSync(path.join(configDir, 'configs'), { recursive: true });
	fs.mkdirSync(path.join(configDir, 'credentials'), { recursive: true });
	fs.writeFileSync(path.join(configDir, 'active_config'), 'default');
	fs.writeFileSync(
		path.join(configDir, 'configs', `${name}.json`),
		JSON.stringify({
			version: '1.0',
			organization_id:
				workspace === 'wrkspc_other'
					? '11111111-1111-1111-1111-111111111111'
					: '00000000-0000-0000-0000-000000000000',
			workspace_id: workspace,
			base_url: api,
			authentication: { type: 'user_oauth', client_id: 'test-client-id' },
			created_by: 'claude-code',
		}),
	);
	// Owner-only, like the real sign-in writes it; on Linux and macOS the SDK refuses anything looser.
	fs.writeFileSync(
		path.join(configDir, 'credentials', `${name}.json`),
		JSON.stringify({ version: '1.0', type: 'oauth_token', scope: 'user:inference user:profile', ...credentials }),
		{ mode: 0o600 },
	);
}

/** The access token a profile's credentials file holds right now (the SDK saves refreshed ones there). */
function tokenOf(name) {
	return JSON.parse(fs.readFileSync(path.join(configDir, 'credentials', `${name}.json`), 'utf8')).access_token;
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

// The usage log the extension appends to, one JSON record per request.
function usageRecords() {
	const { publisher, name } = require('../package.json');
	const file = path.join(process.env.LOGS_DIR, '..', 'User', 'globalStorage', `${publisher}.${name}`, 'usage.jsonl');
	return fs.existsSync(file)
		? fs
				.readFileSync(file, 'utf8')
				.split('\n')
				.filter(Boolean)
				.map(line => JSON.parse(line))
		: [];
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

// VS Code logs (at trace level) every model it gets from the extension, settings included, keyed by
// the identifier it registers: `ants/<group>/<id>`.
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
	return latest && Object.fromEntries(latest.map(({ identifier, metadata }) => [identifier, metadata]));
}

// This run has two groups in chatLanguageModels.json: "Claude (Console)" for the active profile and
// "Other org" for the profile named `other`.
async function withProposedApi() {
	assert.deepStrictEqual(await vscode.lm.selectChatModels({ vendor: 'ants' }), []);
	const firstErrors = await waitFor(() => {
		const lines = antsLog().match(/Couldn't list models[^\n]*/g) ?? [];
		return lines.length >= 2 ? lines : undefined;
	}, 'one sign-in error per group');
	assert.match(firstErrors[0], /^Couldn't list models: No Anthropic sign-in found in .*anthropic-config/);
	assert.match(firstErrors[0], /type \/login/);
	assert.match(
		firstErrors[1],
		/^Couldn't list models for profile "other": No Anthropic profile named "other"\. Run `ant auth login --profile other`/,
	);
	log('ok - no models, and no crash, before anyone signs in; each group says what it is missing');

	// Claude Code's "Create an API key" login leaves a key in its own settings file and no profile.
	const claudeCodeSettings = path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
	fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
	fs.writeFileSync(claudeCodeSettings, JSON.stringify({ primaryApiKey: 'sk-ant-api03-not-for-us' }));
	await vscode.lm.selectChatModels({ vendor: 'ants' });
	await waitFor(
		() => antsLog().match(/Claude Code is signed in with an API key it made for itself[^\n]*/)?.[0],
		'the API-key hint',
	);
	fs.rmSync(claudeCodeSettings);
	log('ok - a Claude Code login that made its own API key is told apart from no login at all');

	// Sign in elsewhere after VS Code started. The access token is already stale.
	writeProfile({ access_token: 'sk-ant-oat01-stale', refresh_token: 'refresh-1', expires_at: now() - 3600 });
	let models = await vscode.lm.selectChatModels({ vendor: 'ants' });
	assert.deepStrictEqual(
		models.map(m => m.id),
		['claude-test-1', 'claude-haiku-5-5', 'claude-small'],
		'retired models are hidden',
	);
	assert.strictEqual(models[0].maxInputTokens, 1_000_000 - 32_000);
	assert.strictEqual(models[2].maxInputTokens, 200_000 - 8192);
	let [model, , small] = models;

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

	// The second group's profile still doesn't exist, so its error now lists what does.
	await waitFor(
		() => antsLog().match(/No Anthropic profile named "other"\. The profiles on this machine are: default\./)?.[0],
		'the missing profile to be named',
	);
	let seen = await waitFor(modelsSeenByVsCode, 'VS Code to log the models');
	assert.deepStrictEqual(
		Object.keys(seen),
		[
			'ants/Claude (Console)/claude-test-1',
			'ants/Claude (Console)/claude-haiku-5-5',
			'ants/Claude (Console)/claude-small',
		],
		'every model belongs to its group; nothing is listed twice',
	);
	assert.strictEqual(seen['ants/Claude (Console)/claude-test-1'].detail, 'Claude (Console)');
	log('ok - models come from groups only, and a group whose profile is missing says which profiles exist');

	// Now sign in to the other workspace too, under its own profile. Its token is stale as well, so
	// it has to be refreshed on its own, without touching the first profile's.
	const defaultCredentialsBefore = fs.readFileSync(credentialsFile, 'utf8');
	writeProfile(
		{ access_token: 'sk-ant-oat01-other-stale', refresh_token: 'refresh-other', expires_at: now() - 3600 },
		{ name: 'other', workspace: 'wrkspc_other' },
	);
	models = await vscode.lm.selectChatModels({ vendor: 'ants' });
	assert.deepStrictEqual(
		models.map(m => m.id),
		['claude-test-1', 'claude-haiku-5-5', 'claude-small', 'claude-test-1', 'claude-other-1'],
		'both workspaces have claude-test-1, and each is listed',
	);
	const other = models.find(m => m.id === 'claude-other-1');
	seen = await waitFor(() => {
		const all = modelsSeenByVsCode();
		return all?.['ants/Other org/claude-other-1'] ? all : undefined;
	}, 'VS Code to log the other group');
	assert.strictEqual(seen['ants/Other org/claude-other-1'].detail, 'Other org');
	assert.strictEqual(seen['ants/Other org/claude-test-1'].detail, 'Other org');
	const otherList = (await serverRequests()).filter(
		r => r.path === '/v1/models' && r.headers['anthropic-workspace-id'] === 'wrkspc_other',
	);
	assert.ok(otherList.length > 0, 'the other workspace was asked for its models');
	assert.deepStrictEqual(
		(await serverRequests()).filter(r => r.path === '/v1/oauth/token').map(r => r.body.refresh_token),
		['refresh-1', 'refresh-other'],
		'each profile refreshes its own token',
	);
	assert.strictEqual(
		fs.readFileSync(credentialsFile, 'utf8'),
		defaultCredentialsBefore,
		"the first profile's file is untouched",
	);
	assert.strictEqual(
		otherList[0].headers.authorization,
		`Bearer ${tokenOf('other')}`,
		'the refreshed token was saved',
	);
	log('ok - a second group reaches a second profile, with its own workspace, models and token refresh');

	// The same model in two groups: each copy goes to its own workspace, even side by side.
	const twins = await vscode.lm.selectChatModels({ vendor: 'ants', id: 'claude-test-1' });
	assert.strictEqual(twins.length, 2);
	await queueMessages('echo', 'echo', 'echo');
	const [replyOne, replyTwo] = await Promise.all(
		twins.map(async twin =>
			collect(await twin.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token())),
		),
	);
	assert.deepStrictEqual([replyOne.text, replyTwo.text].sort(), ['from wrkspc_other', 'from wrkspc_test']);
	const again = await collect(await twins[0].sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()));
	assert.strictEqual(again.text, replyOne.text, 'the same copy always goes the same way');
	const twinRequests = (await sentMessages()).slice(-3);
	assert.deepStrictEqual(
		twinRequests.map(r => r.body.model),
		['claude-test-1', 'claude-test-1', 'claude-test-1'],
	);
	for (const r of twinRequests) {
		assert.strictEqual(
			r.headers.authorization,
			`Bearer ${tokenOf(r.headers['anthropic-workspace-id'] === 'wrkspc_other' ? 'other' : 'default')}`,
			"each request carries its own workspace's token",
		);
	}
	log('ok - the same model in two groups is kept apart: own workspace, own token, side by side');

	assert.deepStrictEqual(seen['ants/Claude (Console)/claude-test-1'].configurationSchema.properties.contextSize, {
		type: 'number',
		title: 'Context Size',
		enum: [200_000, 968_000],
		enumItemLabels: ['200K', '1M'],
		enumDescriptions: ['Summarizes sooner, so turns cost less', 'Longer sessions'],
		default: 968_000,
		group: 'tokens',
	});
	const haikuContext = seen['ants/Claude (Console)/claude-haiku-5-5'].configurationSchema.properties.contextSize;
	assert.deepStrictEqual(
		[haikuContext.enum, haikuContext.enumItemLabels, haikuContext.default],
		[[100_000, 968_000], ['100K', '1M'], 100_000],
	);
	assert.strictEqual(
		seen['ants/Claude (Console)/claude-haiku-5-5'].configurationSchema.properties.reasoningEffort.default,
		'medium',
	);
	assert.strictEqual(
		seen['ants/Claude (Console)/claude-small'].configurationSchema,
		undefined,
		'a 200K model has nothing to pick',
	);
	log('ok - offers 200K or 1M context (1M by default), and 100K or 1M on Haiku 5.5 (100K by default)');

	// A request shaped the way agent sessions send it: a history pointer, a system prompt, earlier thinking,
	// a mid-conversation reminder, tool results with images, an output limit, and an effort level.
	// The API rejects the first attempt with 401, as if the token had been revoked.
	const sentBefore = (await sentMessages()).length;
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

	// The usage log says who paid: the organization and workspace behind the group's sign-in.
	const recorded = await waitFor(() => usageRecords().at(-1), 'the usage record');
	assert.deepStrictEqual(
		[recorded.model, recorded.profile, recorded.organization, recorded.workspace, recorded.effort],
		['claude-test-1', undefined, 'Test Org', 'wrkspc_test', 'medium'],
	);
	assert.deepStrictEqual(
		[recorded.input, recorded.cacheRead, recorded.cacheWrite, recorded.output],
		[10, 1000, 100, 42],
	);
	const lookups = (await serverRequests()).filter(r => r.path === '/api/oauth/profile');
	assert.deepStrictEqual(
		lookups.map(r => r.headers['anthropic-workspace-id']),
		['wrkspc_test', 'wrkspc_other'],
		'one account lookup per profile, after its models were listed',
	);
	log('ok - the usage log names the organization and workspace billed');

	let sent = (await sentMessages()).slice(sentBefore);
	assert.strictEqual(sent.length, 2, 'one retry after the 401');
	assert.strictEqual(sent[1].headers.authorization, `Bearer ${tokenOf('default')}`);
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

	// A model the price table doesn't know gets no cost, rather than a cost of nothing. One it knows
	// gets an estimate, and the same rows come out as CSV for a spreadsheet.
	assert.strictEqual(recorded.cost, undefined, 'claude-test-1 has no list price');
	await queueMessages('stream');
	await collect(await models[1].sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()));
	const priced = await waitFor(() => {
		const last = usageRecords().at(-1);
		return last?.model === 'claude-haiku-5-5' ? last : undefined;
	}, 'the usage record');
	assert.ok(priced.cost > 0 && priced.cost < 0.001, `Haiku 5.5 is priced: ${priced.cost}`);
	const { toCsv } = require('../out/usageLog.js');
	assert.deepStrictEqual(toCsv([recorded, priced]).split('\r\n').length, 3);
	assert.match(
		toCsv([{ ...priced, organization: 'Test, Inc.' }]).split('\r\n')[1],
		/^[^,]+,claude-haiku-5-5,"Test, Inc\.",wrkspc_test,,[^,]+,[0-9a-f]+,medium,,10,0,0,12,\d+,0\.000007$/,
	);
	log('ok - unknown prices stay unknown, known ones are estimated, and rows export as CSV');

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
	const failedRecord = await waitFor(() => {
		const last = usageRecords().at(-1);
		return last?.outcome === 'error' ? last : undefined;
	}, 'the failed request to be logged');
	assert.deepStrictEqual(
		[failedRecord.model, failedRecord.organization, failedRecord.input, failedRecord.output, failedRecord.cost],
		['claude-test-1', 'Test Org', 0, 0, undefined],
		'a failed request is logged with nothing counted',
	);
	log('ok - an expired sign-in fails with instructions for signing in again');

	// A profile that isn't a browser sign-in, like a federated one from CI, gets a different hint.
	fs.writeFileSync(
		path.join(configDir, 'configs', 'default.json'),
		JSON.stringify({ version: '1.0', base_url: api, authentication: { type: 'oidc_federation' } }),
	);
	await assert.rejects(
		async () => collect(await model.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token())),
		/profile "default" signs in with oidc_federation, and that didn't work this time\. The details below are the SDK's\.\n\nDetails: /,
	);
	log("ok - a profile that signs in another way gets the SDK's own error, not sign-in steps");

	// A request through the other group's model goes out with that profile's token and workspace.
	await queueMessages('stream');
	const replyOther = await collect(
		await other.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()),
	);
	assert.strictEqual(replyOther.text, 'Hello world ✓');
	const sentOther = (await sentMessages()).at(-1);
	assert.strictEqual(sentOther.headers['anthropic-workspace-id'], 'wrkspc_other');
	assert.strictEqual(sentOther.headers.authorization, `Bearer ${tokenOf('other')}`);
	assert.strictEqual(sentOther.body.model, 'claude-other-1');
	assert.match(
		await waitFor(() => antsLog().match(/claude-other-1 \[other\][^\n]*/)?.[0], 'the log line'),
		/tokens in/,
	);
	const recordedOther = await waitFor(() => {
		const last = usageRecords().at(-1);
		return last?.model === 'claude-other-1' ? last : undefined;
	}, 'the usage record');
	assert.deepStrictEqual(
		[recordedOther.profile, recordedOther.organization, recordedOther.workspace],
		['other', 'Other Org', 'wrkspc_other'],
	);
	log('ok - requests through a group use its profile');

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
	// What had arrived before the stop is billed all the same, so it goes in the log: the prompt
	// tokens from the start of the message, and the output estimated from the text that got
	// through ("Hello world ✓", 13 characters) since the API only counts it at the end.
	const stopped = await waitFor(() => {
		const last = usageRecords().at(-1);
		return last?.outcome === 'cancelled' ? last : undefined;
	}, 'the cancelled request to be logged');
	assert.deepStrictEqual([stopped.input, stopped.output, stopped.organization], [10, 4, 'Test Org']);
	log('ok - signing in again works without a reload, and cancelling closes the connection');

	// One profile's sign-in going bad leaves the other alone. The API says 401 twice for the other
	// profile (once before and once after the SDK refreshes its token), while the first still works.
	await queueMessages('401', '401');
	await assert.rejects(
		async () => collect(await other.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token())),
		/sign-in for profile "other" has expired or was revoked/,
	);
	await queueMessages('echo');
	assert.strictEqual(
		(await collect(await model.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()))).text,
		'from wrkspc_test',
		'the first profile is unaffected',
	);
	log("ok - one profile's sign-in failing leaves the other working");

	// When the API host can't be reached, say that, rather than blaming the sign-in. The client is
	// made afresh after a failure, which the failure above just caused, so point it at a dead port.
	const otherConfig = path.join(configDir, 'configs', 'other.json');
	fs.writeFileSync(otherConfig, fs.readFileSync(otherConfig, 'utf8').replace(api, 'http://127.0.0.1:9'));
	await assert.rejects(
		async () => collect(await other.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token())),
		/Error: Couldn't reach http:\/\/127\.0\.0\.1:9: Connection error\./,
	);
	// Sign in to the other workspace again, which also puts its API host back.
	writeProfile(
		{ access_token: 'sk-ant-oat01-other-again', refresh_token: 'refresh-other-2', expires_at: now() + 3600 },
		{ name: 'other', workspace: 'wrkspc_other' },
	);
	await queueMessages('stream');
	assert.strictEqual(
		(await collect(await other.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()))).text,
		'Hello world ✓',
		'works again once the host is back',
	);
	log('ok - an unreachable API host is reported as such, and recovers without a reload');

	// Switching the active profile on disk (`ant profile activate other`) moves groups with a blank profile
	// along with it: the next request goes to the other workspace, and the models are listed again.
	const otherListings = async () =>
		(await serverRequests()).filter(
			r => r.path === '/v1/models' && r.headers['anthropic-workspace-id'] === 'wrkspc_other',
		).length;
	const listingsBefore = await otherListings();
	fs.writeFileSync(path.join(configDir, 'active_config'), 'other');
	await queueMessages('stream');
	await collect(await model.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()));
	const moved = (await sentMessages()).at(-1);
	assert.strictEqual(moved.headers['anthropic-workspace-id'], 'wrkspc_other');
	assert.strictEqual(moved.headers.authorization, `Bearer ${tokenOf('other')}`);
	assert.match(antsLog(), /The active Anthropic profile changed from "default" to "other"./);
	await waitFor(async () => (await otherListings()) > listingsBefore, 'the models to be listed again');
	const recordedMove = await waitFor(() => {
		const last = usageRecords().at(-1);
		return last?.organization === 'Other Org' && last.profile === undefined ? last : undefined;
	}, 'the usage record');
	assert.strictEqual(recordedMove.workspace, 'wrkspc_other');
	let status = await vscode.commands.executeCommand('ants.showStatus');
	assert.match(status, /^## Active sign-in \(`other`\)$/m);
	// Back to the first profile for the rest of the run. The group's models changed with the switch, so the
	// old handle is gone; listing them again notices the switch back and brings the first set back.
	fs.writeFileSync(path.join(configDir, 'active_config'), 'default');
	model = await waitFor(async () => {
		const found = await vscode.lm.selectChatModels({ vendor: 'ants', id: 'claude-test-1' });
		return found[0];
	}, "the first profile's models to come back");
	await queueMessages('stream');
	await collect(await model.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()));
	assert.strictEqual((await sentMessages()).at(-1).headers['anthropic-workspace-id'], 'wrkspc_test');
	log('ok - a group with a blank profile follows the active sign-in when it changes, without a reload');

	// The status page: who each group bills, from the config files and the account lookup.
	status = await vscode.commands.executeCommand('ants.showStatus');
	assert.match(status, /^## Active sign-in \(`default`\)$/m);
	assert.match(status, /^- \*\*Organization:\*\* Test Org \(`00000000-0000-0000-0000-000000000000`\)$/m);
	assert.match(status, /^- \*\*Workspace:\*\* `wrkspc_test`$/m);
	assert.match(status, /^- \*\*Account:\*\* me@test.example$/m);
	assert.match(
		status,
		/^- \*\*Sign-in:\*\* browser sign-in; credentials last saved .+ \(the sign-in, or the last token refresh\)$/m,
	);
	assert.match(status, /^## Profile `other`$/m);
	assert.match(status, /^- \*\*Organization:\*\* Other Org \(`11111111-1111-1111-1111-111111111111`\)$/m);
	assert.doesNotMatch(status, /\*\*Last error:\*\* (?!none)/, 'errors from before the sign-ins worked are forgotten');
	assert.match(status, /^- \*\*Proposed APIs:\*\* on/m);
	assert.match(status, /^- \*\*Copilot agent sessions:\*\* not yet: .*supportAgentsWindow/m);
	assert.doesNotMatch(status, /Profiles with no group/, 'every profile on disk has a group');
	log('ok - the connection status page names the organization, workspace and account of each group');

	// VS Code asks for models without a group before it asks per group. That first call must not be
	// mistaken for "no groups": this run has had two all along.
	assert.ok(!antsLog().includes('Offering to add the first one'), 'no offer to add a group when there are groups');
	log('ok - the offer to add a first group stays quiet when groups exist');

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

	await expectAgentSessionsToOfferModels('Claude Test, Claude Haiku 5.5, Claude Small, Claude Test, Claude Other');
}

// VS Code treats models from any extension except Copilot Chat as bring-your-own-key models, which
// Copilot agent sessions can use once chat.agentHost.byokModels.enabled is on. No proposed API needed.
async function expectAgentSessionsToOfferModels(names) {
	const catalog = await waitFor(
		() => {
			const found = agentHostCatalog();
			return found.latest?.names === names ? found : undefined;
		},
		`the agent host to offer ${names} (logs: ${JSON.stringify(agentHostCatalog())})`,
	);
	log(`ok - the agent host offers every group's models to Copilot agent sessions (${catalog.latest.file})`);
}

// This run starts the way a fresh install does: signed in, but with no group in Manage Models yet.
async function withoutProposedApi() {
	writeProfile({ access_token: 'sk-ant-oat01-valid', refresh_token: 'refresh-1', expires_at: now() + 3600 });
	assert.deepStrictEqual(await vscode.lm.selectChatModels({ vendor: 'ants' }), [], 'nothing without a group');
	assert.strictEqual((await serverRequests()).length, 0, 'and no request to Anthropic either');
	await waitFor(() => antsLog().includes('Offering to add the first one'), 'the offer to add a group');
	assert.match(
		await vscode.commands.executeCommand('ants.showStatus'),
		/No group in Manage Models has asked for models yet/,
	);
	log('ok - with no group yet there are no models, and the extension offers to add the first one');

	// Add the group the way Manage Models > Add Models would. VS Code watches the file.
	const groupsFile = path.join(process.env.LOGS_DIR, '..', 'User', 'chatLanguageModels.json');
	fs.writeFileSync(groupsFile, JSON.stringify([{ name: 'My org', vendor: 'ants' }]));
	const models = await waitFor(async () => {
		const found = await vscode.lm.selectChatModels({ vendor: 'ants' });
		return found.length > 0 ? found : undefined;
	}, 'the new group to be picked up');
	assert.deepStrictEqual(
		models.map(m => m.id),
		['claude-test-1', 'claude-haiku-5-5', 'claude-small'],
	);
	const seen = await waitFor(modelsSeenByVsCode, 'VS Code to log the models');
	assert.deepStrictEqual(Object.keys(seen), [
		'ants/My org/claude-test-1',
		'ants/My org/claude-haiku-5-5',
		'ants/My org/claude-small',
	]);
	assert.deepStrictEqual(
		Object.values(seen).map(m => m.configurationSchema),
		[undefined, undefined, undefined],
	);
	log('ok - adding a group lists its models right away, with no effort or context size pickers');

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

	const status = await vscode.commands.executeCommand('ants.showStatus');
	assert.match(status, /^## Active sign-in \(`default`\)$/m);
	assert.match(status, /^- \*\*Organization:\*\* Test Org /m);
	assert.match(status, /^- \*\*Proposed APIs:\*\* off\. Add `"enable-proposed-api"/m);
	assert.match(status, /^- \*\*Copilot agent sessions:\*\* allowed, in this window and in the Agents window$/m);
	log('ok - the connection status page works without the proposed APIs');

	// A second group with a named profile needs no proposed API either: VS Code passes the group's
	// configuration to the extension on stable VS Code as well.
	writeProfile(
		{ access_token: 'sk-ant-oat01-other', refresh_token: 'refresh-other', expires_at: now() + 3600 },
		{ name: 'other', workspace: 'wrkspc_other' },
	);
	fs.writeFileSync(
		groupsFile,
		JSON.stringify([
			{ name: 'My org', vendor: 'ants' },
			{ name: 'Other org', vendor: 'ants', profile: 'other' },
		]),
	);
	const otherModel = await waitFor(async () => {
		const found = await vscode.lm.selectChatModels({ vendor: 'ants', id: 'claude-other-1' });
		return found[0];
	}, 'the other group to be picked up');
	await queueMessages('echo');
	assert.strictEqual(
		(await collect(await otherModel.sendRequest([vscode.LanguageModelChatMessage.User('hi')], {}, token()))).text,
		'from wrkspc_other',
	);
	assert.strictEqual((await sentMessages()).at(-1).headers.authorization, `Bearer ${tokenOf('other')}`);
	log('ok - a group with a named profile works without the proposed APIs too');

	await expectAgentSessionsToOfferModels('Claude Test, Claude Haiku 5.5, Claude Small, Claude Test, Claude Other');
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

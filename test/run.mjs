#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: the runner reports what it does.
// Runs the extension in a real VS Code, twice: once with its proposed APIs enabled (the
// agent-session setup) and once without (plain chat). A fake api.anthropic.com and a
// throwaway Anthropic profile directory stand in for the real service and sign-in.
//
//   node test/run.mjs          test the compiled extension (out/)
//   node test/run.mjs --vsix   test the newest .vsix in the repository root instead
//
// The first run downloads VS Code into .vscode-test/. On Linux, run it under `xvfb-run -a`.
// Set VSCODE_VERSION to test against a specific release instead of the latest stable one.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const scratch = path.join(here, '.scratch');

let requests = [];
let messageQueue = []; // what /v1/messages does next: '401' | 'stream' | 'echo' | 'odd-usage' | 'thinking' | 'reject-thinking' | 'slow'
let issued = 0;

function json(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_test' });
	res.end(JSON.stringify(body));
}

function sse(events) {
	return events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function message(id, usage, blocks, stopReason, outputTokens) {
	const events = [
		{
			type: 'message_start',
			message: {
				id,
				type: 'message',
				role: 'assistant',
				model: 'claude-test-1',
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage,
			},
		},
	];
	blocks.forEach(([start, ...deltas], index) => {
		events.push({ type: 'content_block_start', index, content_block: start });
		for (const delta of deltas) {
			events.push({ type: 'content_block_delta', index, delta });
		}
		events.push({ type: 'content_block_stop', index });
		if (index === 0) {
			events.push({ type: 'ping' });
		}
	});
	events.push({
		type: 'message_delta',
		delta: { stop_reason: stopReason, stop_sequence: null },
		usage: { output_tokens: outputTokens },
	});
	events.push({ type: 'message_stop' });
	return sse(events);
}

const toolUse = [
	{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
	{ type: 'input_json_delta', partial_json: '{"city":' },
	{ type: 'input_json_delta', partial_json: ' "Paris"}' },
];

const replies = {
	// Token counts that aren't numbers, from a server that isn't behaving.
	'odd-usage': () =>
		message(
			'msg_odd',
			{ input_tokens: '<b>x</b>', cache_read_input_tokens: -5, output_tokens: 1 },
			[
				[
					{ type: 'text', text: '' },
					{ type: 'text_delta', text: 'odd' },
				],
			],
			'end_turn',
			'12',
		),
	// Says which workspace answered, so the suite can tell two groups' same-named models apart.
	echo: workspace =>
		message(
			'msg_echo',
			{ input_tokens: 10, output_tokens: 1 },
			[
				[
					{ type: 'text', text: '' },
					{ type: 'text_delta', text: `from ${workspace}` },
				],
			],
			'end_turn',
			3,
		),
	stream: () =>
		message(
			'msg_plain',
			{ input_tokens: 10, output_tokens: 1 },
			[
				[
					{ type: 'text', text: '' },
					{ type: 'text_delta', text: 'Hello' },
					{ type: 'text_delta', text: ' world ✓' },
				],
				toolUse,
			],
			'tool_use',
			12,
		),
	// What the newest models send: thinking first, sometimes a redacted block, then the answer.
	thinking: () =>
		message(
			'msg_think',
			{ input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 1 },
			[
				[
					{ type: 'thinking', thinking: '', signature: '' },
					{ type: 'thinking_delta', thinking: 'Consider ' },
					{ type: 'thinking_delta', thinking: 'Paris.' },
					{ type: 'signature_delta', signature: 'sig-1' },
				],
				[{ type: 'redacted_thinking', data: 'redacted-1' }],
				[
					{ type: 'text', text: '' },
					{ type: 'text_delta', text: 'Sunny ✓' },
				],
				toolUse,
			],
			'tool_use',
			42,
		),
};

const server = http.createServer(async (req, res) => {
	let raw = '';
	for await (const chunk of req) {
		raw += chunk;
	}
	const url = new URL(req.url, 'http://localhost');

	// Test-only control endpoints, used by suite.js.
	if (url.pathname === '/__requests') {
		return json(res, 200, requests);
	}
	if (url.pathname === '/__queue') {
		messageQueue.push(...JSON.parse(raw));
		return json(res, 200, {});
	}

	const entry = {
		method: req.method,
		path: url.pathname,
		query: url.search,
		headers: req.headers,
		body: raw ? JSON.parse(raw) : undefined,
	};
	requests.push(entry);

	if (url.pathname === '/v1/oauth/token') {
		if (entry.body.refresh_token.startsWith('revoked')) {
			return json(res, 400, {
				error: 'invalid_grant',
				error_description: 'Refresh token is invalid or has been revoked',
			});
		}
		issued++;
		return json(res, 200, {
			access_token: `sk-ant-oat01-fresh-${issued}`,
			refresh_token: `refresh-${issued + 1}`,
			expires_in: 28_800,
			token_type: 'Bearer',
			scope: 'user:inference user:profile',
		});
	}

	// Who the token belongs to, the way Claude Code asks. Each workspace is in its own organization.
	if (url.pathname === '/api/oauth/profile') {
		const other = req.headers['anthropic-workspace-id'] === 'wrkspc_other';
		return json(res, 200, {
			account: { uuid: 'acct_test', email: other ? 'me@other.example' : 'me@test.example', display_name: 'Me' },
			organization: {
				uuid: other ? '11111111-1111-1111-1111-111111111111' : '00000000-0000-0000-0000-000000000000',
				name: other ? 'Other Org' : 'Test Org',
				organization_type: 'api_team',
				billing_type: 'usage_based',
			},
		});
	}

	if (url.pathname === '/v1/models') {
		const level = supported => ({ supported });
		const thinkingModel = {
			image_input: level(true),
			effort: {
				supported: true,
				low: level(true),
				medium: level(true),
				high: level(true),
				xhigh: level(false),
				max: level(true),
			},
			thinking: {
				supported: true,
				types: { adaptive: level(true), enabled: level(false), disabled: level(true) },
			},
		};
		const model = (id, displayName, createdAt, lifecycle, maxInputTokens, maxTokens, capabilities) => ({
			type: 'model',
			id,
			display_name: displayName,
			created_at: createdAt,
			lifecycle,
			max_input_tokens: maxInputTokens,
			max_tokens: maxTokens,
			capabilities,
		});
		const shared = model(
			'claude-test-1',
			'Claude Test',
			'2026-07-24T00:00:00Z',
			'active',
			1_000_000,
			64_000,
			thinkingModel,
		);
		// A second workspace, reached through a second profile, has the same first model (as real
		// organizations do) and one of its own.
		if (req.headers['anthropic-workspace-id'] === 'wrkspc_other') {
			return json(res, 200, {
				data: [
					shared,
					model('claude-other-1', 'Claude Other', '2026-09-01T00:00:00Z', 'active', 200_000, 8192, null),
				],
				has_more: false,
				first_id: 'claude-test-1',
				last_id: 'claude-other-1',
			});
		}
		return json(res, 200, {
			data: [
				shared,
				model(
					'claude-haiku-5-5',
					'Claude Haiku 5.5',
					'2026-08-01T00:00:00Z',
					'active',
					1_000_000,
					128_000,
					thinkingModel,
				),
				model('claude-small', 'Claude Small', '2026-01-01T00:00:00Z', 'deprecated', null, 8192, null),
				model('claude-old', 'Claude Old', '2024-01-01T00:00:00Z', 'retired', 100_000, 4096, null),
			],
			has_more: false,
			first_id: 'claude-test-1',
			last_id: 'claude-old',
		});
	}

	if (url.pathname === '/v1/messages') {
		const mode = messageQueue.shift() ?? 'stream';
		if (mode === '401') {
			return json(res, 401, {
				type: 'error',
				error: { type: 'authentication_error', message: 'OAuth token has expired.' },
			});
		}
		if (mode === 'reject-thinking') {
			// The error the newest models return when something before an earlier thinking block changed.
			return json(res, 400, {
				type: 'error',
				error: {
					type: 'invalid_request_error',
					message:
						'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".',
				},
			});
		}
		res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'req_test' });
		const bytes = Buffer.from(replies[mode === 'slow' ? 'stream' : mode](req.headers['anthropic-workspace-id']));
		if (mode === 'slow') {
			// Send the first text delta, then hang until the client goes away.
			res.write(bytes.subarray(0, bytes.indexOf('event: ping')));
			req.socket.on('close', () => requests.push({ event: 'client closed the stream', closedByClient: true }));
			setTimeout(() => res.end(), 30_000);
			return;
		}
		// Awkward 7-byte chunks to exercise buffering across event boundaries.
		for (let i = 0; i < bytes.length; i += 7) {
			res.write(bytes.subarray(i, i + 7));
		}
		res.end();
		return;
	}

	json(res, 404, { type: 'error', error: { type: 'not_found_error', message: `No route for ${url.pathname}` } });
});

// Stages the extension under test in scratch/ext: either the compiled out/ with the real
// node_modules linked in, or the unpacked VSIX.
function stageExtension(ext) {
	fs.rmSync(ext, { recursive: true, force: true });
	if (process.argv.includes('--vsix')) {
		const vsix = fs
			.readdirSync(root)
			.filter(f => f.endsWith('.vsix'))
			.sort()
			.at(-1);
		if (!vsix) {
			throw new Error('No .vsix in the repository root; run `npm run package` first.');
		}
		const unpacked = path.join(scratch, 'vsix');
		fs.rmSync(unpacked, { recursive: true, force: true });
		fs.mkdirSync(unpacked, { recursive: true });
		execFileSync('tar', ['-xf', path.join(root, vsix), '-C', unpacked]);
		fs.renameSync(path.join(unpacked, 'extension'), ext);
		console.log(`Testing ${vsix}`);
	} else {
		fs.mkdirSync(ext, { recursive: true });
		fs.cpSync(path.join(root, 'out'), path.join(ext, 'out'), { recursive: true });
		fs.symlinkSync(path.join(root, 'node_modules'), path.join(ext, 'node_modules'), 'junction');
	}
	fs.mkdirSync(path.join(ext, 'test'), { recursive: true });
	fs.copyFileSync(path.join(here, 'suite.js'), path.join(ext, 'test', 'suite.js'));
}

async function main() {
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	const apiUrl = `http://127.0.0.1:${server.address().port}`;

	const ext = path.join(scratch, 'ext');
	stageExtension(ext);
	const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const extensionId = `${manifest.publisher}.${manifest.name}`;

	const results = path.join(scratch, 'results.log');
	fs.writeFileSync(results, '');

	// Keep real credentials out of the test.
	for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_PROFILE', 'ANTHROPIC_BASE_URL']) {
		delete process.env[name];
	}

	try {
		for (const proposedApi of [true, false]) {
			requests = [];
			messageQueue = [];
			issued = 0;

			// Test-only: the suite sends system messages the way Copilot does, which takes another proposal.
			fs.writeFileSync(
				path.join(ext, 'package.json'),
				JSON.stringify(
					{
						...manifest,
						enabledApiProposals: [
							...manifest.enabledApiProposals,
							...(proposedApi ? ['languageModelSystem'] : []),
						],
					},
					null,
					2,
				),
			);

			// Starts empty: the extension has to cope with nobody being signed in yet. Claude Code's own
			// settings file is kept out of the way too, so the suite never reads yours.
			const configDir = path.join(scratch, 'anthropic-config');
			fs.rmSync(configDir, { recursive: true, force: true });
			fs.mkdirSync(configDir);
			const claudeConfigDir = path.join(scratch, 'claude-config');
			fs.rmSync(claudeConfigDir, { recursive: true, force: true });

			// Run VS Code in portable mode. Otherwise it reads argv.json, where proposed APIs can be turned
			// on, from your own ~/.vscode, even with a separate user data folder. Portable mode keeps
			// everything, user data included, in this one folder. Each pass gets its own: on Windows the
			// previous VS Code can still hold a log file open for a moment after it exits.
			const portable = path.join(scratch, proposedApi ? 'portable-proposed' : 'portable');
			fs.rmSync(portable, { recursive: true, force: true });
			process.env.VSCODE_PORTABLE = portable;
			const userData = path.join(portable, 'user-data');
			fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
			fs.writeFileSync(path.join(portable, 'argv.json'), '{}');
			// Agent sessions only use extension models with this on, on any machine. The proposed-API
			// run starts with it off, so the suite can watch the extension offer to turn it on.
			fs.writeFileSync(
				path.join(userData, 'User', 'settings.json'),
				JSON.stringify(
					proposedApi
						? {}
						: {
								'chat.agentHost.byokModels.enabled': true,
								'extensions.supportAgentsWindow': { [extensionId]: true },
							},
				),
			);
			// Every model comes from a group in Manage Models. The proposed-API run has two: one for the
			// active profile and one for a named profile. The other run starts with none, as a fresh
			// install does, and adds one as it goes.
			fs.writeFileSync(
				path.join(userData, 'User', 'chatLanguageModels.json'),
				JSON.stringify(
					proposedApi
						? [
								{ name: 'Claude (Console)', vendor: 'ants' },
								{ name: 'Other org', vendor: 'ants', profile: 'other' },
							]
						: [],
				),
			);

			await runTests({
				version: process.env.VSCODE_VERSION || 'stable',
				extensionDevelopmentPath: ext,
				extensionTestsPath: path.join(ext, 'test', 'suite.js'),
				extensionTestsEnv: {
					PROPOSED_API: proposedApi ? '1' : '0',
					ANTHROPIC_CONFIG_DIR: configDir,
					CLAUDE_CONFIG_DIR: claudeConfigDir,
					FAKE_ANTHROPIC_URL: apiUrl,
					LOGS_DIR: path.join(userData, 'logs'),
				},
				launchArgs: [
					'--disable-extensions',
					'--user-data-dir',
					userData,
					'--disable-workspace-trust',
					// Trace logging lets the suite read which models the agent host picked up.
					'--log',
					'trace',
					...(proposedApi ? ['--enable-proposed-api', extensionId] : []),
				],
			});
		}
	} finally {
		server.close();
		server.closeAllConnections();
		console.log(`\n${fs.readFileSync(results, 'utf8')}`);
	}
}

main().catch(err => {
	console.error('E2E FAILED:', err);
	process.exit(1);
});

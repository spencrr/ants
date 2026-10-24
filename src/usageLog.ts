import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';

/** One line of the usage log: a single request to Claude. */
export interface UsageRecord {
	/** When the request finished, as ISO 8601. */
	time: string;
	model: string;
	/** The Anthropic profile the group named; absent when it left the field blank (the active sign-in). */
	profile?: string;
	/** The organization billed, by name when the API told us, else by id. Absent before 0.2. */
	organization?: string;
	/** The workspace billed, by id. Absent before 0.2, and when the organization default is used. */
	workspace?: string;
	/** Where the request came from: the chat view, an agent session, or another extension. */
	surface: string;
	/** Groups requests from one conversation. */
	session: string;
	/** The effort level that was sent, if any. */
	effort?: string;
	/** Full-price input tokens: not read from the cache and not written to it. */
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	/** How long the request took, in milliseconds. */
	ms: number;
	/** Estimated cost in US dollars from the price table at the time; absent when the model had no price. */
	cost?: number;
	/**
	 * Absent when Claude answered. `cancelled` means the user stopped the reply; the token counts are
	 * what had arrived by then, with the output estimated from the text when the API hadn't said yet.
	 * `error` means the request failed, and the counts are zero because nothing is known.
	 */
	outcome?: 'cancelled' | 'error';
}

/** When the price table was last checked against Anthropic's pricing page. Shown next to every total. */
export const PRICES_AS_OF = 'October 2026';

// Anthropic's list prices in dollars per million tokens, as of PRICES_AS_OF. Prices change,
// so treat totals as estimates. Models not listed here get no estimate, not a wrong one.
const PRICES: Record<string, { input: number; cacheRead: number; cacheWrite: number; output: number }> = {
	'claude-fable-5-1': { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
	'claude-mythos-5-1': { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
	'claude-fable-5': { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
	'claude-mythos-5': { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
	'claude-opus-5-5': { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
	'claude-opus-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
	'claude-opus-4-8': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
	'claude-opus-4-7': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
	'claude-opus-4-6': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
	'claude-opus-4-5': { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
	'claude-sonnet-5-5': { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
	'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
	'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
	'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheWrite: 3.75, output: 15 },
	'claude-haiku-5-5': { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
	'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
};

/** Estimated cost of one request in dollars, or undefined for a model with no known price. */
export function estimateCost(
	model: string,
	tokens: Pick<UsageRecord, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>,
): number | undefined {
	// Model ids can carry a date suffix, like claude-opus-4-5-20251101.
	const key = Object.keys(PRICES)
		.sort((a, b) => b.length - a.length)
		.find(id => model === id || model.startsWith(`${id}-`));
	let price = key ? PRICES[key] : undefined;
	if (!price) {
		return undefined;
	}
	// Haiku 5.5 charges five times as much once a prompt passes 100K tokens.
	if (key === 'claude-haiku-5-5' && tokens.input + tokens.cacheRead + tokens.cacheWrite > 100_000) {
		price = { input: 0.5, cacheRead: 0.05, cacheWrite: 0.625, output: 2.5 };
	}
	const perMillion =
		tokens.input * price.input +
		tokens.cacheRead * price.cacheRead +
		tokens.cacheWrite * price.cacheWrite +
		tokens.output * price.output;
	return perMillion / 1_000_000;
}

/**
 * Works out which conversation a request belongs to. Chat passes a conversation id along.
 * Agent sessions don't, but they resend the whole conversation every turn, so the first
 * user message identifies it well enough.
 */
export function sessionOf(
	modelOptions: Record<string, unknown> | undefined,
	messages: readonly vscode.LanguageModelChatRequestMessage[],
): string {
	const conversationId = modelOptions?._conversationId;
	if (typeof conversationId === 'string' && conversationId) {
		return conversationId.slice(0, 12);
	}
	const firstUser = messages.find(m => m.role === vscode.LanguageModelChatMessageRole.User);
	const text =
		firstUser?.content.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : '')).join('') ?? '';
	return text ? createHash('sha1').update(text).digest('hex').slice(0, 12) : 'unknown';
}

/** Where the request came from, for grouping. */
export function surfaceOf(
	modelOptions: Record<string, unknown> | undefined,
	requestInitiator: string | undefined,
): string {
	if (modelOptions?._conversationId !== undefined) {
		return 'Chat';
	}
	if (requestInitiator === undefined || requestInitiator === 'core') {
		return 'Agent session';
	}
	return requestInitiator;
}

const CSV_COLUMNS: (keyof UsageRecord)[] = [
	'time',
	'model',
	'organization',
	'workspace',
	'profile',
	'surface',
	'session',
	'effort',
	'outcome',
	'input',
	'cacheRead',
	'cacheWrite',
	'output',
	'ms',
	'cost',
];

/** The records as a CSV file, one row each, for a spreadsheet. */
export function toCsv(records: UsageRecord[]): string {
	const cell = (value: unknown) => {
		if (value === undefined) {
			return '';
		}
		const text = String(value);
		return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
	};
	const rows = records.map(record => CSV_COLUMNS.map(column => cell(record[column])).join(','));
	return [CSV_COLUMNS.join(','), ...rows].join('\r\n');
}

/** Append-only JSONL file of every request, kept in the extension's global storage. */
export class UsageLog {
	private readonly changed = new vscode.EventEmitter<UsageRecord>();
	readonly onDidAppend = this.changed.event;
	readonly path: string;

	constructor(storageDir: vscode.Uri) {
		this.path = join(storageDir.fsPath, 'usage.jsonl');
	}

	async append(record: UsageRecord): Promise<void> {
		await mkdir(join(this.path, '..'), { recursive: true });
		await appendFile(this.path, `${JSON.stringify(record)}\n`);
		this.changed.fire(record);
	}

	async readAll(): Promise<UsageRecord[]> {
		let text: string;
		try {
			text = await readFile(this.path, 'utf8');
		} catch {
			return [];
		}
		const records: UsageRecord[] = [];
		for (const line of text.split('\n')) {
			if (!line.trim()) {
				continue;
			}
			try {
				records.push(JSON.parse(line));
			} catch {
				// A line cut short by a crash shouldn't hide the rest.
			}
		}
		return records;
	}
}

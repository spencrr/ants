// @ts-check
// Runs inside the Claude Usage webview. Gets every record from the extension, then does all the
// filtering, grouping, and drawing here so clicking around never waits on the extension host.
(() => {
	const vscode = acquireVsCodeApi();

	/** @typedef {{ time: string; model: string; surface: string; session: string; effort?: string; input: number; cacheRead: number; cacheWrite: number; output: number; ms: number; cost: number }} Record */

	/** @type {Record[]} */
	let all = [];
	let logPath = '';

	// What the user has picked. Filters stack: range, then a clicked bucket, then clicked values.
	const state = {
		range: '7d',
		measure: 'cost',
		dimension: 'model',
		/** @type {{ from: number; to: number } | undefined} */
		zoom: undefined,
		/** @type {Map<string, string>} dimension -> value */
		filters: new Map(),
		sort: { key: 'cost', asc: false },
		/** Set once a column header is clicked, so the table stops choosing a sort on its own. */
		sortedExplicitly: false,
		/** Session whose individual requests are expanded in the table. */
		openSession: /** @type {string | undefined} */ (undefined),
	};

	const $ = id => /** @type {HTMLElement} */ (document.getElementById(id));
	const tip = document.createElement('div');
	tip.className = 'tip';
	tip.hidden = true;
	document.body.appendChild(tip);

	// ---- formatting ----
	const money = n =>
		n >= 100
			? `$${n.toFixed(0)}`
			: n >= 10
				? `$${n.toFixed(1)}`
				: n >= 0.01
					? `$${n.toFixed(2)}`
					: n > 0
						? `$${n.toFixed(3)}`
						: '$0';
	/** Shorter form for axis labels: $225, $150, $75. */
	const axisMoney = n =>
		n >= 10 ? `$${Math.round(n)}` : n >= 1 ? `$${n.toFixed(1)}` : n > 0 ? `$${n.toFixed(2)}` : '$0';
	const tokens = n =>
		n >= 1e9
			? `${(n / 1e9).toFixed(2)}B`
			: n >= 1e6
				? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`
				: n >= 1e3
					? `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`
					: String(n);
	const count = n => n.toLocaleString();
	const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '–');
	const duration = ms =>
		ms >= 3_600_000
			? `${(ms / 3_600_000).toFixed(1)} h`
			: ms >= 60_000
				? `${(ms / 60_000).toFixed(1)} min`
				: `${(ms / 1000).toFixed(1)}s`;
	const when = t =>
		new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
	const measureOf = r =>
		state.measure === 'cost'
			? r.cost
			: state.measure === 'tokens'
				? r.input + r.cacheRead + r.cacheWrite + r.output
				: 1;
	const formatMeasure = n =>
		state.measure === 'cost' ? money(n) : state.measure === 'tokens' ? tokens(n) : count(n);
	const formatAxis = n =>
		state.measure === 'cost' ? axisMoney(n) : state.measure === 'tokens' ? tokens(n) : count(Math.round(n));
	const measureName = () => (state.measure === 'cost' ? 'cost' : state.measure === 'tokens' ? 'tokens' : 'requests');
	/** Drops the shared prefix so model names fit: claude-fable-5-1 → fable-5-1. */
	const shortModel = m => m.replace(/^claude-/, '');

	// ---- filtering ----
	function rangeStart() {
		const now = new Date();
		if (state.range === 'today') {
			now.setHours(0, 0, 0, 0);
			return now.getTime();
		}
		if (state.range === '7d') {
			return Date.now() - 7 * 86_400_000;
		}
		if (state.range === '30d') {
			return Date.now() - 30 * 86_400_000;
		}
		return 0;
	}

	/** Records in the time window, before any clicked filters. */
	function inRange() {
		const start = rangeStart();
		return all.filter(r => {
			const t = Date.parse(r.time);
			return t >= start && (!state.zoom || (t >= state.zoom.from && t < state.zoom.to));
		});
	}

	/** Records after every filter. */
	function visible() {
		const rows = inRange();
		if (state.filters.size === 0) {
			return rows;
		}
		return rows.filter(r => [...state.filters].every(([dim, value]) => (r[dim] ?? '—') === value));
	}

	// ---- buckets for the timeline ----
	function bucketing(rows) {
		const times = rows.map(r => Date.parse(r.time));
		const from = state.zoom?.from ?? (state.range === 'all' ? Math.min(...times, Date.now()) : rangeStart());
		const to = state.zoom?.to ?? Date.now();
		const span = Math.max(to - from, 60_000);
		// Aim for 40-80 bars with round sizes.
		const sizes = [60_000, 5 * 60_000, 15 * 60_000, 3_600_000, 6 * 3_600_000, 86_400_000, 7 * 86_400_000];
		const size = sizes.find(s => span / s <= 80) ?? sizes.at(-1);
		const start = Math.floor(from / size) * size;
		const n = Math.ceil((to - start) / size);
		const buckets = Array.from({ length: n }, (_, i) => ({
			from: start + i * size,
			to: start + (i + 1) * size,
			value: 0,
			requests: 0,
		}));
		for (const r of rows) {
			const i = Math.floor((Date.parse(r.time) - start) / size);
			if (buckets[i]) {
				buckets[i].value += measureOf(r);
				buckets[i].requests++;
			}
		}
		return { buckets, size };
	}

	function bucketLabel(ts, size) {
		const d = new Date(ts);
		if (size >= 86_400_000) {
			return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
		}
		if (size >= 3_600_000) {
			return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
		}
		return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
	}

	// ---- rendering ----
	function render() {
		const rows = visible();
		const scoped = inRange();
		$('empty').hidden = all.length > 0;
		renderCrumbs();
		renderCards(rows);
		renderTimeline(rows);
		renderBreakdown(rows);
		renderMix(rows);
		renderTable(rows);
		const first = all.length > 0 ? Date.parse(all[0].time) : undefined;
		$('subtitle').textContent =
			all.length > 0
				? `${count(all.length)} requests logged since ${first ? new Date(first).toLocaleDateString() : ''} · ${count(scoped.length)} in view`
				: '';
	}

	function renderCrumbs() {
		const el = $('crumbs');
		el.replaceChildren();
		const add = (label, clear) => {
			const span = document.createElement('span');
			span.className = 'crumb';
			span.textContent = `${label} `;
			const x = document.createElement('button');
			x.textContent = '×';
			x.title = 'Remove filter';
			x.onclick = () => {
				clear();
				render();
			};
			span.appendChild(x);
			el.appendChild(span);
		};
		if (state.zoom) {
			add(`${when(state.zoom.from)} – ${when(state.zoom.to)}`, () => {
				state.zoom = undefined;
			});
		}
		for (const [dim, value] of state.filters) {
			add(`${dim}: ${value}`, () => state.filters.delete(dim));
		}
		if (state.zoom || state.filters.size > 0) {
			const clear = document.createElement('button');
			clear.className = 'crumb-clear';
			clear.textContent = 'Clear all';
			clear.onclick = () => {
				state.zoom = undefined;
				state.filters.clear();
				state.openSession = undefined;
				render();
			};
			el.appendChild(clear);
		}
	}

	function totals(rows) {
		const t = {
			cost: 0,
			input: 0,
			cacheRead: 0,
			cacheWrite: 0,
			output: 0,
			ms: 0,
			sessions: new Set(),
			requests: rows.length,
			unpriced: 0,
		};
		for (const r of rows) {
			t.cost += r.cost;
			t.input += r.input;
			t.cacheRead += r.cacheRead;
			t.cacheWrite += r.cacheWrite;
			t.output += r.output;
			t.ms += r.ms;
			t.sessions.add(r.session);
			if (!r.cost && (r.input || r.output)) {
				t.unpriced++;
			}
		}
		return t;
	}

	function renderCards(rows) {
		const t = totals(rows);
		const prompt = t.input + t.cacheRead + t.cacheWrite;
		// What the same prompts would have cost with no cache: every token at the full input price.
		// Approximated from the ratio in this slice, good enough for a headline.
		const cards = [
			[
				'Estimated cost',
				money(t.cost),
				t.unpriced ? `${t.unpriced} requests have no price` : 'Anthropic list prices',
			],
			['Requests', count(t.requests), `${t.sessions.size} session${t.sessions.size === 1 ? '' : 's'}`],
			['Prompt tokens', tokens(prompt), `${pct(t.cacheRead, prompt)} from cache`],
			[
				'Output tokens',
				tokens(t.output),
				t.requests ? `${tokens(Math.round(t.output / t.requests))} per request` : '',
			],
			['Time waiting', duration(t.ms), t.requests ? `${duration(t.ms / t.requests)} per request` : ''],
		];
		$('cards').replaceChildren(
			...cards.map(([label, value, sub]) => {
				const card = document.createElement('div');
				card.className = 'card';
				card.innerHTML = `<div class="label"></div><div class="value"></div><div class="sub"></div>`;
				card.children[0].textContent = label;
				card.children[1].textContent = value;
				card.children[2].textContent = sub;
				return card;
			}),
		);
	}

	function renderTimeline(rows) {
		const host = $('timeline');
		host.replaceChildren();
		$('timelineTitle').textContent = `${measureName()[0].toUpperCase() + measureName().slice(1)} over time`;
		const { buckets, size } = bucketing(rows);
		const width = host.clientWidth || 600;
		const height = host.clientHeight || 180;
		const pad = { left: 44, right: 8, top: 8, bottom: 22 };
		const w = width - pad.left - pad.right;
		const h = height - pad.top - pad.bottom;
		const max = Math.max(...buckets.map(b => b.value), 0) || 1;
		const ns = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(ns, 'svg');
		svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

		// Grid and y labels.
		const grid = document.createElementNS(ns, 'g');
		grid.setAttribute('class', 'axis');
		for (let i = 0; i <= 3; i++) {
			const y = pad.top + h - (h * i) / 3;
			const line = document.createElementNS(ns, 'line');
			line.setAttribute('x1', String(pad.left));
			line.setAttribute('x2', String(width - pad.right));
			line.setAttribute('y1', String(y));
			line.setAttribute('y2', String(y));
			line.setAttribute('class', 'grid');
			grid.appendChild(line);
			const text = document.createElementNS(ns, 'text');
			text.setAttribute('x', String(pad.left - 6));
			text.setAttribute('y', String(y + 3));
			text.setAttribute('text-anchor', 'end');
			text.textContent = formatAxis((max * i) / 3);
			grid.appendChild(text);
		}
		svg.appendChild(grid);

		const barW = Math.max(1, w / buckets.length - 1);
		buckets.forEach((b, i) => {
			const x = pad.left + (i * w) / buckets.length;
			const barH = (b.value / max) * h;
			const rect = document.createElementNS(ns, 'rect');
			rect.setAttribute('class', `bar${b.requests ? '' : ' dim'}`);
			rect.setAttribute('x', String(x));
			rect.setAttribute('width', String(barW));
			rect.setAttribute('y', String(pad.top + h - Math.max(barH, b.requests ? 2 : 0)));
			rect.setAttribute('height', String(Math.max(barH, b.requests ? 2 : 0)));
			rect.addEventListener('mousemove', e =>
				showTip(
					e,
					`${bucketLabel(b.from, size)}<br><b>${formatMeasure(b.value)}</b> · ${count(b.requests)} requests`,
				),
			);
			rect.addEventListener('mouseleave', hideTip);
			rect.addEventListener('click', () => {
				if (b.requests) {
					state.zoom = { from: b.from, to: b.to };
					render();
				}
			});
			svg.appendChild(rect);
		});

		// X labels: about 6 of them.
		const step = Math.max(1, Math.ceil(buckets.length / 6));
		const axis = document.createElementNS(ns, 'g');
		axis.setAttribute('class', 'axis');
		buckets.forEach((b, i) => {
			if (i % step) {
				return;
			}
			const text = document.createElementNS(ns, 'text');
			text.setAttribute('x', String(pad.left + (i * w) / buckets.length));
			text.setAttribute('y', String(height - 6));
			text.textContent = bucketLabel(b.from, size);
			axis.appendChild(text);
		});
		svg.appendChild(axis);

		// Drag to zoom.
		let dragStart;
		const brush = document.createElementNS(ns, 'rect');
		brush.setAttribute('class', 'brush');
		brush.setAttribute('y', String(pad.top));
		brush.setAttribute('height', String(h));
		const toIndex = clientX => {
			const { left, width: cw } = svg.getBoundingClientRect();
			const px = ((clientX - left) / cw) * width;
			return Math.min(buckets.length - 1, Math.max(0, Math.floor(((px - pad.left) / w) * buckets.length)));
		};
		svg.addEventListener('mousedown', e => {
			dragStart = toIndex(e.clientX);
			svg.appendChild(brush);
		});
		svg.addEventListener('mousemove', e => {
			if (dragStart === undefined) {
				return;
			}
			const a = Math.min(dragStart, toIndex(e.clientX));
			const b = Math.max(dragStart, toIndex(e.clientX));
			brush.setAttribute('x', String(pad.left + (a * w) / buckets.length));
			brush.setAttribute('width', String(((b - a + 1) * w) / buckets.length));
		});
		window.addEventListener(
			'mouseup',
			e => {
				if (dragStart === undefined) {
					return;
				}
				const end = toIndex(e.clientX);
				const a = Math.min(dragStart, end);
				const b = Math.max(dragStart, end);
				dragStart = undefined;
				brush.remove();
				if (b > a) {
					state.zoom = { from: buckets[a].from, to: buckets[b].to };
					render();
				}
			},
			{ once: true },
		);

		host.appendChild(svg);
	}

	function groupBy(rows, dim) {
		const groups = new Map();
		for (const r of rows) {
			const key = r[dim] ?? '—';
			const g = groups.get(key) ?? { key, value: 0, requests: 0, cost: 0 };
			g.value += measureOf(r);
			g.requests++;
			g.cost += r.cost;
			groups.set(key, g);
		}
		return [...groups.values()].sort((a, b) => b.value - a.value);
	}

	function renderBreakdown(rows) {
		const dim = state.dimension;
		$('dimLabel').textContent = dim;
		const groups = groupBy(rows, dim).slice(0, 12);
		const max = groups[0]?.value || 1;
		const total = groups.reduce((s, g) => s + g.value, 0);
		$('breakdown').replaceChildren(
			...groups.map(g => {
				const row = document.createElement('div');
				row.className = 'bar-row';
				row.title = `Filter to ${dim} = ${g.key}`;
				row.innerHTML = `<span class="name"></span><div class="track"><div class="fill"></div></div><span class="num"></span>`;
				row.children[0].textContent = dim === 'model' ? shortModel(g.key) : g.key;
				row.children[0].title = g.key;
				/** @type {HTMLElement} */ (row.children[1].firstElementChild).style.width =
					`${(g.value / max) * 100}%`;
				row.children[2].textContent = `${formatMeasure(g.value)} · ${pct(g.value, total)}`;
				row.onclick = () => {
					state.filters.set(dim, g.key);
					if (dim === 'session') {
						state.openSession = g.key;
					}
					render();
				};
				return row;
			}),
		);
	}

	function renderMix(rows) {
		const t = totals(rows);
		const parts = [
			['input', 'Input (full price)', t.input],
			['cacheRead', 'Cache reads', t.cacheRead],
			['cacheWrite', 'Cache writes', t.cacheWrite],
			['output', 'Output', t.output],
		];
		const sum = parts.reduce((s, [, , n]) => s + n, 0) || 1;
		const stack = document.createElement('div');
		stack.className = 'stack';
		const legend = document.createElement('div');
		legend.className = 'legend';
		for (const [cls, label, n] of parts) {
			const seg = document.createElement('div');
			seg.className = `seg ${cls}`;
			seg.style.width = `${(n / sum) * 100}%`;
			seg.title = `${label}: ${tokens(n)}`;
			stack.appendChild(seg);
			legend.insertAdjacentHTML(
				'beforeend',
				`<span class="swatch ${cls}"></span><span></span><span class="num"></span><span class="num"></span>`,
			);
			const cells = legend.children;
			cells.at(-3).textContent = label;
			cells.at(-2).textContent = tokens(n);
			cells.at(-1).textContent = pct(n, sum);
		}
		$('mix').replaceChildren(stack, legend);
		$('cacheHint').textContent = t.cacheRead
			? `Cache reads cost 2.5–10% of full price, so they're ${pct(t.cacheRead, sum)} of tokens but much less of the cost.`
			: '';
	}

	function renderTable(rows) {
		const table = $('table');
		table.replaceChildren();
		const detail = state.openSession !== undefined;
		const data = detail
			? rows
					.filter(r => r.session === state.openSession)
					.map(r => ({
						...r,
						key: r.time,
						label: when(r.time),
						prompt: r.input + r.cacheRead + r.cacheWrite,
						requests: 1,
					}))
			: groupSessions(rows);
		$('tableTitle').textContent = detail ? `Requests in session ${state.openSession}` : 'Sessions';
		$('tableHint').textContent = detail
			? 'Click a filter chip above to go back.'
			: 'Click a session to see its requests.';

		const columns = detail
			? [
					['label', 'Time', true],
					['model', 'Model', true],
					['effort', 'Effort', true],
					['prompt', 'Prompt'],
					['cacheRead', 'Cached'],
					['output', 'Output'],
					['ms', 'Took'],
					['cost', 'Cost'],
				]
			: [
					['label', 'Session', true],
					['surface', 'Surface', true],
					['models', 'Models', true],
					['requests', 'Requests'],
					['prompt', 'Prompt'],
					['cacheRead', 'Cached'],
					['output', 'Output'],
					['ms', 'Took'],
					['cost', 'Cost'],
				];

		const { key, asc } = state.sort;
		// Inside a session, read the requests in order unless a column was clicked.
		const sortKey = detail && key === 'cost' && !state.sortedExplicitly ? 'key' : key;
		const sortAsc = detail && key === 'cost' && !state.sortedExplicitly ? true : asc;
		data.sort((a, b) => {
			const x = a[sortKey] ?? '';
			const y = b[sortKey] ?? '';
			const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
			return sortAsc ? c : -c;
		});

		const thead = table.createTHead();
		const hr = thead.insertRow();
		for (const [k, label, left] of columns) {
			const th = document.createElement('th');
			th.textContent = label;
			const sortedHere = k === sortKey || (k === 'label' && sortKey === 'key');
			th.className = (left ? 'left' : '') + (sortedHere ? ` sorted${sortAsc ? ' asc' : ''}` : '');
			th.onclick = () => {
				state.sort = { key: k === 'label' ? 'key' : k, asc: sortedHere ? !sortAsc : false };
				state.sortedExplicitly = true;
				render();
			};
			hr.appendChild(th);
		}
		const maxCost = Math.max(...data.map(d => d.cost), 0) || 1;
		const tbody = table.createTBody();
		for (const d of data.slice(0, 200)) {
			const tr = tbody.insertRow();
			if (detail) {
				tr.className = 'detail';
			} else {
				tr.onclick = () => {
					state.filters.set('session', d.key);
					state.openSession = d.key;
					render();
				};
			}
			for (const [k, , left] of columns) {
				const td = tr.insertCell();
				if (left) {
					td.className = 'left';
				}
				const v = d[k];
				if (k === 'cost') {
					td.textContent = money(v);
					const mini = document.createElement('span');
					mini.className = 'mini';
					mini.style.width = `${Math.max(2, (v / maxCost) * 60)}px`;
					mini.style.background = 'var(--c-bar)';
					td.appendChild(mini);
				} else if (k === 'ms') {
					td.textContent = duration(v);
				} else if (k === 'label' && !detail) {
					td.innerHTML = `<span class="mono"></span> `;
					td.firstElementChild.textContent = d.key;
					td.append(d.label);
				} else if (k === 'model') {
					td.textContent = shortModel(v);
					td.title = v;
				} else if (typeof v === 'number') {
					td.textContent = k === 'requests' ? count(v) : tokens(v);
				} else {
					td.textContent = v ?? '—';
				}
			}
		}
	}

	function groupSessions(rows) {
		const sessions = new Map();
		for (const r of rows) {
			const s = sessions.get(r.session) ?? {
				key: r.session,
				first: r.time,
				last: r.time,
				surface: r.surface,
				modelSet: new Set(),
				requests: 0,
				prompt: 0,
				cacheRead: 0,
				output: 0,
				ms: 0,
				cost: 0,
			};
			s.modelSet.add(r.model);
			s.requests++;
			s.prompt += r.input + r.cacheRead + r.cacheWrite;
			s.cacheRead += r.cacheRead;
			s.output += r.output;
			s.ms += r.ms;
			s.cost += r.cost;
			if (r.time < s.first) {
				s.first = r.time;
			}
			if (r.time > s.last) {
				s.last = r.time;
			}
			sessions.set(r.session, s);
		}
		return [...sessions.values()].map(s => ({
			...s,
			label: `${when(s.first)}${s.last === s.first ? '' : ` – ${when(s.last)}`}`,
			models: [...s.modelSet].map(m => m.replace(/^claude-/, '')).join(', '),
		}));
	}

	function showTip(e, html) {
		tip.innerHTML = html;
		tip.hidden = false;
		tip.style.left = `${e.clientX + 12}px`;
		tip.style.top = `${e.clientY + 12}px`;
	}
	function hideTip() {
		tip.hidden = true;
	}

	// ---- wiring ----
	function segmented(id, attr, onPick) {
		$(id).addEventListener('click', e => {
			const button = /** @type {HTMLElement} */ (e.target).closest('button');
			if (!button) {
				return;
			}
			for (const b of $(id).querySelectorAll('button')) {
				b.classList.toggle('active', b === button);
			}
			onPick(button.dataset[attr]);
			render();
		});
	}
	segmented('range', 'range', v => {
		state.range = v;
		state.zoom = undefined;
	});
	segmented('measure', 'measure', v => {
		state.measure = v;
	});
	segmented('dimension', 'dim', v => {
		state.dimension = v;
	});
	$('openLog').onclick = () => vscode.postMessage({ type: 'openLog' });
	window.addEventListener('resize', () => renderTimeline(visible()));

	window.addEventListener('message', e => {
		const msg = e.data;
		if (msg.type === 'records') {
			all = msg.records.sort((a, b) => a.time.localeCompare(b.time));
			logPath = msg.path;
			$('openLog').title = logPath;
			render();
		} else if (msg.type === 'append') {
			all.push(msg.record);
			render();
		}
	});
	vscode.postMessage({ type: 'load' });
})();

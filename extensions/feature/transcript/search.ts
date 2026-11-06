export type Match = {
	lineIdx: number;
	col: number;
	len: number;
};

export type Hit = {
	col: number;
	len: number;
	current?: boolean;
};

const MATCH_OPEN = "\x1b[4m";
const MATCH_CURRENT_OPEN = "\x1b[7m";
const MATCH_CLOSE = "\x1b[24;27m";

const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]))/y;

export function findMatches(plain: string[], query: string, lower?: string[]): Match[] {
	if (!query) return [];

	const caseInsensitive = query === query.toLowerCase();
	const needle = caseInsensitive ? query.toLowerCase() : query;
	const lines = caseInsensitive ? (lower ?? plain.map((line) => line.toLowerCase())) : plain;

	const matches: Match[] = [];
	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		let position = 0;
		while (true) {
			const found = lines[lineIdx].indexOf(needle, position);
			if (found === -1) break;
			matches.push({ lineIdx, col: found, len: query.length });
			position = found + Math.max(1, query.length);
		}
	}
	return matches;
}

/**
 * Apply highlight escapes to an already-styled line. `hits` must be sorted by
 * column; findMatches emits them in that order.
 */
export function highlightLine(text: string, hits: Hit[]): string {
	if (hits.length === 0) return text;

	let result = "";
	let plainColumn = 0;
	let index = 0;
	let active: Hit | null = null;
	let nextIndex = 0;

	while (index < text.length) {
		if (text[index] === "\x1b") {
			ANSI_ESCAPE_RE.lastIndex = index;
			const match = ANSI_ESCAPE_RE.exec(text);
			if (match) {
				result += match[0];
				index = ANSI_ESCAPE_RE.lastIndex;
				continue;
			}
		}

		if (!active && nextIndex < hits.length && plainColumn >= hits[nextIndex].col) {
			active = hits[nextIndex];
			result += active.current ? MATCH_CURRENT_OPEN : MATCH_OPEN;
		}

		result += text[index];
		plainColumn++;
		index++;

		if (active && plainColumn >= active.col + active.len) {
			result += MATCH_CLOSE;
			active = null;
			nextIndex++;
		}
	}

	if (active) result += MATCH_CLOSE;
	return result;
}

export function nearestMatchAfter(matches: Match[], lineIdx: number): number {
	if (matches.length === 0) return -1;
	for (let i = 0; i < matches.length; i++) {
		if (matches[i].lineIdx >= lineIdx) return i;
	}
	return 0;
}

export class SearchSession {
	private open = false;
	private queryText = "";
	private matches: Match[] = [];
	private index = -1;
	private plainLines: string[] = [];
	private lowerLines: string[] | null = null;
	private highlights = new Map<number, Hit[]>();

	get isOpen(): boolean {
		return this.open;
	}

	get query(): string {
		return this.queryText;
	}

	get matchCount(): number {
		return this.matches.length;
	}

	get currentIndex(): number {
		return this.index;
	}

	get currentMatch(): Match | undefined {
		return this.matches[this.index];
	}

	get isActive(): boolean {
		return this.queryText.length > 0;
	}

	setPlain(plain: string[]): void {
		if (plain === this.plainLines) return;
		this.plainLines = plain;
		this.lowerLines = null;
	}

	begin(): void {
		this.open = true;
		this.queryText = "";
		this.resetMatches();
	}

	clear(): void {
		this.queryText = "";
		this.resetMatches();
	}

	cancel(): void {
		this.open = false;
		this.clear();
	}

	setQuery(query: string): void {
		this.queryText = query;
		this.matches = this.find(query);
		this.index = this.matches.length > 0 ? 0 : -1;
		this.rebuildHighlights();
	}

	/** Recompute matches after the rendered layout changes. */
	sync(anchor: number): void {
		if (!this.queryText) {
			this.resetMatches();
			return;
		}
		this.matches = this.find(this.queryText);
		this.index = this.matches.length > 0 ? nearestMatchAfter(this.matches, anchor) : -1;
		this.rebuildHighlights();
	}

	commit(anchor: number): Match | undefined {
		this.open = false;
		if (this.matches.length === 0) {
			this.index = -1;
			this.rebuildHighlights();
			return undefined;
		}
		this.index = nearestMatchAfter(this.matches, anchor);
		this.rebuildHighlights();
		return this.currentMatch;
	}

	move(direction: 1 | -1): Match | undefined {
		if (this.matches.length === 0) return undefined;
		const count = this.matches.length;
		this.index =
			this.index < 0 ? (direction === 1 ? 0 : count - 1) : (this.index + direction + count) % count;
		this.rebuildHighlights();
		return this.currentMatch;
	}

	highlightsFor(lineIdx: number): Hit[] | undefined {
		return this.highlights.get(lineIdx);
	}

	private find(query: string): Match[] {
		const caseInsensitive = query === query.toLowerCase();
		if (!caseInsensitive) return findMatches(this.plainLines, query);
		this.lowerLines ??= this.plainLines.map((line) => line.toLowerCase());
		return findMatches(this.plainLines, query, this.lowerLines);
	}

	private resetMatches(): void {
		this.matches = [];
		this.index = -1;
		this.rebuildHighlights();
	}

	private rebuildHighlights(): void {
		const highlights = new Map<number, Hit[]>();
		this.matches.forEach((match, matchIndex) => {
			const hits = highlights.get(match.lineIdx) ?? [];
			hits.push({
				col: match.col,
				len: match.len,
				current: matchIndex === this.index,
			});
			highlights.set(match.lineIdx, hits);
		});
		this.highlights = highlights;
	}
}

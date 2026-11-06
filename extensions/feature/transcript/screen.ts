import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { buildBlocks, transcriptMarkdown } from "./blocks.ts";
import { openMarkdownInEditor } from "./editor.ts";
import { matchesAny, matchesBinding } from "./keymap.ts";
import { buildLayout, createMessageLineCache, type MessageLineCache } from "./layout.ts";
import { SearchSession, highlightLine } from "./search.ts";
import type {
	BlockViews,
	Keymap,
	KeyName,
	Motion,
	Notify,
	RenderConfig,
	ThemeLike,
	TuiLike,
} from "./types.ts";
import { Viewport } from "./viewport.ts";

type HelpItem = { keys: string; label: string };

export class TranscriptScreen {
	private readonly tui: TuiLike;
	private readonly theme: ThemeLike;
	private readonly cwd: string;
	private readonly renderConfig: RenderConfig;
	private readonly keymap: Keymap;
	private readonly notify: Notify;
	private readonly done: () => void;
	private readonly blocks: BlockViews;
	private readonly viewport = new Viewport();
	private readonly search = new SearchSession();
	private messageCache: MessageLineCache = createMessageLineCache();
	private showAll = false;
	private helpOpen = false;
	private cachedWidth = -1;
	private cachedShowAll = false;
	private editorBusy = false;
	private userMarkerStarts: number[] = [];
	private userLabels: string[] = [];

	constructor(
		tui: TuiLike,
		theme: ThemeLike,
		cwd: string,
		renderConfig: RenderConfig,
		keymap: Keymap,
		notify: Notify,
		entries: SessionEntry[],
		done: () => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.cwd = cwd;
		this.renderConfig = renderConfig;
		this.keymap = keymap;
		this.notify = notify;
		this.done = done;
		this.blocks = buildBlocks(entries);
	}

	handleInput(data: string): void {
		if (this.helpOpen) {
			if (matchesAny(data, [...this.keymap.actions.help, "escape"])) {
				this.helpOpen = false;
				this.tui.requestRender();
				return;
			}
			if (
				matchesAny(data, this.keymap.actions.quit) ||
				matchesAny(data, this.keymap.open) ||
				matchesBinding(data, "ctrl+c")
			) {
				this.done();
				return;
			}
			// Other keys fall through
		}

		if (this.search.isOpen) {
			this.handleSearchInput(data);
			return;
		}

		// A committed search stays highlighted. Clear it on the first Escape,
		// and let a second Escape exit the transcript.
		if (matchesBinding(data, "escape") && this.search.isActive) {
			this.search.clear();
			this.tui.requestRender();
			return;
		}

		// Esc and Ctrl+C are always available for closing. Esc first clears a
		// committed search, then closes on the next press.
		if (matchesBinding(data, "escape") || matchesBinding(data, "ctrl+c")) {
			this.done();
			return;
		}

		if (matchesAny(data, this.keymap.actions.quit)) {
			this.done();
			return;
		}
		// keys.open is a toggle: it closes the transcript even when quit no
		// longer lists the same key.
		if (matchesAny(data, this.keymap.open)) {
			this.done();
			return;
		}
		if (matchesAny(data, this.keymap.actions.search)) {
			this.helpOpen = false;
			this.search.begin();
			this.tui.requestRender();
			return;
		}
		if (matchesAny(data, this.keymap.actions.help)) {
			this.helpOpen = true;
			this.tui.requestRender();
			return;
		}
		if (matchesAny(data, this.keymap.actions.editor)) {
			void this.openEditor();
			return;
		}
		if (matchesAny(data, this.keymap.actions.previousPrompt)) {
			this.jumpPrompt(-1);
			return;
		}
		if (matchesAny(data, this.keymap.actions.nextPrompt)) {
			this.jumpPrompt(1);
			return;
		}
		if (this.search.matchCount > 0 && matchesAny(data, this.keymap.actions.nextMatch)) {
			this.moveMatch(1);
			return;
		}
		if (this.search.matchCount > 0 && matchesAny(data, this.keymap.actions.previousMatch)) {
			this.moveMatch(-1);
			return;
		}
		if (matchesAny(data, this.keymap.actions.showAll)) {
			this.toggleShowAll();
			return;
		}
		if (matchesAny(data, this.keymap.actions.top)) {
			this.scrollTo(0);
			return;
		}
		if (matchesAny(data, this.keymap.actions.bottom)) {
			this.scrollTo(this.viewport.maxScroll);
			return;
		}

		const motion = this.keymap.motions.find((candidate) => matchesAny(data, candidate.keys));
		if (motion) this.applyMotion(motion);
	}

	render(width: number): string[] {
		width = Math.max(1, width);
		const rows = Math.max(4, this.tui.terminal.rows || 24);
		const helpLines = this.helpOpen ? this.renderHelpPanel(width) : [];
		const showHelp = helpLines.length > 0;
		const footerRows = 1 + (showHelp ? helpLines.length : 1);
		const baseContentRows = Math.max(1, rows - footerRows);
		const startRows =
			this.viewport.rows > 1 ? Math.min(baseContentRows, this.viewport.rows) : baseContentRows;
		this.refreshLayout(width, startRows);

		const sticky = this.renderConfig.ui.stickyHeader ? this.stickyLabel() : undefined;
		const contentRows = Math.max(1, baseContentRows - (sticky !== undefined ? 1 : 0));
		if (contentRows !== startRows) {
			if (this.viewport.atBottom) this.viewport.pinToBottom();
			this.viewport.setRows(contentRows);
			this.search.sync(this.viewport.scrollOffset);
		}

		const output: string[] = [];
		if (sticky !== undefined) output.push(this.renderSticky(sticky, width));

		const visible = this.viewport.visibleLines();
		for (let i = 0; i < visible.length; i++) {
			const hits = this.search.highlightsFor(this.viewport.scrollOffset + i);
			output.push(hits ? highlightLine(visible[i], hits) : visible[i]);
		}
		for (let i = visible.length; i < contentRows; i++) output.push("");

		output.push(this.renderSeparator(width));
		if (showHelp) output.push(...helpLines);
		else output.push(this.renderFooterLine(width));
		return output;
	}

	invalidate(): void {
		this.cachedWidth = -1;
		this.messageCache = createMessageLineCache();
	}

	private refreshLayout(width: number, contentRows: number): void {
		if (this.cachedWidth !== width || this.cachedShowAll !== this.showAll) {
			const blocks = this.showAll ? this.blocks.all : this.blocks.compact;
			const layout = buildLayout(
				blocks,
				this.theme,
				width,
				this.showAll,
				this.messageCache,
				this.renderConfig,
			);
			this.viewport.setLayout(layout, contentRows);
			this.search.setPlain(layout.plain);
			this.search.sync(this.viewport.scrollOffset);
			this.userMarkerStarts = layout.userMarkerStarts;
			this.userLabels = layout.userLabels;
			this.cachedWidth = width;
			this.cachedShowAll = this.showAll;
			return;
		}
		this.viewport.setRows(contentRows);
	}

	private stickyLabel(): string | undefined {
		const offset = this.viewport.scrollOffset;
		let index = -1;
		for (let i = 0; i < this.userMarkerStarts.length; i++) {
			if (this.userMarkerStarts[i] < offset) index = i;
			else break;
		}
		return index >= 0 ? (this.userLabels[index] ?? "") : undefined;
	}

	private renderSticky(label: string, width: number): string {
		const pad = Math.max(0, Math.floor(this.renderConfig.outputPad));
		const maxContentWidth = Math.max(1, width - 2);
		const availableMarker = Math.max(1, maxContentWidth - pad);
		const markerText = truncatePlain(this.renderConfig.ui.userMarker, availableMarker);
		const markerWidth = visibleWidth(markerText);
		const labelWidth = Math.max(0, maxContentWidth - pad - markerWidth - 1);
		const labelText = truncatePlain(label, labelWidth);
		const text = `${" ".repeat(pad)}${this.theme.fg("userMessageText", this.theme.bold(markerText))} ${this.theme.fg("userMessageText", labelText)}`;
		const padded = truncateToWidth(text, width, "", true);
		return this.renderConfig.ui.userMessageBackground
			? this.theme.bg("userMessageBg", padded)
			: padded;
	}

	private renderSeparator(width: number): string {
		return truncateToWidth(this.theme.fg("dim", "─".repeat(width)), width, "");
	}

	private renderFooterLine(width: number): string {
		const statusParts = [`${this.showAll ? "all" : "compact"} · ${this.viewport.percent()}%`];
		if (this.search.matchCount > 0) {
			statusParts.push(`${this.search.currentIndex + 1}/${this.search.matchCount}`);
		}
		const status = this.theme.fg("dim", ` ${statusParts.join(" · ")} `);

		if (this.search.isOpen) {
			const prompt = this.theme.fg("accent", ` /${this.search.query}█`);
			const info = this.search.query ? ` ${this.search.matchCount} matches ` : " type to search ";
			const hint = this.theme.fg("dim", `${info}· Enter keep · Esc cancel `);
			return this.alignFooter(prompt, hint, width);
		}

		if (this.search.isActive) {
			const parts: string[] = [];
			if (this.search.matchCount > 0) parts.push("n/N match");
			parts.push("Esc clear");
			const searchKey = this.keymap.actions.search[0];
			if (searchKey) parts.push(`${searchKey} search`);
			const quitKey = this.keymap.actions.quit[0];
			if (quitKey) parts.push(`${quitKey} quit`);
			return this.alignFooter(this.theme.fg("dim", ` ${parts.join(" · ")}`), status, width);
		}

		const openKey = this.keymap.open[0];
		const editorKey = this.keymap.actions.editor[0];
		const helpKey = this.keymap.actions.help[0];

		const buildHint = (short: boolean): string => {
			const hintParts = ["Transcript"];
			if (openKey) hintParts.push(short ? `${openKey} toggle` : `${openKey} to toggle`);
			hintParts.push(short ? "↑↓" : "↑↓ scroll");
			if (editorKey) hintParts.push(short ? `${editorKey} nvim` : `${editorKey} to open in nvim`);
			if (helpKey) hintParts.push(short ? `${helpKey} help` : `${helpKey} for shortcuts`);
			return hintParts.join(" · ");
		};

		const available = Math.max(1, width - visibleWidth(status) - 1);
		let hint = ` ${buildHint(false)}`;
		if (visibleWidth(hint) > available) hint = ` ${buildHint(true)}`;
		return this.alignFooter(this.theme.fg("dim", hint), status, width);
	}

	private alignFooter(left: string, right: string, width: number): string {
		const rightWidth = visibleWidth(right);
		const leftMax = Math.max(0, width - rightWidth - 1);
		const leftLimited = truncateToWidth(left, leftMax, "");
		const gap = Math.max(1, width - visibleWidth(leftLimited) - rightWidth);
		return truncateToWidth(leftLimited + " ".repeat(gap) + right, width, "");
	}

	private renderHelpPanel(width: number): string[] {
		const columns = this.helpColumns();
		if (columns.length === 0) return [];

		const gap = columns.length > 1 ? 3 : 0;
		const minKeyWidth = 7;
		const natural = columns.map((column) => {
			const keyWidth = Math.max(
				minKeyWidth,
				Math.max(...column.map((item) => visibleWidth(item.keys))) + 1,
			);
			const labelWidth = Math.max(...column.map((item) => visibleWidth(item.label)));
			return { keyWidth, labelWidth, width: keyWidth + 1 + labelWidth };
		});
		const naturalWidth = natural.reduce((sum, column) => sum + column.width, 0);
		const available = width - gap * (columns.length - 1);

		let colWidths: number[];
		if (naturalWidth <= available) {
			colWidths = natural.map((column) => column.width);
		} else {
			const scale = Math.max(0.1, available / Math.max(1, naturalWidth));
			colWidths = natural.map((column) => Math.max(8, Math.floor(column.width * scale)));
			let overflow = colWidths.reduce((sum, column) => sum + column, 0) - available;
			while (overflow > 0) {
				const widest = colWidths.indexOf(Math.max(...colWidths));
				if (colWidths[widest] <= 8) break;
				colWidths[widest] -= 1;
				overflow -= 1;
			}
		}

		const maxRows = Math.max(...columns.map((column) => column.length));
		const lines: string[] = [];
		for (let row = 0; row < maxRows; row++) {
			const cells = columns.map((column, index) => {
				const item = column[row];
				if (!item) return " ".repeat(colWidths[index]);
				const keyWidth = Math.min(natural[index].keyWidth, Math.max(0, colWidths[index] - 2));
				const cell = `${this.theme.fg("accent", item.keys.padEnd(keyWidth))} ${this.theme.fg("dim", item.label)}`;
				const limited = truncateToWidth(cell, colWidths[index], "...");
				return limited + " ".repeat(Math.max(0, colWidths[index] - visibleWidth(limited)));
			});
			lines.push(truncateToWidth(cells.join(" ".repeat(gap)), width, "", true));
		}
		return lines;
	}

	private helpColumns(): HelpItem[][] {
		const columns: HelpItem[][] = [
			[
				{ keys: this.lineScrollKeys(), label: "scroll" },
				{
					keys: this.pairKeys("halfPageUp", "halfPageDown"),
					label: "half page",
				},
				{ keys: this.pageKeys(), label: "page" },
				{ keys: this.pairKeys("top", "bottom"), label: "top/bottom" },
			],
			[
				{ keys: this.singleKey("search"), label: "search" },
				{
					keys: this.pairKeys("nextMatch", "previousMatch"),
					label: "match",
				},
				{ keys: this.singleKey("editor"), label: "open in nvim" },
				{
					keys: this.pairKeys("previousPrompt", "nextPrompt"),
					label: "prev/next prompt",
				},
			],
			[
				{ keys: this.singleKey("open"), label: "toggle" },
				{ keys: this.singleKey("showAll"), label: "compact/all" },
				{ keys: this.exitKeys(), label: "exit" },
				{ keys: this.closeKeys(), label: "clear/close" },
			],
		];
		return columns
			.map((column) => column.filter((item) => item.keys))
			.filter((column) => column.length > 0);
	}

	private lineScrollKeys(): string {
		const down = this.keysFor("lineDown");
		const up = this.keysFor("lineUp");
		const parts: string[] = [];
		if (down.includes("down") && up.includes("up")) parts.push("↑↓");
		if (down.includes("j") && up.includes("k")) parts.push("j/k");
		if (down.includes("ctrl+e") && up.includes("ctrl+y")) parts.push("ctrl+e/y");
		return parts.length > 0 ? parts.join(" ") : this.pairKeys("lineUp", "lineDown");
	}

	private pageKeys(): string {
		const down = this.keysFor("pageDown");
		const up = this.keysFor("pageUp");
		const parts: string[] = [];
		if (down.includes("ctrl+f") && up.includes("ctrl+b")) parts.push("ctrl+f/b");
		if (down.includes("space") && up.includes("b")) parts.push("space b");
		return parts.length > 0 ? parts.join(" ") : this.pairKeys("pageUp", "pageDown");
	}

	private exitKeys(): string {
		const keys = this.keysFor("quit");
		const primary = keys.includes("q")
			? "q"
			: keys.find((key) => key !== "escape" && key !== "esc" && key !== "ctrl+c");
		if (!primary || primary === "ctrl+c") return "ctrl+c";
		return `ctrl+c ${primary}`;
	}

	private closeKeys(): string {
		const helpKey = this.singleKey("help");
		if (helpKey && helpKey !== "escape" && helpKey !== "esc") return `esc ${helpKey}`;
		return "esc";
	}

	private singleKey(name: KeyName): string {
		return this.keysFor(name)[0] ?? "";
	}

	private pairKeys(first: KeyName, second: KeyName): string {
		const a = this.singleKey(first);
		const b = this.singleKey(second);
		if (a && b) {
			if (a.startsWith("ctrl+") && b.startsWith("ctrl+")) {
				return `ctrl+${a.slice(5)}/${b.slice(5)}`;
			}
			return `${a}/${b}`;
		}
		return a || b;
	}

	private keysFor(name: KeyName): string[] {
		if (name === "open") return this.keymap.open;
		const actions: Partial<Record<KeyName, string[]>> = this.keymap.actions;
		const action = actions[name];
		if (action) return action;
		return this.keymap.motions.find((motion) => motion.name === name)?.keys ?? [];
	}

	private applyMotion(motion: Motion): void {
		const amount =
			motion.amount === "line"
				? 1
				: motion.amount === "half"
					? Math.max(1, Math.floor(this.viewport.rows / 2))
					: this.viewport.rows;
		this.viewport.scrollBy(motion.direction * amount);
		this.tui.requestRender();
	}

	private toggleShowAll(): void {
		if (this.viewport.atBottom) this.viewport.pinToBottom();
		this.showAll = !this.showAll;
		this.tui.requestRender();
	}

	private scrollTo(offset: number): void {
		this.viewport.scrollTo(offset);
		this.tui.requestRender();
	}

	private jumpPrompt(direction: 1 | -1): void {
		if (this.viewport.jumpPrompt(direction)) this.tui.requestRender();
	}

	private moveMatch(direction: 1 | -1): void {
		const match = this.search.move(direction);
		if (match) this.viewport.scrollToLine(match.lineIdx, Math.floor(this.viewport.rows / 3));
		this.tui.requestRender();
	}

	private commitSearch(): void {
		const match = this.search.commit(this.viewport.scrollOffset);
		if (match) this.viewport.scrollToLine(match.lineIdx, Math.floor(this.viewport.rows / 3));
		this.tui.requestRender();
	}

	private setSearchQuery(query: string): void {
		this.search.setQuery(query);
		this.tui.requestRender();
	}

	private handleSearchInput(data: string): void {
		if (matchesAny(data, this.keymap.open)) {
			this.done();
			return;
		}
		if (matchesAny(data, ["escape", "ctrl+c"])) {
			this.search.cancel();
			this.tui.requestRender();
			return;
		}
		if (matchesAny(data, ["enter"]) || data === "\r" || data === "\n") {
			this.commitSearch();
			return;
		}
		if (matchesAny(data, ["backspace"]) || data === "\x7f" || data === "\b") {
			this.setSearchQuery(this.search.query.slice(0, -1));
			return;
		}
		if (!data.includes("\x1b")) {
			const printable = Array.from(data)
				.filter((char) => char >= " " && char !== "\x7f")
				.join("");
			if (printable) this.setSearchQuery(this.search.query + printable);
		}
	}

	private async openEditor(): Promise<void> {
		if (this.editorBusy) return;
		this.editorBusy = true;
		try {
			await openMarkdownInEditor({
				markdown: transcriptMarkdown(this.blocks.all),
				cwd: this.cwd,
				notify: this.notify,
				tui: this.tui,
			});
		} finally {
			this.editorBusy = false;
		}
	}
}

function truncatePlain(text: string, max: number, ellipsis = "..."): string {
	if (max <= 0) return "";
	if (visibleWidth(text) <= max) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	if (ellipsisWidth >= max) return sliceByColumn(ellipsis, 0, max);
	return `${sliceByColumn(text, 0, max - ellipsisWidth)}${ellipsis}`;
}

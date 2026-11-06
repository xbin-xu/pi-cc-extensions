import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Text,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

import { ROLE_META } from "./blocks.ts";
import type { Block, Layout, MessageBlock, RenderConfig, ThemeLike } from "./types.ts";

export type MessageLineCache = WeakMap<Block, { width: number; variant: string; lines: string[] }>;

export function createMessageLineCache(): MessageLineCache {
	return new WeakMap();
}

type MarkdownTheme = ReturnType<typeof getMarkdownTheme>;

export function buildLayout(
	blocks: Block[],
	theme: ThemeLike,
	width: number,
	showAll: boolean,
	cache: MessageLineCache,
	config: RenderConfig,
): Layout {
	const lines: string[] = [];
	const plain: string[] = [];
	const userStarts: number[] = [];
	const userMarkerStarts: number[] = [];
	const userLabels: string[] = [];
	const outputPad = Math.max(0, Math.floor(config.outputPad));
	const contentWidth = Math.max(1, width - outputPad * 2);
	const prefix = " ".repeat(outputPad);
	const markdownTheme: MarkdownTheme = {
		...getMarkdownTheme(),
		codeBlockIndent: config.codeBlockIndent,
	};
	let previousWasUserPanel = false;

	const push = (styled: string): void => {
		const limited = `${prefix}${truncateToWidth(styled, contentWidth, "")}`;
		lines.push(limited);
		plain.push(stripTerminalSequences(limited));
	};

	const pushRaw = (styled: string): void => {
		const limited = truncateToWidth(styled, width, "");
		lines.push(limited);
		plain.push(stripTerminalSequences(limited));
	};

	for (const block of blocks) {
		const isUserPanel =
			block.kind === "message" && block.role === "user" && config.ui.userMessageBackground;
		const isCompactTool = (block.kind === "tool" || block.kind === "toolGroup") && !showAll;

		// A user panel's background padding rows act as separators, so do not
		// add an uncolored separator before or after one.
		if (lines.length > 0 && !isUserPanel && !previousWasUserPanel && !isCompactTool) push("");

		if (block.kind === "toolGroup") {
			previousWasUserPanel = false;
			if (block.summary) push(theme.fg("accent", `  ${block.summary}`));
			for (const member of block.lineMembers)
				push(theme.fg(member.error ? "error" : "dim", `  ${member.summary}`));
			continue;
		}

		if (block.kind === "tool") {
			previousWasUserPanel = false;
			if (!showAll) {
				push(theme.fg(block.error ? "error" : "dim", `  ${block.summary}`));
				continue;
			}

			push(theme.fg(block.error ? "error" : "toolTitle", theme.bold(`▸ ${block.label}`)));
			for (const line of new Text(block.full(), 0, 0).render(Math.max(1, contentWidth - 2))) {
				push(theme.fg(block.error ? "error" : "toolOutput", `  ${line}`));
			}
			continue;
		}

		const meta = ROLE_META[block.role];

		if (block.role === "user") {
			const panelStart = lines.length;
			if (isUserPanel && !previousWasUserPanel) pushRaw(userPadLine(width));
			const markerStart = lines.length;
			userStarts.push(panelStart);
			userMarkerStarts.push(markerStart);
			userLabels.push(collapsedLabel(block.markdown));

			const background = isUserPanel;
			const variant = background ? "user-bg" : "user-plain";
			const textStyle = {
				color: (text: string) => theme.fg("userMessageText", text),
			};
			for (const line of markedMessageLines(
				block,
				width,
				outputPad,
				config.ui.userMarker,
				meta.color,
				markdownTheme,
				textStyle,
				theme,
				background,
				variant,
				cache,
			)) {
				pushRaw(line);
			}
			if (background) pushRaw(userPadLine(width));
			previousWasUserPanel = background;
			continue;
		}

		if (block.role === "assistant") {
			for (const line of markedMessageLines(
				block,
				width,
				outputPad,
				config.ui.assistantMarker,
				meta.color,
				markdownTheme,
				undefined,
				theme,
				false,
				"assistant",
				cache,
			)) {
				pushRaw(line);
			}
			previousWasUserPanel = false;
			continue;
		}

		const header = block.header ?? meta.header;
		push(theme.fg(meta.color, theme.bold(header)));
		for (const line of messageLines(block, contentWidth, markdownTheme, cache)) push(line);
		previousWasUserPanel = false;
	}

	if (lines.length === 0) push(theme.fg("dim", "No messages in this session yet."));
	return { lines, plain, userStarts, userMarkerStarts, userLabels };
}

function userPadLine(width: number): string {
	return " ".repeat(width);
}

function collapsedLabel(markdown: string): string {
	return markdown.replace(/\s+/g, " ").trim();
}

function markedMessageLines(
	block: MessageBlock,
	width: number,
	outputPad: number,
	marker: string,
	markerColor: string,
	markdownTheme: MarkdownTheme,
	textStyle: { color?: (text: string) => string } | undefined,
	theme: ThemeLike,
	background: boolean,
	variant: string,
	cache: MessageLineCache,
): string[] {
	const cached = cache.get(block);
	if (cached?.width === width && cached.variant === variant) return cached.lines;

	const markerWidth = visibleWidth(marker);
	const textIndent = Math.min(Math.max(0, width - 1), outputPad + markerWidth + 1);
	const textWidth = Math.max(1, width - textIndent - outputPad);
	const rendered = new Markdown(block.markdown, 0, 0, markdownTheme, textStyle).render(textWidth);

	const lines: string[] = [];
	for (let i = 0; i < rendered.length; i++) {
		const lead =
			i === 0
				? `${" ".repeat(outputPad)}${theme.fg(markerColor, theme.bold(marker))} `
				: " ".repeat(textIndent);
		const raw = lead + rendered[i];
		lines.push(
			background
				? theme.bg("userMessageBg", truncateToWidth(raw, width, "", true))
				: truncateToWidth(raw, width, ""),
		);
	}

	cache.set(block, { width, variant, lines });
	return lines;
}

function messageLines(
	block: MessageBlock,
	width: number,
	markdownTheme: MarkdownTheme,
	cache: MessageLineCache,
): string[] {
	const cached = cache.get(block);
	if (cached?.width === width && cached.variant === "plain") return cached.lines;

	const lines = new Markdown(block.markdown, 0, 0, markdownTheme).render(width);
	cache.set(block, { width, variant: "plain", lines });
	return lines;
}

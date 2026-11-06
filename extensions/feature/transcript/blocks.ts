import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import { clampText, oneLine, tryStringify } from "./text.ts";
import type { Block, BlockViews, MessageRole, ToolBlock, ToolGroupBlock } from "./types.ts";

type ToolCall = { id?: string; name: string; args: unknown };

type ParsedContent = { text: string; thinking: string[]; calls: ToolCall[] };

type PendingToolBlock = ToolBlock & {
	callName: string;
	callArgs: unknown;
	callDetail: string;
	callStats: string;
	resultFull?: string;
};

type ToolResultData = {
	name: string;
	error: boolean;
	text: string;
	first: string;
	lineCount: number;
	full: string;
	at?: number;
};

/** compact 折叠时保留独立标题行的工具（与 live 转录的 compact 摘要行为一致）。 */
const TITLED_TOOLS = new Set(["edit", "write"]);

export const ROLE_META: Record<MessageRole, { title: string; header: string; color: string }> = {
	user: { title: "User", header: "USER", color: "userMessageText" },
	assistant: { title: "Assistant", header: "ASSISTANT", color: "accent" },
	custom: { title: "Custom", header: "CUSTOM", color: "customMessageLabel" },
	meta: { title: "Summary", header: "SUMMARY", color: "muted" },
};

const SUMMARY_LABEL = {
	branchSummary: "BRANCH SUMMARY",
	compactionSummary: "COMPACTION",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseContent(content: unknown): ParsedContent {
	if (typeof content === "string") return { text: content, thinking: [], calls: [] };
	if (!Array.isArray(content)) return { text: "", thinking: [], calls: [] };

	const texts: string[] = [];
	const thinking: string[] = [];
	const calls: ToolCall[] = [];
	for (const part of content) {
		if (!isRecord(part)) continue;
		if (part.type === "text" && typeof part.text === "string") texts.push(part.text);
		else if (part.type === "image") texts.push("[image]");
		else if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim())
			thinking.push(part.thinking);
		else if (part.type === "toolCall") {
			calls.push({
				id: typeof part.id === "string" ? part.id : undefined,
				name: String(part.name ?? "tool"),
				args: part.arguments,
			});
		}
	}
	return { text: texts.join("\n"), thinking, calls };
}

function toolCallDetail(args: unknown): string {
	if (!isRecord(args)) return oneLine(tryStringify(args, false), 120);
	for (const key of ["path", "command", "pattern", "url", "query"]) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return oneLine(value, 160);
	}
	return oneLine(tryStringify(args, false), 160);
}

function memoizedFull(create: () => string): () => string {
	let cached: string | undefined;
	return () => {
		if (cached === undefined) cached = create();
		return cached;
	};
}

function makeToolBlock(
	label: string,
	summary: string,
	full: string | (() => string),
	error: boolean,
	meta?: Pick<ToolBlock, "toolName" | "dedupKey" | "at" | "endedAt">,
): ToolBlock {
	return {
		kind: "tool",
		label,
		summary,
		error,
		full: memoizedFull(typeof full === "string" ? () => full : full),
		...meta,
	};
}

function messageTime(message: Record<string, unknown>): number | undefined {
	return typeof message.timestamp === "number" ? message.timestamp : undefined;
}

function lineCount(text: string): number {
	return text ? text.split("\n").length : 0;
}

/** edit/write 的 `(+n -m)` 行数统计，直接拼进标题行。 */
function toolStatsSuffix(name: string, args: unknown): string {
	if (!isRecord(args)) return "";
	if (name === "edit") {
		const oldText = typeof args.old_string === "string" ? args.old_string : "";
		const newText = typeof args.new_string === "string" ? args.new_string : "";
		if (!oldText && !newText) return "";
		return `  (+${lineCount(newText)} -${lineCount(oldText)})`;
	}
	if (name === "write" && typeof args.content === "string")
		return `  (+${lineCount(args.content)})`;
	return "";
}

function dedupKeyFor(call: ToolCall): string | undefined {
	if (call.name !== "read" || !isRecord(call.args)) return undefined;
	const path = call.args.path;
	return typeof path === "string" && path ? `read:${path}` : undefined;
}

function firstNonEmptyLine(text: string): { first: string; lineCount: number } {
	let first = "done";
	let lineCount = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		if (lineCount === 0) first = oneLine(line);
		lineCount++;
	}
	return { first, lineCount };
}

function formatCallFull(block: PendingToolBlock): string {
	const call = `[tool call: ${block.callName}]\n${tryStringify(block.callArgs, true)}`;
	return block.resultFull ? `${call}\n\n${block.resultFull}` : call;
}

function callFull(call: ToolCall): string {
	return `[tool call: ${call.name}]\n${tryStringify(call.args, true)}`;
}

function makeCallOnlyBlock(call: ToolCall, detail: string, at?: number): ToolBlock {
	return makeToolBlock(
		`→ ${call.name}`,
		`→ ${call.name}  ${detail}${toolStatsSuffix(call.name, call.args)}`,
		() => callFull(call),
		false,
		{ toolName: call.name, dedupKey: dedupKeyFor(call), at },
	);
}

function makePendingToolBlock(call: ToolCall, detail: string, at?: number): PendingToolBlock {
	const block: PendingToolBlock = {
		kind: "tool",
		label: `→ ${call.name}`,
		summary: `→ ${call.name}  ${detail}${toolStatsSuffix(call.name, call.args)}`,
		error: false,
		callName: call.name,
		callArgs: call.args,
		callDetail: detail,
		callStats: toolStatsSuffix(call.name, call.args),
		toolName: call.name,
		dedupKey: dedupKeyFor(call),
		at,
		full: () => "",
	};
	block.full = memoizedFull(() => formatCallFull(block));
	return block;
}

function readToolResult(message: Record<string, unknown>): ToolResultData {
	const name = String(message.toolName ?? "tool");
	const error = Boolean(message.isError);
	const text = clampText(parseContent(message.content).text);
	const { first, lineCount } = firstNonEmptyLine(text);
	return {
		name,
		error,
		text,
		first,
		lineCount,
		full: `[${name} ${error ? "error" : "ok"}]\n${text || "(no output)"}`,
		at: messageTime(message),
	};
}

function toolResultBlock(data: ToolResultData): ToolBlock {
	const mark = data.error ? "✗" : "✓";
	const extra = data.lineCount > 1 ? `  (${data.lineCount} lines)` : "";
	return makeToolBlock(
		`${mark} ${data.name}`,
		`${mark} ${data.name}  ${data.first}${extra}`,
		data.full,
		data.error,
		{ toolName: data.name, at: data.at, endedAt: data.at },
	);
}

function mergeToolResult(block: PendingToolBlock, data: ToolResultData): void {
	const mark = data.error ? "✗" : "✓";
	const note = data.error
		? data.first === "done"
			? ""
			: `  ${data.first}`
		: data.lineCount > 1
			? `  (${data.lineCount} lines)`
			: "";

	block.label = `${mark} ${data.name}`;
	block.summary = `${mark} ${data.name}  ${block.callDetail}${block.callStats}${note}`;
	block.error = data.error;
	block.resultFull = data.full;
	if (data.at !== undefined) block.endedAt = data.at;
	block.full = memoizedFull(() => formatCallFull(block));
}

function bashBlock(message: Record<string, unknown>): ToolBlock {
	const command = String(message.command ?? "");
	const output = String(message.output ?? "");
	const cancelled = Boolean(message.cancelled);
	const truncated = Boolean(message.truncated);
	const error = typeof message.exitCode === "number" && message.exitCode !== 0;
	const status = cancelled
		? "cancelled"
		: `${oneLine(output || "done", 120)}${truncated ? " …" : ""}`;
	const fullParts = [`$ ${command}`];
	if (cancelled) fullParts.push("(cancelled)");
	fullParts.push(output || "(no output)");
	if (truncated) {
		const path = typeof message.fullOutputPath === "string" ? message.fullOutputPath : "";
		fullParts.push(path ? `(output truncated — full output: ${path})` : "(output truncated)");
	}
	return makeToolBlock(
		"$ bash",
		`$ ${oneLine(command, 160)} → ${status}`,
		fullParts.join("\n"),
		error,
		{ toolName: "bash", at: messageTime(message), endedAt: messageTime(message) },
	);
}

function pushMessage(views: BlockViews, role: MessageRole, text: string, header?: string): void {
	const markdown = clampText(text);
	if (!markdown.trim()) return;

	const block: Block = { kind: "message", role, header, markdown };
	views.compact.push(block);
	views.all.push(block);
}

function appendMessage(
	views: BlockViews,
	message: Record<string, unknown>,
	pendingCalls: Map<string, PendingToolBlock>,
): void {
	switch (String(message.role ?? "")) {
		case "user":
			pushMessage(views, "user", parseContent(message.content).text);
			break;

		case "assistant": {
			const { text, thinking, calls } = parseContent(message.content);
			if (thinking.length > 0)
				views.all.push(makeToolBlock("✻ thinking", "✻ thinking", thinking.join("\n\n"), false));
			pushMessage(views, "assistant", text);
			const at = messageTime(message);
			for (const call of calls) {
				const detail = toolCallDetail(call.args);
				views.all.push(makeCallOnlyBlock(call, detail, at));

				const pending = makePendingToolBlock(call, detail, at);
				if (call.id) pendingCalls.set(call.id, pending);
				views.compact.push(pending);
			}
			const errorMessage =
				typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
			if (errorMessage) {
				const block = makeToolBlock(
					"✗ error",
					`✗ error  ${oneLine(errorMessage, 120)}`,
					errorMessage,
					true,
				);
				views.compact.push(block);
				views.all.push(block);
			}
			break;
		}

		case "toolResult": {
			const data = readToolResult(message);
			const resultBlock = toolResultBlock(data);
			views.all.push(resultBlock);

			const callId = String(message.toolCallId ?? "");
			const pending = callId ? pendingCalls.get(callId) : undefined;
			if (pending) {
				mergeToolResult(pending, data);
				pendingCalls.delete(callId);
			} else {
				views.compact.push(resultBlock);
			}
			break;
		}

		case "bashExecution": {
			const block = bashBlock(message);
			views.compact.push(block);
			views.all.push(block);
			break;
		}

		case "custom":
			if (message.display !== false) {
				const customType = String(message.customType ?? "").trim();
				pushMessage(
					views,
					"custom",
					parseContent(message.content).text,
					`CUSTOM ${customType}`.trim(),
				);
			}
			break;

		case "branchSummary":
			pushMessage(views, "meta", String(message.summary ?? ""), SUMMARY_LABEL.branchSummary);
			break;

		case "compactionSummary":
			pushMessage(views, "meta", String(message.summary ?? ""), SUMMARY_LABEL.compactionSummary);
			break;
	}
}

export function buildBlocks(entries: SessionEntry[]): BlockViews {
	const views: BlockViews = { compact: [], all: [] };
	const pendingCalls = new Map<string, PendingToolBlock>();

	for (const entry of entries) {
		for (const message of sessionEntryToContextMessages(entry)) {
			appendMessage(views, message as unknown as Record<string, unknown>, pendingCalls);
		}
	}
	return { compact: groupToolRuns(views.compact), all: views.all };
}

function formatDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

/**
 * compact 视图的按回合折叠：连续的工具块合成一条 `✦ 时长 · 名称×N` 汇总行
 * （read 按路径去重），edit/write 与出错的工具保留独立行；单个工具不折叠。
 * 消息块（user/assistant 正文等）是回合边界。all 视图不经过此处理。
 */
export function groupToolRuns(blocks: Block[]): Block[] {
	const result: Block[] = [];
	let run: ToolBlock[] = [];

	const flush = (): void => {
		if (run.length === 0) return;
		result.push(...collapseRun(run));
		run = [];
	};

	for (const block of blocks) {
		if (block.kind === "tool") run.push(block);
		else {
			flush();
			result.push(block);
		}
	}
	flush();
	return result;
}

function collapseRun(run: ToolBlock[]): Block[] {
	if (run.length === 1) return run;

	const counts = new Map<string, { label: string; count: number }>();
	const lineMembers: ToolBlock[] = [];
	let error = false;
	let firstAt: number | undefined;
	let lastAt: number | undefined;

	for (const block of run) {
		if (block.error) error = true;
		for (const at of [block.at, block.endedAt]) {
			if (typeof at !== "number") continue;
			firstAt = firstAt === undefined ? at : Math.min(firstAt, at);
			lastAt = lastAt === undefined ? at : Math.max(lastAt, at);
		}

		const name = block.toolName;
		if (!name) {
			if (block.error) lineMembers.push(block);
			continue;
		}
		if (TITLED_TOOLS.has(name) || block.error) lineMembers.push(block);
		if (TITLED_TOOLS.has(name)) continue;

		const key = block.dedupKey ?? name;
		const entry = counts.get(key);
		if (entry) {
			// read 同路径只计一次；其余按调用次数累加。
			if (!block.dedupKey) entry.count += 1;
		} else {
			counts.set(key, { label: name, count: 1 });
		}
	}

	// 展示时同名聚合：两个不同路径的 read 合成 read×2。
	const labelTotals = new Map<string, number>();
	for (const { label, count } of counts.values())
		labelTotals.set(label, (labelTotals.get(label) ?? 0) + count);

	const parts: string[] = [];
	const duration =
		firstAt !== undefined && lastAt !== undefined && lastAt > firstAt
			? lastAt - firstAt
			: undefined;
	if (duration !== undefined) parts.push(formatDuration(duration));
	if (labelTotals.size > 0)
		parts.push(
			[...labelTotals]
				.map(([label, total]) => (total > 1 ? `${label}×${total}` : label))
				.join(" · "),
		);

	const group: ToolGroupBlock = {
		kind: "toolGroup",
		label: `Tools (${run.length})`,
		summary: parts.length > 0 ? `✦ ${parts.join(" · ")}` : null,
		lineMembers,
		allMembers: run,
		error,
	};
	return [group];
}

export function blockTitle(block: Block): string {
	if (block.kind === "toolGroup") return block.label;
	if (block.kind === "tool") return block.label;
	return block.header ?? ROLE_META[block.role].title;
}

function longestBacktickRun(text: string): number {
	let longest = 0;
	for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
	return longest;
}

export function transcriptMarkdown(blocks: Block[]): string {
	const output: string[] = ["# Pi transcript", ""];
	const pushToolSection = (block: ToolBlock): void => {
		const full = block.full();
		const fence = "`".repeat(Math.max(3, longestBacktickRun(full) + 1));
		output.push(`### ${blockTitle(block)}`, "", `${fence}text`, full.trimEnd(), fence, "");
	};
	for (const block of blocks) {
		if (block.kind === "message") {
			output.push(`## ${blockTitle(block)}`, "", block.markdown.trimEnd(), "");
			continue;
		}
		if (block.kind === "toolGroup") {
			for (const member of block.allMembers) pushToolSection(member);
			continue;
		}
		pushToolSection(block);
	}
	return output.join("\n");
}

import assert from "node:assert/strict";
import test from "node:test";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildBlocks, transcriptMarkdown } from "../extensions/feature/transcript/blocks.ts";
import type { Block, ToolBlock, ToolGroupBlock } from "../extensions/feature/transcript/types.ts";

let nextId = 0;

function messageEntry(message: Record<string, unknown>): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `e${nextId}`,
		parentId: null,
		timestamp: "2026-11-06T12:00:00.000Z",
		message,
	} as unknown as SessionEntry;
}

function toolBlocks(blocks: Block[]): ToolBlock[] {
	return blocks.filter((block): block is ToolBlock => block.kind === "tool");
}

function labels(blocks: Block[]): string[] {
	return toolBlocks(blocks).map((block) => block.label);
}

test("tool call merges with its result in compact view", () => {
	const views = buildBlocks([
		messageEntry({
			role: "assistant",
			content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }],
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "file-a\nfile-b" }],
			isError: false,
		}),
	]);

	assert.deepEqual(labels(views.compact), ["✓ bash"]);
	assert.deepEqual(labels(views.all), ["→ bash", "✓ bash"]);
	// compact 的合并块 full() 同时包含调用与结果
	const merged = toolBlocks(views.compact)[0];
	assert.match(merged.full(), /\[tool call: bash\]/);
	assert.match(merged.full(), /\[bash ok\]/);
});

test("tool result without a pending call becomes a standalone block", () => {
	const views = buildBlocks([
		messageEntry({
			role: "toolResult",
			toolCallId: "missing",
			toolName: "read",
			content: [{ type: "text", text: "contents" }],
			isError: false,
		}),
	]);

	assert.deepEqual(labels(views.compact), ["✓ read"]);
	assert.equal(toolBlocks(views.compact)[0].error, false);
});

test("thinking appears in the all view only", () => {
	const views = buildBlocks([
		messageEntry({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "pondering deeply" },
				{ type: "text", text: "answer" },
			],
		}),
	]);

	assert.deepEqual(labels(views.all), ["✻ thinking"]);
	assert.deepEqual(labels(views.compact), []);
});

test("assistant error message shows in both views", () => {
	const views = buildBlocks([
		messageEntry({
			role: "assistant",
			content: [],
			errorMessage: "provider 500",
		}),
	]);

	assert.deepEqual(labels(views.compact), ["✗ error"]);
	assert.deepEqual(labels(views.all), ["✗ error"]);
	assert.equal(toolBlocks(views.compact)[0].error, true);
});

test("cancelled bash execution is annotated", () => {
	const views = buildBlocks([
		messageEntry({
			role: "bashExecution",
			command: "sleep 10",
			output: "",
			exitCode: undefined,
			cancelled: true,
			truncated: false,
		}),
	]);

	const block = toolBlocks(views.compact)[0];
	assert.match(block.summary, /cancelled/);
	assert.match(block.full(), /\(cancelled\)/);
});

function findGroup(blocks: Block[]): ToolGroupBlock {
	const group = blocks.find((block): block is ToolGroupBlock => block.kind === "toolGroup");
	assert.ok(group, "expected a toolGroup block");
	return group;
}

test("compact collapses consecutive tool runs into one summary line", () => {
	const views = buildBlocks([
		messageEntry({
			role: "assistant",
			timestamp: 1000,
			content: [
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "b", name: "bash", arguments: { command: "pwd" } },
				{ type: "toolCall", id: "c", name: "read", arguments: { path: "/x.ts" } },
				{ type: "toolCall", id: "d", name: "read", arguments: { path: "/x.ts" } },
			],
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "a",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3000,
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "b",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 5000,
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "c",
			toolName: "read",
			content: [{ type: "text", text: "x" }],
			isError: false,
			timestamp: 7000,
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "d",
			toolName: "read",
			content: [{ type: "text", text: "x" }],
			isError: false,
			timestamp: 9000,
		}),
	]);

	const group = findGroup(views.compact);
	assert.equal(group.allMembers.length, 4);
	assert.equal(group.lineMembers.length, 0);
	// read 同路径去重；时长取首次调用到末个结果
	assert.match(group.summary ?? "", /8\.0s/);
	assert.match(group.summary ?? "", /bash×2/);
	assert.match(group.summary ?? "", /read(?!×)/);
});

test("edit keeps a titled line with diff stats inside a collapsed run", () => {
	const views = buildBlocks([
		messageEntry({
			role: "assistant",
			timestamp: 1000,
			content: [
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "ls" } },
				{
					type: "toolCall",
					id: "b",
					name: "edit",
					arguments: { path: "/a.ts", old_string: "a\nb", new_string: "x\ny\nz" },
				},
			],
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "a",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 2000,
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "b",
			toolName: "edit",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3000,
		}),
	]);

	const group = findGroup(views.compact);
	assert.equal(group.lineMembers.length, 1);
	assert.equal(group.lineMembers[0].toolName, "edit");
	assert.match(group.lineMembers[0].summary, /\(\+3 -2\)/);
	// edit 不进计数，只计 bash
	assert.match(group.summary ?? "", /bash(?!×)/);
	assert.doesNotMatch(group.summary ?? "", /edit/);
});

test("failed tools stay visible inside the collapsed summary", () => {
	const views = buildBlocks([
		messageEntry({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "a", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "b", name: "bash", arguments: { command: "boom" } },
			],
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "a",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "b",
			toolName: "bash",
			content: [{ type: "text", text: "kaput" }],
			isError: true,
		}),
	]);

	const group = findGroup(views.compact);
	assert.equal(group.error, true);
	assert.equal(group.lineMembers.length, 1);
	assert.match(group.lineMembers[0].summary, /kaput/);
});

test("message blocks split tool runs", () => {
	const views = buildBlocks([
		messageEntry({
			role: "assistant",
			content: [{ type: "toolCall", id: "a", name: "bash", arguments: { command: "one" } }],
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "a",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		}),
		messageEntry({ role: "user", content: "steer" }),
		messageEntry({
			role: "assistant",
			content: [{ type: "toolCall", id: "b", name: "bash", arguments: { command: "two" } }],
		}),
		messageEntry({
			role: "toolResult",
			toolCallId: "b",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
			isError: false,
		}),
	]);

	// 两个单工具回合互不折叠
	assert.equal(views.compact.filter((block) => block.kind === "toolGroup").length, 0);
	assert.equal(views.compact.filter((block) => block.kind === "tool").length, 2);
});

test("markdown export fences tool blocks and keeps message headings", () => {
	const markdown = transcriptMarkdown(
		buildBlocks([
			messageEntry({ role: "user", content: "hi" }),
			messageEntry({
				role: "toolResult",
				toolCallId: "x",
				toolName: "bash",
				content: [{ type: "text", text: "```nested```" }],
				isError: false,
			}),
		]).all,
	);

	assert.match(markdown, /## User/);
	assert.match(markdown, /### ✓ bash/);
	assert.match(markdown, /````text/); // fence 长于嵌套反引号
});

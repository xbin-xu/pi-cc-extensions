export interface ThemeLike {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
	bold(text: string): string;
}

export interface TuiLike {
	requestRender(force?: boolean): void;
	start(): void;
	stop(): void;
	terminal: { rows: number; columns: number };
}

export type Notify = (message: string, type?: "info" | "warning" | "error") => void;

export type MessageRole = "user" | "assistant" | "custom" | "meta";

export type MessageBlock = {
	kind: "message";
	role: MessageRole;
	header?: string;
	markdown: string;
};

export type ToolBlock = {
	kind: "tool";
	label: string;
	summary: string;
	error: boolean;
	full: () => string;
	toolName?: string;
	/** read 去重键（read:path），同组内同路径只计一次。 */
	dedupKey?: string;
	at?: number;
	endedAt?: number;
};

export type ToolGroupBlock = {
	kind: "toolGroup";
	label: string;
	/** `✦ 8s · bash×2 · read` 汇总行；全部成员都独立成行时为 null。 */
	summary: string | null;
	/** compact 下保留独立行的成员：edit/write 与出错的工具。 */
	lineMembers: ToolBlock[];
	/** 全部成员（导出/markdown 用）。 */
	allMembers: ToolBlock[];
	error: boolean;
};

export type Block = MessageBlock | ToolBlock | ToolGroupBlock;

export type ActionName =
	| "quit"
	| "help"
	| "search"
	| "editor"
	| "previousPrompt"
	| "nextPrompt"
	| "showAll"
	| "top"
	| "bottom"
	| "nextMatch"
	| "previousMatch";

export type MotionName =
	| "lineDown"
	| "lineUp"
	| "halfPageDown"
	| "halfPageUp"
	| "pageDown"
	| "pageUp";

export type KeyName = ActionName | MotionName | "open";

export type MotionAmount = "line" | "half" | "page";

export type Motion = {
	name: MotionName;
	keys: string[];
	amount: MotionAmount;
	direction: 1 | -1;
};

export type Keymap = {
	actions: Record<ActionName, string[]>;
	motions: Motion[];
	open: string[];
};

export type UIConfig = {
	userMessageBackground: boolean;
	stickyHeader: boolean;
	userMarker: string;
	assistantMarker: string;
};

export type TranscriptConfig = {
	keys: Record<KeyName, string[]>;
	ui: UIConfig;
};

export type RenderConfig = {
	outputPad: number;
	codeBlockIndent: string;
	ui: UIConfig;
};

export type BlockViews = {
	compact: Block[];
	all: Block[];
};

export type Layout = {
	lines: string[];
	plain: string[];
	userStarts: number[];
	userMarkerStarts: number[];
	userLabels: string[];
};

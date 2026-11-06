/**
 * Claude Code 风格的 transcript viewer:全屏回看当前会话分支。
 *
 * `/transcript` 或 `transcriptOpenKey` 配置的快捷键打开;入口键默认不绑定,
 * 避免与 pi 原生 `app.tools.expand`(ctrl+o)冲突——想还原 Claude Code 的
 * ctrl+o 体验,把 keybindings.json 里 app.tools.expand 挪走后配置
 * `"transcriptOpenKey": "ctrl+o"` 即可。
 *
 * 视图自带滚动/搜索/跳转/导出,不依赖 renderer 补丁栈:
 * blocks(session 条目 -> 视图块) / layout(块 -> 行) / search / viewport /
 * keymap / editor($EDITOR 导出) / screen(组合与输入)。打开时从
 * sessionManager.getBranch() 取条目,overlay 独占输入,不与鼠标栈交互。
 */
import {
	SettingsManager,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KeyId } from "@earendil-works/pi-tui";

import { config } from "../../config/config.ts";
import { buildKeymap, cloneDefaultKeys } from "./keymap.ts";
import { TranscriptScreen } from "./screen.ts";
import type { Notify, RenderConfig, ThemeLike, TuiLike, UIConfig } from "./types.ts";

const DEFAULT_UI: UIConfig = {
	userMessageBackground: true,
	stickyHeader: false,
	userMarker: "❯",
	assistantMarker: "●",
};

function loadPiRenderSettings(
	ctx: ExtensionContext,
): Pick<RenderConfig, "outputPad" | "codeBlockIndent"> {
	try {
		const settings = SettingsManager.create(ctx.cwd, undefined, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		return {
			outputPad: settings.getOutputPad(),
			codeBlockIndent: settings.getCodeBlockIndent(),
		};
	} catch {
		return { outputPad: 1, codeBlockIndent: "  " };
	}
}

async function openTranscript(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		ctx.ui.notify("Transcript is only available in TUI mode", "warning");
		return;
	}

	const entries = ctx.sessionManager.getBranch();
	const keys = cloneDefaultKeys();
	if (config.transcriptOpenKey) keys.open = [config.transcriptOpenKey];
	const keymap = buildKeymap(keys);
	const renderConfig: RenderConfig = {
		...loadPiRenderSettings(ctx),
		ui: { ...DEFAULT_UI },
	};
	const { cwd, ui } = ctx;
	const notify: Notify = (message, type) => ui.notify(message, type);

	await ctx.ui.custom(
		(tui, theme, _keybindings, done) =>
			new TranscriptScreen(
				tui as TuiLike,
				theme as ThemeLike,
				cwd,
				renderConfig,
				keymap,
				notify,
				entries,
				() => done(undefined),
			),
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "center",
				margin: 0,
				offsetX: 0,
				offsetY: 0,
			},
		},
	);
}

export default function transcriptExtension(pi: ExtensionAPI): void {
	pi.registerCommand("transcript", {
		description: "Open the full session transcript",
		handler: async (_args, ctx) => {
			await openTranscript(ctx);
		},
	});

	if (config.transcriptOpenKey) {
		pi.registerShortcut(config.transcriptOpenKey as KeyId, {
			description: "Open transcript",
			handler: async (ctx) => {
				await openTranscript(ctx);
			},
		});
	}
}

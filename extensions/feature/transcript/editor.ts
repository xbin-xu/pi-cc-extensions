import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Notify, TuiLike } from "./types.ts";

type EditorTui = Pick<TuiLike, "start" | "stop" | "requestRender">;

export async function openMarkdownInEditor(options: {
	markdown: string;
	cwd: string;
	notify: Notify;
	tui: EditorTui;
}): Promise<void> {
	const { markdown, cwd, notify, tui } = options;
	const editor = process.env.VISUAL || process.env.EDITOR || "nvim";
	let directory: string | undefined;

	try {
		directory = await mkdtemp(path.join(tmpdir(), "pi-transcript-"));
		const filePath = path.join(directory, "transcript.md");
		await writeFile(filePath, `${markdown}\n`, "utf8");

		tui.stop();
		try {
			process.stdout.write("\x1b[2J\x1b[H");
			const result = spawnSync(editor, ["-R", filePath], {
				stdio: "inherit",
				cwd,
				env: process.env,
			});

			if (result.error) {
				const message = result.error instanceof Error ? result.error.message : String(result.error);
				notify(`${editor} failed: ${message}`, "error");
			} else if (result.status !== 0) {
				notify(`${editor} exited with code ${result.status ?? "unknown"}`, "warning");
			}
		} finally {
			tui.start();
			tui.requestRender(true);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(`Failed to open transcript in editor: ${message}`, "error");
	} finally {
		if (directory) {
			try {
				await rm(directory, { recursive: true, force: true });
			} catch {
				// Best-effort cleanup.
			}
		}
	}
}

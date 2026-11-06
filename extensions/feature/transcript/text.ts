import { stripTerminalSequences } from "@earendil-works/pi-tui";

const MAX_TEXT_CHARS = 24_000;
const TRUNCATION_MARKER = "\n... [truncated]";

export function sanitize(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function clampText(text: string): string {
	if (text.length <= MAX_TEXT_CHARS) return sanitize(text);

	// Sanitize a bounded prefix first. The extra margin keeps a cut escape
	// sequence out of the rendered slice while avoiding full-length scans on
	// multi-megabyte tool output.
	const clean = sanitize(text.slice(0, MAX_TEXT_CHARS + 512));
	return clean.length > MAX_TEXT_CHARS
		? `${clean.slice(0, MAX_TEXT_CHARS)}${TRUNCATION_MARKER}`
		: clean;
}

export function oneLine(text: string, max = 160): string {
	const bounded = text.length > 256_000 ? text.slice(0, 256_000) : text;
	const clean = sanitize(bounded).replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, Math.max(0, max - 3))}...` : clean;
}

export function tryStringify(value: unknown, pretty: boolean): string {
	try {
		const text = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
		return text ?? String(value);
	} catch {
		return String(value);
	}
}

export function clampNumber(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

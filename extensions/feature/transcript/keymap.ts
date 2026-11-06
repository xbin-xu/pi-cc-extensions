import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

import type { Keymap, KeyName, Motion, MotionAmount, MotionName } from "./types.ts";

export const DEFAULT_KEYS: Record<KeyName, string[]> = {
	open: ["ctrl+o"],
	quit: ["q"],
	help: ["?"],
	showAll: ["ctrl+t"],
	editor: ["v"],
	lineDown: ["j", "down", "ctrl+e"],
	lineUp: ["k", "up", "ctrl+y"],
	halfPageDown: ["ctrl+d"],
	halfPageUp: ["ctrl+u"],
	pageDown: ["ctrl+f", "space"],
	pageUp: ["ctrl+b", "b"],
	top: ["g", "home"],
	bottom: ["G", "end"],
	search: ["/"],
	nextMatch: ["n"],
	previousMatch: ["N"],
	previousPrompt: ["{"],
	nextPrompt: ["}"],
};

const MOTION_SPECS: readonly {
	name: MotionName;
	amount: MotionAmount;
	direction: 1 | -1;
}[] = [
	{ name: "lineDown", amount: "line", direction: 1 },
	{ name: "lineUp", amount: "line", direction: -1 },
	{ name: "halfPageDown", amount: "half", direction: 1 },
	{ name: "halfPageUp", amount: "half", direction: -1 },
	{ name: "pageDown", amount: "page", direction: 1 },
	{ name: "pageUp", amount: "page", direction: -1 },
];

export const KEY_NAMES = Object.keys(DEFAULT_KEYS) as KeyName[];

export function cloneDefaultKeys(): Record<KeyName, string[]> {
	return Object.fromEntries(KEY_NAMES.map((name) => [name, [...DEFAULT_KEYS[name]]])) as Record<
		KeyName,
		string[]
	>;
}

export function buildKeymap(keys: Record<KeyName, string[]>): Keymap {
	const motions: Motion[] = MOTION_SPECS.map((spec) => ({
		...spec,
		keys: keys[spec.name],
	}));
	return {
		actions: {
			quit: keys.quit,
			help: keys.help,
			search: keys.search,
			editor: keys.editor,
			previousPrompt: keys.previousPrompt,
			nextPrompt: keys.nextPrompt,
			showAll: keys.showAll,
			top: keys.top,
			bottom: keys.bottom,
			nextMatch: keys.nextMatch,
			previousMatch: keys.previousMatch,
		},
		motions,
		open: keys.open,
	};
}

/**
 * matchesKey lowercases key ids, so the uppercase literals must be compared
 * directly on terminals that do not report shift as a modifier.
 */
export function matchesBinding(data: string, key: string): boolean {
	if (/^[A-Z]$/.test(key)) {
		return data === key || matchesKey(data, `shift+${key.toLowerCase()}` as KeyId);
	}
	return matchesKey(data, key as KeyId);
}

export function matchesAny(data: string, keys: readonly string[]): boolean {
	return keys.some((key) => matchesBinding(data, key));
}

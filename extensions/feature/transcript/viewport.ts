import { clampNumber } from "./text.ts";
import type { Layout } from "./types.ts";

export class Viewport {
	private lines: string[] = [];
	private userStarts: number[] = [];
	private rowCount = 1;
	private maxOffset = 0;
	private offset = 0;
	private stickToBottom = true;

	get rows(): number {
		return this.rowCount;
	}

	get scrollOffset(): number {
		return this.offset;
	}

	get maxScroll(): number {
		return this.maxOffset;
	}

	get atBottom(): boolean {
		return this.offset >= this.maxOffset;
	}

	setLayout(layout: Layout, rows: number): void {
		this.lines = layout.lines;
		this.userStarts = layout.userStarts;
		this.setRows(rows);
	}

	setRows(rows: number): void {
		this.rowCount = Math.max(1, rows);
		this.maxOffset = Math.max(0, this.lines.length - this.rowCount);

		if (this.stickToBottom) {
			this.offset = this.maxOffset;
			this.stickToBottom = false;
			return;
		}
		this.offset = clampNumber(this.offset, 0, this.maxOffset);
	}

	scrollBy(delta: number): void {
		this.offset = clampNumber(this.offset + delta, 0, this.maxOffset);
	}

	scrollTo(offset: number): void {
		this.offset = clampNumber(offset, 0, this.maxOffset);
	}

	scrollToLine(line: number, margin = 0): void {
		this.scrollTo(line - margin);
	}

	pinToBottom(): void {
		this.stickToBottom = true;
	}

	jumpPrompt(direction: 1 | -1): boolean {
		if (this.userStarts.length === 0) return false;

		const current = this.offset;
		const targetFor = (start: number): number =>
			clampNumber(start - (start > 0 ? 1 : 0), 0, this.maxOffset);

		if (direction === 1) {
			for (const start of this.userStarts) {
				if (start <= current) continue;
				const target = targetFor(start);
				if (target > current) {
					this.offset = target;
					return true;
				}
			}
			return false;
		}

		for (let i = this.userStarts.length - 1; i >= 0; i--) {
			const start = this.userStarts[i];
			if (start >= current) continue;
			const target = targetFor(start);
			if (target < current) {
				this.offset = target;
				return true;
			}
		}
		return false;
	}

	visibleLines(): string[] {
		return this.lines.slice(this.offset, this.offset + this.rowCount);
	}

	percent(): number {
		return this.maxOffset === 0 ? 100 : Math.round((this.offset / this.maxOffset) * 100);
	}
}

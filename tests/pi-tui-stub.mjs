// Minimal public-component surface for offline picker interaction tests.
// Input intentionally has no onChange callback, matching Pi's current API.
export class Container {
	children = [];
	addChild(child) { this.children.push(child); }
	clear() { this.children = []; }
	render(width) { return this.children.flatMap((child) => child.render(width)); }
	invalidate() {}
}
export class Text {
	constructor(text) { this.text = text; }
	render(width) { return [this.text.slice(0, width)]; }
}
export class Spacer {
	render() { return [""]; }
}
export class Input {
	value = "";
	focused = false;
	getValue() { return this.value; }
	handleInput(data) {
		if (data === "\x7f") this.value = this.value.slice(0, -1);
		else this.value += data;
	}
	render(width) { return [this.value.slice(0, width)]; }
}
export class SelectList {
	constructor(items) { this.items = items; this.index = 0; }
	setSelectedIndex(index) { this.index = index; }
	handleInput(data) {
		if (data === "\r") {
			if (this.items[this.index]) this.onSelect?.(this.items[this.index]);
		} else if (data === "\x1b") this.onCancel?.();
		else if (data === "\x1b[B") this.index = Math.min(this.index + 1, this.items.length - 1);
		else if (data === "\x1b[A") this.index = Math.max(0, this.index - 1);
	}
	render(width) { return this.items.map((item) => item.label.slice(0, width)); }
}
export function fuzzyFilter(items, query, text) {
	return items.filter((item) => text(item).toLowerCase().includes(query.toLowerCase()));
}
export function visibleWidth(text) { return Array.from(text).length; }
export function truncateToWidth(text, width, ellipsis = "…") {
	const points = Array.from(text);
	if (points.length <= width) return text;
	if (width <= 0) return "";
	const suffix = Array.from(ellipsis).slice(0, width).join("");
	return points.slice(0, Math.max(0, width - Array.from(suffix).length)).join("") + suffix;
}

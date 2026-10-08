import assert from "node:assert/strict";
import test from "node:test";
import { pickDelegateModel } from "../extensions/delegator-config/model-picker.ts";

const choices = [
	{ value: "@inherit-parent", label: "Inherit parent model" },
	{ value: "provider/other-model", label: "provider/other-model" },
	{ value: "provider/search-target", label: "provider/search-target" },
];
const keys = {
	"tui.select.up": "\x1b[A", "tui.select.down": "\x1b[B",
	"tui.select.confirm": "\r", "tui.select.cancel": "\x1b",
};

async function exercise(actions, current = "@inherit-parent") {
	let renders = 0;
	const ctx = {
		ui: {
			custom: async (factory) => {
				let done = false;
				let selected;
				const component = await factory(
					{ requestRender() { renders += 1; } },
					{ fg: (_color, text) => text, bold: (text) => text },
					{ matches: (data, key) => data === keys[key] },
					(value) => { done = true; selected = value; },
				);
				component.focused = true;
				assert.equal(component.focused, true);
				for (const action of actions) component.handleInput(action);
				assert.ok(component.render(10).every((line) => line.length <= 10));
				component.invalidate();
				assert.ok(done, "selection or cancellation must settle the picker");
				return selected;
			},
		},
	};
	const selected = await pickDelegateModel(ctx, "oracle", choices, current);
	assert.ok(renders > 0);
	return selected;
}

test("typing updates model filtering using Input.getValue, including non-prefix searches", async () => {
	assert.equal(await exercise([..."search", "\r"]), "provider/search-target");
});

test("current selection, arrow navigation, and inherit-parent selection work", async () => {
	assert.equal(await exercise(["\r"], "provider/other-model"), "provider/other-model");
	assert.equal(await exercise(["\x1b[B", "\r"]), "provider/other-model");
	assert.equal(await exercise(["\r"]), "@inherit-parent");
});

test("empty search results can still be cancelled", async () => {
	assert.equal(await exercise([..."no-match", "\x1b"]), undefined);
});

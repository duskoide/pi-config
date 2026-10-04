import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SelectItem } from "@earendil-works/pi-tui";

/** Search a cached model snapshot without refreshing providers or changing Pi's model. */
export async function pickDelegateModel(
	ctx: ExtensionCommandContext,
	profile: string,
	choices: SelectItem[],
	current: string,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>(async (tui, theme, keybindings, done) => {
		const { Container, fuzzyFilter, Input, SelectList, Spacer, Text, truncateToWidth } = await import("@earendil-works/pi-tui");
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold(`Model for ${profile}`)), 1, 0));
		container.addChild(new Spacer(1));
		const input = new Input();
		container.addChild(input);
		container.addChild(new Spacer(1));
		const listContainer = new Container();
		let list: InstanceType<typeof SelectList>;
		const updateList = (query: string) => {
			const filtered = fuzzyFilter(choices, query, (choice) => `${choice.label} ${choice.description ?? ""}`);
			list = new SelectList(filtered, 10, {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: () => theme.fg("warning", "  No matching models"),
			});
			if (!query) list.setSelectedIndex(Math.max(0, filtered.findIndex((choice) => choice.value === current)));
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			listContainer.clear();
			listContainer.addChild(list);
		};
		updateList("");
		container.addChild(listContainer);
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "Type to search · ↑↓ navigate · Enter select · Esc cancel"), 1, 0));
		container.addChild(new Text(theme.fg("muted", "Cached available models. Provider extensions are not inherited by delegates."), 1, 0));
		return {
			get focused() { return input.focused; },
			set focused(value: boolean) { input.focused = value; },
			render(width: number) { return container.render(width).map((line) => truncateToWidth(line, width)); },
			invalidate() { container.invalidate(); },
			handleInput(data: string) {
				const actions = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
				if (actions.some((key) => keybindings.matches(data, key))) {
					list.handleInput(data);
				} else {
					const previous = input.getValue();
					input.handleInput(data);
					if (input.getValue() !== previous) updateList(input.getValue());
				}
				tui.requestRender();
			},
		};
	});
}

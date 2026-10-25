import assert from "node:assert/strict";
import test from "node:test";
import idleCompact from "../extensions/idle-compact.ts";

function setup({ settings = {}, tokens = 90000, idle = true, pending = false } = {}) {
	const handlers = new Map();
	const state = { tokens, idle, pending };
	const notifications = [];
	const compactions = [];
	const terminalInputHandlers = [];
	let unsubscribed = 0;
	const ctx = {
		hasUI: true,
		isIdle: () => state.idle,
		hasPendingMessages: () => state.pending,
		getContextUsage: () => ({ tokens: state.tokens, contextWindow: 200000, percent: 25 }),
		ui: {
			notify: (message, level) => notifications.push({ message, level }),
			onTerminalInput: (handler) => {
				terminalInputHandlers.push(handler);
				return () => {
					unsubscribed += 1;
				};
			},
		},
		compact: (options = {}) => {
			compactions.push(options);
		},
	};
	idleCompact({
		on(name, handler) {
			handlers.set(name, handler);
		},
		getSettings: () => settings,
	});
	ctx.compactions = compactions;
	ctx.notifications = notifications;
	ctx.terminalInputHandlers = terminalInputHandlers;
	ctx.unsubscribed = () => unsubscribed;
	ctx.state = state;
	return {
		state,
		ctx,
		compactions,
		notifications,
		terminalInputHandlers,
		fire(name, event = {}) {
			const handler = handlers.get(name);
			assert.ok(handler, `missing handler: ${name}`);
			return handler(event, ctx);
		},
		has(name) {
			return handlers.has(name);
		},
	};
}

const minutes = (n) => n * 60_000;
const DEFAULT_IDLE = { idleCompact: undefined };

test("compacts after the configured idle window", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup({ settings: { idleCompact: { minutes: 10 } } });
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(9));
	assert.equal(s.compactions.length, 0);
	t.mock.timers.tick(minutes(1));
	assert.equal(s.compactions.length, 1);
	assert.deepEqual(
		s.notifications.map((n) => n.level),
		["info"],
	);
});

test("defaults to a 10 minute window", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup(DEFAULT_IDLE);
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(10));
	assert.equal(s.compactions.length, 1);
});

test("does nothing when disabled", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup({ settings: { idleCompact: { enabled: false } } });
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(60));
	assert.equal(s.compactions.length, 0);
});

test("skips sessions below minTokens", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup({ settings: { idleCompact: { minTokens: 60000 } }, tokens: 5000 });
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(60));
	assert.equal(s.compactions.length, 0);
});

test("skips when context usage is unknown", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup({ tokens: null });
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(60));
	assert.equal(s.compactions.length, 0);
});

test("user input cancels the pending idle window", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(5));
	s.fire("input", { text: "next question" });
	t.mock.timers.tick(minutes(30));
	assert.equal(s.compactions.length, 0);

	s.fire("agent_settled");
	t.mock.timers.tick(minutes(10));
	assert.equal(s.compactions.length, 1);
});

test("agent start cancels the pending idle window", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(5));
	s.fire("agent_start");
	t.mock.timers.tick(minutes(30));
	assert.equal(s.compactions.length, 0);
});

test("typing in the terminal counts as activity", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("session_start");
	assert.equal(s.terminalInputHandlers.length, 1);
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(5));
	assert.equal(s.terminalInputHandlers[0]("hello"), undefined);
	t.mock.timers.tick(minutes(30));
	assert.equal(s.compactions.length, 0);
});

test("a new settle restarts the window instead of stacking timers", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(5));
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(9));
	assert.equal(s.compactions.length, 0);
	t.mock.timers.tick(minutes(1));
	assert.equal(s.compactions.length, 1);
	t.mock.timers.tick(minutes(60));
	assert.equal(s.compactions.length, 1, "no re-arm after the idle compaction");
});

test("re-checks idle state at fire time", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("agent_settled");
	s.state.idle = false;
	t.mock.timers.tick(minutes(10));
	assert.equal(s.compactions.length, 0);
});

test("re-checks pending messages at fire time", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("agent_settled");
	s.state.pending = true;
	t.mock.timers.tick(minutes(10));
	assert.equal(s.compactions.length, 0);
});

test("session shutdown clears the timer", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("agent_settled");
	s.fire("session_shutdown");
	t.mock.timers.tick(minutes(60));
	assert.equal(s.compactions.length, 0);
});

test("headless sessions never arm", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.ctx.hasUI = false;
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(60));
	assert.equal(s.compactions.length, 0);
	assert.equal(s.terminalInputHandlers.length, 0);
});

test("quiet no-op compaction errors are not reported", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("agent_settled");
	t.mock.timers.tick(minutes(10));
	assert.equal(s.compactions.length, 1);
	s.compactions[0].onError(new Error("Nothing to compact (session too small)"));
	assert.equal(s.notifications.length, 1, "only the idle notice");

	s.fire("agent_settled");
	t.mock.timers.tick(minutes(10));
	s.compactions[1].onError(new Error("model exploded"));
	assert.equal(s.notifications.at(-1).level, "error");
	assert.match(s.notifications.at(-1).message, /model exploded/);
});

test("registers the lifecycle hooks", () => {
	const s = setup();
	for (const name of ["agent_settled", "agent_start", "input", "session_start", "session_shutdown"]) {
		assert.ok(s.has(name), `missing hook: ${name}`);
	}
});

test("terminal input handler is released on shutdown and on re-registration", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = setup();
	s.fire("session_start");
	s.fire("session_start");
	assert.equal(s.ctx.unsubscribed(), 1, "second registration releases the first handler");
	s.fire("session_shutdown");
	assert.equal(s.ctx.unsubscribed(), 2);
	assert.equal(s.terminalInputHandlers.length, 2);
});

test("independent runtimes keep independent timers", (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const first = setup();
	const second = setup({ idle: false });
	first.fire("agent_settled");
	// Another runtime in the same process settles: must not cancel the first timer.
	second.fire("agent_settled");
	second.fire("session_shutdown");
	t.mock.timers.tick(minutes(10));
	assert.equal(first.compactions.length, 1);
	assert.equal(second.compactions.length, 0);
});

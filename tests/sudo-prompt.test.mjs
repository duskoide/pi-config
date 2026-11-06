import assert from "node:assert/strict";
import test from "node:test";
import { applyPasswordInput as f } from "../extensions/sudo-prompt.ts";

test("typing, backspace, clear", () => {
	assert.equal(f("ab", "c").buf, "abc");
	assert.equal(f("abc", "\x7f").buf, "ab");
	assert.equal(f("", "\x7f").buf, "");
	assert.equal(f("abc", "\x15").buf, "");
});
test("submit / cancel", () => {
	assert.equal(f("a", "\r").action, "submit");
	assert.equal(f("a", "\x1b").action, "cancel");
	assert.equal(f("a", "\x03").action, "cancel");
});
test("paste incl. bracketed paste and trailing newline", () => {
	assert.deepEqual(f("", "\x1b[200~p@ss w0rd\x1b[201~"), { buf: "p@ss w0rd", action: "none" });
	assert.deepEqual(f("", "secret\r"), { buf: "secret", action: "submit" });
	assert.equal(f("", "pässwörd🔑").buf, "pässwörd🔑");
});
test("arrow keys ignored", () => {
	assert.deepEqual(f("ab", "\x1b[A"), { buf: "ab", action: "none" });
});

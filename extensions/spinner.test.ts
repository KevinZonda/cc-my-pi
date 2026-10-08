import assert from "node:assert/strict";
import test from "node:test";
import spinnerExtension, { hexToAnsiFg, formatDuration, formatTokenCount, outputTokens, renderWorkingLines } from "./spinner.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

test("hexToAnsiFg parses a valid lowercase hex color", () => {
	assert.equal(hexToAnsiFg("#d77757"), "\x1b[38;2;215;119;87m");
});

test("hexToAnsiFg parses uppercase hex digits", () => {
	assert.equal(hexToAnsiFg("#D77757"), "\x1b[38;2;215;119;87m");
});

test("hexToAnsiFg returns null for a theme-key string", () => {
	assert.equal(hexToAnsiFg("borderAccent"), null);
});

test("hexToAnsiFg returns null for a malformed hex string", () => {
	assert.equal(hexToAnsiFg("#fff"), null);
	assert.equal(hexToAnsiFg("d77757"), null);
});


const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

function harness() {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const widgets = new Map<string, any>();
	const visibility: boolean[] = [];
	let renderCount = 0;
	const tui = { stopped: false, requestRender() { renderCount++; } };
	const ctx = {
		hasUI: true,
		ui: {
			setWorkingVisible(value: boolean) { visibility.push(value); },
			setWorkingMessage() {},
			setWidget(key: string, content: any) {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, typeof content === "function" ? content(tui) : content);
			},
		},
	};
	spinnerExtension({ on: (name: string, handler: any) => handlers.set(name, handler) } as unknown as ExtensionAPI);
	return {
		widgets, visibility,
		get renderCount() { return renderCount; },
		emit: async (name: string, event = {}) => handlers.get(name)?.(event, ctx),
		lines: (width = 100) => {
			const widget = widgets.get("cc-my-pi-spinner");
			return (Array.isArray(widget) ? widget : widget?.render(width) ?? []).map(plain);
		},
	};
}

test("formats the reference layout and wraps within narrow terminal widths", () => {
	assert.deepEqual(renderWorkingLines(100, "✻", "Cultivating… (1m 31s · ↑ 4.6k tokens)", "Press Shift+Enter to insert a new line").map(plain), [
		" ✻ Cultivating… (1m 31s · ↑ 4.6k tokens)",
		"   └ Tip: Press Shift+Enter to insert a new line",
	]);
	for (const width of [1, 2, 3, 12, 25, 40]) {
		const lines = renderWorkingLines(width, "✻", "Cultivating… (1m 31s · ↑ 4.6k tokens)", "Press Shift+Enter to insert a new line");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	assert.deepEqual(renderWorkingLines(0, "✻", "Working…", "Tip"), []);
	assert.equal(formatDuration(91_000), "1m 31s");
	assert.equal(formatTokenCount(4_600), "4.6k");
});

test("rejects missing, zero, and invalid provider output usage", () => {
	for (const value of [undefined, 0, -1, NaN, Infinity, "100"]) {
		assert.equal(outputTokens({ usage: { output: value } }), undefined);
	}
	assert.equal(outputTokens({ usage: { output: 4_600 } }), 4_600);
});

test("counts thinking and tool deltas, then corrects estimates using final usage across turns", async () => {
	const h = harness();
	try {
		await h.emit("before_agent_start");
		await h.emit("turn_start");
		const tip = h.lines()[1];
		assert.match(tip, /└ Tip: Press .* to insert a new line/);
		assert.deepEqual(h.visibility, [false]);
		for (const [contentIndex, type] of ["text_delta", "thinking_delta", "toolcall_delta"].entries()) {
			await h.emit("message_update", { assistantMessageEvent: { type, contentIndex, delta: "x".repeat(40) } });
		}
		// The refresh loop picks up streamed estimates once per second.
		await h.emit("tool_execution_start", { toolCallId: "1", toolName: "bash" });
		assert.match(h.lines()[0], /↑ ~30 tokens/);
		assert.equal(h.lines()[1], tip);
		const message = { role: "assistant", content: [{ type: "text", text: "x".repeat(40) }], usage: { output: 4_600 } };
		await h.emit("message_update", { assistantMessageEvent: { type: "done", message } });
		await h.emit("message_end", { message });
		assert.match(h.lines()[0], /↑ 4\.6k tokens/);
		await h.emit("turn_end");
		assert.equal(h.lines().length, 1);
		assert.match(h.lines()[0], /Worked for .*↑ 4\.6k tokens/);
		await h.emit("turn_start");
		assert.match(h.lines()[0], /↑ 4\.6k tokens/);
		await h.emit("message_end", { message: { ...message, usage: { output: 100 } } });
		assert.match(h.lines()[0], /↑ 4\.7k tokens/);
		await h.emit("turn_end");
		await h.emit("agent_end");
		await h.emit("before_agent_start");
		await h.emit("turn_start");
		assert.match(h.lines()[0], /↑ 0 tokens/);
	} finally {
		await h.emit("session_shutdown");
	}
});

test("cancel and reload remove the working widget and restore the native loader", async () => {
	const old = harness();
	await old.emit("turn_start");
	assert.equal(old.widgets.size, 1);
	const replacement = harness();
	try {
		assert.equal(old.widgets.size, 0);
		assert.equal(old.visibility.at(-1), true);
		await replacement.emit("turn_start");
		await replacement.emit("agent_end");
		assert.equal(replacement.widgets.size, 0);
		assert.equal(replacement.visibility.at(-1), true);
	} finally {
		await replacement.emit("session_shutdown");
	}
});

test("completion summary expires and cancelled animation stops requesting renders", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 10_000 });
	const h = harness();
	try {
		await h.emit("turn_start");
		await h.emit("message_end", { message: { role: "assistant", content: [], usage: { output: 100 } } });
		await h.emit("turn_end");
		await h.emit("agent_end");
		assert.match(h.lines()[0], /↑ 100 tokens/);
		t.mock.timers.tick(2_500);
		assert.equal(h.widgets.size, 0);
		assert.equal(h.visibility.at(-1), true);
		await h.emit("turn_start");
		await h.emit("session_shutdown");
		const renderCount = h.renderCount;
		t.mock.timers.tick(10_000);
		assert.equal(h.renderCount, renderCount);
		assert.equal(h.widgets.size, 0);
	} finally {
		await h.emit("session_shutdown");
	}
});

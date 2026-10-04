import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.ts";

/** Short helper: expect a parse failure whose error contains the given piece. */
function expectFail(raw: string, errorIncludes: string) {
	const r = parseConfig(raw);
	expect(r.ok).toBe(false);
	if (!r.ok) expect(r.error).toContain(errorIncludes);
}

function expectOk(raw: string) {
	const r = parseConfig(raw);
	expect(r.ok).toBe(true);
	return r.ok ? r : (undefined as never);
}

describe("parseConfig valid input", () => {
	it("empty / whitespace only → default 60s once", () => {
		for (const raw of ["", "   "]) {
			const r = expectOk(raw);
			expect(r.timeoutSeconds).toBe(60);
			expect(r.maxNudges).toBeUndefined();
			expect(r.message).toBeUndefined();
			expect(r.keepAlive).toBe(false);
		}
	});

	it("each key works on its own", () => {
		expect(expectOk("timeout=5").timeoutSeconds).toBe(5);
		expect(expectOk("max=3").maxNudges).toBe(3);
		expect(expectOk("mode=keep").keepAlive).toBe(true);
		expect(expectOk("mode=once").keepAlive).toBe(false);
		expect(expectOk("message=hi").message).toBe("hi");
	});

	it("combo args", () => {
		const r = expectOk("timeout=10 max=2 mode=keep message=go on");
		expect(r).toMatchObject({ timeoutSeconds: 10, maxNudges: 2, keepAlive: true, message: "go on" });
	});

	it("timeout/max=0 and a leading 0: 0 is clamped to the min of 1", () => {
		expect(expectOk("timeout=0").timeoutSeconds).toBe(1);
		expect(expectOk("max=0").maxNudges).toBe(1);
		expect(expectOk("timeout=007").timeoutSeconds).toBe(7);
	});

	it("message= empty value → message is undefined", () => {
		expect(expectOk("message=").message).toBeUndefined();
	});

	it("bad tokens after message= are swallowed into the text, not an error", () => {
		expect(expectOk("message=a timeout=bad foo").message).toBe("a timeout=bad foo");
	});

	it("repeated key: the last value wins", () => {
		expect(expectOk("timeout=5 timeout=9").timeoutSeconds).toBe(9);
	});

	it("repeated message=: last wins and the rest joins the text", () => {
		expect(expectOk("message=a message=b c").message).toBe("a message=b c");
	});
});

describe("parseConfig bad input", () => {
	it("bare token (no =) → asks for key=value form", () => {
		expectFail("30go", "key=value");
		expectFail("continue", "key=value");
	});

	it("key starting with = (=value) → bad", () => {
		expectFail("=5", "key=value");
	});

	it("unknown key → lists the supported keys", () => {
		expectFail("foo=bar", "timeout/max/message/mode");
		expectFail("Timeout=5", "timeout/max/message/mode"); // case sensitive
	});

	it("bad timeout value: negative / decimal / non-number / unit", () => {
		expectFail("timeout=-1", "timeout");
		expectFail("timeout=1.5", "timeout");
		expectFail("timeout=abc", "timeout");
		expectFail("timeout=30s", "timeout");
		expectFail("timeout=+5", "timeout");
	});

	it("bad max value, same as above", () => {
		expectFail("max=-1", "max");
		expectFail("max=1.5", "max");
		expectFail("max=abc", "max");
	});

	it("bad mode value: empty / wrong case / unknown word", () => {
		expectFail("mode=", "mode");
		expectFail("mode=KEEP", "mode");
		expectFail("mode=always", "mode");
	});

	it("error names the exact bad token", () => {
		const r = parseConfig("timeout=30 badkey=1 max=2");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("badkey");
	});

	it("a bad token after a good one is still caught", () => {
		expectFail("timeout=30 max=xx", "max");
	});
});

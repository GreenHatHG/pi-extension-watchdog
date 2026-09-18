import { describe, expect, it } from "vitest";
import { parseConfig } from "../index.ts";

/** 便捷断言：期望解析失败且 error 含指定片段 */
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

describe("parseConfig 合法输入", () => {
	it("空串 / 纯空白 → 默认 60s once", () => {
		for (const raw of ["", "   "]) {
			const r = expectOk(raw);
			expect(r.timeoutSeconds).toBe(60);
			expect(r.maxNudges).toBeUndefined();
			expect(r.message).toBeUndefined();
			expect(r.keepAlive).toBe(false);
		}
	});

	it("各 key 单独生效", () => {
		expect(expectOk("timeout=5").timeoutSeconds).toBe(5);
		expect(expectOk("max=3").maxNudges).toBe(3);
		expect(expectOk("mode=keep").keepAlive).toBe(true);
		expect(expectOk("mode=once").keepAlive).toBe(false);
		expect(expectOk("message=hi").message).toBe("hi");
	});

	it("组合参数", () => {
		const r = expectOk("timeout=10 max=2 mode=keep message=go on");
		expect(r).toMatchObject({ timeoutSeconds: 10, maxNudges: 2, keepAlive: true, message: "go on" });
	});

	it("timeout/max=0 与前导 0：0 被钳到最小值 1", () => {
		expect(expectOk("timeout=0").timeoutSeconds).toBe(1);
		expect(expectOk("max=0").maxNudges).toBe(1);
		expect(expectOk("timeout=007").timeoutSeconds).toBe(7);
	});

	it("message= 空值 → message 为 undefined", () => {
		expect(expectOk("message=").message).toBeUndefined();
	});

	it("message= 之后的非法 token 被吞进文案，不算错误", () => {
		expect(expectOk("message=a timeout=bad foo").message).toBe("a timeout=bad foo");
	});

	it("重复 key：后值覆盖前值", () => {
		expect(expectOk("timeout=5 timeout=9").timeoutSeconds).toBe(9);
	});

	it("message= 重复覆盖且后续全归文案", () => {
		expect(expectOk("message=一 message=二 三").message).toBe("一 message=二 三");
	});
});

describe("parseConfig 非法输入", () => {
	it("裸 token（无 =）→ 提示 key=value 形式", () => {
		expectFail("30继续吧", "key=value");
		expectFail("continue", "key=value");
	});

	it("key 以 = 开头（=value）→ 非法", () => {
		expectFail("=5", "key=value");
	});

	it("未知 key → 提示支持的 key 列表", () => {
		expectFail("foo=bar", "timeout/max/message/mode");
		expectFail("Timeout=5", "timeout/max/message/mode"); // 大小写敏感
	});

	it("timeout 非法值：负数 / 小数 / 非数字 / 单位", () => {
		expectFail("timeout=-1", "timeout");
		expectFail("timeout=1.5", "timeout");
		expectFail("timeout=abc", "timeout");
		expectFail("timeout=30s", "timeout");
		expectFail("timeout=+5", "timeout");
	});

	it("max 非法值同上", () => {
		expectFail("max=-1", "max");
		expectFail("max=1.5", "max");
		expectFail("max=abc", "max");
	});

	it("mode 非法值：空 / 大小写 / 未知词", () => {
		expectFail("mode=", "mode");
		expectFail("mode=KEEP", "mode");
		expectFail("mode=always", "mode");
	});

	it("error 指明出错的具体 token", () => {
		const r = parseConfig("timeout=30 badkey=1 max=2");
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain("badkey");
	});

	it("非法 token 出现在合法 token 之后也能被捕获", () => {
		expectFail("timeout=30 max=xx", "max");
	});
});

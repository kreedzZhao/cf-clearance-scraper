const { isClickableAtCenter } = require("../captcha-solvers/turnstile/endpoints/operations/query");

// isClickableAtCenter 决定按钮点击走真实 locator.click()（会等元素可交互，disabled 时等到 ~30s 超时）
// 还是退回页面内 element.click()（对 disabled 是安全的 no-op）。
// dao365 等站点在单号非法时把查询按钮置灰（disabled），必须判为不可点，才能让 captureStopConditions
// 在 ~1s 内读到前端的 parcelCodeInvalid 并返回 not found，而不是挂到全局超时。

function makePage(element, { elementFromPointReturns } = {}) {
  const fakeWindow = { innerWidth: 1000, innerHeight: 800 };
  const fakeDocument = {
    evaluate: () => ({ singleNodeValue: element }),
    querySelector: () => element,
    elementFromPoint: () => (elementFromPointReturns === undefined ? element : elementFromPointReturns),
  };
  return {
    evaluate: async (fn, arg) => {
      const saved = { document: global.document, window: global.window, XPathResult: global.XPathResult };
      global.document = fakeDocument;
      global.window = fakeWindow;
      global.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
      try {
        return fn(arg);
      } finally {
        Object.assign(global, saved);
      }
    },
  };
}

function makeButton(overrides = {}) {
  return {
    disabled: false,
    scrollIntoView() {},
    getBoundingClientRect: () => ({ x: 100, y: 100, width: 100, height: 40 }),
    getAttribute: () => null,
    contains: () => false,
    ...overrides,
  };
}

describe("isClickableAtCenter 对 disabled 按钮的判定", () => {
  test("启用且未被遮挡的按钮 → 可点击", async () => {
    const btn = makeButton();
    const page = makePage(btn);
    expect(await isClickableAtCenter(page, "//button[@id='b']")).toBe(true);
  });

  test("disabled 按钮 → 不可点击（退回页面内 no-op 点击）", async () => {
    const btn = makeButton({ disabled: true });
    const page = makePage(btn);
    expect(await isClickableAtCenter(page, "//button[@id='b']")).toBe(false);
  });

  test("aria-disabled='true' 的按钮 → 不可点击", async () => {
    const btn = makeButton({ getAttribute: (name) => (name === "aria-disabled" ? "true" : null) });
    const page = makePage(btn);
    expect(await isClickableAtCenter(page, "//button[@id='b']")).toBe(false);
  });

  test("被其它元素遮挡的启用按钮 → 不可点击", async () => {
    const btn = makeButton();
    const page = makePage(btn, { elementFromPointReturns: { contains: () => false } });
    expect(await isClickableAtCenter(page, "//button[@id='b']")).toBe(false);
  });
});

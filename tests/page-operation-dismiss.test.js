const {
  dismissOptionalOverlays,
  executePageOperation,
  PageOperationType,
} = require("../captcha-solvers/turnstile/endpoints/operations/query");
const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");

/**
 * 伪造一个 page：evaluate 收到 selectorExists 的探测请求时按 present 集合作答，
 * 收到点击请求时记录被点掉的选择器。
 */
function createFakePage({ present = [], appearAfter = {} } = {}) {
  const visible = new Set(present);
  const clicked = [];
  const probes = [];
  const probeCounts = new Map();

  const page = {
    clicked,
    probes,
    show: (selector) => visible.add(selector),
    evaluate: jest.fn(async (fn, arg) => {
      const selector = arg.rawSelector;
      const source = String(fn);

      // clickSelectorInPage 的实现里含有 scrollIntoView
      if (source.includes("scrollIntoView")) {
        if (!visible.has(selector)) return false;
        clicked.push(selector);
        visible.delete(selector);
        return true;
      }

      probes.push(selector);
      const count = (probeCounts.get(selector) || 0) + 1;
      probeCounts.set(selector, count);
      if (appearAfter[selector] !== undefined && count >= appearAfter[selector]) {
        visible.add(selector);
      }
      return visible.has(selector);
    }),
  };

  return page;
}

describe("dismissOptionalOverlays", () => {
  test("未配置 dismissXpathArr 时是空操作", async () => {
    const page = createFakePage();

    await expect(dismissOptionalOverlays(page, {})).resolves.toEqual({
      attempted: 0,
      dismissed: 0,
    });
    await expect(dismissOptionalOverlays(page, undefined)).resolves.toEqual({
      attempted: 0,
      dismissed: 0,
    });
    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test("按顺序点掉出现的遮罩", async () => {
    const cookieBtn = "#cookieScreen .cm-btn-accept-all";
    const introBtn = "//button[normalize-space()='Razumem']";
    const page = createFakePage({ present: [cookieBtn, introBtn] });

    const result = await dismissOptionalOverlays(page, {
      dismissXpathArr: [cookieBtn, introBtn],
      dismissSettleMs: 0,
    });

    expect(result).toEqual({ attempted: 2, dismissed: 2 });
    expect(page.clicked).toEqual([cookieBtn, introBtn]);
  });

  test("遮罩没出现时跳过，不抛错", async () => {
    const page = createFakePage({ present: [] });

    const result = await dismissOptionalOverlays(page, {
      dismissXpathArr: [".never-shows"],
      dismissTimeoutMs: 300,
      dismissPollIntervalMs: 100,
      dismissSettleMs: 0,
    });

    expect(result).toEqual({ attempted: 1, dismissed: 0 });
    expect(page.clicked).toEqual([]);
  });

  test("轮询等待延迟出现的遮罩", async () => {
    const late = ".late-modal";
    const page = createFakePage({ appearAfter: { [late]: 3 } });

    const result = await dismissOptionalOverlays(page, {
      dismissXpathArr: [late],
      dismissTimeoutMs: 3000,
      dismissPollIntervalMs: 20,
      dismissSettleMs: 0,
    });

    expect(result).toEqual({ attempted: 1, dismissed: 1 });
    expect(page.clicked).toEqual([late]);
  });

  test("selectorExists 抛错时视为不存在并继续", async () => {
    const page = {
      clicked: [],
      evaluate: jest.fn(async () => {
        throw new Error("execution context destroyed");
      }),
    };

    const result = await dismissOptionalOverlays(page, {
      dismissXpathArr: [".boom"],
      dismissTimeoutMs: 200,
      dismissPollIntervalMs: 100,
      dismissSettleMs: 0,
    });

    expect(result).toEqual({ attempted: 1, dismissed: 0 });
  });
});

describe("executePageOperation 与遮罩清理的衔接", () => {
  test("没有 operationType 时不做任何事", async () => {
    const page = createFakePage({ present: [".modal"] });

    await executePageOperation(page, null, { dismissXpathArr: [".modal"] });

    expect(page.evaluate).not.toHaveBeenCalled();
  });

  test("在派发具体操作之前先清理遮罩", async () => {
    const modal = ".modal-close";
    const page = createFakePage({ present: [modal] });
    // 让后续的具体操作立刻失败，以此确认遮罩清理发生在它之前
    page.locator = jest.fn(() => {
      throw new Error("stop here");
    });

    await expect(
      executePageOperation(page, PageOperationType.INPUT_AND_CLICK, {
        trackingNumber: "CS000638190SI",
        inputXpath: "//input[@id='parcelSearchInput']",
        buttonXpathArr: ["//input[@id='parcelSearchInput']/../button"],
        dismissXpathArr: [modal],
        dismissSettleMs: 0,
      })
    ).rejects.toThrow("stop here");

    expect(page.clicked).toEqual([modal]);
  });
});

describe("dismiss 参数校验", () => {
  test("接受 posta.si 的完整配置", () => {
    expect(reqValidate({
      mode: "source",
      action: "recaptcha",
      url: "https://moja.posta.si/tracking",
      operationType: "INPUT_AND_CLICK",
      operationConfig: {
        trackingNumber: "CS000638190SI",
        inputXpath: "//input[@id='parcelSearchInput']",
        buttonXpathArr: ["//input[@id='parcelSearchInput']/../button"],
        dismissXpathArr: [
          "#cookieScreen .cm-btn-accept-all",
          "//button[normalize-space()='Razumem']",
        ],
        dismissTimeoutMs: 5000,
      },
      targetUrl: "https://moja.posta.si/api/v1/parcels/track/",
      targetNotFoundStatus: [404],
    })).toBe(true);
  });

  test("老的 operationConfig 不受影响", () => {
    expect(reqValidate({
      mode: "source",
      action: "cloudflare",
      url: "https://example.com/tracking",
      operationType: "INPUT_AND_CLICK",
      operationConfig: {
        trackingNumber: "123456",
        inputXpath: "//input[@id='q']",
        buttonXpathArr: ["//button"],
      },
      targetContent: ["Delivered"],
    })).toBe(true);
  });

  test("拒绝空的 dismissXpathArr", () => {
    expect(reqValidate({
      mode: "source",
      url: "https://example.com",
      operationType: "INPUT_AND_CLICK",
      operationConfig: {
        trackingNumber: "1",
        inputXpath: "//i",
        buttonXpathArr: ["//b"],
        dismissXpathArr: [],
      },
    })).not.toBe(true);
  });
});

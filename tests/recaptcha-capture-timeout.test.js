jest.mock("../captcha-solvers/turnstile/endpoints/operations/query.js", () => {
  class PageOperationEarlyTermination extends Error {}
  return {
    executePageOperation: jest.fn().mockResolvedValue(undefined),
    PageOperationEarlyTermination,
  };
});

const getRecaptchaSource = require("../captcha-solvers/turnstile/endpoints/source/recaptcha");
const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");

const PAGE_URL = "https://moja.posta.si/track";
const TARGET_URL = "https://moja.posta.si/api/v1/parcels/track/";
const OPERATION = {
  operationType: "INPUT_AND_CLICK",
  operationConfig: {
    trackingNumber: "CH860689567SI",
    inputXpath: "//input[@id='tn']",
    buttonXpathArr: ["//button[@id='search']"],
  },
};

function createFakeResponse({ url, status = 200, json, text = "" }) {
  return {
    url: () => url,
    status: () => status,
    json: jest.fn(async () => {
      if (json === undefined) throw new Error("not json");
      return json;
    }),
    text: jest.fn(async () => text),
  };
}

function createFakePage() {
  const handlers = new Map();
  return {
    on: jest.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    }),
    off: jest.fn(),
    setRequestInterception: jest.fn().mockResolvedValue(undefined),
    setUserAgent: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(undefined),
    evaluate: jest.fn(async () => ({ targetUpdated: 0, formTargetUpdated: 0 })),
    goto: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    async emit(event, ...args) {
      for (const handler of handlers.get(event) || []) {
        await handler(...args);
      }
    },
  };
}

function installFakeContextPool(page) {
  const context = { newPage: jest.fn().mockResolvedValue(page) };
  global.contextPool = {
    getContext: jest.fn().mockResolvedValue(context),
    releaseContext: jest.fn().mockResolvedValue(undefined),
  };
}

async function flush(times = 6) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("recaptcha source captureTimeoutMs", () => {
  afterEach(() => {
    delete global.contextPool;
    delete global.timeOut;
    jest.clearAllMocks();
  });

  test("页面操作完成后迟迟没有目标响应时按 captureTimeoutMs 返回 Capture Timeout 并丢弃上下文", async () => {
    const page = createFakePage();
    installFakeContextPool(page);

    const promise = getRecaptchaSource({
      url: PAGE_URL,
      targetUrl: TARGET_URL,
      captureTimeoutMs: 1000,
      ...OPERATION,
    });

    await expect(promise).resolves.toBe("Capture Timeout");
    expect(global.contextPool.releaseContext).toHaveBeenCalledWith(
      expect.anything(),
      { forceClose: true, reason: "recaptcha page operation timeout" }
    );
  });

  test("超时前拿到目标响应则正常返回数据，且不再触发超时", async () => {
    const page = createFakePage();
    installFakeContextPool(page);

    const promise = getRecaptchaSource({
      url: PAGE_URL,
      targetUrl: TARGET_URL,
      captureTimeoutMs: 1000,
      ...OPERATION,
    });
    await flush();
    await page.emit("response", createFakeResponse({ url: TARGET_URL, json: { ok: true } }));

    await expect(promise).resolves.toEqual({ ok: true });
    await sleep(1200);
    expect(global.contextPool.releaseContext).toHaveBeenCalledTimes(1);
  });

  test("未配置 captureTimeoutMs 时行为不变：不会提前返回 Capture Timeout", async () => {
    const page = createFakePage();
    installFakeContextPool(page);
    global.timeOut = 60000;

    const promise = getRecaptchaSource({
      url: PAGE_URL,
      targetUrl: TARGET_URL,
      ...OPERATION,
    });
    await flush();

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await sleep(1200);
    expect(settled).toBe(false);

    await page.emit("response", createFakeResponse({ url: TARGET_URL, json: { ok: true } }));
    await expect(promise).resolves.toEqual({ ok: true });
  });

  test("参数校验接受 captureTimeoutMs，拒绝小于 1000 的值", () => {
    const base = { mode: "source", action: "recaptcha", url: PAGE_URL, targetUrl: TARGET_URL };
    expect(reqValidate({ ...base, captureTimeoutMs: 25000 })).toBe(true);
    expect(reqValidate({ ...base, captureTimeoutMs: 10 })).not.toBe(true);
  });
});

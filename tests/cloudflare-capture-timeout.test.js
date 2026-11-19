jest.mock("../captcha-solvers/turnstile/endpoints/operations/query.js", () => {
  class PageOperationEarlyTermination extends Error {}
  return {
    executePageOperation: jest.fn().mockResolvedValue(undefined),
    PageOperationEarlyTermination,
    matchStopCondition: jest.fn().mockResolvedValue(null),
  };
});
const { matchStopCondition } = require("../captcha-solvers/turnstile/endpoints/operations/query.js");

const getCfSource = require("../captcha-solvers/turnstile/endpoints/source/cloudflare");
const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");

const PAGE_URL = "https://rastreamento.correios.com.br/app/index.php";
const API_URL = "https://rastreamento.correios.com.br/app/resultado.php";
const OPERATION = {
  operationType: "INPUT_AND_CLICK",
  operationConfig: {
    trackingNumber: "INVALID_TN_1793182189472",
    inputXpath: "//input[@id='objeto']",
    buttonXpathArr: ["//button[@id='b-pesquisar']"],
  },
};

function createFakeResponse({ url, status = 200, body = "" }) {
  return {
    url: () => url,
    status: () => status,
    text: jest.fn().mockResolvedValue(body),
    request: () => ({ method: () => "POST" }),
  };
}

function createFakePage() {
  const handlers = new Map();
  return {
    on: jest.fn((event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    }),
    setRequestInterception: jest.fn().mockResolvedValue(undefined),
    setUserAgent: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
    cookies: jest.fn().mockResolvedValue([]),
    deleteCookie: jest.fn().mockResolvedValue(undefined),
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

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cloudflare source captureTimeoutMs", () => {
  afterEach(() => {
    delete global.contextPool;
    delete global.timeOut;
    jest.clearAllMocks();
  });

  test("页面操作完成后迟迟没有捕获响应（如前端拒绝提交）时返回 Capture Timeout 并丢弃上下文", async () => {
    const page = createFakePage();
    installFakeContextPool(page);

    const promise = getCfSource({ url: PAGE_URL, captureUrl: [API_URL], captureTimeoutMs: 1000, ...OPERATION });
    await flush();
    await page.emit("response", createFakeResponse({ url: PAGE_URL, body: "<html>form</html>" }));

    await expect(promise).resolves.toBe("Capture Timeout");
    expect(global.contextPool.releaseContext).toHaveBeenCalledWith(
      expect.anything(),
      { forceClose: true, reason: "capture timeout" }
    );
  });

  test("超时前拿到捕获结果则正常返回，且不会再触发超时", async () => {
    const page = createFakePage();
    installFakeContextPool(page);

    const promise = getCfSource({ url: PAGE_URL, captureUrl: [API_URL], captureTimeoutMs: 1000, ...OPERATION });
    await flush();
    await page.emit("response", createFakeResponse({ url: PAGE_URL, body: "<html>form</html>" }));
    await page.emit("response", createFakeResponse({ url: API_URL, body: '{"codObjeto":"AP627580058BR"}' }));

    await expect(promise).resolves.toBe('{"codObjeto":"AP627580058BR"}');
    await sleep(1200);
    expect(global.contextPool.releaseContext).toHaveBeenCalledTimes(1);
  });

  test("未配置 captureTimeoutMs 时保持原行为（继续等待）", async () => {
    const page = createFakePage();
    installFakeContextPool(page);

    const promise = getCfSource({ url: PAGE_URL, captureUrl: [API_URL], ...OPERATION });
    await flush();
    await page.emit("response", createFakeResponse({ url: PAGE_URL, body: "<html>form</html>" }));

    let settled = false;
    promise.then(() => { settled = true; }, () => { settled = true; });
    await sleep(1200);
    expect(settled).toBe(false);

    await page.emit("response", createFakeResponse({ url: API_URL, body: "{}" }));
    await expect(promise).resolves.toBe("{}");
  });

  test("等待捕获期间命中 captureStopConditions（如前端只弹校验错误、不发请求）时立即关闭页面并返回其 result", async () => {
    const page = createFakePage();
    installFakeContextPool(page);
    const conditions = [{ textIncludes: ["Os códigos de rastreamento informados estão inválidos"], result: "Tracking not found" }];
    matchStopCondition.mockResolvedValue({ condition: conditions[0], result: "Tracking not found" });

    const promise = getCfSource({ url: PAGE_URL, captureUrl: [API_URL], captureStopConditions: conditions, ...OPERATION });
    await flush();
    await page.emit("response", createFakeResponse({ url: PAGE_URL, body: "<html>form</html>" }));

    await expect(promise).resolves.toBe("Tracking not found");
    expect(matchStopCondition).toHaveBeenCalledWith(page, conditions);
    expect(page.close).toHaveBeenCalled();
  });

  test("捕获响应先到时直接返回数据，之后不再轮询 captureStopConditions", async () => {
    const page = createFakePage();
    installFakeContextPool(page);
    matchStopCondition.mockResolvedValue(null);

    const promise = getCfSource({
      url: PAGE_URL,
      captureUrl: [API_URL],
      captureStopConditions: [{ textIncludes: ["inválido"], result: "Tracking not found" }],
      ...OPERATION,
    });
    await flush();
    await page.emit("response", createFakeResponse({ url: PAGE_URL, body: "<html>form</html>" }));
    await page.emit("response", createFakeResponse({ url: API_URL, body: '{"transito":[]}' }));

    await expect(promise).resolves.toBe('{"transito":[]}');
    const calls = matchStopCondition.mock.calls.length;
    await sleep(1200);
    expect(matchStopCondition.mock.calls.length).toBe(calls);
  });

  test("参数校验接受 captureStopConditions", () => {
    expect(reqValidate({
      mode: "source", action: "cloudflare", url: PAGE_URL, captureUrl: [API_URL],
      captureStopConditions: [
        { textIncludes: ["O código de rastreamento informado está inválido"], result: "Tracking not found" },
        { urlIncludes: ["seguranca/entrar.php"], result: "Tracking not found" },
      ],
    })).toBe(true);
  });

  test("参数校验接受 captureTimeoutMs，拒绝小于 1000 的值", () => {
    const base = { mode: "source", action: "cloudflare", url: PAGE_URL, captureUrl: [API_URL] };
    expect(reqValidate({ ...base, captureTimeoutMs: 20000 })).toBe(true);
    expect(reqValidate({ ...base, captureTimeoutMs: 10 })).not.toBe(true);
  });
});

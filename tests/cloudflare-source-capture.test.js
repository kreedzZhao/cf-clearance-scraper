const getCfSource = require("../captcha-solvers/turnstile/endpoints/source/cloudflare");
const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");

const PAGE_URL = "https://services.dpd.ro/tracking/?shipmentNumber=81356087479&language=en";
const API_URL = "https://mydpd.dpd.ro/rest/public/track?id=81356087479&language=en&mobile=N";
const CAPTURE_URL = "https://mydpd.dpd.ro/rest/public/track";

function createFakeResponse({ url, status = 200, body = "", method = "GET" }) {
  return {
    url: () => url,
    status: () => status,
    text: jest.fn().mockResolvedValue(body),
    request: () => ({ method: () => method }),
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
  return context;
}

async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("cloudflare source", () => {
  afterEach(() => {
    delete global.contextPool;
    delete global.browser;
    delete global.timeOut;
    jest.clearAllMocks();
  });

  describe("既有行为（未配置 captureUrl）", () => {
    test("文档响应命中 targetContent 时返回 HTML", async () => {
      const page = createFakePage();
      const context = installFakeContextPool(page);

      const promise = getCfSource({
        url: "https://example.com/tracking?id=123",
        targetContent: ["Delivered", "In transit"],
      });
      await flush();

      await page.emit("response", createFakeResponse({
        url: "https://example.com/tracking?id=123",
        body: "<html><body>Pending</body></html>",
      }));
      await page.emit("response", createFakeResponse({
        url: "https://example.com/tracking?id=123",
        body: "<html><body>Delivered</body></html>",
      }));

      await expect(promise).resolves.toBe("<html><body>Delivered</body></html>");
      expect(global.contextPool.releaseContext).toHaveBeenCalledWith(context, {
        forceClose: false,
        reason: undefined,
      });
    });

    test("文档 403 且非 CF 挑战页时返回 Completely Forbidden", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({ url: "https://example.com/tracking" });
      await flush();

      await page.emit("response", createFakeResponse({
        url: "https://example.com/tracking",
        status: 403,
        body: "<html>Access denied</html>",
      }));

      await expect(promise).resolves.toBe("Completely Forbidden");
      expect(global.contextPool.releaseContext).toHaveBeenCalledWith(
        expect.anything(),
        { forceClose: true, reason: "completely forbidden" }
      );
    });

    test("文档 429 时清 cookie 并返回 Rate Limit Exceeded", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({ url: "https://example.com/tracking" });
      await flush();

      await page.emit("response", createFakeResponse({
        url: "https://example.com/tracking",
        status: 429,
      }));

      await expect(promise).resolves.toBe("Rate Limit Exceeded");
      expect(page.cookies).toHaveBeenCalled();
    });

    test("不会被无关的第三方接口响应干扰", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: "https://example.com/tracking",
        targetContent: "Delivered",
      });
      await flush();

      await page.emit("response", createFakeResponse({
        url: "https://analytics.example.net/collect",
        body: "Delivered",
      }));
      await flush();

      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      await flush();
      expect(settled).toBe(false);

      await page.emit("response", createFakeResponse({
        url: "https://example.com/tracking",
        body: "Delivered",
      }));
      await expect(promise).resolves.toBe("Delivered");
    });
  });

  describe("捕获通道（配置 captureUrl，DPD RO 场景）", () => {
    test("接口 200 时返回接口响应体而非文档 HTML", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: PAGE_URL,
        captureUrl: CAPTURE_URL,
      });
      await flush();

      await page.emit("response", createFakeResponse({
        url: PAGE_URL,
        body: "<html><body>Parcel tracking</body></html>",
      }));
      await page.emit("response", createFakeResponse({
        url: API_URL,
        body: '{"parcels":[{"status":"Delivered"}]}',
      }));

      await expect(promise).resolves.toBe('{"parcels":[{"status":"Delivered"}]}');
      expect(global.contextPool.releaseContext).toHaveBeenCalledWith(
        expect.anything(),
        { forceClose: false, reason: undefined }
      );
    });

    test("接口 404 时立即返回 Tracking not found", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: PAGE_URL,
        captureUrl: CAPTURE_URL,
        captureNotFoundStatus: [404],
      });
      await flush();

      await page.emit("response", createFakeResponse({
        url: PAGE_URL,
        body: "<html><body>Parcel tracking</body></html>",
      }));
      await page.emit("response", createFakeResponse({
        url: "https://mydpd.dpd.ro/rest/public/track?id=81356087000&language=en&mobile=N",
        status: 404,
        body: '{"error":"not found"}',
      }));

      await expect(promise).resolves.toBe("Tracking not found");
    });

    test("忽略 CORS 预检，只认真正的 XHR 响应", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({ url: PAGE_URL, captureUrl: CAPTURE_URL });
      await flush();

      await page.emit("response", createFakeResponse({
        url: API_URL,
        status: 204,
        body: "",
        method: "OPTIONS",
      }));
      await flush();

      let settled = false;
      promise.then(() => { settled = true; }, () => { settled = true; });
      await flush();
      expect(settled).toBe(false);

      await page.emit("response", createFakeResponse({
        url: API_URL,
        body: '{"parcels":[]}',
      }));
      await expect(promise).resolves.toBe('{"parcels":[]}');
    });

    test("接口先 403 后重试成功时采用重试结果", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({ url: PAGE_URL, captureUrl: CAPTURE_URL });
      await flush();

      await page.emit("response", createFakeResponse({
        url: API_URL,
        status: 403,
        body: "Just a moment...",
      }));
      await page.emit("response", createFakeResponse({
        url: API_URL,
        body: '{"parcels":[{"status":"In transit"}]}',
      }));

      await expect(promise).resolves.toBe('{"parcels":[{"status":"In transit"}]}');
    });

    test("接口命中 captureFailStatus 时立即返回 Capture Failed 并丢弃上下文", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: PAGE_URL,
        captureUrl: CAPTURE_URL,
        captureFailStatus: [403],
      });
      await flush();

      await page.emit("response", createFakeResponse({
        url: API_URL,
        status: 403,
        body: '{"erro":true,"mensagem":"Não foi possível validar a solicitação."}',
      }));

      await expect(promise).resolves.toBe("Capture Failed: HTTP 403");
      expect(global.contextPool.releaseContext).toHaveBeenCalledWith(
        expect.anything(),
        { forceClose: true, reason: "capture failed: HTTP 403" }
      );
    });

    test("captureFailStatus 不影响其它非 2xx 的重试等待", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: PAGE_URL,
        captureUrl: CAPTURE_URL,
        captureFailStatus: [403],
      });
      await flush();

      await page.emit("response", createFakeResponse({
        url: API_URL,
        status: 502,
        body: "bad gateway",
      }));
      await page.emit("response", createFakeResponse({
        url: API_URL,
        body: '{"parcels":[]}',
      }));

      await expect(promise).resolves.toBe('{"parcels":[]}');
    });

    test("配置 captureUrl 后文档 HTML 不再作为结果", async () => {
      global.timeOut = 300;
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: PAGE_URL,
        captureUrl: CAPTURE_URL,
        targetContent: "Parcel tracking",
      });
      await flush();

      await page.emit("response", createFakeResponse({
        url: PAGE_URL,
        body: "<html><body>Parcel tracking</body></html>",
      }));
      await page.emit("response", createFakeResponse({
        url: API_URL,
        status: 502,
        body: "bad gateway",
      }));

      await expect(promise).rejects.toContain("HTTP 502");
    });

    test("文档 CF 状态判定仍然生效", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({ url: PAGE_URL, captureUrl: CAPTURE_URL });
      await flush();

      await page.emit("response", createFakeResponse({
        url: PAGE_URL,
        status: 429,
      }));

      await expect(promise).resolves.toBe("Rate Limit Exceeded");
    });
  });

  describe("captureTimeoutMs 兜底（不做页面操作，pos-indonesia 场景）", () => {
    const POS_URL = "https://www.posindonesia.co.id/en/tracking/CC008008495ID";
    const POS_CAPTURE = "co.id/en/tracking/";
    const RSC_OK = '0:["$@1",["abc",null]]\n1:{"receiptId":"CC008008495ID"}\n';

    beforeEach(() => {
      jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick"] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    test("一直没有捕获结果时按 captureTimeoutMs 结束并丢弃上下文", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: POS_URL,
        captureUrl: POS_CAPTURE,
        targetContent: '0:["$@1",["',
        captureTimeoutMs: 25000,
      });
      await flush();
      // 文档到了，但 server action 一直没来
      await page.emit("response", createFakeResponse({ url: POS_URL, body: "<html>tracking</html>" }));

      jest.advanceTimersByTime(25000);
      await flush();

      await expect(promise).resolves.toBe("Capture Timeout");
      expect(page.close).toHaveBeenCalled();
      expect(global.contextPool.releaseContext).toHaveBeenCalledWith(
        expect.anything(),
        { forceClose: true, reason: "capture timeout" }
      );
    });

    test("计时从导航开始，server action 在超时前返回则正常取数且不会再触发超时", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: POS_URL,
        captureUrl: POS_CAPTURE,
        targetContent: '0:["$@1",["',
        captureTimeoutMs: 25000,
      });
      await flush();
      await page.emit("response", createFakeResponse({ url: POS_URL, body: "<html>tracking</html>" }));
      jest.advanceTimersByTime(10000);
      await page.emit("response", createFakeResponse({ url: POS_URL, method: "POST", body: RSC_OK }));

      await expect(promise).resolves.toBe(RSC_OK);
      jest.advanceTimersByTime(30000);
      await flush();
      expect(global.contextPool.releaseContext).toHaveBeenCalledTimes(1);
    });

    test("未配置 captureTimeoutMs 时行为不变：只受全局超时约束", async () => {
      const page = createFakePage();
      installFakeContextPool(page);
      global.timeOut = 120000;

      const promise = getCfSource({
        url: POS_URL,
        captureUrl: POS_CAPTURE,
        targetContent: '0:["$@1",["',
      });
      const settled = jest.fn();
      promise.then(settled, settled);
      await flush();
      await page.emit("response", createFakeResponse({ url: POS_URL, body: "<html>tracking</html>" }));

      jest.advanceTimersByTime(60000);
      await flush();
      expect(settled).not.toHaveBeenCalled();

      jest.advanceTimersByTime(60000);
      await flush();
      await expect(promise).rejects.toMatch(/^Timeout Error/);
    });

    test("做页面操作的请求不在导航时计时（brazil-correios 等现有用法不变）", async () => {
      const page = createFakePage();
      installFakeContextPool(page);

      const promise = getCfSource({
        url: "https://rastreamento.correios.com.br/app/index.php",
        captureUrl: ["/app/resultado.php"],
        captureTimeoutMs: 20000,
        operationType: "INPUT_AND_CLICK",
        operationConfig: {
          trackingNumber: "AA123456785BR",
          inputXpath: "//input[@id='objeto']",
          buttonXpathArr: ["//button[@id='b-pesquisar']"],
        },
      });
      const settled = jest.fn();
      promise.then(settled, settled);
      await flush();

      // 文档还没到、操作还没执行：兜底不应启动
      jest.advanceTimersByTime(20000);
      await flush();
      expect(settled).not.toHaveBeenCalled();
    });
  });

  describe("参数校验", () => {
    test("接受 DPD RO 的新配置", () => {
      expect(reqValidate({
        mode: "source",
        action: "cloudflare",
        url: PAGE_URL,
        captureUrl: CAPTURE_URL,
        captureNotFoundStatus: [404],
      })).toBe(true);
    });

    test("接受 captureFailStatus", () => {
      expect(reqValidate({
        mode: "source",
        action: "cloudflare",
        url: PAGE_URL,
        captureUrl: [CAPTURE_URL],
        captureNotFoundStatus: [404],
        captureFailStatus: [403],
      })).toBe(true);
    });

    test("接受 captureUrl 数组", () => {
      expect(reqValidate({
        mode: "source",
        action: "cloudflare",
        url: PAGE_URL,
        captureUrl: [CAPTURE_URL, "/rest/public/track"],
      })).toBe(true);
    });

    test("老配置不受影响", () => {
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
  });
});

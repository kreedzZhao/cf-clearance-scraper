jest.mock("../captcha-solvers/turnstile/endpoints/source/f5.js", () => jest.fn());
jest.mock("../captcha-solvers/turnstile/endpoints/source/akm.js", () => jest.fn());

const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");
const browserRenderSource = require("../captcha-solvers/turnstile/endpoints/source/browser_render");
const getSource = require("../captcha-solvers/turnstile/endpoints/getSource");

describe("browser_render source", () => {
  afterEach(() => {
    delete global.contextPool;
    delete global.browser;
    delete global.timeOut;
  });

  test("allows generic rendered-page wait options", () => {
    expect(reqValidate({
      mode: "source",
      action: "browser_render",
      url: "https://example.com/tracking?id=123",
      waitForSelector: "#tracking-result",
      targetContent: ["Delivered", "In transit"],
      waitUntil: "domcontentloaded",
      navigationTimeoutMs: 15000,
      renderDelayMs: 500,
      domStableMs: 750,
      pollIntervalMs: 100,
      timeoutMs: 30000,
      stopStableMs: 750,
      renderStopConditions: [
        {
          textIncludes: ["We don’t have a record of this parcel yet"],
          textExcludes: ["Fetching Your Information"],
          result: "not_found",
          reason: "tracking_not_found",
        },
      ],
      captureSteps: [
        {
          name: "detailed",
          clickSelector: "#DesktopDetailedView",
          targetContent: "TRACKING OVERVIEW",
          timeoutMs: 10000,
          renderDelayMs: 250,
          domStableMs: 500,
          pollIntervalMs: 100,
        },
      ],
    })).toBe(true);
  });

  test("waits until configured render conditions match", async () => {
    const page = {
      evaluate: jest
        .fn()
        .mockResolvedValueOnce({
          selectorMatched: false,
          contentMatched: false,
          signature: "10:0:1",
        })
        .mockResolvedValueOnce({
          selectorMatched: true,
          contentMatched: true,
          signature: "100:20:2",
        }),
    };

    const state = await browserRenderSource.waitForRenderedState(page, {
      waitForSelector: "#result",
      targetContent: "Delivered",
      renderDelayMs: 0,
      domStableMs: 0,
      pollIntervalMs: 25,
      timeoutMs: 1000,
    });

    expect(state.selectorMatched).toBe(true);
    expect(state.contentMatched).toBe(true);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  test("does not match a stop condition while excluded loading text is present", async () => {
    const page = {
      evaluate: jest.fn(async (fn, args) => {
        global.document = {
          documentElement: { outerHTML: "<html>loading</html>" },
          body: {
            innerText:
              "We don’t have a record of this parcel yet\nFetching Your Information",
          },
          querySelector: jest.fn(() => null),
        };
        global.window = { location: { href: "https://example.com/tracking" } };

        try {
          return fn(args);
        } finally {
          delete global.document;
          delete global.window;
        }
      }),
    };

    const state = await browserRenderSource.readRenderState(page, {
      waitForSelector: "#tracking-result",
      targetContent: ["Delivered"],
      stopConditions: [
        {
          textIncludes: ["We don’t have a record of this parcel yet"],
          textExcludes: ["Fetching Your Information"],
          result: "not_found",
        },
      ],
    });

    expect(state.matchedStopConditionIndex).toBe(-1);
  });

  test("returns the browser-rendered DOM and releases the pooled context", async () => {
    const page = {
      setUserAgent: jest.fn().mockResolvedValue(undefined),
      authenticate: jest.fn().mockResolvedValue(undefined),
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue({
        selectorMatched: true,
        contentMatched: true,
        signature: "200:50:3",
      }),
      content: jest.fn().mockResolvedValue(
        "<html><body><section id=\"tracking-result\">Delivered</section></body></html>"
      ),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      newPage: jest.fn().mockResolvedValue(page),
    };
    global.contextPool = {
      getContext: jest.fn().mockResolvedValue(context),
      releaseContext: jest.fn().mockResolvedValue(undefined),
    };

    const result = await getSource({
      action: "browser_render",
      url: "https://example.com/tracking?id=123",
      userAgent: "Test Browser",
      proxy: {
        host: "127.0.0.1",
        port: 8080,
        username: "user",
        password: "pass",
      },
      waitForSelector: "#tracking-result",
      targetContent: "Delivered",
      renderDelayMs: 0,
      domStableMs: 0,
      timeoutMs: 5000,
    });

    expect(result).toEqual(expect.objectContaining({
      __browserRenderResult: true,
      status: "ok",
      message: "Success",
    }));
    expect(result.source).toContain("tracking-result");
    expect(page.goto).toHaveBeenCalledWith(
      "https://example.com/tracking?id=123",
      { waitUntil: "domcontentloaded", timeout: 5000 }
    );
    expect(page.setUserAgent).toHaveBeenCalledWith("Test Browser");
    expect(page.authenticate).toHaveBeenCalledWith({ username: "user", password: "pass" });
    expect(page.content).toHaveBeenCalled();
    expect(page.close).toHaveBeenCalled();
    expect(global.contextPool.releaseContext).toHaveBeenCalledWith(context, {
      forceClose: false,
      reason: undefined,
    });
  });

  test("returns the initial DOM and each configured post-click capture", async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest
        .fn()
        .mockResolvedValueOnce({
          selectorMatched: true,
          contentMatched: true,
          matchedStopConditionIndex: -1,
          signature: "summary",
        })
        .mockResolvedValueOnce({
          name: "initial",
          headHtml: "<title>Tracking</title>",
          bodyHtml: "<main>Summary view</main>",
          url: "https://example.com/tracking?id=123",
        })
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce({
          selectorMatched: true,
          contentMatched: true,
          matchedStopConditionIndex: -1,
          signature: "detailed",
        })
        .mockResolvedValueOnce({
          name: "detailed",
          headHtml: "<title>Tracking</title>",
          bodyHtml: "<main>Tracking overview</main>",
          url: "https://example.com/tracking?id=123",
        }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const context = { newPage: jest.fn().mockResolvedValue(page) };
    global.contextPool = {
      getContext: jest.fn().mockResolvedValue(context),
      releaseContext: jest.fn().mockResolvedValue(undefined),
    };

    const result = await getSource({
      action: "browser_render",
      url: "https://example.com/tracking?id=123",
      renderDelayMs: 0,
      domStableMs: 0,
      timeoutMs: 5000,
      captureSteps: [
        {
          name: "detailed",
          clickSelector: "#DesktopDetailedView",
          targetContent: "TRACKING OVERVIEW",
          renderDelayMs: 0,
          domStableMs: 0,
        },
      ],
    });

    expect(result.status).toBe("ok");
    expect(typeof result.source).toBe("string");
    expect(result.source).toContain('data-browser-render-output="merged"');
    expect(result.source).toContain('data-capture-name="initial"');
    expect(result.source).toContain('data-capture-name="detailed"');
    expect(result.source).toContain("Summary view");
    expect(result.source).toContain("Tracking overview");
    expect(page.evaluate).toHaveBeenCalledTimes(5);
  });

  test("returns not_found without clicking capture steps", async () => {
    const page = {
      goto: jest.fn().mockResolvedValue(undefined),
      evaluate: jest.fn().mockResolvedValue({
        selectorMatched: false,
        contentMatched: false,
        matchedStopConditionIndex: 0,
        signature: "invalid",
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    const context = { newPage: jest.fn().mockResolvedValue(page) };
    global.contextPool = {
      getContext: jest.fn().mockResolvedValue(context),
      releaseContext: jest.fn().mockResolvedValue(undefined),
    };

    const result = await getSource({
      action: "browser_render",
      url: "https://example.com/tracking?id=invalid",
      waitForSelector: "#tracking-result",
      targetContent: "Delivered",
      renderDelayMs: 0,
      domStableMs: 0,
      stopStableMs: 0,
      timeoutMs: 5000,
      renderStopConditions: [
        {
          textIncludes: ["No tracking record"],
          result: "not_found",
          reason: "tracking_not_found",
        },
      ],
      captureSteps: [
        {
          name: "detailed",
          clickSelector: "#DesktopDetailedView",
        },
      ],
    });

    expect(result).toEqual({
      __browserRenderResult: true,
      status: "not_found",
      source: null,
      message: "Tracking not found",
      reason: "tracking_not_found",
    });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});

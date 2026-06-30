const hcaptchaSource = require("../captcha-solvers/turnstile/endpoints/source/hcaptcha");

describe("Royal Mail hcaptcha source helpers", () => {
  test("detects Royal Mail tracking URLs", () => {
    expect(hcaptchaSource.isRoyalMailTrackingUrl(
      "https://www.royalmail.com/track-your-item#/tracking-results/YS357798268GB"
    )).toBe(true);

    expect(hcaptchaSource.isRoyalMailTrackingUrl(
      "https://royalmail.com/track-your-item#/tracking-results/YS357798268GB"
    )).toBe(true);

    expect(hcaptchaSource.isRoyalMailTrackingUrl(
      "https://www.royalmail.com/help"
    )).toBe(false);
  });

  test("parses tracking number from Royal Mail hash URL", () => {
    expect(hcaptchaSource.parseRoyalMailTrackingNumber(
      "https://www.royalmail.com/track-your-item#/tracking-results/YS357798268GB"
    )).toBe("YS357798268GB");
  });

  test("uses top-level tracking number before URL fallback", () => {
    expect(hcaptchaSource.parseRoyalMailTrackingNumber({
      trackingNumber: "  AB123456789GB ",
      url: "https://www.royalmail.com/track-your-item#/tracking-results/YS357798268GB",
    })).toBe("AB123456789GB");
  });

  test("builds Royal Mail summary and events URLs", () => {
    expect(hcaptchaSource.buildRoyalMailUrls("YS357798268GB")).toEqual({
      pageUrl: "https://www.royalmail.com/track-your-item#/tracking-results/YS357798268GB",
      summaryUrl: "https://api-web.royalmail.com/mailpieces/microsummary/v1/summary/YS357798268GB",
      eventsUrl: "https://api-web.royalmail.com/mailpieces/v3/YS357798268GB/events",
    });
  });

  test("rewrites microsummary requests to events", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const request = {
      url: () => `${urls.summaryUrl}?cacheBust=1`,
      continue: jest.fn(async () => undefined),
    };

    const handled = await hcaptchaSource.rewriteRoyalMailSummaryRequest(request, urls);

    expect(handled).toBe(true);
    expect(request.continue).toHaveBeenCalledWith({ url: urls.eventsUrl });
  });

  test("resolves successful events responses as JSON", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const payload = { mailpieces: [{ status: "delivered" }] };
    const resolve = jest.fn();
    const reject = jest.fn();
    const cleanup = jest.fn(async () => undefined);

    const handled = await hcaptchaSource.handleRoyalMailEventsResponse({
      response: {
        url: () => urls.eventsUrl,
        status: () => 200,
        json: jest.fn(async () => payload),
      },
      eventsUrl: urls.eventsUrl,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup,
      resolve,
      reject,
      markContextUnhealthy: jest.fn(),
    });

    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledWith({
      status: 200,
      url: urls.eventsUrl,
      ok: true,
      body: payload,
    });
    expect(reject).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  test("ignores rewritten events preflight responses", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const resolve = jest.fn();
    const reject = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailEventsResponse({
      response: {
        url: () => urls.eventsUrl,
        status: () => 204,
        request: () => ({
          method: () => "OPTIONS",
          resourceType: () => "other",
        }),
        json: jest.fn(),
      },
      eventsUrl: urls.eventsUrl,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup: jest.fn(async () => undefined),
      resolve,
      reject,
      markContextUnhealthy: jest.fn(),
    });

    expect(handled).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  test("resolves non-200 events responses for diagnostics", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const payload = { error: "forbidden" };
    const resolve = jest.fn();
    const reject = jest.fn();
    const markContextUnhealthy = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailEventsResponse({
      response: {
        url: () => urls.eventsUrl,
        status: () => 403,
        json: jest.fn(async () => payload),
      },
      eventsUrl: urls.eventsUrl,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup: jest.fn(async () => undefined),
      resolve,
      reject,
      markContextUnhealthy,
    });

    expect(handled).toBe(true);
    expect(markContextUnhealthy).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      status: 403,
      url: urls.eventsUrl,
      ok: false,
      body: payload,
    });
  });

  test("resolves failed events requests for diagnostics", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("GV398892427GB");
    const resolve = jest.fn();
    const cleanup = jest.fn(async () => undefined);
    const markContextUnhealthy = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailRequestFailure({
      request: {
        url: () => urls.eventsUrl,
        method: () => "GET",
        resourceType: () => "xhr",
        failure: () => ({ errorText: "net::ERR_FAILED" }),
      },
      target: {
        ...urls,
        trackingNumber: "GV398892427GB",
      },
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup,
      resolve,
      markContextUnhealthy,
    });

    expect(handled).toBe(true);
    expect(markContextUnhealthy).toHaveBeenCalledWith("royal mail target request failed: net::ERR_FAILED");
    expect(resolve).toHaveBeenCalledWith({
      status: null,
      url: urls.eventsUrl,
      ok: false,
      requestFailed: true,
      failure: "net::ERR_FAILED",
      resourceType: "xhr",
      body: null,
    });
    expect(cleanup).toHaveBeenCalled();
  });

  test("resolves failed Royal Mail API requests that include the tracking number", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("GV398892427GB");
    const resolve = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailRequestFailure({
      request: {
        url: () => "https://api-web.royalmail.com/mailpieces/lookup/GV398892427GB",
        method: () => "GET",
        resourceType: () => "xhr",
        failure: () => "net::ERR_ABORTED",
      },
      target: {
        ...urls,
        trackingNumber: "GV398892427GB",
      },
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup: jest.fn(async () => undefined),
      resolve,
      markContextUnhealthy: jest.fn(),
    });

    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({
      status: null,
      ok: false,
      requestFailed: true,
      failure: "net::ERR_ABORTED",
      resourceType: "xhr",
    }));
  });

  test("does not submit generic site search inputs as tracking forms", async () => {
    let searchButtonClicked = false;
    const page = {
      evaluate: jest.fn(async (fn, trackingNumber) => {
        const searchInput = {
          getAttribute: jest.fn((name) => {
            if (name === "placeholder") return "Search";
            if (name === "name") return "search";
            if (name === "id") return "site-search";
            return "";
          }),
          getBoundingClientRect: jest.fn(() => ({ width: 200, height: 40 })),
          dispatchEvent: jest.fn(),
        };
        const searchButton = {
          textContent: "Search",
          getAttribute: jest.fn(() => ""),
          getBoundingClientRect: jest.fn(() => ({ width: 40, height: 40 })),
          click: jest.fn(() => {
            searchButtonClicked = true;
          }),
        };

        global.document = {
          querySelector: jest.fn((selector) => {
            if (selector === "#barcode-input") return null;
            if (selector === "#btn-more-details") return null;
            return null;
          }),
          querySelectorAll: jest.fn((selector) => {
            if (selector === "input") return [searchInput];
            if (selector === "button") return [searchButton];
            return [];
          }),
        };
        global.window = {
          getComputedStyle: jest.fn(() => ({
            display: "block",
            visibility: "visible",
            opacity: "1",
          })),
          HTMLInputElement: function HTMLInputElement() {},
        };
        global.window.HTMLInputElement.prototype = {};
        global.Event = function Event() {};

        try {
          return fn(trackingNumber);
        } finally {
          delete global.document;
          delete global.window;
          delete global.Event;
        }
      }),
    };

    const result = await hcaptchaSource.triggerRoyalMailTracking(page, "GV398892427GB");

    expect(result).toBe(false);
    expect(searchButtonClicked).toBe(false);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});

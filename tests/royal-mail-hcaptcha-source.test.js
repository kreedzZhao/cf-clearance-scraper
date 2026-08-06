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

  test("builds safe headers for the Royal Mail HTTP/1.1 fallback", () => {
    const headers = hcaptchaSource.buildRoyalMailReplayHeaders({
      headers: () => ({
        accept: "application/json",
        connection: "keep-alive",
        host: "untrusted.example",
        origin: "https://www.royalmail.com",
        "x-request-context": "validated-test-value",
      }),
    });

    expect(headers).toEqual({
      accept: "application/json",
      origin: "https://www.royalmail.com",
      "x-request-context": "validated-test-value",
      "accept-encoding": "identity",
    });
  });

  test("uses wreq browser impersonation for the Royal Mail events request", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const payload = { events: [{ eventCode: "EVKOP" }] };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify(payload),
    }));

    const result = await hcaptchaSource.fetchRoyalMailTargetOverWreq(
      {
        headers: () => ({
          accept: "application/json",
          "accept-encoding": "gzip, deflate, br, zstd",
          connection: "keep-alive",
          origin: "https://www.royalmail.com",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36",
          "x-request-context": "validated-test-value",
        }),
      },
      urls.eventsUrl,
      "events",
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith(urls.eventsUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "accept-encoding": "gzip, deflate, br, zstd",
        origin: "https://www.royalmail.com",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/134.0.0.0 Safari/537.36",
        "x-request-context": "validated-test-value",
      },
      browser: "chrome_134",
      os: "windows",
      timeout: 20000,
      redirect: "error",
      disableDefaultHeaders: true,
    });
    expect(result).toEqual({
      status: 200,
      url: urls.eventsUrl,
      ok: true,
      body: payload,
    });
  });

  test("matches the wreq profile to the intercepted Chromium user agent", () => {
    expect(hcaptchaSource.selectRoyalMailWreqProfile({
      headers: () => ({
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chromium/139.0.0.0 Safari/537.36",
      }),
    })).toEqual({ browser: "chrome_139", os: "macos" });
  });

  test("rejects non-Royal-Mail targets before calling wreq", async () => {
    const fetchImpl = jest.fn();

    const result = await hcaptchaSource.fetchRoyalMailTargetOverWreq(
      { headers: () => ({ accept: "application/json" }) },
      "https://example.com/mailpieces/v3/YS357798268GB/events",
      "events",
      fetchImpl,
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      status: null,
      ok: false,
      requestFailed: true,
      failure: "Invalid Royal Mail events URL",
      body: null,
    }));
  });

  test("returns wreq transport failures without waiting for the browser", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const fetchImpl = jest.fn(async () => {
      throw new Error("TLS transport failed");
    });

    const result = await hcaptchaSource.fetchRoyalMailTargetOverWreq(
      { headers: () => ({ accept: "application/json" }) },
      urls.eventsUrl,
      "events",
      fetchImpl,
    );

    expect(result).toEqual({
      status: null,
      url: urls.eventsUrl,
      ok: false,
      requestFailed: true,
      failure: "TLS transport failed",
      error: "Royal Mail events wreq request failed: TLS transport failed",
      body: null,
    });
  });

  test("recognizes Royal Mail cold-start transport failures for one refresh retry", () => {
    expect(hcaptchaSource.isRetryableRoyalMailTransportFailure({
      failure: "net::ERR_HTTP2_PROTOCOL_ERROR",
    })).toBe(true);
    expect(hcaptchaSource.isRetryableRoyalMailTransportFailure(
      "http2 stream error received",
    )).toBe(true);
    expect(hcaptchaSource.isRetryableRoyalMailTransportFailure({
      error: "Royal Mail events request failed with status 403",
    })).toBe(false);
  });

  test("resolves successful summary responses as JSON", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const payload = { mailpieces: [{ status: "delivered" }] };
    const resolve = jest.fn();
    const reject = jest.fn();
    const cleanup = jest.fn(async () => undefined);

    const handled = await hcaptchaSource.handleRoyalMailSummaryResponse({
      response: {
        url: () => urls.summaryUrl,
        status: () => 200,
        json: jest.fn(async () => payload),
      },
      summaryUrl: urls.summaryUrl,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup,
      resolve,
      reject,
      markContextUnhealthy: jest.fn(),
    });

    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledWith(payload);
    expect(reject).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalled();
  });

  test("captures an events response reported under the original rewritten summary URL", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const payload = { events: [{ eventCode: "EVKOP" }] };
    const resolve = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailSummaryResponse({
      response: {
        url: () => urls.summaryUrl,
        status: () => 200,
        request: () => ({
          method: () => "GET",
          resourceType: () => "xhr",
        }),
        json: jest.fn(async () => payload),
      },
      summaryUrl: urls.eventsUrl,
      alternateUrl: urls.summaryUrl,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup: jest.fn(async () => undefined),
      resolve,
      reject: jest.fn(),
      markContextUnhealthy: jest.fn(),
      targetName: "events",
    });

    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledWith(payload);
  });

  test("ignores summary preflight responses", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const resolve = jest.fn();
    const reject = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailSummaryResponse({
      response: {
        url: () => urls.summaryUrl,
        status: () => 204,
        request: () => ({
          method: () => "OPTIONS",
          resourceType: () => "other",
        }),
        json: jest.fn(),
      },
      summaryUrl: urls.summaryUrl,
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

  test("resolves non-200 summary responses for diagnostics", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const payload = { error: "forbidden" };
    const resolve = jest.fn();
    const reject = jest.fn();
    const markContextUnhealthy = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailSummaryResponse({
      response: {
        url: () => urls.summaryUrl,
        status: () => 403,
        json: jest.fn(async () => payload),
      },
      summaryUrl: urls.summaryUrl,
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
      url: urls.summaryUrl,
      ok: false,
      body: payload,
      error: "Royal Mail summary request failed with status 403",
    });
  });

  test("ends immediately with failure details when the summary body cannot be read", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const resolve = jest.fn();
    const setResolved = jest.fn();
    const clearTimers = jest.fn();
    const cleanup = jest.fn(async () => undefined);
    const markContextUnhealthy = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailSummaryResponse({
      response: {
        url: () => urls.summaryUrl,
        status: () => 200,
        text: jest.fn(async () => {
          expect(setResolved).toHaveBeenCalledWith(true);
          expect(clearTimers).toHaveBeenCalled();
          throw new Error("response body unavailable");
        }),
      },
      summaryUrl: urls.summaryUrl,
      getIsResolved: () => false,
      setResolved,
      clearTimers,
      cleanup,
      resolve,
      reject: jest.fn(),
      markContextUnhealthy,
    });

    expect(handled).toBe(true);
    expect(setResolved).toHaveBeenCalledWith(true);
    expect(clearTimers).toHaveBeenCalled();
    expect(markContextUnhealthy).toHaveBeenCalledWith(
      "royal mail summary response body failed: response body unavailable"
    );
    expect(cleanup).toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      status: 200,
      url: urls.summaryUrl,
      ok: false,
      body: null,
      bodyError: "response body unavailable",
      error: "Failed to read Royal Mail summary response body: response body unavailable",
    });
  });

  test("does not wait for browser cleanup after a summary response", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const cleanup = jest.fn(() => new Promise(() => {}));
    const resolve = jest.fn();

    const completion = hcaptchaSource.handleRoyalMailSummaryResponse({
      response: {
        url: () => urls.summaryUrl,
        status: () => 200,
        json: jest.fn(async () => ({ delivered: true })),
      },
      summaryUrl: urls.summaryUrl,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup,
      resolve,
      reject: jest.fn(),
      markContextUnhealthy: jest.fn(),
    });

    await expect(Promise.race([
      completion,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("handler waited for cleanup")), 100);
      }),
    ])).resolves.toBe(true);
    expect(resolve).toHaveBeenCalledWith({ delivered: true });
    expect(cleanup).toHaveBeenCalled();
  });

  test("ends with failure details when the summary response body never completes", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("YS357798268GB");
    const resolve = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailSummaryResponse({
      response: {
        url: () => urls.summaryUrl,
        status: () => 200,
        text: jest.fn(() => new Promise(() => {})),
      },
      summaryUrl: urls.summaryUrl,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup: jest.fn(async () => undefined),
      resolve,
      reject: jest.fn(),
      markContextUnhealthy: jest.fn(),
      responseBodyTimeoutMs: 20,
    });

    expect(handled).toBe(true);
    expect(resolve).toHaveBeenCalledWith({
      status: 200,
      url: urls.summaryUrl,
      ok: false,
      body: null,
      bodyError: "Royal Mail summary response body timed out after 20ms",
      error: "Failed to read Royal Mail summary response body: Royal Mail summary response body timed out after 20ms",
    });
  });

  test("does not wait for browser cleanup after a target request failure", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("GV398892427GB");
    const cleanup = jest.fn(() => new Promise(() => {}));

    const completion = hcaptchaSource.handleRoyalMailRequestFailure({
      request: {
        url: () => urls.summaryUrl,
        method: () => "GET",
        resourceType: () => "xhr",
        failure: () => ({ errorText: "net::ERR_HTTP2_PROTOCOL_ERROR" }),
      },
      target: {
        ...urls,
        trackingNumber: "GV398892427GB",
      },
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup,
      resolve: jest.fn(),
      markContextUnhealthy: jest.fn(),
    });

    await expect(Promise.race([
      completion,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("handler waited for cleanup")), 100);
      }),
    ])).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalled();
  });

  test("can defer a transient summary request failure for a later retry", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("GV398892427GB");
    const resolve = jest.fn();
    const cleanup = jest.fn();
    const onDeferredFailure = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailRequestFailure({
      request: {
        url: () => urls.summaryUrl,
        method: () => "GET",
        resourceType: () => "xhr",
        failure: () => ({ errorText: "net::ERR_FAILED" }),
      },
      target: urls,
      getIsResolved: () => false,
      setResolved: jest.fn(),
      clearTimers: jest.fn(),
      cleanup,
      resolve,
      markContextUnhealthy: jest.fn(),
      deferResolution: true,
      onDeferredFailure,
    });

    expect(handled).toBe(true);
    expect(onDeferredFailure).toHaveBeenCalledWith(expect.objectContaining({
      url: urls.summaryUrl,
      requestFailed: true,
      failure: "net::ERR_FAILED",
    }));
    expect(resolve).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  test("resolves failed summary requests for diagnostics", async () => {
    const urls = hcaptchaSource.buildRoyalMailUrls("GV398892427GB");
    const resolve = jest.fn();
    const cleanup = jest.fn(async () => undefined);
    const markContextUnhealthy = jest.fn();

    const handled = await hcaptchaSource.handleRoyalMailRequestFailure({
      request: {
        url: () => urls.summaryUrl,
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
      url: urls.summaryUrl,
      ok: false,
      requestFailed: true,
      failure: "net::ERR_FAILED",
      error: "Royal Mail summary request failed: net::ERR_FAILED",
      resourceType: "xhr",
      body: null,
    });
    expect(cleanup).toHaveBeenCalled();
  });

  test("ignores failures from non-summary Royal Mail API requests", async () => {
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

    expect(handled).toBe(false);
    expect(resolve).not.toHaveBeenCalled();
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

  test("restarts the Royal Mail SPA tracking route after a refresh", async () => {
    const page = {
      evaluate: jest.fn(async (fn, trackingNumber) => {
        expect(trackingNumber).toBe("GV398892427GB");
        return {
          restarted: true,
          before: "#/tracking-results/GV398892427GB",
          after: "#/tracking-results/GV398892427GB",
        };
      }),
    };

    await expect(hcaptchaSource.restartRoyalMailTrackingRoute(
      page,
      "GV398892427GB",
    )).resolves.toBe(true);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});

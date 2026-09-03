const EventEmitter = require("events");
const recaptchaSource = require("../captcha-solvers/turnstile/endpoints/source/recaptcha");

describe("recaptcha source response handling", () => {
  test("resolves target responses from the current page", async () => {
    const mainPage = new EventEmitter();
    const response = {
      url: () => "https://www.arcospedizioni.it/en/shipping-tracking-2/?foo=bar",
      status: () => 200,
      json: jest.fn(async () => {
        throw new Error("not json");
      }),
      text: jest.fn(async () => "<html>tracking result</html>"),
    };
    const cleanup = jest.fn();
    const resolve = jest.fn();
    const reject = jest.fn();

    recaptchaSource.attachTargetResponseHandlers({
      page: mainPage,
      targetUrl: "https://www.arcospedizioni.it/en/shipping-tracking-2/",
      getIsResolved: () => false,
      setResolved: jest.fn(),
      cleanup,
      resolve,
      reject,
      clearTimers: jest.fn(),
      markContextUnhealthy: jest.fn(),
    });

    mainPage.emit("response", response);
    await new Promise((resolveTick) => setImmediate(resolveTick));

    expect(resolve).toHaveBeenCalledWith("<html>tracking result</html>");
    expect(cleanup).toHaveBeenCalled();
  });

  test("keeps rejecting target API errors when targetNotFoundStatus is not configured", async () => {
    const mainPage = new EventEmitter();
    const response = {
      url: () => "https://moja.posta.si/api/v1/parcels/track/?TrackingNumber=CS000000000SI",
      status: () => 404,
      json: jest.fn(),
      text: jest.fn(),
    };
    const resolve = jest.fn();
    const reject = jest.fn();
    const markContextUnhealthy = jest.fn();

    recaptchaSource.attachTargetResponseHandlers({
      page: mainPage,
      targetUrl: "https://moja.posta.si/api/v1/parcels/track/",
      getIsResolved: () => false,
      setResolved: jest.fn(),
      cleanup: jest.fn(),
      resolve,
      reject,
      clearTimers: jest.fn(),
      markContextUnhealthy,
    });

    mainPage.emit("response", response);
    await new Promise((resolveTick) => setImmediate(resolveTick));

    expect(reject).toHaveBeenCalledWith("Target API failed, status code: 404");
    expect(resolve).not.toHaveBeenCalled();
    expect(markContextUnhealthy).toHaveBeenCalledWith("target API status 404");
  });

  test("returns Tracking not found for configured not-found statuses and keeps the context", async () => {
    const mainPage = new EventEmitter();
    const response = {
      url: () => "https://moja.posta.si/api/v1/parcels/track/?TrackingNumber=CS000000000SI",
      status: () => 404,
      json: jest.fn(),
      text: jest.fn(),
    };
    const resolve = jest.fn();
    const reject = jest.fn();
    const markContextUnhealthy = jest.fn();

    recaptchaSource.attachTargetResponseHandlers({
      page: mainPage,
      targetUrl: "https://moja.posta.si/api/v1/parcels/track/",
      notFoundStatusList: [404],
      getIsResolved: () => false,
      setResolved: jest.fn(),
      cleanup: jest.fn(),
      resolve,
      reject,
      clearTimers: jest.fn(),
      markContextUnhealthy,
    });

    mainPage.emit("response", response);
    await new Promise((resolveTick) => setImmediate(resolveTick));

    expect(resolve).toHaveBeenCalledWith("Tracking not found");
    expect(reject).not.toHaveBeenCalled();
    expect(markContextUnhealthy).not.toHaveBeenCalled();
  });

  test("still rejects other error statuses when targetNotFoundStatus is configured", async () => {
    const mainPage = new EventEmitter();
    const response = {
      url: () => "https://moja.posta.si/api/v1/parcels/track/?TrackingNumber=CS000638190SI",
      status: () => 500,
      json: jest.fn(),
      text: jest.fn(),
    };
    const resolve = jest.fn();
    const reject = jest.fn();

    recaptchaSource.attachTargetResponseHandlers({
      page: mainPage,
      targetUrl: "https://moja.posta.si/api/v1/parcels/track/",
      notFoundStatusList: [404],
      getIsResolved: () => false,
      setResolved: jest.fn(),
      cleanup: jest.fn(),
      resolve,
      reject,
      clearTimers: jest.fn(),
      markContextUnhealthy: jest.fn(),
    });

    mainPage.emit("response", response);
    await new Promise((resolveTick) => setImmediate(resolveTick));

    expect(reject).toHaveBeenCalledWith("Target API failed, status code: 500");
    expect(resolve).not.toHaveBeenCalled();
  });

  test("accepts the posta.si tracking config", () => {
    const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");

    expect(reqValidate({
      mode: "source",
      action: "recaptcha",
      url: "https://moja.posta.si/tracking",
      operationType: "INPUT_AND_CLICK",
      operationConfig: {
        trackingNumber: "CS000638190SI",
        inputXpath: "//input[@id='parcelSearchInput']",
        buttonXpathArr: ["//input[@id='parcelSearchInput']/../button"],
      },
      targetUrl: "https://moja.posta.si/api/v1/parcels/track/",
      targetNotFoundStatus: [404],
    })).toBe(true);
  });

  test("forces blank form and link targets to open in the current tab", async () => {
    const page = {
      evaluate: jest.fn(async (fn) => fn()),
    };

    global.document = {
      querySelectorAll: jest.fn((selector) => {
        if (selector === 'form[target="_blank"], a[target="_blank"]') {
          return [
            { setAttribute: jest.fn() },
            { setAttribute: jest.fn() },
          ];
        }
        if (selector === 'button[formtarget="_blank"], input[formtarget="_blank"]') {
          return [
            { setAttribute: jest.fn() },
          ];
        }
        return [];
      }),
    };

    try {
      const result = await recaptchaSource.forceCurrentTabNavigation(page);

      expect(result).toEqual({ targetUpdated: 2, formTargetUpdated: 1 });
      expect(page.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      delete global.document;
    }
  });
});

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

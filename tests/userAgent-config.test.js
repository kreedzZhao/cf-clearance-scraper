const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");
const { applyUserAgent } = require("../captcha-solvers/turnstile/module/pageOptions");

describe("request userAgent config", () => {
  test("allows userAgent on new-format cfcookie requests", () => {
    const result = reqValidate({
      type: "cfcookie",
      websiteUrl: "https://example.com/h5",
      userAgent: "Emb/iOS/5.0.0",
    });

    expect(result).toBe(true);
  });

  test("applies configured userAgent to a page before navigation", async () => {
    const page = {
      setUserAgent: jest.fn().mockResolvedValue(undefined),
    };

    await applyUserAgent(page, "Emb/iOS/5.0.0");

    expect(page.setUserAgent).toHaveBeenCalledWith("Emb/iOS/5.0.0");
  });

  test("skips empty userAgent values", async () => {
    const page = {
      setUserAgent: jest.fn().mockResolvedValue(undefined),
    };

    await applyUserAgent(page, "");

    expect(page.setUserAgent).not.toHaveBeenCalled();
  });
});

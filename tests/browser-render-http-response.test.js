process.env.NODE_ENV = "development";
process.env.SKIP_LAUNCH = "true";

jest.useFakeTimers();
jest.mock("../captcha-solvers/turnstile/module/reqValidate", () => jest.fn(() => true));
jest.mock("../captcha-solvers/turnstile/endpoints/getSource", () => jest.fn());

const request = require("supertest");
const getSource = require("../captcha-solvers/turnstile/endpoints/getSource");
const app = require("../captcha-solvers/turnstile/index");

describe("browser_render HTTP response", () => {
  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    delete process.env.SKIP_LAUNCH;
  });

  test("flattens a successful browser render result", async () => {
    getSource.mockResolvedValueOnce({
      __browserRenderResult: true,
      status: "ok",
      message: "Success",
      source: "<html>merged</html>",
    });

    const response = await request(app)
      .post("/cf-clearance-scraper")
      .send({ mode: "source", action: "browser_render", url: "https://example.com" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      code: 200,
      message: "Success",
      status: "ok",
      token: null,
      source: "<html>merged</html>",
    });
  });

  test("returns not_found at the top level with a null source", async () => {
    getSource.mockResolvedValueOnce({
      __browserRenderResult: true,
      status: "not_found",
      message: "Tracking not found",
      reason: "tracking_not_found",
      source: null,
    });

    const response = await request(app)
      .post("/cf-clearance-scraper")
      .send({ mode: "source", action: "browser_render", url: "https://example.com" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      code: 200,
      message: "Tracking not found",
      status: "not_found",
      reason: "tracking_not_found",
      token: null,
      source: null,
    });
  });
});

const {
  PageOperationType,
  executePageOperation,
} = require("../captcha-solvers/turnstile/endpoints/operations/query");
const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");

describe("page operations", () => {
  test("types multiple inputs before clicking once", async () => {
    const typed = [];
    const clicks = [];
    const beforeClick = jest.fn();
    const elements = new Map([
      ["#riferimento_anno", { click: jest.fn() }],
      ["#riferimento_mittente", { click: jest.fn() }],
      ["#codice_cliente", { click: jest.fn() }],
      ["button.btn.cerca.btn-block.btn-primary.shadow.lift", { click: jest.fn(() => clicks.push("search")) }],
    ]);
    const page = {
      locator: jest.fn(async (selector) => elements.get(selector)),
      evaluate: jest.fn(async () => undefined),
      keyboard: {
        type: jest.fn(async (value, options) => typed.push([value, options])),
      },
    };

    await executePageOperation(page, PageOperationType.INPUTS_AND_CLICK, {
      inputs: [
        { inputXpath: "#riferimento_anno", inputValue: "2026" },
        { inputXpath: "#riferimento_mittente", inputValue: "123" },
        { inputXpath: "#codice_cliente", inputValue: "12345678" },
      ],
      buttonXpathArr: ["button.btn.cerca.btn-block.btn-primary.shadow.lift"],
      typeDelayMs: 80,
    }, {
      beforeClick,
    });

    expect(typed).toEqual([
      ["2026", { delay: 80 }],
      ["123", { delay: 80 }],
      ["12345678", { delay: 80 }],
    ]);
    expect(beforeClick).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual(["search"]);
  });

  test("allows INPUTS_AND_CLICK request config", () => {
    const result = reqValidate({
      mode: "source",
      url: "https://www.arcospedizioni.it/",
      action: "recaptcha",
      targetUrl: "https://www.arcospedizioni.it/en/shipping-tracking-2/",
      operationType: "INPUTS_AND_CLICK",
      operationConfig: {
        inputs: [
          { inputXpath: "#riferimento_anno", inputValue: "2026" },
          { inputXpath: "#riferimento_mittente", inputValue: "123" },
          { inputXpath: "#codice_cliente", inputValue: "12345678" },
        ],
        buttonXpathArr: ["button.btn.cerca.btn-block.btn-primary.shadow.lift"],
        inputMethod: "type",
        typeDelayMs: 80,
      },
    });

    expect(result).toBe(true);
  });
});

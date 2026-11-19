const {
  PageOperationType,
  executePageOperation,
} = require("../captcha-solvers/turnstile/endpoints/operations/query");
const reqValidate = require("../captcha-solvers/turnstile/module/reqValidate");

// inputMethod: "set" —— 直接写 value 并派发 input/change，不走键盘。
// brazil-correios 合查 279 字时 fill/type 都会丢字（只进前 12–248 字），前端按"单号无效"拒绝提交。

function createPage(input) {
  const events = [];
  const fakeDocument = {
    evaluate: () => ({ singleNodeValue: input }),
    querySelector: () => input,
  };
  const page = {
    events,
    keyboard: { type: jest.fn() },
    locator: jest.fn(async () => ({ click: jest.fn(), fill: jest.fn() })),
    evaluate: jest.fn(async (fn, arg) => {
      // 只有 setInputValue 的参数带 value：在假 DOM 里真正执行它；其余（可点击检查、点击）直接放行
      if (arg && Object.prototype.hasOwnProperty.call(arg, "value")) {
        const saved = { document: global.document, XPathResult: global.XPathResult, Event: global.Event };
        global.document = fakeDocument;
        global.XPathResult = { FIRST_ORDERED_NODE_TYPE: 9 };
        global.Event = class { constructor(type) { this.type = type; } };
        try {
          return fn(arg);
        } finally {
          Object.assign(global, saved);
        }
      }
      return true;
    }),
  };
  if (input) {
    input.focus = jest.fn();
    input.dispatchEvent = jest.fn((e) => events.push(e.type));
  }
  return page;
}

const LONG = Array.from({ length: 20 }, (_, i) => `OY7923${String(91661 + i).padStart(5, "0")}BR`).join(",");

describe("INPUTS_AND_CLICK inputMethod: set", () => {
  test("整串一次写入并派发 input/change，不调用键盘", async () => {
    const input = { value: "stale" };
    const page = createPage(input);

    await executePageOperation(page, PageOperationType.INPUTS_AND_CLICK, {
      inputs: [{ inputXpath: "//input[@id='objeto']", inputValue: LONG }],
      buttonXpathArr: ["//button[@id='b-pesquisar']"],
      inputMethod: "set",
    });

    expect(input.value).toBe(LONG);
    expect(input.focus).toHaveBeenCalled();
    expect(page.events).toEqual(["input", "change"]);
    expect(page.keyboard.type).not.toHaveBeenCalled();
  });

  test("找不到输入框时报错，不会带着空值去点查询", async () => {
    const page = createPage(null);
    page.locator = jest.fn(async () => ({ click: jest.fn() }));

    await expect(executePageOperation(page, PageOperationType.INPUTS_AND_CLICK, {
      inputs: [{ inputXpath: "//input[@id='objeto']", inputValue: LONG }],
      buttonXpathArr: ["//button[@id='b-pesquisar']"],
      inputMethod: "set",
    })).rejects.toThrow(/input value mismatch after set \(got no element/);
  });

  test("参数校验接受 inputMethod: set（顶层与单个 input 上）", () => {
    const base = {
      mode: "source", action: "cloudflare", url: "https://rastreamento.correios.com.br/app/index.php",
      operationType: "INPUTS_AND_CLICK",
    };
    expect(reqValidate({
      ...base,
      operationConfig: { inputs: [{ inputXpath: "//input[@id='objeto']", inputValue: "x" }], buttonXpathArr: ["//b"], inputMethod: "set" },
    })).toBe(true);
    expect(reqValidate({
      ...base,
      operationConfig: { inputs: [{ inputXpath: "//input[@id='objeto']", inputValue: "x", inputMethod: "set" }], buttonXpathArr: ["//b"] },
    })).toBe(true);
    expect(reqValidate({
      ...base,
      operationConfig: { inputs: [{ inputXpath: "//input[@id='objeto']", inputValue: "x" }], buttonXpathArr: ["//b"], inputMethod: "paste" },
    })).not.toBe(true);
  });
});

// 页面操作类型枚举
const PageOperationType = {
  CLICK: 'CLICK',                // 仅点击按钮
  INPUT_AND_CLICK: 'INPUT_AND_CLICK',  // 输入文本到 input 并点击按钮
  INPUTS_AND_CLICK: 'INPUTS_AND_CLICK',  // 多个 input 填完后点击按钮
  MULTI_INPUT_AND_CLICK: 'MULTI_INPUT_AND_CLICK',  // 多步骤：输入+点击，等待导航，再输入+点击
  // 未来可扩展：CLICK_ONLY, INPUT_ONLY, WAIT, SCROLL 等
};

const DEFAULT_POST_CLICK_TIMEOUT = 15000;
const DEFAULT_POST_CLICK_POLL_INTERVAL = 400;

class PageOperationEarlyTermination extends Error {
  constructor({ result, reason, matchedCondition }) {
    super(reason || result || 'Page operation terminated early');
    this.name = 'PageOperationEarlyTermination';
    this.result = result || reason || 'Page operation terminated early';
    this.reason = reason || this.result;
    this.matchedCondition = matchedCondition || null;
    this.isPageOperationEarlyTermination = true;
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isXPathSelector(selector) {
  if (!selector) {
    return false;
  }

  return selector.startsWith('//') || selector.startsWith('xpath=');
}

function toXPath(selector) {
  return selector.startsWith('xpath=') ? selector.slice(6) : selector;
}

/**
 * page.locator 只认 Puppeteer 的选择器语法：CSS，或带 `xpath=` / `xpath/` 前缀的 XPath。
 * 裸 `//foo` 会掉到 CSS 分支被 querySelector 解析，从而永远匹配不到元素。
 * 这里统一补上前缀，让 locator 与走 page.evaluate 的 selectorExists / clearInputValue
 * （两者本来就认裸 XPath）行为一致。CSS 选择器与已带前缀的 XPath 原样透传。
 */
function toLocatorSelector(selector) {
  const value = String(selector || '');
  return value.startsWith('//') ? `xpath=${value}` : value;
}

async function selectorExists(page, selector) {
  if (!selector) {
    return false;
  }

  try {
    const xpathSelector = isXPathSelector(selector);
    const rawSelector = xpathSelector ? toXPath(selector) : selector;

    return await page.evaluate(({ rawSelector, xpathSelector }) => {
      if (xpathSelector) {
        return !!document.evaluate(
          rawSelector,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
      }

      return !!document.querySelector(rawSelector);
    }, {
      rawSelector,
      xpathSelector,
    });
  } catch (e) {
    return false;
  }
}

const DEFAULT_DISMISS_TIMEOUT_MS = 3000;
const DEFAULT_DISMISS_POLL_INTERVAL_MS = 200;
const DEFAULT_DISMISS_SETTLE_MS = 400;

function toPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * 判断元素中心点是否真的能被鼠标点到。
 *
 * Puppeteer 的 Locator.click() 是按坐标发真实鼠标事件的，命中的是该坐标上
 * 层叠最高的元素。轮播图、横幅、遮罩盖住按钮时，点击会落在盖住它的元素上，
 * 而 Puppeteer **不会报错**（确实有元素收到了点击），于是流程静默失效。
 * 实测 ptt.gov.tr：查询按钮被 hero 轮播的 <img> 盖住，elementFromPoint 返回 IMG。
 */
async function isClickableAtCenter(page, selector) {
  try {
    const xpathSelector = isXPathSelector(selector);
    const rawSelector = xpathSelector ? toXPath(selector) : selector;

    return await page.evaluate(({ rawSelector, xpathSelector }) => {
      const element = xpathSelector
        ? document.evaluate(rawSelector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        : document.querySelector(rawSelector);

      if (!element) return false;

      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'center' });
      }

      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;

      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;

      const topElement = document.elementFromPoint(cx, cy);
      if (!topElement) return false;

      return topElement === element || element.contains(topElement) || topElement.contains(element);
    }, { rawSelector, xpathSelector });
  } catch (e) {
    return false;
  }
}

/**
 * 点击元素：能真实点到就发真实鼠标事件（对风控更友好），
 * 被遮挡时退回页面内 element.click()，避免静默点空。
 */
async function clickElement(page, selector) {
  if (await isClickableAtCenter(page, selector)) {
    const locator = await page.locator(toLocatorSelector(selector));
    if (locator) {
      await locator.click();
      return;
    }
  }

  const clicked = await clickSelectorInPage(page, selector);
  if (!clicked) {
    throw new Error(`element not found or not clickable: ${selector}`);
  }
}

async function clickSelectorInPage(page, selector) {
  try {
    const xpathSelector = isXPathSelector(selector);
    const rawSelector = xpathSelector ? toXPath(selector) : selector;

    return await page.evaluate(({ rawSelector, xpathSelector }) => {
      const element = xpathSelector
        ? document.evaluate(
            rawSelector,
            document,
            null,
            XPathResult.FIRST_ORDERED_NODE_TYPE,
            null
          ).singleNodeValue
        : document.querySelector(rawSelector);

      if (!element) return false;

      if (typeof element.scrollIntoView === 'function') {
        element.scrollIntoView({ block: 'center', inline: 'center' });
      }
      element.click();
      return true;
    }, {
      rawSelector,
      xpathSelector,
    });
  } catch (e) {
    return false;
  }
}

/**
 * 点掉可选的遮罩层（cookie 同意弹窗、首访介绍弹窗等）。
 *
 * 每个选择器都是「可选」的：等不到就跳过，点不动也只跳过，绝不让主流程失败。
 * 复用上下文时这些弹窗往往根本不出现，同一份配置必须两种情况都能跑。
 * 点击走页面内的 element.click()，因此不受遮罩遮挡与可交互性检查影响。
 */
async function dismissOptionalOverlays(page, config = {}) {
  const selectors = Array.isArray(config.dismissXpathArr)
    ? config.dismissXpathArr.filter(Boolean)
    : [];

  if (selectors.length === 0) {
    return { attempted: 0, dismissed: 0 };
  }

  const timeoutMs = toPositiveInteger(config.dismissTimeoutMs, DEFAULT_DISMISS_TIMEOUT_MS);
  const pollIntervalMs = toPositiveInteger(
    config.dismissPollIntervalMs,
    DEFAULT_DISMISS_POLL_INTERVAL_MS
  );
  const settleMs = toNonNegativeInteger(config.dismissSettleMs, DEFAULT_DISMISS_SETTLE_MS);

  let dismissed = 0;

  for (const selector of selectors) {
    const deadline = Date.now() + timeoutMs;
    let appeared = false;

    while (Date.now() < deadline) {
      if (await selectorExists(page, selector)) {
        appeared = true;
        break;
      }
      await sleep(pollIntervalMs);
    }

    if (!appeared) continue;

    if (await clickSelectorInPage(page, selector)) {
      dismissed += 1;
      if (settleMs > 0) {
        await sleep(settleMs);
      }
    }
  }

  return { attempted: selectors.length, dismissed };
}

async function getPageText(page) {
  try {
    const pageText = await page.evaluate(() => {
      return document.body?.innerText || document.body?.textContent || '';
    });

    return normalizeText(pageText);
  } catch (e) {
    return '';
  }
}

function getStopConditionMessage(condition, matchedText) {
  return condition?.result || condition?.reason || matchedText || 'Page operation terminated early';
}

async function matchStopCondition(page, stopConditions) {
  if (!Array.isArray(stopConditions) || stopConditions.length === 0) {
    return null;
  }

  const currentUrl = typeof page.url === 'function' ? page.url() : '';
  const normalizedUrl = normalizeText(currentUrl);
  const pageText = await getPageText(page);

  for (const condition of stopConditions) {
    const textIncludes = Array.isArray(condition?.textIncludes) ? condition.textIncludes : [];
    const selectorArr = Array.isArray(condition?.selectorArr) ? condition.selectorArr : [];
    const urlIncludes = Array.isArray(condition?.urlIncludes) ? condition.urlIncludes : [];

    const textMatched = textIncludes.length === 0 || textIncludes.every(text =>
      pageText.includes(normalizeText(text))
    );

    if (!textMatched) {
      continue;
    }

    const urlMatched = urlIncludes.length === 0 || urlIncludes.every(fragment =>
      normalizedUrl.includes(normalizeText(fragment))
    );

    if (!urlMatched) {
      continue;
    }

    let selectorsMatched = true;
    for (const selector of selectorArr) {
      if (!(await selectorExists(page, selector))) {
        selectorsMatched = false;
        break;
      }
    }

    if (!selectorsMatched) {
      continue;
    }

    return {
      condition,
      result: getStopConditionMessage(condition, textIncludes[0]),
    };
  }

  return null;
}

async function waitForPostClickState(page, options = {}) {
  const {
    nextInputXpath,
    stopConditions = [],
    postClickTimeoutMs = DEFAULT_POST_CLICK_TIMEOUT,
    postClickPollIntervalMs = DEFAULT_POST_CLICK_POLL_INTERVAL,
  } = options;

  const shouldWaitForNextStep = Boolean(nextInputXpath);
  const shouldCheckStopConditions = Array.isArray(stopConditions) && stopConditions.length > 0;

  if (!shouldWaitForNextStep && !shouldCheckStopConditions) {
    return { type: 'continue' };
  }

  const deadline = Date.now() + postClickTimeoutMs;

  while (Date.now() < deadline) {
    if (shouldCheckStopConditions) {
      const matchedStopCondition = await matchStopCondition(page, stopConditions);
      if (matchedStopCondition) {
        return {
          type: 'terminated',
          ...matchedStopCondition,
        };
      }
    }

    if (shouldWaitForNextStep && await selectorExists(page, nextInputXpath)) {
      return { type: 'next-step-ready' };
    }

    await sleep(postClickPollIntervalMs);
  }

  if (shouldCheckStopConditions) {
    const matchedStopCondition = await matchStopCondition(page, stopConditions);
    if (matchedStopCondition) {
      return {
        type: 'terminated',
        ...matchedStopCondition,
      };
    }
  }

  if (shouldWaitForNextStep && await selectorExists(page, nextInputXpath)) {
    return { type: 'next-step-ready' };
  }

  return { type: 'timeout' };
}

/**
 * 执行输入文本并点击按钮的操作
 * @param {Object} page - Puppeteer page 对象
 * @param {Object} config - 操作配置
 * @param {string} config.trackingNumber - 要输入的文本
 * @param {string} config.inputXpath - input 元素的 xpath
 * @param {string} config.buttonXpath - 按钮元素的 xpath
 */
async function executeInputAndClick(page, config) {
  const { trackingNumber, inputXpath, buttonXpathArr, stopConditions, postClickTimeoutMs, postClickPollIntervalMs } = config;
  
  if (!trackingNumber) {
    throw new Error('trackingNumber is required for INPUT_AND_CLICK operation');
  }
  if (!inputXpath) {
    throw new Error('inputXpath is required for INPUT_AND_CLICK operation');
  }
  if (!buttonXpathArr) {
    throw new Error('buttonXpathArr is required for INPUT_AND_CLICK operation');
  }
  
  // 等待 input 元素出现（使用轮询方式，兼容性更好）
  const inputWaitStartTime = Date.now();
  const inputWaitTimeout = 10000;
  let inputElement;
  while (!inputElement && (Date.now() - inputWaitStartTime) < inputWaitTimeout) {
    inputElement = await page.locator(toLocatorSelector(inputXpath));
    if (!inputElement) {
      await sleep(200); // 等待 200ms 后重试
    }
  }
  if (!inputElement) {
    throw new Error(`Input element not found within ${inputWaitTimeout}ms: ${inputXpath}`);
  }
  
  // 定位并输入文本
  try {
    await inputElement.fill(trackingNumber);
  } catch (typeError) {
    throw new Error(`Failed to fill input element: ${typeError.message}`);
  }

  // 点击可能有多次
  for (let btnXpath of buttonXpathArr) {
        // 等待按钮元素出现
        // const buttonWaitStartTime = Date.now();
        // const buttonWaitTimeout = 10000;
        // let buttonElement;
        // while (!buttonElement && (Date.now() - buttonWaitStartTime) < buttonWaitTimeout) {
        //     buttonElement = await page.locator(btnXpath);
        //     if (!buttonElement) {
        //     await page.waitForTimeout(200); // 等待 200ms 后重试
        //     }
        // }
        // if (!buttonElement) {
        //     throw new Error(`Button element not found within ${buttonWaitTimeout}ms: ${btnXpath}`);
        // }

        let buttonElement = await page.locator(toLocatorSelector(btnXpath));
        if (!buttonElement) {
          continue; // 如果按钮不存在，跳过此次点击
        }

        // 定位并点击按钮
    try {
      await clickElement(page, btnXpath);
        } catch (clickError) {
            throw new Error(`Failed to click button element: ${clickError.message}`);
        }

        const postClickState = await waitForPostClickState(page, {
          stopConditions,
          postClickTimeoutMs,
          postClickPollIntervalMs,
        });

        if (postClickState.type === 'terminated') {
          throw new PageOperationEarlyTermination({
            result: postClickState.result,
            reason: postClickState.result,
            matchedCondition: postClickState.condition,
          });
        }
    }
}

async function waitForElement(page, selector, timeoutMs, label) {
  const waitStartTime = Date.now();
  let element;
  while (!element && (Date.now() - waitStartTime) < timeoutMs) {
    element = await page.locator(toLocatorSelector(selector));
    if (!element) {
      await sleep(200);
    }
  }

  if (!element) {
    throw new Error(`${label} element not found within ${timeoutMs}ms: ${selector}`);
  }

  return element;
}

async function clearInputValue(page, selector) {
  await page.evaluate(({ selector }) => {
    const isXPath = selector.startsWith('//') || selector.startsWith('xpath=');
    const rawSelector = selector.startsWith('xpath=') ? selector.slice(6) : selector;
    const element = isXPath
      ? document.evaluate(rawSelector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
      : document.querySelector(rawSelector);

    if (!element) {
      return;
    }

    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, { selector });
}

// 直接写 value 并派发 input/change，不走键盘。用于长串输入时键盘事件会丢的页面
// （brazil-correios 合查 279 字：fill/type 只进前 12–248 字，前端按"单号无效"拒绝提交）。
async function setInputValue(page, selector, value) {
  const written = await page.evaluate(({ selector, value }) => {
    const isXPath = selector.startsWith('//') || selector.startsWith('xpath=');
    const rawSelector = selector.startsWith('xpath=') ? selector.slice(6) : selector;
    const element = isXPath
      ? document.evaluate(rawSelector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
      : document.querySelector(rawSelector);
    if (!element) return null;
    element.focus();
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return element.value;
  }, { selector, value });
  if (written !== value) {
    throw new Error(`input value mismatch after set (got ${written === null ? 'no element' : written.length + ' chars'}, want ${value.length})`);
  }
}

async function typeIntoInput(page, inputElement, selector, value, delayMs) {
  if (!page.keyboard || typeof page.keyboard.type !== 'function') {
    throw new Error('page.keyboard.type is required for type input method');
  }

  await clearInputValue(page, selector);
  await inputElement.click();
  await page.keyboard.type(value, { delay: delayMs });
}

/**
 * 执行多个输入框填充后点击按钮的操作
 * @param {Object} page - Puppeteer page 对象
 * @param {Object} config - 操作配置
 * @param {Array} config.inputs - 输入数组，每项包含 inputValue, inputXpath
 * @param {Array} config.buttonXpathArr - 按钮 selector/xpath 数组
 */
async function executeInputsAndClick(page, config, options = {}) {
  const {
    inputs,
    buttonXpathArr,
    stopConditions,
    postClickTimeoutMs,
    postClickPollIntervalMs,
    inputMethod = 'type',
    typeDelayMs = 80,
  } = config;

  if (!inputs || !Array.isArray(inputs) || inputs.length === 0) {
    throw new Error('inputs array is required for INPUTS_AND_CLICK operation');
  }
  if (!buttonXpathArr) {
    throw new Error('buttonXpathArr is required for INPUTS_AND_CLICK operation');
  }

  for (let i = 0; i < inputs.length; i++) {
    const { inputValue, inputXpath } = inputs[i];

    if (!inputValue) {
      throw new Error(`Input ${i + 1}: inputValue is required`);
    }
    if (!inputXpath) {
      throw new Error(`Input ${i + 1}: inputXpath is required`);
    }

    const inputElement = await waitForElement(page, inputXpath, 15000, `Input ${i + 1}`);
    try {
      const method = inputs[i].inputMethod || inputMethod;
      const delay = inputs[i].typeDelayMs ?? typeDelayMs;
      if (method === 'fill') {
        await inputElement.fill(inputValue);
      } else if (method === 'set') {
        await setInputValue(page, inputXpath, inputValue);
      } else {
        await typeIntoInput(page, inputElement, inputXpath, inputValue, delay);
      }
    } catch (typeError) {
      throw new Error(`Input ${i + 1}: Failed to input text: ${typeError.message}`);
    }
  }

  for (let btnXpath of buttonXpathArr) {
    let buttonElement = await page.locator(toLocatorSelector(btnXpath));
    if (!buttonElement) {
      continue;
    }

    try {
      if (typeof options.beforeClick === 'function') {
        await options.beforeClick();
      }
      await clickElement(page, btnXpath);
    } catch (clickError) {
      throw new Error(`Failed to click button element: ${clickError.message}`);
    }

    const postClickState = await waitForPostClickState(page, {
      stopConditions,
      postClickTimeoutMs,
      postClickPollIntervalMs,
    });

    if (postClickState.type === 'terminated') {
      throw new PageOperationEarlyTermination({
        result: postClickState.result,
        reason: postClickState.result,
        matchedCondition: postClickState.condition,
      });
    }
  }
}

/**
 * 执行多步骤输入+点击操作
 * 每一步：等待 input 出现 → 输入文本 → 点击按钮
 * 非最后一步会等待页面导航完成后再执行下一步
 * @param {Object} page - Puppeteer page 对象
 * @param {Object} config - 操作配置
 * @param {Array} config.steps - 步骤数组，每项包含 inputValue, inputXpath, buttonXpathArr
 */
async function executeMultiInputAndClick(page, config) {
  const { steps } = config;

  if (!steps || !Array.isArray(steps) || steps.length < 2) {
    throw new Error('steps array with at least 2 items is required for MULTI_INPUT_AND_CLICK');
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const { inputValue, inputXpath, buttonXpathArr, stopConditions, postClickTimeoutMs, postClickPollIntervalMs } = step;

    if (!inputValue) {
      throw new Error(`Step ${i + 1}: inputValue is required`);
    }
    if (!inputXpath) {
      throw new Error(`Step ${i + 1}: inputXpath is required`);
    }
    if (!buttonXpathArr) {
      throw new Error(`Step ${i + 1}: buttonXpathArr is required`);
    }

    // 等待 input 元素出现（使用轮询方式）
    const inputWaitStartTime = Date.now();
    const inputWaitTimeout = 15000;
    let inputElement;
    while (!inputElement && (Date.now() - inputWaitStartTime) < inputWaitTimeout) {
      inputElement = await page.locator(toLocatorSelector(inputXpath));
      if (!inputElement) {
        await sleep(200);
      }
    }
    if (!inputElement) {
      throw new Error(`Step ${i + 1}: Input element not found within ${inputWaitTimeout}ms: ${inputXpath}`);
    }

    // 输入文本
    try {
      await inputElement.fill(inputValue);
    } catch (typeError) {
      throw new Error(`Step ${i + 1}: Failed to fill input: ${typeError.message}`);
    }

    // 点击按钮
    for (let btnXpath of buttonXpathArr) {
      let buttonElement = await page.locator(toLocatorSelector(btnXpath));
      if (!buttonElement) {
        continue;
      }

      try {
        await clickElement(page, btnXpath);
      } catch (clickError) {
        throw new Error(`Step ${i + 1}: Failed to click button: ${clickError.message}`);
      }

      const nextInputXpath = i < steps.length - 1 ? steps[i + 1].inputXpath : null;
      const postClickState = await waitForPostClickState(page, {
        nextInputXpath,
        stopConditions,
        postClickTimeoutMs,
        postClickPollIntervalMs,
      });

      if (postClickState.type === 'terminated') {
        throw new PageOperationEarlyTermination({
          result: postClickState.result,
          reason: postClickState.result,
          matchedCondition: postClickState.condition,
        });
      }

      if (postClickState.type === 'timeout' && nextInputXpath) {
        throw new Error(`Step ${i + 1}: Next step input did not appear within ${postClickTimeoutMs || DEFAULT_POST_CLICK_TIMEOUT}ms`);
      }

      if (postClickState.type === 'next-step-ready') {
        break;
      }
    }
  }
}

async function executeClick(page, config) {
    const { buttonXpathArr, stopConditions, postClickTimeoutMs, postClickPollIntervalMs } = config;
    if (!buttonXpathArr) {
        throw new Error('buttonXpath is required for CLICK operation');
        }
    for (let buttonXpath of buttonXpathArr) {
        // 等待按钮元素出现
        // const buttonWaitStartTime = Date.now();
        // const buttonWaitTimeout = 10000;
        // let buttonElement;
        // while (!buttonElement && (Date.now() - buttonWaitStartTime) < buttonWaitTimeout) {
        //     buttonElement = await page.locator(buttonXpath);
        //     if (!buttonElement) {
        //         await page.waitForTimeout(200); // 等待 200ms 后重试
        //     }
        // }
        // if (!buttonElement) {
        //     throw new Error(`Button element not found within ${buttonWaitTimeout}ms: ${buttonXpath}`);
        // }


        let buttonElement = await page.locator(toLocatorSelector(buttonXpath));
        if (!buttonElement) {
          continue; // 如果按钮不存在，跳过此次点击
        }
        
        // 定位并点击按钮
        try {
            await clickElement(page, buttonXpath);
        } catch (clickError) {
            throw new Error(`Failed to click button element: ${clickError.message}`);
        }

        const postClickState = await waitForPostClickState(page, {
          stopConditions,
          postClickTimeoutMs,
          postClickPollIntervalMs,
        });

        if (postClickState.type === 'terminated') {
          throw new PageOperationEarlyTermination({
            result: postClickState.result,
            reason: postClickState.result,
            matchedCondition: postClickState.condition,
          });
        }
    }
}

/**
 * 页面操作执行器 - 根据操作类型分发到对应的执行函数
 * @param {Object} page - Puppeteer page 对象
 * @param {string} operationType - 操作类型
 * @param {Object} operationConfig - 操作配置
 */
async function executePageOperation(page, operationType, operationConfig, options = {}) {
  if (!operationType) {
    return; // 如果没有指定操作类型，直接返回
  }

  // 页面操作前先点掉可选遮罩（未配置 dismissXpathArr 时为空操作）
  await dismissOptionalOverlays(page, operationConfig);

  switch (operationType) {
    case PageOperationType.INPUT_AND_CLICK:
      return await executeInputAndClick(page, operationConfig);
    case PageOperationType.INPUTS_AND_CLICK:
      return await executeInputsAndClick(page, operationConfig, options);
    case PageOperationType.CLICK:
      // 仅点击按钮的操作可以复用 INPUT_AND_CLICK 逻辑，传入空的 trackingNumber
      return await executeClick(page, operationConfig);
    case PageOperationType.MULTI_INPUT_AND_CLICK:
      return await executeMultiInputAndClick(page, operationConfig);
    // 未来可扩展其他操作类型
    default:
      throw new Error(`Unsupported operation type: ${operationType}`);
  }
}

module.exports = {
  PageOperationType,
  executePageOperation,
  PageOperationEarlyTermination,
  dismissOptionalOverlays,
  toLocatorSelector,
  matchStopCondition,
};

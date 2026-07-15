const { executePageOperation, PageOperationEarlyTermination } = require("../operations/query.js");
const { applyUserAgent } = require("../../module/pageOptions");

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30000;
const DEFAULT_RENDER_DELAY_MS = 500;
const DEFAULT_DOM_STABLE_MS = 750;
const DEFAULT_STOP_STABLE_MS = 750;
const DEFAULT_POLL_INTERVAL_MS = 200;
const BROWSER_RENDER_RESULT_MARKER = "__browserRenderResult";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStrings(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "")).filter(Boolean);
  }

  if (value === undefined || value === null || value === "") {
    return [];
  }

  return [String(value)];
}

function toPositiveInteger(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return Math.floor(parsed);
}

function createTimeoutError(message) {
  const error = new Error(message);
  error.code = "BROWSER_RENDER_TIMEOUT";
  return error;
}

function getWaitDescription({ waitForSelector, targetContent }) {
  const parts = [];
  if (waitForSelector) parts.push(`selector ${JSON.stringify(waitForSelector)}`);
  if (targetContent.length > 0) {
    parts.push(`content ${targetContent.map((item) => JSON.stringify(item)).join(" or ")}`);
  }
  return parts.length > 0 ? parts.join(" and ") : "a stable rendered DOM";
}

async function readRenderState(page, { waitForSelector, targetContent, stopConditions = [] }) {
  return await page.evaluate(({ selector, expectedText, terminalConditions }) => {
    const findBySelector = (value) => {
      if (!value) return true;

      try {
        if (value.startsWith("//") || value.startsWith("xpath=")) {
          const xpath = value.startsWith("xpath=") ? value.slice(6) : value;
          return Boolean(
            document.evaluate(
              xpath,
              document,
              null,
              XPathResult.FIRST_ORDERED_NODE_TYPE,
              null
            ).singleNodeValue
          );
        }

        return Boolean(document.querySelector(value));
      } catch (_) {
        return false;
      }
    };

    const html = document.documentElement ? document.documentElement.outerHTML : "";
    const bodyText = document.body ? document.body.innerText : "";
    const currentUrl = window.location.href;
    let hash = 2166136261;

    for (let index = 0; index < html.length; index++) {
      hash ^= html.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }

    const matchedStopConditionIndex = terminalConditions.findIndex((condition) => {
      const textIncludes = Array.isArray(condition.textIncludes) ? condition.textIncludes : [];
      const textExcludes = Array.isArray(condition.textExcludes) ? condition.textExcludes : [];
      const urlIncludes = Array.isArray(condition.urlIncludes) ? condition.urlIncludes : [];
      const selectorArr = Array.isArray(condition.selectorArr) ? condition.selectorArr : [];

      return (
        textIncludes.every((text) => bodyText.includes(text)) &&
        textExcludes.every((text) => !bodyText.includes(text)) &&
        urlIncludes.every((fragment) => currentUrl.includes(fragment)) &&
        selectorArr.every((item) => findBySelector(item))
      );
    });

    return {
      readyState: document.readyState,
      selectorMatched: findBySelector(selector),
      contentMatched:
        expectedText.length === 0 || expectedText.some((text) => bodyText.includes(text)),
      matchedStopConditionIndex,
      signature: `${html.length}:${bodyText.length}:${hash >>> 0}`,
    };
  }, {
    selector: waitForSelector || "",
    expectedText: targetContent,
    terminalConditions: stopConditions,
  });
}

async function waitForRenderedState(page, options = {}) {
  const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1);
  const renderDelayMs = toPositiveInteger(
    options.renderDelayMs,
    DEFAULT_RENDER_DELAY_MS
  );
  const domStableMs = toPositiveInteger(
    options.domStableMs,
    DEFAULT_DOM_STABLE_MS
  );
  const stopStableMs = toPositiveInteger(
    options.stopStableMs,
    DEFAULT_STOP_STABLE_MS
  );
  const pollIntervalMs = toPositiveInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    25
  );
  const waitForSelector = options.waitForSelector || "";
  const targetContent = normalizeStrings(options.targetContent);
  const stopConditions = Array.isArray(options.stopConditions) ? options.stopConditions : [];
  const deadline = options.deadline || Date.now() + timeoutMs;

  if (renderDelayMs > 0) {
    const remainingDelay = Math.min(renderDelayMs, Math.max(0, deadline - Date.now()));
    if (remainingDelay > 0) await sleep(remainingDelay);
  }

  let lastSignature = null;
  let stableSince = null;
  let matchedStopConditionIndex = -1;
  let stopSignature = null;
  let stopStableSince = null;

  while (Date.now() <= deadline) {
    const state = await readRenderState(page, {
      waitForSelector,
      targetContent,
      stopConditions,
    });
    const conditionsMatched = state.selectorMatched && state.contentMatched;

    if (state.matchedStopConditionIndex >= 0) {
      if (
        state.matchedStopConditionIndex !== matchedStopConditionIndex ||
        state.signature !== stopSignature
      ) {
        matchedStopConditionIndex = state.matchedStopConditionIndex;
        stopSignature = state.signature;
        stopStableSince = Date.now();
      }

      if (stopStableMs === 0 || Date.now() - stopStableSince >= stopStableMs) {
        const matchedCondition = stopConditions[state.matchedStopConditionIndex];
        return {
          ...state,
          terminated: true,
          result: matchedCondition.result || "terminated",
          reason: matchedCondition.reason || matchedCondition.result || "render_stop_condition",
          matchedCondition,
        };
      }
    } else {
      matchedStopConditionIndex = -1;
      stopSignature = null;
      stopStableSince = null;
    }

    if (conditionsMatched) {
      if (state.signature !== lastSignature) {
        lastSignature = state.signature;
        stableSince = Date.now();
      } else if (stableSince === null) {
        stableSince = Date.now();
      }

      if (domStableMs === 0 || Date.now() - stableSince >= domStableMs) {
        return { ...state, terminated: false };
      }
    } else {
      lastSignature = state.signature;
      stableSince = null;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  throw createTimeoutError(
    `Timeout waiting for ${getWaitDescription({ waitForSelector, targetContent })}`
  );
}

async function closeQuietly(target) {
  if (!target || typeof target.close !== "function") return;
  try {
    await target.close();
  } catch (_) {}
}

async function clickPageElement(page, selector) {
  const clicked = await page.evaluate((value) => {
    const findElement = () => {
      if (value.startsWith("//") || value.startsWith("xpath=")) {
        const xpath = value.startsWith("xpath=") ? value.slice(6) : value;
        return document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
      }

      return document.querySelector(value);
    };

    const element = findElement();
    if (!element) return false;

    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ block: "center", inline: "center" });
    }
    element.click();
    return true;
  }, selector);

  if (!clicked) {
    throw new Error(`Capture click element not found: ${selector}`);
  }
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function readCaptureSnapshot(page, name) {
  return await page.evaluate((captureName) => ({
    name: captureName,
    headHtml: document.head ? document.head.innerHTML : "",
    bodyHtml: document.body ? document.body.innerHTML : "",
    url: window.location.href,
  }), name);
}

function buildMergedHtml(initialSnapshot, captureSnapshots) {
  const snapshots = [initialSnapshot, ...captureSnapshots];
  const sections = snapshots.map((snapshot, index) => {
    const name = escapeHtmlAttribute(snapshot.name);
    const url = escapeHtmlAttribute(snapshot.url || "");
    return `<section data-capture-name="${name}" data-capture-index="${index}" data-source-url="${url}">${snapshot.bodyHtml}</section>`;
  });

  return [
    "<!DOCTYPE html>",
    '<html data-browser-render-output="merged">',
    `<head>${initialSnapshot.headHtml}</head>`,
    `<body>${sections.join("\n")}</body>`,
    "</html>",
  ].join("\n");
}

function createBrowserRenderResult({ status, source, message, reason }) {
  return {
    [BROWSER_RENDER_RESULT_MARKER]: true,
    status,
    source,
    message,
    ...(reason ? { reason } : {}),
  };
}

async function captureRenderedStates(page, initialSnapshot, captureSteps, config, deadline) {
  const captureSnapshots = [];

  for (const step of captureSteps) {
    if (Date.now() >= deadline) {
      throw createTimeoutError(`Timeout before capture step ${JSON.stringify(step.name)}`);
    }

    await clickPageElement(page, step.clickSelector);

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw createTimeoutError(`Timeout after clicking capture step ${JSON.stringify(step.name)}`);
    }
    const stepTimeoutMs = Math.min(
      remainingMs,
      toPositiveInteger(step.timeoutMs, remainingMs, 1)
    );

    const renderState = await waitForRenderedState(page, {
      waitForSelector: step.waitForSelector,
      targetContent: step.targetContent,
      stopConditions: config.renderStopConditions,
      stopStableMs: config.stopStableMs,
      renderDelayMs: step.renderDelayMs ?? config.renderDelayMs,
      domStableMs: step.domStableMs ?? config.domStableMs,
      pollIntervalMs: step.pollIntervalMs ?? config.pollIntervalMs,
      timeoutMs: stepTimeoutMs,
      deadline: Date.now() + stepTimeoutMs,
    });

    if (renderState.terminated) {
      return { terminatedState: renderState };
    }

    captureSnapshots.push(await readCaptureSnapshot(page, step.name));
  }

  return {
    source: buildMergedHtml(initialSnapshot, captureSnapshots),
  };
}

async function getBrowserRenderedSource(config = {}) {
  const {
    url,
    proxy,
    userAgent,
    operationType,
    operationConfig,
    targetContent,
    waitForSelector,
    waitUntil = "domcontentloaded",
  } = config;

  if (!url) throw new Error("Missing url parameter");

  const timeoutMs = toPositiveInteger(
    config.timeoutMs,
    global.timeOut || DEFAULT_TIMEOUT_MS,
    1000
  );
  const navigationTimeoutMs = Math.min(
    timeoutMs,
    toPositiveInteger(
      config.navigationTimeoutMs,
      DEFAULT_NAVIGATION_TIMEOUT_MS,
      1000
    )
  );
  const deadline = Date.now() + timeoutMs;

  let page = null;
  let context = null;
  let shouldReuseContext = true;
  let discardReason = "";

  try {
    if (global.contextPool && typeof global.contextPool.getContext === "function") {
      context = await global.contextPool.getContext(proxy);
    } else {
      context = await global.browser
        .createBrowserContext({
          proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
        })
        .catch(() => null);
    }

    if (!context) throw new Error("Failed to create browser context");

    page = await context.newPage();
    await applyUserAgent(page, userAgent);

    if (proxy?.username && proxy?.password && typeof page.authenticate === "function") {
      await page.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }

    const navigationRemainingMs = deadline - Date.now();
    if (navigationRemainingMs <= 0) {
      throw createTimeoutError("Timeout before browser navigation could start");
    }

    await page.goto(url, {
      waitUntil,
      timeout: Math.min(navigationTimeoutMs, navigationRemainingMs),
    });

    if (operationType && operationConfig) {
      try {
        await executePageOperation(page, operationType, operationConfig);
      } catch (error) {
        if (error instanceof PageOperationEarlyTermination || error?.isPageOperationEarlyTermination) {
          return error.result;
        }
        throw error;
      }
    }

    const initialRenderState = await waitForRenderedState(page, {
      waitForSelector,
      targetContent,
      stopConditions: config.renderStopConditions,
      stopStableMs: config.stopStableMs,
      renderDelayMs: config.renderDelayMs,
      domStableMs: config.domStableMs,
      pollIntervalMs: config.pollIntervalMs,
      timeoutMs,
      deadline,
    });

    if (initialRenderState.terminated) {
      return createBrowserRenderResult({
        status: initialRenderState.result,
        source: null,
        message:
          initialRenderState.result === "not_found"
            ? "Tracking not found"
            : "Render stopped",
        reason: initialRenderState.reason,
      });
    }

    const captureSteps = Array.isArray(config.captureSteps) ? config.captureSteps : [];

    if (captureSteps.length === 0) {
      return createBrowserRenderResult({
        status: "ok",
        source: await page.content(),
        message: "Success",
      });
    }

    const initialSnapshot = await readCaptureSnapshot(page, "initial");
    const captureResult = await captureRenderedStates(
      page,
      initialSnapshot,
      captureSteps,
      config,
      deadline
    );

    if (captureResult.terminatedState) {
      return createBrowserRenderResult({
        status: captureResult.terminatedState.result,
        source: null,
        message:
          captureResult.terminatedState.result === "not_found"
            ? "Tracking not found"
            : "Render stopped",
        reason: captureResult.terminatedState.reason,
      });
    }

    return createBrowserRenderResult({
      status: "ok",
      source: captureResult.source,
      message: "Success",
    });
  } catch (error) {
    if (
      error?.name === "TargetCloseError" ||
      error?.message?.includes("Target closed") ||
      error?.message?.includes("Session closed")
    ) {
      shouldReuseContext = false;
      discardReason = error.message;
    }
    throw error;
  } finally {
    await closeQuietly(page);

    if (context) {
      if (global.contextPool && typeof global.contextPool.releaseContext === "function") {
        try {
          await global.contextPool.releaseContext(context, {
            forceClose: !shouldReuseContext,
            reason: discardReason || undefined,
          });
        } catch (error) {
          console.error("Error releasing browser_render context:", error.message);
        }
      } else {
        await closeQuietly(context);
      }
    }
  }
}

module.exports = getBrowserRenderedSource;
module.exports.normalizeStrings = normalizeStrings;
module.exports.readRenderState = readRenderState;
module.exports.waitForRenderedState = waitForRenderedState;
module.exports.clickPageElement = clickPageElement;
module.exports.captureRenderedStates = captureRenderedStates;
module.exports.readCaptureSnapshot = readCaptureSnapshot;
module.exports.buildMergedHtml = buildMergedHtml;
module.exports.createBrowserRenderResult = createBrowserRenderResult;
module.exports.BROWSER_RENDER_RESULT_MARKER = BROWSER_RENDER_RESULT_MARKER;

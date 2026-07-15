const { executePageOperation, PageOperationEarlyTermination } = require("../operations/query");
const { applyUserAgent } = require("../../module/pageOptions");

const ROYAL_MAIL_ORIGIN = "https://www.royalmail.com";
const ROYAL_MAIL_API_ORIGIN = "https://api-web.royalmail.com";
const ROYAL_MAIL_DEBUG = process.env.DEBUG_ROYAL_MAIL_HCAPTCHA === "true";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function royalMailLog(message, data) {
  if (!ROYAL_MAIL_DEBUG) return;
  if (data === undefined) {
    console.log(`[royal-mail:hcaptcha] ${message}`);
    return;
  }
  console.log(`[royal-mail:hcaptcha] ${message}`, data);
}

function callMaybe(value, ...args) {
  return typeof value === "function" ? value(...args) : value;
}

function responseUrl(response) {
  return String(callMaybe(response.url?.bind?.(response) || response.url) || "");
}

function responseStatus(response) {
  return Number(callMaybe(response.status?.bind?.(response) || response.status));
}

async function responseBody(response) {
  if (typeof response.text === "function") {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return text;
    }
  }

  if (typeof response.json === "function") {
    return await response.json();
  }

  return null;
}

function requestUrl(request) {
  return String(callMaybe(request.url?.bind?.(request) || request.url) || "");
}

function requestResourceType(request) {
  if (!request) return "";
  return String(callMaybe(request.resourceType?.bind?.(request) || request.resourceType || request.resource_type) || "");
}

function responseRequest(response) {
  return callMaybe(response.request?.bind?.(response) || response.request);
}

function requestMethod(request) {
  return String(callMaybe(request?.method?.bind?.(request) || request?.method) || "").toUpperCase();
}

function requestFailureText(request) {
  const failure = callMaybe(request?.failure?.bind?.(request) || request?.failure);
  if (!failure) return "unknown";
  if (typeof failure === "string") return failure;
  return String(failure.errorText || failure.message || JSON.stringify(failure));
}

function isRoyalMailTrackingUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return ["www.royalmail.com", "royalmail.com"].includes(parsed.hostname) &&
      parsed.pathname === "/track-your-item";
  } catch (e) {
    return false;
  }
}

function normalizeTrackingNumber(value) {
  const trackingNumber = String(value || "").trim().replace(/\s+/g, "");
  return trackingNumber || null;
}

function parseRoyalMailTrackingNumber(value) {
  if (!value) return null;

  if (typeof value === "object") {
    return normalizeTrackingNumber(
      value.trackingNumber ||
      value.tracking_number ||
      value.operationConfig?.trackingNumber ||
      value.operationConfig?.tracking_number
    ) || parseRoyalMailTrackingNumber(value.url || value.pageUrl || value.websiteUrl);
  }

  const rawUrl = String(value);
  try {
    const parsed = new URL(rawUrl);
    const candidates = [parsed.hash, parsed.pathname, parsed.href];
    for (const candidate of candidates) {
      const match = String(candidate || "").match(/\/tracking-results\/([^/?#]+)/i);
      if (match) return normalizeTrackingNumber(decodeURIComponent(match[1]));
    }
  } catch (e) {
    const match = rawUrl.match(/\/tracking-results\/([^/?#]+)/i);
    if (match) return normalizeTrackingNumber(decodeURIComponent(match[1]));
  }

  return null;
}

function buildRoyalMailUrls(trackingNumber) {
  const cleanTrackingNumber = normalizeTrackingNumber(trackingNumber);
  if (!cleanTrackingNumber) {
    throw new Error("Missing Royal Mail tracking number");
  }

  return {
    pageUrl: `${ROYAL_MAIL_ORIGIN}/track-your-item#/tracking-results/${encodeURIComponent(cleanTrackingNumber)}`,
    summaryUrl: `${ROYAL_MAIL_API_ORIGIN}/mailpieces/microsummary/v1/summary/${encodeURIComponent(cleanTrackingNumber)}`,
    eventsUrl: `${ROYAL_MAIL_API_ORIGIN}/mailpieces/v3/${encodeURIComponent(cleanTrackingNumber)}/events`,
  };
}

function isSameRequestUrl(currentUrl, targetUrl) {
  if (!currentUrl || !targetUrl) return false;
  if (currentUrl === targetUrl) return true;

  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl);
    return current.origin === target.origin && current.pathname === target.pathname;
  } catch (e) {
    return currentUrl.includes(targetUrl);
  }
}

function isPreflightResponse(response) {
  const request = responseRequest(response);
  if (requestMethod(request) === "OPTIONS") return true;

  const resourceType = requestResourceType(request);
  const status = responseStatus(response);
  return resourceType === "other" && (status === 204 || status === 0);
}

function isRoyalMailTargetRequestUrl(currentUrl, { summaryUrl, eventsUrl, trackingNumber }) {
  if (isSameRequestUrl(currentUrl, summaryUrl) || isSameRequestUrl(currentUrl, eventsUrl)) {
    return true;
  }

  try {
    const parsed = new URL(currentUrl);
    const isRoyalMailApi = parsed.hostname === "api-web.royalmail.com";
    return isRoyalMailApi &&
      parsed.pathname.includes("/mailpieces/") &&
      parsed.pathname.includes(String(trackingNumber || ""));
  } catch (e) {
    return String(currentUrl || "").includes(String(trackingNumber || "")) &&
      String(currentUrl || "").includes("mailpieces");
  }
}

async function continueRequest(request, overrides) {
  if (typeof request.continue === "function") {
    return await request.continue(overrides);
  }
  if (typeof request.continue_ === "function") {
    return await request.continue_(overrides);
  }
}

async function rewriteRoyalMailSummaryRequest(request, { summaryUrl, eventsUrl }) {
  if (isSameRequestUrl(requestUrl(request), summaryUrl)) {
    royalMailLog("rewrite summary request to events", {
      from: requestUrl(request),
      to: eventsUrl,
    });
    await continueRequest(request, { url: eventsUrl });
    return true;
  }
  return false;
}

async function handleRoyalMailEventsResponse({
  response,
  eventsUrl,
  getIsResolved,
  setResolved,
  clearTimers,
  cleanup,
  resolve,
  reject,
  markContextUnhealthy,
}) {
  const currentUrl = responseUrl(response);
  if (!isSameRequestUrl(currentUrl, eventsUrl)) return false;
  if (getIsResolved()) return true;

  const status = responseStatus(response);
  if (isPreflightResponse(response)) {
    royalMailLog("ignore events preflight response", {
      status,
      url: currentUrl,
    });
    return true;
  }

  royalMailLog("events response received", {
    status,
    url: currentUrl,
  });

  const body = await responseBody(response);
  setResolved(true);
  clearTimers();
  await cleanup();
  resolve({
    status,
    url: currentUrl,
    ok: status >= 200 && status < 300,
    body,
  });
  return true;
}

async function handleRoyalMailRequestFailure({
  request,
  target,
  getIsResolved,
  setResolved,
  clearTimers,
  cleanup,
  resolve,
  markContextUnhealthy,
}) {
  const currentUrl = requestUrl(request);
  const resourceType = requestResourceType(request);
  if (!isRoyalMailTargetRequestUrl(currentUrl, target)) return false;
  if (getIsResolved()) return true;

  const failure = requestFailureText(request);
  royalMailLog("target request failed", {
    method: requestMethod(request),
    resourceType,
    url: currentUrl,
    failure,
  });

  setResolved(true);
  clearTimers();
  markContextUnhealthy(`royal mail target request failed: ${failure}`);
  await cleanup();
  resolve({
    status: null,
    url: currentUrl,
    ok: false,
    requestFailed: true,
    failure,
    resourceType,
    body: null,
  });
  return true;
}

async function suppressRoyalMailCookieOverlay(page) {
  try {
    const result = await page.evaluate(() => {
      const selectors = [
        "#truste-consent-track",
        "#truste-consent-content",
        "#truste-consent-buttons",
        ".truste_box_overlay",
        ".truste_overlay",
        ".truste_popframe",
        "#consent_blackbar",
        ".trustarc-banner",
        "[id*='truste']",
      ];
      const matched = new Set();
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((element) => {
          matched.add(selector);
          element.remove();
        });
      }
      document.documentElement.style.overflow = "auto";
      document.body.style.overflow = "auto";
      document.body.style.pointerEvents = "auto";
      return {
        removedSelectorCount: matched.size,
        matchedSelectors: Array.from(matched),
      };
    });
    royalMailLog("cookie overlay suppressed without clicking", result);
    return result;
  } catch (e) {
    royalMailLog("cookie overlay suppress failed", e.message);
    return null;
  }
}

async function logRoyalMailPageState(page, phase) {
  if (!ROYAL_MAIL_DEBUG) return null;
  try {
    const state = await page.evaluate(() => {
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
      };
      const cookieSelectors = [
        "#truste-consent-track",
        "#truste-consent-content",
        ".truste_box_overlay",
        ".truste_overlay",
        "#consent_blackbar",
        "[id*='truste']",
      ];
      const cookieElements = cookieSelectors
        .map((selector) => ({ selector, count: document.querySelectorAll(selector).length }))
        .filter((entry) => entry.count > 0);
      const trackingInput = document.querySelector("input[name='trackingNumber'], input#trackingNumber, input[type='text']");
      const moreDetails = document.querySelector("#btn-more-details");
      return {
        href: window.location.href,
        hash: window.location.hash,
        title: document.title,
        readyState: document.readyState,
        cookieElements,
        trackingInputVisible: visible(trackingInput),
        moreDetailsVisible: visible(moreDetails),
        bodyTextSample: (document.body?.innerText || "").slice(0, 300),
      };
    });
    royalMailLog(`page state: ${phase}`, state);
    return state;
  } catch (e) {
    royalMailLog(`page state failed: ${phase}`, e.message);
    return null;
  }
}

async function ensureRoyalMailTrackingHash(page, trackingNumber) {
  try {
    const result = await page.evaluate((value) => {
      const expectedHash = `#/tracking-results/${value}`;
      const before = window.location.hash;
      if (window.location.hash !== expectedHash) {
        const url = `${window.location.origin}/track-your-item${expectedHash}`;
        window.history.replaceState(window.history.state, document.title, url);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
      }
      return {
        before,
        after: window.location.hash,
        changed: before !== window.location.hash,
      };
    }, trackingNumber);
    royalMailLog("ensure tracking hash", result);
  } catch (e) {
    royalMailLog("ensure tracking hash failed", e.message);
  }
}

async function triggerRoyalMailTracking(page, trackingNumber) {
  try {
    const submitted = await page.evaluate((value) => {
      const visible = (element) => {
        if (!element) return false;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0";
      };

      const input = document.querySelector("#barcode-input") ||
        Array.from(document.querySelectorAll("input")).find((candidate) => {
          const placeholder = (candidate.getAttribute("placeholder") || "").toLowerCase();
          const name = (candidate.getAttribute("name") || "").toLowerCase();
          const id = (candidate.getAttribute("id") || "").toLowerCase();
          return visible(candidate) && (
            placeholder.includes("aa123456789us") ||
            id === "barcode-input" ||
            name === "barcode" ||
            name === "trackingnumber"
          );
        });
      if (input && visible(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        if (descriptor && descriptor.set) {
          descriptor.set.call(input, value);
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        const buttons = Array.from(document.querySelectorAll("button"));
        const submit = buttons.find((candidate) => {
          const text = (candidate.textContent || "").trim().toLowerCase();
          const id = (candidate.getAttribute("id") || "").toLowerCase();
          return visible(candidate) && (
            text.includes("track your delivery") ||
            id === "btn-track"
          );
        });
        if (submit && visible(submit)) {
          submit.click();
          return true;
        }
      }

      const moreDetails = document.querySelector("#btn-more-details");
      if (moreDetails && visible(moreDetails)) {
        moreDetails.click();
        return true;
      }

      return false;
    }, trackingNumber);

    if (submitted) {
      await sleep(2000);
    }
    royalMailLog("trigger tracking result", { submitted: Boolean(submitted) });
    return Boolean(submitted);
  } catch (e) {
    royalMailLog("trigger tracking evaluate failed", e.message);
    try {
      const moreDetails = await page.locator("xpath=//button[@id='btn-more-details']");
      if (moreDetails) {
        await moreDetails.click();
        await sleep(2000);
        royalMailLog("clicked more details fallback");
        return true;
      }
    } catch (fallbackError) {
      royalMailLog("more details fallback failed", fallbackError.message);
    }
  }
  royalMailLog("trigger tracking result", { submitted: false });
  return false;
}

function getHcapSource({ url, proxy, operationType, operationConfig, userAgent, trackingNumber }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");

    const royalMailTrackingNumber = parseRoyalMailTrackingNumber({
      url,
      trackingNumber,
      operationConfig,
    });
    const isRoyalMail = isRoyalMailTrackingUrl(url) && Boolean(royalMailTrackingNumber);
    const royalMailUrls = isRoyalMail ? buildRoyalMailUrls(royalMailTrackingNumber) : null;
    if (isRoyalMail) {
      royalMailLog("source request initialized", {
        url,
        trackingNumber: royalMailTrackingNumber,
        summaryUrl: royalMailUrls.summaryUrl,
        eventsUrl: royalMailUrls.eventsUrl,
      });
    }

    let context = null;
    let page = null;
    let isResolved = false;
    let contextClosed = false;
    let shouldReuseContext = true;
    let discardReason = "";

    const markContextUnhealthy = (reason) => {
      shouldReuseContext = false;
      if (!discardReason) {
        discardReason = reason;
      }
    };

    const cleanup = async () => {
      if (page) {
        try {
          await page.close().catch(() => {});
        } catch (e) {}
      }
      if (context && !contextClosed) {
        try {
          contextClosed = true;
          // 使用上下文池释放上下文
          if (
            global.contextPool &&
            typeof global.contextPool.releaseContext === "function"
          ) {
            await global.contextPool.releaseContext(context, {
              forceClose: !shouldReuseContext,
              reason: discardReason || undefined,
            });
          } else {
            // 回退到直接关闭
            await context.close();
          }
        } catch (e) {
          console.error("Error releasing context:", e.message);
        }
      }
    };

    let pageOperationTimeout = null;

    const clearTimers = () => {
      clearTimeout(timeoutHandler);
      if (pageOperationTimeout) {
        clearTimeout(pageOperationTimeout);
        pageOperationTimeout = null;
      }
    };

    const timeoutHandler = setTimeout(async () => {
      if (!isResolved) {
        isResolved = true;
        markContextUnhealthy("hcaptcha source timeout");
        await cleanup();
        reject("Timeout Error - cf_clearance cookie not obtained");
      }
    }, global.timeOut || 120000);

    try {
      // 使用上下文池获取上下文
      if (
        global.contextPool &&
        typeof global.contextPool.getContext === "function"
      ) {
        context = await global.contextPool.getContext(proxy);
      } else {
        // 回退到直接创建
        context = await global.browser
          .createBrowserContext({
            proxyServer: proxy
              ? `http://${proxy.host}:${proxy.port}`
              : undefined,
          })
          .catch(() => null);
      }

      if (!context) {
        clearTimeout(timeoutHandler);
        return reject("Failed to create browser context");
      }

      page = await context.newPage();
      await applyUserAgent(page, userAgent);

      if (proxy?.username && proxy?.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      await page.setRequestInterception(true);
      const allow = [
        // main page + config
        /^https:\/\/www\.royalmail\.com\/track-your-item(?:#.*)?$/,
        /^https:\/\/royalmail\.com\/track-your-item(?:#.*)?$/,
        /^https:\/\/www\.royalmail\.com\/spalp\/rml_track_and_trace\/json$/,
        /^https:\/\/royalmail\.com\/spalp\/rml_track_and_trace\/json$/,
        // core JS (包含 hcaptcha/recaptcha 逻辑)
        /^https:\/\/www\.royalmail\.com\/sites\/royalmail\.com\/files\/js\/js_[^/]+\.js$/,
        /^https:\/\/royalmail\.com\/sites\/royalmail\.com\/files\/js\/js_[^/]+\.js$/,
        // target API
        /^https:\/\/api-web\.royalmail\.com\/mailpieces\/microsummary\/v1\/summary\//,
        /^https:\/\/api-web\.royalmail\.com\/mailpieces\/v3\/[^/]+\/events/,
        // hcaptcha
        /^https:\/\/hcaptcha\.com\/1\/api\.js/,
        /^https:\/\/newassets\.hcaptcha\.com\//,
        /^https:\/\/api\.hcaptcha\.com\//,
      ];
      page.on("request", async (req) => {
        const currentUrl = requestUrl(req);
        if (isRoyalMail && (
          currentUrl.includes("mailpieces/") ||
          currentUrl.includes("hcaptcha") ||
          currentUrl.includes("rml_track_and_trace")
        )) {
          royalMailLog("request", {
            method: requestMethod(req),
            resourceType: requestResourceType(req),
            url: currentUrl,
          });
        }
        if (isRoyalMail && await rewriteRoyalMailSummaryRequest(req, royalMailUrls)) return;
        if (allow.some(r => r.test(currentUrl))) return continueRequest(req);
        // 兜底：允许同源 XHR/Fetch (必要时)
        const resourceType = requestResourceType(req);
        if (resourceType === 'xhr' || resourceType === 'fetch') {
          if (
            currentUrl.startsWith('https://www.royalmail.com/') ||
            currentUrl.startsWith('https://royalmail.com/')
          ) return continueRequest(req);
        }
        // return req.abort();
        return continueRequest(req);
      });
      page.on("requestfailed", async (req) => {
        try {
          if (!isRoyalMail) return;
          const currentUrl = requestUrl(req);
          if (
            currentUrl.includes("mailpieces/") ||
            currentUrl.includes(royalMailTrackingNumber)
          ) {
            royalMailLog("request failed", {
              method: requestMethod(req),
              resourceType: requestResourceType(req),
              url: currentUrl,
              failure: requestFailureText(req),
            });
          }

          await handleRoyalMailRequestFailure({
            request: req,
            target: {
              ...royalMailUrls,
              trackingNumber: royalMailTrackingNumber,
            },
            getIsResolved: () => isResolved,
            setResolved: (value) => { isResolved = value; },
            clearTimers,
            cleanup,
            resolve,
            markContextUnhealthy,
          });
        } catch (e) {
          royalMailLog("request failed handler error", e.message);
        }
      });
      page.on("response", async (res) => {
        try {
          if (isRoyalMail) {
            const currentResponseUrl = responseUrl(res);
            if (
              currentResponseUrl.includes("mailpieces/") ||
              currentResponseUrl.includes("hcaptcha") ||
              currentResponseUrl.includes("rml_track_and_trace")
            ) {
              royalMailLog("response", {
                status: responseStatus(res),
                url: currentResponseUrl,
              });
            }
          }
          if (isRoyalMail) {
            const handled = await handleRoyalMailEventsResponse({
              response: res,
              eventsUrl: royalMailUrls.eventsUrl,
              getIsResolved: () => isResolved,
              setResolved: (value) => { isResolved = value; },
              clearTimers,
              cleanup,
              resolve,
              reject,
              markContextUnhealthy,
            });
            if (handled) return;
          }

          // 429 限频 直接关闭
          if (
            [429].includes(res.status()) &&
            [url, url + "/"].includes(res.url())
          ) {
            const cookies = await page.cookies();
            await page.deleteCookie(...cookies);
            isResolved = true;
            clearTimers();
            markContextUnhealthy("rate limit exceeded");
            await cleanup();
            resolve("Rate Limit Exceeded");
            return;
          }

          // console.log(await res.text())
          // console.log(!(await res.text()).includes("Just a moment..."))

          // 403 禁止访问 直接关闭
          if (
            [403].includes(res.status()) &&
            [url, url + "/"].includes(res.url()) &&
            !(await res.text()).includes("Just a moment...")
          ) {
            isResolved = true;
            clearTimers();
            markContextUnhealthy("completely forbidden");
            await cleanup();
            resolve("Completely Forbidden");
            return;
          }

          // console.log(res.url());
          // 如果提供了操作配置，在获取 HTML 之前执行页面操作
          if (!isRoyalMail &&
            res.url().includes(
              "mailpieces/microsummary/v1/summary",
            )
          ) {
            // if (operationType && operationConfig) {
            //   try {
            //     // 等待2秒
            //     // await new Promise(resolve => setTimeout(resolve, 2000));

            //     await executePageOperation(
            //       page,
            //       operationType,
            //       {
            //         "buttonXpathArr": [
            //           operationConfig
            //             .buttonXpathArr[
            //               operationConfig.buttonXpathArr.length - 1
            //             ],
            //         ],
            //       },
            //     );
            //   } catch (operationError) {
            //     isResolved = true;
            //     clearTimeout(timeoutHandler);
            //     await cleanup();
            //     reject(`Page operation failed: ${operationError.message}`);
            //   }
            // }

            if (res.status() !== 200) {
              isResolved = true;
              clearTimers();
              markContextUnhealthy(`hcaptcha summary status ${res.status()}`);
              await cleanup();
              reject(`Failed to get hcaptcha source info, status code: ${res.status()}`);
              return;
            }
            const html = await res.json();
            isResolved = true;
            clearTimers();
            await cleanup();
            resolve(html);
          }

          if (
            (!isRoyalMail && res.url().includes("https://api.hcaptcha.com/getcaptcha")) ||
            (!isRoyalMail && res.url().includes(
              "mailpieces/microsummary/v1/summary",
            ))
          ) {
            // 如果提供了操作配置，在获取 HTML 之前执行页面操作
            if (operationType && operationConfig) {
              try {
                await executePageOperation(
                  page,
                  operationType,
                  {
                    "buttonXpathArr": [operationConfig.buttonXpathArr[0]],
                  },
                );
              } catch (operationError) {
                if (operationError instanceof PageOperationEarlyTermination || operationError?.isPageOperationEarlyTermination) {
                  isResolved = true;
                  clearTimers();
                  await cleanup();
                  resolve(operationError.result);
                  return;
                }

                isResolved = true;
                clearTimers();
                markContextUnhealthy(`page operation failed: ${operationError.message}`);
                await cleanup();
                reject(`Page operation failed: ${operationError.message}`);
              }
            }
          }

          if (!isRoyalMail &&
            res.url().includes("mailpieces/v3") &&
            res.url().includes("/events")
          ) {
            if (res.status() !== 200) {
              isResolved = true;
              clearTimers();
              markContextUnhealthy(`hcaptcha events status ${res.status()}`);
              await cleanup();
              reject(`Failed to get hcaptcha source info, status code: ${res.status()}`);
              return;
            }
            const html = await res.json();
            isResolved = true;
            clearTimers();
            await cleanup();
            resolve(html);
          }
        } catch (e) {}
      });
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      if (isRoyalMail) {
        royalMailLog("goto completed", { url });
        await logRoyalMailPageState(page, "after goto");
      }

      if (isRoyalMail) {
        await suppressRoyalMailCookieOverlay(page);
        await logRoyalMailPageState(page, "after cookie overlay suppress");

        if (!isResolved) {
          await ensureRoyalMailTrackingHash(page, royalMailTrackingNumber);
          await logRoyalMailPageState(page, "after ensure hash");
        }
        if (!isResolved) {
          await triggerRoyalMailTracking(page, royalMailTrackingNumber);
          await logRoyalMailPageState(page, "after trigger tracking");
        }
      }

      if (isResolved) return;
      if (isRoyalMail) {
        royalMailLog("waiting for events response", {
          timeoutMs: 120000,
          eventsUrl: royalMailUrls.eventsUrl,
        });
      }

      // 最大超时时间 2 min
      pageOperationTimeout = setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          clearTimers();
          markContextUnhealthy("hcaptcha page operation timeout");
          if (isRoyalMail) {
            await logRoyalMailPageState(page, "page operation timeout");
          }
          await cleanup();
          reject("Timeout Error - page operation not completed");
        }
      }, 120000);
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimers();
        markContextUnhealthy(e.message || "hcaptcha source failed");
        await cleanup();
        reject(e.message || "Unknown error while getting source info");
      }
    }
  });
}
module.exports = getHcapSource;
module.exports.isRoyalMailTrackingUrl = isRoyalMailTrackingUrl;
module.exports.parseRoyalMailTrackingNumber = parseRoyalMailTrackingNumber;
module.exports.buildRoyalMailUrls = buildRoyalMailUrls;
module.exports.rewriteRoyalMailSummaryRequest = rewriteRoyalMailSummaryRequest;
module.exports.handleRoyalMailEventsResponse = handleRoyalMailEventsResponse;
module.exports.handleRoyalMailRequestFailure = handleRoyalMailRequestFailure;
module.exports.triggerRoyalMailTracking = triggerRoyalMailTracking;

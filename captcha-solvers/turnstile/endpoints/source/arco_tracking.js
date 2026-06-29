const { applyUserAgent } = require("../../module/pageOptions");

const DEFAULT_PAGE_URL = "https://www.arcospedizioni.it/en/";
const DEFAULT_TARGET_URL = "https://www.arcospedizioni.it/en/shipping-tracking-2/";
const DEFAULT_TIMEOUT_MS = 120000;

const BLOCKED_HOSTS = new Set([
  "b.delivery.consentmanager.net",
  "cdn.consentmanager.net",
  "consentmanager.mgr.consensu.org",
  "pagead2.googlesyndication.com",
  "googleads.g.doubleclick.net",
  "stats.g.doubleclick.net",
  "www.googletagmanager.com",
  "www.google-analytics.com",
  "analytics.google.com",
  "fonts.gstatic.com",
]);

const BLOCKED_RESOURCE_TYPES = new Set(["image", "font", "media", "manifest"]);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function callMaybe(value, ...args) {
  return typeof value === "function" ? value(...args) : value;
}

function responseUrl(response) {
  return String(callMaybe(response.url?.bind?.(response) || response.url) || "");
}

function requestResourceType(request) {
  if (!request) return null;
  return String(callMaybe(request.resourceType?.bind?.(request) || request.resourceType || request.resource_type) || "");
}

async function responseText(response) {
  if (typeof response.text === "function") {
    return await response.text();
  }

  if (typeof response.body === "function") {
    const body = await response.body();
    return Buffer.isBuffer(body) ? body.toString("utf8") : String(body || "");
  }

  return "";
}

function requestUrl(request) {
  return String(callMaybe(request.url?.bind?.(request) || request.url) || "");
}

async function continueRequest(requestOrRoute) {
  if (typeof requestOrRoute.continue === "function") return await requestOrRoute.continue();
  if (typeof requestOrRoute.continue_ === "function") return await requestOrRoute.continue_();
}

async function abortRequest(requestOrRoute) {
  if (typeof requestOrRoute.abort === "function") return await requestOrRoute.abort();
}

function isTargetResponse(responseUrlValue, targetUrl = DEFAULT_TARGET_URL) {
  if (!responseUrlValue || !targetUrl) return false;
  if (responseUrlValue.includes(targetUrl)) return true;

  try {
    const responseParsed = new URL(responseUrlValue);
    const targetParsed = new URL(targetUrl);
    return responseParsed.origin === targetParsed.origin &&
      responseParsed.pathname === targetParsed.pathname;
  } catch (e) {
    return false;
  }
}

function shouldBlockArcoRequest(requestUrlValue, resourceType, targetUrl = DEFAULT_TARGET_URL) {
  if (!requestUrlValue || isTargetResponse(requestUrlValue, targetUrl)) return false;

  let parsed;
  try {
    parsed = new URL(requestUrlValue);
  } catch (e) {
    return false;
  }

  if (BLOCKED_HOSTS.has(parsed.host.toLowerCase())) return true;
  return BLOCKED_RESOURCE_TYPES.has(String(resourceType || "").toLowerCase());
}

async function installArcoRequestFilter(page, targetUrl) {
  const handleRequest = async (request, fallbackRoute) => {
    const requestOrRoute = fallbackRoute || request;
    try {
      if (shouldBlockArcoRequest(requestUrl(request), requestResourceType(request), targetUrl)) {
        return await abortRequest(requestOrRoute);
      }
      return await continueRequest(requestOrRoute);
    } catch (e) {
      try {
        return await continueRequest(requestOrRoute);
      } catch (_) {}
    }
  };

  if (typeof page.setRequestInterception === "function") {
    await page.setRequestInterception(true);
    page.on("request", handleRequest);
    return;
  }

  if (typeof page.route === "function") {
    await page.route("**/*", async (route) => {
      const request = typeof route.request === "function" ? route.request() : route.request;
      await handleRequest(request, route);
    });
  }
}

function splitTrackingNumber(trackingNumber) {
  const value = String(trackingNumber || "").replace(/\s+/g, "");
  if (!value) return null;
  if (value.length < 15) {
    throw new Error("trackingNumber must contain at least 15 characters");
  }

  return {
    year: value.slice(0, 4),
    sender: value.slice(4, 7),
    customerCode: value.slice(7, 15),
  };
}

function resolveTrackingParts(config = {}) {
  const trackingNumber = config.trackingNumber || config.tracking_number;
  const splitParts = trackingNumber ? splitTrackingNumber(trackingNumber) : null;

  return {
    year: String(config.year || splitParts?.year || ""),
    sender: String(config.sender || splitParts?.sender || ""),
    customerCode: String(config.customerCode || config.customer_code || splitParts?.customerCode || ""),
  };
}

async function newPage(context) {
  if (typeof context.newPage === "function") return await context.newPage();
  if (typeof context.new_page === "function") return await context.new_page();
  throw new Error("Browser context does not support newPage");
}

async function closeQuietly(target) {
  if (!target || typeof target.close !== "function") return;
  try {
    await target.close();
  } catch (e) {}
}

async function fillAndSubmitTrackingForm(page, { year, sender, customerCode }) {
  return Boolean(await page.evaluate(({ year, sender, customerCode }) => {
    const setValue = (selector, value) => {
      const input = document.querySelector(selector);
      if (!input) {
        throw new Error(`missing tracking input: ${selector}`);
      }

      input.focus();
      const descriptor = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      );
      if (descriptor && descriptor.set) {
        descriptor.set.call(input, value);
      } else {
        input.value = value;
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return input;
    };

    const yearInput = setValue("#cercasped_anno", year);
    setValue("#cercasped_sede", sender);
    setValue("#cercasped_codice", customerCode);

    const form = yearInput.closest("form") || document.querySelector("form");
    if (!form) {
      throw new Error("tracking form not found");
    }

    form.removeAttribute("target");
    form.setAttribute("target", "_self");
    document.querySelectorAll("a[target], area[target], button[formtarget], input[formtarget]").forEach((element) => {
      element.removeAttribute("target");
      element.removeAttribute("formtarget");
    });
    window.open = (url) => {
      if (url) {
        window.location.assign(url);
      }
      return window;
    };

    const submit = form.querySelector("button[type=\"submit\"], input[type=\"submit\"], button, .btn");
    if (submit) {
      submit.scrollIntoView({ block: "center", inline: "center" });
      submit.click();
      return true;
    }

    form.submit();
    return true;
  }, { year, sender, customerCode }));
}

function getArcoTrackingSource(config = {}) {
  return new Promise(async (resolve, reject) => {
    const pageUrl = config.url || config.pageUrl || DEFAULT_PAGE_URL;
    const targetUrl = config.targetUrl || DEFAULT_TARGET_URL;
    const timeoutMs = Number(config.timeoutMs || global.timeOut || DEFAULT_TIMEOUT_MS);
    const parts = resolveTrackingParts(config);

    if (!parts.year || !parts.sender || !parts.customerCode) {
      return reject(new Error("Missing Arco tracking fields: provide trackingNumber or year/sender/customerCode"));
    }

    let context = null;
    let page = null;
    let isResolved = false;
    let contextClosed = false;
    let navigationError = null;

    const finish = async (result, rejectResult = false) => {
      if (isResolved) return;
      isResolved = true;
      clearTimeout(timeoutHandler);
      await closeQuietly(page);

      if (context && !contextClosed) {
        contextClosed = true;
        try {
          if (global.contextPool && typeof global.contextPool.releaseContext === "function") {
            const reason = result instanceof Error ? result.message : undefined;
            await global.contextPool.releaseContext(context, {
              forceClose: Boolean(rejectResult),
              reason,
            });
          } else {
            await closeQuietly(context);
          }
        } catch (e) {
          console.error("Error releasing Arco tracking context:", e.message);
        }
      }

      if (rejectResult) {
        reject(result instanceof Error ? result : new Error(String(result)));
      } else {
        resolve(result);
      }
    };

    const timeoutHandler = setTimeout(async () => {
      const error = navigationError
        ? `navigation_error: ${navigationError.message || navigationError}`
        : "target_response_timeout";
      await finish(new Error(error), true);
    }, timeoutMs);

    try {
      if (global.contextPool && typeof global.contextPool.getContext === "function") {
        context = await global.contextPool.getContext(config.proxy);
      } else if (global.browser && typeof global.browser.createBrowserContext === "function") {
        context = await global.browser.createBrowserContext({
          proxyServer: config.proxy ? `http://${config.proxy.host}:${config.proxy.port}` : undefined,
        }).catch(() => null);
      }

      if (!context) {
        clearTimeout(timeoutHandler);
        return reject(new Error("Failed to create browser context"));
      }

      page = await newPage(context);
      await applyUserAgent(page, config.userAgent);

      if (config.proxy?.username && config.proxy?.password && typeof page.authenticate === "function") {
        await page.authenticate({
          username: config.proxy.username,
          password: config.proxy.password,
        });
      }

      await installArcoRequestFilter(page, targetUrl);

      page.on("response", async (response) => {
        if (isResolved || !isTargetResponse(responseUrl(response), targetUrl)) return;

        try {
          await finish(await responseText(response));
        } catch (e) {
          await finish(e, true);
        }
      });

      try {
        await page.goto(pageUrl, {
          waitUntil: "domcontentloaded",
          timeout: timeoutMs,
        });
      } catch (e) {
        navigationError = e;
      }

      if (!isResolved) {
        const submitted = await fillAndSubmitTrackingForm(page, parts).catch((e) => {
          navigationError = e;
          return false;
        });

        if (!submitted) {
          await finish(new Error("tracking_form_submit_failed"), true);
          return;
        }
      }

      if (!isResolved) {
        if (typeof page.waitForTimeout === "function") {
          await page.waitForTimeout(timeoutMs).catch(() => {});
        } else {
          await sleep(timeoutMs);
        }
      }
    } catch (e) {
      await finish(e, true);
    }
  });
}

module.exports = getArcoTrackingSource;
module.exports.DEFAULT_PAGE_URL = DEFAULT_PAGE_URL;
module.exports.DEFAULT_TARGET_URL = DEFAULT_TARGET_URL;
module.exports.splitTrackingNumber = splitTrackingNumber;
module.exports.resolveTrackingParts = resolveTrackingParts;
module.exports.fillAndSubmitTrackingForm = fillAndSubmitTrackingForm;
module.exports.isTargetResponse = isTargetResponse;
module.exports.shouldBlockArcoRequest = shouldBlockArcoRequest;

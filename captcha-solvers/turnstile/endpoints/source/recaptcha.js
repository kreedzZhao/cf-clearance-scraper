const { executePageOperation, PageOperationEarlyTermination } = require("../operations/query");
const { applyUserAgent } = require("../../module/pageOptions");

async function forceCurrentTabNavigation(page) {
  return await page.evaluate(() => {
    const targetElements = Array.from(document.querySelectorAll('form[target="_blank"], a[target="_blank"]'));
    const formTargetElements = Array.from(document.querySelectorAll('button[formtarget="_blank"], input[formtarget="_blank"]'));

    for (const element of targetElements) {
      element.setAttribute("target", "_self");
    }

    for (const element of formTargetElements) {
      element.setAttribute("formtarget", "_self");
    }

    return {
      targetUpdated: targetElements.length,
      formTargetUpdated: formTargetElements.length,
    };
  });
}

function attachTargetResponseHandlers({
  page,
  url,
  targetUrl,
  getIsResolved,
  setResolved,
  clearTimers,
  cleanup,
  resolve,
  reject,
  markContextUnhealthy,
}) {
  const handleResponse = async (res) => {
    try {
      if (getIsResolved()) return;

      // 429 限频
      if (
        url &&
        [429].includes(res.status()) &&
        [url, url + "/"].includes(res.url())
      ) {
        setResolved(true);
        clearTimers();
        markContextUnhealthy("rate limit exceeded");
        await cleanup();
        resolve("Rate Limit Exceeded");
        return;
      }

      // 监控当前页面上的目标 API/页面响应。
      if (res.url().includes(targetUrl)) {
        console.log(`[recaptcha] Target API response: ${res.status()} ${res.url()}`);

        if (res.status() !== 200) {
          setResolved(true);
          clearTimers();
          markContextUnhealthy(`target API status ${res.status()}`);
          await cleanup();
          reject(`Target API failed, status code: ${res.status()}`);
          return;
        }

        // 尝试 JSON 解析，失败则返回文本
        let data;
        try {
          data = await res.json();
        } catch (e) {
          data = await res.text();
        }

        setResolved(true);
        clearTimers();
        await cleanup();
        resolve(data);
      }
    } catch (e) {}
  };

  page.on("response", handleResponse);

  return {
    detach() {
      if (typeof page.off === "function") {
        page.off("response", handleResponse);
      }
    },
  };
}

function getRecaptchaSource({ url, proxy, operationType, operationConfig, targetUrl, userAgent }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");
    if (!targetUrl) return reject("Missing targetUrl parameter");

    let context = null;
    let page = null;
    let isResolved = false;
    let contextClosed = false;
    let shouldReuseContext = true;
    let discardReason = "";
    let responseHandlers = null;
    let operationTimeoutHandler = null;

    const markContextUnhealthy = (reason) => {
      shouldReuseContext = false;
      if (!discardReason) {
        discardReason = reason;
      }
    };

    const clearTimers = () => {
      clearTimeout(timeoutHandler);
      if (operationTimeoutHandler) {
        clearTimeout(operationTimeoutHandler);
        operationTimeoutHandler = null;
      }
    };

    const cleanup = async () => {
      if (responseHandlers) {
        responseHandlers.detach();
        responseHandlers = null;
      }
      if (page) {
        try {
          await page.close().catch(() => {});
        } catch (e) {}
      }
      if (context && !contextClosed) {
        try {
          contextClosed = true;
          if (global.contextPool && typeof global.contextPool.releaseContext === "function") {
            await global.contextPool.releaseContext(context, {
              forceClose: !shouldReuseContext,
              reason: discardReason || undefined,
            });
          } else {
            await context.close();
          }
        } catch (e) {
          console.error("Error releasing context:", e.message);
        }
      }
    };

    const timeoutHandler = setTimeout(async () => {
      if (!isResolved) {
        isResolved = true;
        markContextUnhealthy("recaptcha source timeout");
        await cleanup();
        reject("Timeout Error - recaptcha source not obtained");
      }
    }, global.timeOut || 120000);

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

      responseHandlers = attachTargetResponseHandlers({
        page,
        url,
        targetUrl,
        getIsResolved: () => isResolved,
        setResolved: (value) => {
          isResolved = value;
        },
        clearTimers,
        cleanup,
        resolve,
        reject,
        markContextUnhealthy,
      });

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // 执行页面操作（输入 + 点击）
      if (operationType && operationConfig) {
        try {
          await forceCurrentTabNavigation(page);
          await executePageOperation(page, operationType, operationConfig, {
            beforeClick: () => forceCurrentTabNavigation(page),
          });
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
          return;
        }
      }

      // 最大超时时间 2 min
      operationTimeoutHandler = setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          clearTimers();
          markContextUnhealthy("recaptcha page operation timeout");
          await cleanup();
          reject("Timeout Error - page operation not completed");
        }
      }, 120000);
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimers();
        markContextUnhealthy(e.message || "recaptcha source failed");
        await cleanup();
        reject(e.message || "Unknown error while getting recaptcha source");
      }
    }
  });
}

module.exports = getRecaptchaSource;
module.exports.attachTargetResponseHandlers = attachTargetResponseHandlers;
module.exports.forceCurrentTabNavigation = forceCurrentTabNavigation;

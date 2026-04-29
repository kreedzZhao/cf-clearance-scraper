const { executePageOperation, PageOperationEarlyTermination } = require("../operations/query");

function getRecaptchaSource({ url, proxy, operationType, operationConfig, targetUrl }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");
    if (!targetUrl) return reject("Missing targetUrl parameter");

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

      if (proxy?.username && proxy?.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      await page.setRequestInterception(true);
      page.on("request", async (request) => request.continue());

      page.on("response", async (res) => {
        try {
          if (isResolved) return;

          // 429 限频
          if (
            [429].includes(res.status()) &&
            [url, url + "/"].includes(res.url())
          ) {
            isResolved = true;
            clearTimeout(timeoutHandler);
            markContextUnhealthy("rate limit exceeded");
            await cleanup();
            resolve("Rate Limit Exceeded");
            return;
          }

          // 监控目标 API 响应
          if (res.url().includes(targetUrl)) {
            console.log(`[recaptcha] Target API response: ${res.status()} ${res.url()}`);

            if (res.status() !== 200) {
              isResolved = true;
              clearTimeout(timeoutHandler);
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

            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(data);
          }
        } catch (e) {}
      });

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // 执行页面操作（输入 + 点击）
      if (operationType && operationConfig) {
        try {
          await executePageOperation(page, operationType, operationConfig);
        } catch (operationError) {
          if (operationError instanceof PageOperationEarlyTermination || operationError?.isPageOperationEarlyTermination) {
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(operationError.result);
            return;
          }

          isResolved = true;
          clearTimeout(timeoutHandler);
          markContextUnhealthy(`page operation failed: ${operationError.message}`);
          await cleanup();
          reject(`Page operation failed: ${operationError.message}`);
          return;
        }
      }

      // 最大超时时间 2 min
      setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandler);
          markContextUnhealthy("recaptcha page operation timeout");
          await cleanup();
          reject("Timeout Error - page operation not completed");
        }
      }, 120000);
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandler);
        markContextUnhealthy(e.message || "recaptcha source failed");
        await cleanup();
        reject(e.message || "Unknown error while getting recaptcha source");
      }
    }
  });
}

module.exports = getRecaptchaSource;

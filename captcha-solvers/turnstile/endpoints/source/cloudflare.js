const { executePageOperation, PageOperationEarlyTermination } = require("../operations/query.js");
const { applyUserAgent } = require("../../module/pageOptions");

function getCfSource({ url, proxy, operationType, operationConfig, targetContent, userAgent }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");

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
          if (global.contextPool && typeof global.contextPool.releaseContext === 'function') {
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
    
    const timeoutHandler = setTimeout(async () => {
      if (!isResolved) {
        isResolved = true;
        markContextUnhealthy("cloudflare source timeout");
        await cleanup();
        reject("Timeout Error - cf_clearance cookie not obtained");
      }
    }, global.timeOut || 120000);

    try {
      // 使用上下文池获取上下文
      if (global.contextPool && typeof global.contextPool.getContext === 'function') {
        context = await global.contextPool.getContext(proxy);
      } else {
        // 回退到直接创建
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

      if (proxy?.username && proxy?.password)
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });

      const isMultiStepOperation = operationType === 'MULTI_INPUT_AND_CLICK';
      let operationStarted = false;
      let operationDone = !isMultiStepOperation; // 单步操作无需等待，多步操作需等操作完成

      await page.setRequestInterception(true);
      page.on("request", async (request) => request.continue());
      page.on("response", async (res) => {
        try {
          if (isResolved) return;

          // 429 限频 直接关闭
          if (
            [429].includes(res.status()) &&
            res.url().includes(url)
          ) {
            const cookies = await page.cookies();
            await page.deleteCookie(...cookies);
            isResolved = true;
            clearTimeout(timeoutHandler);
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
            res.url().includes(url) &&
            !(await res.text()).includes("Just a moment...")
          ) {
            isResolved = true;
            clearTimeout(timeoutHandler);
            markContextUnhealthy("completely forbidden");
            await cleanup();
            resolve("Completely Forbidden");
            return;
          }

          if (
            [200, 302].includes(res.status()) &&
            res.url().includes(url)
          ) {
            const html = await res.text();

            // 如果提供了操作配置，且操作尚未开始，执行页面操作
            if (operationType && operationConfig && !operationStarted) {
              operationStarted = true;

              if (html.includes("could not be found. Please try again!")){
                isResolved = true;
                clearTimeout(timeoutHandler);
                markContextUnhealthy("tracking not found");
                await cleanup();
                resolve(`Tracking not found`);
                return;
              }

              try {
                await executePageOperation(page, operationType, operationConfig);
                operationDone = true;
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

              if (isMultiStepOperation) {
                return; // 多步骤操作：不在此响应上 resolve，等待最终响应
              }
            }

            // 多步骤操作进行中，跳过中间响应
            if (!operationDone) {
              return;
            }

            // 检查响应体是否包含目标内容
            if (targetContent) {
              const includes = Array.isArray(targetContent) ? targetContent : [targetContent];
              if (!includes.some(str => html.includes(str))) {
                return;
              }
            }

            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(html);
          }
        } catch (e) {}
      });
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      // 最大超时时间 2 min
      setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandler);
          markContextUnhealthy("cloudflare page operation timeout");
          await cleanup();
          reject("Timeout Error - page operation not completed");
        }
      }, 120000);
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandler);
        markContextUnhealthy(e.message || "cloudflare source failed");
        await cleanup();
        reject(e.message || 'Unknown error while getting source info');
      }
    }
  });
}
module.exports = getCfSource;

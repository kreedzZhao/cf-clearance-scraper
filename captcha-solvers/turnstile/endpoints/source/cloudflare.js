const { executePageOperation, PageOperationEarlyTermination, matchStopCondition } = require("../operations/query.js");
const { applyUserAgent } = require("../../module/pageOptions");
const { matchesResponseUrl, normalizePatterns, normalizeStatusList } = require("../../module/responseMatch");

const DEFAULT_CAPTURE_NOT_FOUND_STATUS = [404];
const CAPTURE_STOP_POLL_INTERVAL_MS = 500;

function getRequestMethod(res) {
  try {
    const request = typeof res.request === "function" ? res.request() : null;
    if (!request) return "";
    const method = typeof request.method === "function" ? request.method() : request.method;
    return String(method || "").toUpperCase();
  } catch (e) {
    return "";
  }
}

function getCfSource({ url, proxy, operationType, operationConfig, targetContent, userAgent, captureUrl, captureNotFoundStatus, captureFailStatus, captureTimeoutMs, captureStopConditions }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");

    let context = null;
    let page = null;
    let isResolved = false;
    let contextClosed = false;
    let shouldReuseContext = true;
    let discardReason = "";

    // 捕获通道：数据不在文档 HTML 里、而是由页面异步接口返回时使用
    const capturePatterns = normalizePatterns(captureUrl);
    const captureEnabled = capturePatterns.length > 0;
    const captureNotFoundStatusList = normalizeStatusList(
      captureNotFoundStatus,
      DEFAULT_CAPTURE_NOT_FOUND_STATUS
    );
    const captureFailStatusList = normalizeStatusList(captureFailStatus, []);
    let lastCaptureFailure = null;
    let operationTimeoutHandler = null;
    let captureTimeoutHandler = null;
    let captureStopPoller = null;

    // 捕获兜底：captureTimeoutMs 内没拿到捕获结果就结束并关 tab，不再挂到 120s 全局超时。
    // 只有请求体显式带 captureTimeoutMs 时才生效，未配置的 channel 行为不变。
    const armCaptureTimeout = () => {
      if (!captureEnabled || !Number.isInteger(captureTimeoutMs) || captureTimeoutMs <= 0) return;
      if (captureTimeoutHandler) return;
      captureTimeoutHandler = setTimeout(async () => {
        if (isResolved) return;
        isResolved = true;
        clearTimeout(timeoutHandler);
        markContextUnhealthy("capture timeout");
        await cleanup();
        resolve("Capture Timeout" + describeCaptureFailure());
      }, captureTimeoutMs);
    };

    const describeCaptureFailure = () =>
      lastCaptureFailure
        ? ` (last capture response: HTTP ${lastCaptureFailure.status} ${lastCaptureFailure.url})`
        : "";

    const markContextUnhealthy = (reason) => {
      shouldReuseContext = false;
      if (!discardReason) {
        discardReason = reason;
      }
    };
    
    const cleanup = async () => {
      // 已有结论后不再需要兜底定时器，避免请求结束后仍挂着 2 分钟的 timer
      if (operationTimeoutHandler) {
        clearTimeout(operationTimeoutHandler);
        operationTimeoutHandler = null;
      }
      if (captureTimeoutHandler) {
        clearTimeout(captureTimeoutHandler);
        captureTimeoutHandler = null;
      }
      if (captureStopPoller) {
        clearInterval(captureStopPoller);
        captureStopPoller = null;
      }
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
        reject("Timeout Error - cf_clearance cookie not obtained" + describeCaptureFailure());
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
      const requiresOperation = Boolean(operationType && operationConfig);
      let operationStarted = false;
      let operationDone = !isMultiStepOperation; // 单步操作无需等待，多步操作需等操作完成
      let operationCompleted = !requiresOperation; // 捕获通道用：页面操作是否已真正执行完

      await page.setRequestInterception(true);
      page.on("request", async (request) => request.continue());
      page.on("response", async (res) => {
        try {
          if (isResolved) return;

          const responseUrl = res.url();
          const isDocumentResponse = responseUrl.includes(url);
          const isCaptureResponse = captureEnabled && matchesResponseUrl(responseUrl, capturePatterns);

          // 429 限频 直接关闭
          if (
            [429].includes(res.status()) &&
            isDocumentResponse
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
            isDocumentResponse &&
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
            isDocumentResponse
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
                operationCompleted = true;
                armCaptureTimeout();
                if (captureEnabled && Array.isArray(captureStopConditions) && captureStopConditions.length > 0) {
                  let polling = false;
                  captureStopPoller = setInterval(async () => {
                    if (isResolved || polling) return;
                    polling = true;
                    try {
                      const matched = await matchStopCondition(page, captureStopConditions);
                      if (matched && !isResolved) {
                        isResolved = true;
                        clearTimeout(timeoutHandler);
                        await cleanup();
                        resolve(matched.result);
                      }
                    } catch (e) {
                    } finally {
                      polling = false;
                    }
                  }, CAPTURE_STOP_POLL_INTERVAL_MS);
                }
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

            // 配置了捕获目标且文档本身不是捕获目标时，
            // 文档响应只负责 CF 状态判定与触发页面操作，结果一律来自捕获通道
            if (captureEnabled && !isCaptureResponse) {
              return;
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
            return;
          }

          // 捕获通道：命中 captureUrl 的异步接口响应
          if (isCaptureResponse && !isDocumentResponse) {
            // 跨域 XHR 的 CORS 预检没有响应体，忽略
            if (getRequestMethod(res) === "OPTIONS") return;

            // 需要页面操作的场景，忽略操作完成前的中间请求
            if (!operationCompleted) return;

            const status = res.status();

            if (captureNotFoundStatusList.includes(status)) {
              isResolved = true;
              clearTimeout(timeoutHandler);
              await cleanup();
              resolve(`Tracking not found`);
              return;
            }

            if (captureFailStatusList.includes(status)) {
              isResolved = true;
              clearTimeout(timeoutHandler);
              markContextUnhealthy(`capture failed: HTTP ${status}`);
              await cleanup();
              resolve(`Capture Failed: HTTP ${status}`);
              return;
            }

            if (status < 200 || status >= 300) {
              // 接口可能在拿到 cf_clearance 之前先失败一次，前端会自行重试，
              // 这里只记录状态用于超时诊断，不提前终止
              lastCaptureFailure = { status, url: responseUrl };
              return;
            }

            const body = await res.text();

            if (targetContent) {
              const includes = Array.isArray(targetContent) ? targetContent : [targetContent];
              if (!includes.some(str => body.includes(str))) {
                return;
              }
            }

            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(body);
            return;
          }
        } catch (e) {}
      });
      // 不做页面操作的捕获请求（例：pos-indonesia 文档 → Turnstile → server action POST），
      // 数据请求由页面自己发起，没有"操作完成"这个时点，兜底从开始导航计时。
      // 做页面操作的请求仍在操作完成后才计时（executePageOperation 之后），行为不变。
      if (!requiresOperation) {
        armCaptureTimeout();
      }
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });

      // 最大超时时间 2 min
      operationTimeoutHandler = setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandler);
          markContextUnhealthy("cloudflare page operation timeout");
          await cleanup();
          reject("Timeout Error - page operation not completed" + describeCaptureFailure());
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

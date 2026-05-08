const { executePageOperation, PageOperationEarlyTermination } = require("../operations/query");
const { applyUserAgent } = require("../../module/pageOptions");

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getHcapSource({ url, proxy, operationType, operationConfig, userAgent }) {
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
        /^https:\/\/www\.royalmail\.com\/spalp\/rml_track_and_trace\/json$/,
        // core JS (包含 hcaptcha/recaptcha 逻辑)
        /^https:\/\/www\.royalmail\.com\/sites\/royalmail\.com\/files\/js\/js_[^/]+\.js$/,
        // target API
        /^https:\/\/api-web\.royalmail\.com\/mailpieces\/microsummary\/v1\/summary\//,
        // hcaptcha
        /^https:\/\/hcaptcha\.com\/1\/api\.js/,
        /^https:\/\/newassets\.hcaptcha\.com\//,
        /^https:\/\/api\.hcaptcha\.com\//,
      ];
      page.on("request", async (req) => {
        const url = req.url();
        if (allow.some(r => r.test(url))) return req.continue();
        // 兜底：允许同源 XHR/Fetch (必要时)
        if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
          if (url.startsWith('https://www.royalmail.com/')) return req.continue();
        }
        // return req.abort();
        return req.continue();
      });
      page.on("response", async (res) => {
        try {
          // 429 限频 直接关闭
          if (
            [429].includes(res.status()) &&
            [url, url + "/"].includes(res.url())
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
            [url, url + "/"].includes(res.url()) &&
            !(await res.text()).includes("Just a moment...")
          ) {
            isResolved = true;
            clearTimeout(timeoutHandler);
            markContextUnhealthy("completely forbidden");
            await cleanup();
            resolve("Completely Forbidden");
            return;
          }

          // console.log(res.url());
          // 如果提供了操作配置，在获取 HTML 之前执行页面操作
          if (
            res.url().includes(
              "mailpieces/microsummary/v1/summary",
            )
          ) {
            console.log(res.status(), res.url());
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
              clearTimeout(timeoutHandler);
              markContextUnhealthy(`hcaptcha summary status ${res.status()}`);
              await cleanup();
              reject(`Failed to get hcaptcha source info, status code: ${res.status()}`);
            }
            const html = await res.json();
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(html);
          }

          if (
            res.url().includes("https://api.hcaptcha.com/getcaptcha") ||
            res.url().includes(
              "mailpieces/microsummary/v1/summary",
            ) 
          ) {
            console.log(res.url());
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
              }
            }
          }

          if (
            res.url().includes("mailpieces/v3") &&
            res.url().includes("/events")
          ) {
            if (res.status() !== 200) {
              isResolved = true;
              clearTimeout(timeoutHandler);
              markContextUnhealthy(`hcaptcha events status ${res.status()}`);
              await cleanup();
              reject(`Failed to get hcaptcha source info, status code: ${res.status()}`);
            }
            const html = await res.json();
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(html);
          }
        } catch (e) {}
      });
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      // 前置操作：检查并点击 cookie consent 按钮，点击后重新跳转到目标 URL
      try {
        const consentButton = await page.locator("xpath=//button[@id='truste-consent-button']");
        if (consentButton) {
          console.log('click truste consent button');
          await consentButton.click();
          await sleep(1000);
          // 重新跳转到目标 URL
          await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
          });
        }
      } catch (e) {
        // consent 按钮不存在或点击失败，忽略继续
      }

      // 循环点击 query 按钮
      while (true) {
        try {
          // const cookieEnable = await page.locator(
          //   "xpath=//button[@id='consent_prompt_decline']",
          // );
          // if (cookieEnable) {
          //   console.log('click cookie decline button');
          //   await cookieEnable.click();
          //   // 等待一秒
          //   await page.waitForTimeout(1000);
          // }

          const queryButton = await page.locator("xpath=//button[@class='button-primary']");
          if (queryButton) {
            console.log('click query button');
            await queryButton.click();
            await sleep(3000); // 等待 3 秒
          }
        } catch (e) {
          break;
        }
      }

      // 最大超时时间 2 min
      setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandler);
          markContextUnhealthy("hcaptcha page operation timeout");
          await cleanup();
          reject("Timeout Error - page operation not completed");
        }
      }, 120000);
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandler);
        markContextUnhealthy(e.message || "hcaptcha source failed");
        await cleanup();
        reject(e.message || "Unknown error while getting source info");
      }
    }
  });
}
module.exports = getHcapSource;

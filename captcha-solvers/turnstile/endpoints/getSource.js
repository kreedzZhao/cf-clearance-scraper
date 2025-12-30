// 页面操作类型枚举
const PageOperationType = {
  INPUT_AND_CLICK: 'INPUT_AND_CLICK',  // 输入文本到 input 并点击按钮
  // 未来可扩展：CLICK_ONLY, INPUT_ONLY, WAIT, SCROLL 等
};

/**
 * 执行输入文本并点击按钮的操作
 * @param {Object} page - Puppeteer page 对象
 * @param {Object} config - 操作配置
 * @param {string} config.trackingNumber - 要输入的文本
 * @param {string} config.inputXpath - input 元素的 xpath
 * @param {string} config.buttonXpath - 按钮元素的 xpath
 */
async function executeInputAndClick(page, config) {
  const { trackingNumber, inputXpath, buttonXpath } = config;
  
  if (!trackingNumber) {
    throw new Error('trackingNumber is required for INPUT_AND_CLICK operation');
  }
  if (!inputXpath) {
    throw new Error('inputXpath is required for INPUT_AND_CLICK operation');
  }
  if (!buttonXpath) {
    throw new Error('buttonXpath is required for INPUT_AND_CLICK operation');
  }
  
  // 等待 input 元素出现（使用轮询方式，兼容性更好）
  const inputWaitStartTime = Date.now();
  const inputWaitTimeout = 10000;
  let inputElement;
  while (!inputElement && (Date.now() - inputWaitStartTime) < inputWaitTimeout) {
    inputElement = await page.locator(inputXpath);
    if (!inputElement) {
      await page.waitForTimeout(200); // 等待 200ms 后重试
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
  
  // 等待按钮元素出现
  const buttonWaitStartTime = Date.now();
  const buttonWaitTimeout = 10000;
  let buttonElement;
  while (!buttonElement && (Date.now() - buttonWaitStartTime) < buttonWaitTimeout) {
    buttonElement = await page.locator(buttonXpath);
    if (!buttonElement) {
      await page.waitForTimeout(200); // 等待 200ms 后重试
    }
  }
  if (!buttonElement) {
    throw new Error(`Button element not found within ${buttonWaitTimeout}ms: ${buttonXpath}`);
  }
  
  // 定位并点击按钮
  try {
    await buttonElement.click();
  } catch (clickError) {
    throw new Error(`Failed to click button element: ${clickError.message}`);
  }
  
  // 等待操作完成（给页面一些时间处理点击事件）
  await page
              .waitForNavigation({ waitUntil: "load", timeout: 5000 })
              .catch(() => {});
}

/**
 * 页面操作执行器 - 根据操作类型分发到对应的执行函数
 * @param {Object} page - Puppeteer page 对象
 * @param {string} operationType - 操作类型
 * @param {Object} operationConfig - 操作配置
 */
async function executePageOperation(page, operationType, operationConfig) {
  if (!operationType) {
    return; // 如果没有指定操作类型，直接返回
  }
  
  switch (operationType) {
    case PageOperationType.INPUT_AND_CLICK:
      return await executeInputAndClick(page, operationConfig);
    // 未来可扩展其他操作类型
    default:
      throw new Error(`Unsupported operation type: ${operationType}`);
  }
}

function getSource({ url, proxy, operationType, operationConfig }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");

    let context = null;
    let page = null;
    let isResolved = false;
    let contextClosed = false;
    
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
            await global.contextPool.releaseContext(context);
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

      if (proxy?.username && proxy?.password)
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });

      await page.setRequestInterception(true);
      page.on("request", async (request) => request.continue());
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
            await cleanup();
            resolve("Completely Forbidden");
            return;
          }

          if (
            [200, 302].includes(res.status()) &&
            [url, url + "/"].includes(res.url())
          ) {
            await page
              .waitForNavigation({ waitUntil: "load", timeout: 5000 })
              .catch(() => {});

              // 如果提供了操作配置，在获取 HTML 之前执行页面操作
              if (operationType && operationConfig) {
                try {
                  await executePageOperation(page, operationType, operationConfig);
                } catch (operationError) {
                  isResolved = true;
                  clearTimeout(timeoutHandler);
                  await cleanup();
                  reject(`Page operation failed: ${operationError.message}`);
                }
              }

            const html = await page.content();
            // await context.close();
            // isResolved = true;
            // clearInterval(cl);
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
          await cleanup();
          reject("Timeout Error - page operation not completed");
        }
      }, 120000);
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandler);
        await cleanup();
        reject(e.message || 'Unknown error while getting source info');
      }
    }
  });
}
module.exports = getSource;

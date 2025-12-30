function interceptor({ url, targetUrl, proxy }) {
  return new Promise(async (resolve, reject) => {
    if (!url) return reject("Missing url parameter");

    let context = null;
    let page = null;
    let isResolved = false;
    let contextClosed = false;
    let responseHandler = null;
    
    const cleanup = async () => {
      // 移除事件监听器
      if (page && responseHandler) {
        try {
          page.off("response", responseHandler);
        } catch (e) {
          // 忽略移除监听器时的错误
        }
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
        // 超时返回空数据
        resolve(null);
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

      if (proxy?.username && proxy?.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      await page.setRequestInterception(true);
      page.on("request", async (request) => request.continue());
      
      // 设置响应监听器
      responseHandler = async (res) => {
        try {
          if (isResolved) return;
          
          const responseUrl = res.url();
          
          // 如果没有指定 targetUrl，返回第一个成功的响应
          if (!targetUrl) {
            if (res.status() >= 200 && res.status() < 300) {
              try {
                const responseData = await res.text();
                isResolved = true;
                clearTimeout(timeoutHandler);
                await cleanup();
                resolve({
                  url: responseUrl,
                  status: res.status(),
                  headers: res.headers(),
                  data: responseData
                });
              } catch (e) {
                // 如果无法读取响应体，返回基本信息
                isResolved = true;
                clearTimeout(timeoutHandler);
                await cleanup();
                resolve({
                  url: responseUrl,
                  status: res.status(),
                  headers: res.headers(),
                  data: null
                });
              }
            }
            return;
          }
          
          // 如果指定了 targetUrl，检查是否匹配
          // 支持完整URL匹配或部分匹配（包含targetUrl）
          // 使用更灵活的匹配：支持完整URL、路径匹配、域名+路径匹配
          let urlMatches = false;
          try {
            const responseUrlObj = new URL(responseUrl);
            const targetUrlObj = new URL(targetUrl);
            
            // 完整URL匹配
            if (responseUrl === targetUrl) {
              urlMatches = true;
            }
            // 域名+路径匹配
            else if (responseUrlObj.origin + responseUrlObj.pathname === targetUrlObj.origin + targetUrlObj.pathname) {
              urlMatches = true;
            }
            // 路径匹配（忽略查询参数）
            else if (responseUrlObj.pathname === targetUrlObj.pathname) {
              urlMatches = true;
            }
            // 包含匹配（作为后备方案）
            else if (responseUrl.includes(targetUrl)) {
              urlMatches = true;
            }
          } catch (e) {
            // 如果URL解析失败，使用简单的字符串包含匹配
            urlMatches = responseUrl.includes(targetUrl);
          }
          
          if (urlMatches) {
            // 检查响应状态码
            if (res.status() >= 200 && res.status() < 300) {
              try {
                // 尝试获取响应数据
                const responseData = await res.text();
                isResolved = true;
                clearTimeout(timeoutHandler);
                await cleanup();
                resolve({
                  url: responseUrl,
                  status: res.status(),
                  headers: res.headers(),
                  data: responseData
                });
              } catch (e) {
                console.error("Error reading response data:", e.message);
                // 即使读取失败，也返回基本信息
                isResolved = true;
                clearTimeout(timeoutHandler);
                await cleanup();
                resolve({
                  url: responseUrl,
                  status: res.status(),
                  headers: res.headers(),
                  data: null,
                  error: "Failed to read response body: " + e.message
                });
              }
            } else {
              // 状态码不正确，返回空
            const data = await res.text();
              console.log(`Target URL found but status code is ${res.status()}, returning ${data}`);
              isResolved = true;
              clearTimeout(timeoutHandler);
              await cleanup();
              resolve(null);
            }
          }
        } catch (e) {
          console.error("Error in response handler:", e.message);
          // 不在这里 resolve/reject，让超时处理
        }
      };
      
      page.on("response", responseHandler);
      
      // 导航到目标页面
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
      
      // 如果没有指定 targetUrl，等待页面加载完成后再等待一段时间
      // 给页面一些时间发起请求
      if (!targetUrl) {
        // 等待页面完全加载
        try {
          await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 }).catch(() => {});
        } catch (e) {
          // 如果网络空闲等待超时，继续执行
        }
        
        // 额外等待一段时间让异步请求完成
        setTimeout(async () => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(null);
          }
        }, 30000); // 等待5秒让异步请求完成
      }
      
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandler);
        await cleanup();
        reject(e.message || 'Unknown error while intercepting requests');
      }
    }
  });
}

module.exports = interceptor;


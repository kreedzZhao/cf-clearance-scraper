/**
 * CF Cookie Service - 专门提取 cf_clearance cookie
 * 使用上下文池优化版本，兼容 puppeteer-real-browser
 */
async function getCfClearance({ url, proxy }) {
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
      if (proxy?.username && proxy?.password) {
        await page.authenticate({
          username: proxy.username,
          password: proxy.password,
        });
      }

      // const ipUrl = "https://ifconfig.me/";
      // await page.goto(ipUrl,{
      //   waitUntil: "domcontentloaded",
      //   timeout: 30000
      // })
      // console.log('✅ 访问 ip 页面成功');

      console.log(`正在访问: ${url}`);
      
      // 直接访问页面
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000
      });
      
      // 等待页面完全加载，让 Cloudflare 有时间设置 cookie
      console.log('等待页面加载和 Cloudflare 验证...');
      
      let maxWaitTime = 90; // 等待90秒
      let checkInterval = 3; // 每3秒检查一次，减少频率
      
      for (let i = 0; i < maxWaitTime / checkInterval; i++) {
        if (isResolved) break;
        
        await new Promise(resolve => setTimeout(resolve, checkInterval * 1000));
        
        try {
          // 检查 cf_clearance cookie
          const cookies = await page.cookies();
          const cfClearanceCookie = cookies.find(cookie => cookie.name === 'cf_clearance');
          
          if (cfClearanceCookie && cfClearanceCookie.value) {
            console.log('✅ 成功获取 cf_clearance cookie');
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(cfClearanceCookie.value);
            return;
          }
          
          // 检查页面状态 - 简化检查
          const content = await page.content();
          const isCloudflareChallenge = content.includes('Just a moment') || 
                                      content.includes('cf-browser-verification') ||
                                      content.includes('Checking if the site connection is secure') ||
                                      content.includes('DDoS protection by Cloudflare') ||
                                      content.includes('Ray ID:');
          
          if (isCloudflareChallenge) {
            console.log(`⏳ Cloudflare 验证中... (${i * checkInterval}/${maxWaitTime}s)`);
          } else {
            console.log(`🔍 页面已加载，等待 cf_clearance cookie... (${i * checkInterval}/${maxWaitTime}s)`);
            
            // 如果页面已经加载完成但没有验证页面，可能需要刷新一下
            if (i > 5 && i % 10 === 0) {
              console.log('🔄 尝试刷新页面以触发 Cloudflare 验证...');
              await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            }
          }
          
        } catch (e) {
          console.error('检查过程中发生错误:', e.message);
          // 继续等待，不立即退出
        }
      }
      
      // 如果循环结束仍未找到 cookie
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandler);
        await cleanup();
        reject('cf_clearance cookie not found after waiting');
      }
      
    } catch (e) {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutHandler);
        await cleanup();
        reject(e.message || 'Unknown error while getting cf_clearance');
      }
    }
  });
}

module.exports = getCfClearance;
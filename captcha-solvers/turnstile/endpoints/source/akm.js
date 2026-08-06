const { max } = require("@xenova/transformers");
const { executePageOperation } = require("../operations/query");
const { applyUserAgent } = require("../../module/pageOptions");

function getAkmSource({ url, proxy, operationType, operationConfig, targetUrl, userAgent }) {
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
                    await page.close().catch(() => { });
                } catch (e) { }
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
                markContextUnhealthy("akm source timeout");
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
             isResolved = false;

            if (proxy?.username && proxy?.password) {
                await page.authenticate({
                    username: proxy.username,
                    password: proxy.password,
                });
            }

            await page.setRequestInterception(true);

            // 白名单：url、targetUrl 始终放行，challenge 脚本从首页响应动态提取
            const baseOrigin = new URL(url).origin;
            let challengeScriptUrl = null;   // 从首页 HTML 解析出的完整 challenge 脚本 URL
            let firstResponseParsed = false; // 首页响应是否已解析
            // 用 Promise 让 request handler 等待首页解析完成
            let resolveFirstResponse;
            const firstResponseReady = new Promise(r => { resolveFirstResponse = r; });

              const allow = [
                // /^https:\/\/www\.fedex\.com\/wtrk\/track\/?\?trknbr=/,
                /^https:\/\/www\.fedex\.com\/wtrk\/track\/(?:main|chunk|polyfills|scripts)-.*\.js$/,
                /^https:\/\/www\.fedex\.com\/wtrk\/track\/properties\/WTRKProperties\.json$/,
                /^https:\/\/api\.fedex\.com\/auth\/oauth\/v2\/token/,
            ];


            page.on("request", async (request) => {
                const reqUrl = request.url();

                // 主页面 document 始终放行
                if ([url, url + "/"].includes(reqUrl) || reqUrl.includes(targetUrl)) {
                    return request.continue();
                }

                if (allow.some(regex => regex.test(reqUrl))) {
                    return request.continue();
                }

                // 等待首页响应解析完成后再决定
                if (!firstResponseParsed) {
                    await firstResponseReady;
                }

                // challenge 脚本放行
                if (challengeScriptUrl && reqUrl === challengeScriptUrl) {
                    return request.continue();
                }

                // 其余全部 block
                return request.continue();
            });

            page.on("response", async (res) => {
                try {
                    // 从首页响应中提取 JS challenge 脚本路径
                    if (
                        !firstResponseParsed &&
                        [url, url + "/"].includes(res.url()) &&
                        res.status() === 200
                    ) {
                        try {
                            const html = await res.text();
                            const match = html.match(/<script type="text\/javascript"\s+src="(\/[^"]+)"[^>]*><\/script>/);
                            if (match && match[1]) {
                                challengeScriptUrl = baseOrigin + match[1];
                                // console.log(`[akm] Challenge script URL: ${challengeScriptUrl}`);
                            }
                        } catch (e) {}
                        firstResponseParsed = true;
                        resolveFirstResponse(); // 解除 request handler 中的等待
                    }

                    // shipment API
                    if (
                        res.url().includes(targetUrl)
                    ) {
                        const html = await res.json();
                        // JSON 直接返回
                        if (html) {
                            isResolved = true;
                            clearTimeout(timeoutHandler);
                            await cleanup();
                            return resolve(html);
                        }
                    }
                } catch (e) { }
            });

            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
            });
            await page.waitForSelector(".shipment-status__key, .fdx-c-notification__body", { timeout: 30000 });
            await page.reload();
            await page.waitForSelector(".shipment-status__key, .fdx-c-notification__body", { timeout: 30000 });

            isResolved = true;
            clearTimeout(timeoutHandler);
            markContextUnhealthy("f5 page operation timeout");
            await cleanup();
            reject("Timeout Error - page operation not completed");

            // 最大超时时间 2 min
            setTimeout(async () => {
                if (!isResolved) {
                    isResolved = true;
                    clearTimeout(timeoutHandler);
                    markContextUnhealthy("f5 page operation timeout");
                    await cleanup();
                    reject("Timeout Error - page operation not completed");
                }
            }, 120000);
        } catch (e) {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(timeoutHandler);
                markContextUnhealthy(e.message || "f5 source failed");
                await cleanup();
                reject(e.message || "Unknown error while getting source info");
            }
        }
    });
}
module.exports = getAkmSource;

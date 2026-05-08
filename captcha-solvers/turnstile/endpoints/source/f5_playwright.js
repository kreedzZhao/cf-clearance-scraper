const { webkit } = require("playwright");

function parseScriptAttrs(rawAttrs) {
    const attrs = {};
    const attrRe = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m;
    while ((m = attrRe.exec(rawAttrs)) !== null) {
        const key = String(m[1] || "").toLowerCase();
        const value = m[2] ?? m[3] ?? m[4] ?? "";
        attrs[key] = value;
    }
    return attrs;
}

function extractScripts(html) {
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    const scripts = [];
    let m;
    while ((m = re.exec(html)) !== null) {
        const attrsRaw = m[1] || "";
        const body = m[2] || "";
        const attrs = parseScriptAttrs(attrsRaw);
        scripts.push({
            attrsRaw,
            attrs,
            body,
            hasSrc: Object.prototype.hasOwnProperty.call(attrs, "src"),
        });
    }
    return scripts;
}

function instrumentIndexedPropertyHop(code) {
    if (typeof code !== "string" || code.length === 0) {
        return code;
    }

    const hopRe =
        /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\[\1\.length-2\]\s*=\s*\1\[\1\.length-2\]\[\1\[\1\.length-1\]\];?/g;

    return ";" + code.replace(hopRe, (stmt, stackExpr) => {
        const probe =
            `typeof ${stackExpr}[${stackExpr}.length-2] == 'string' && ` +
            `${stackExpr}[${stackExpr}.length-1] == 0 && ` +
            `console.log(${stackExpr}[${stackExpr}.length-2]);`;
        return `${probe}\n${stmt}`;
    });
}

function buildOutput(scripts) {
    const out = [];
    out.push("// clear cache");
    out.push("localStorage.clear()");
    out.push("sessionStorage.clear()");
    out.push("indexedDB.databases().then(dbs => {");
    out.push("  dbs.forEach(db => indexedDB.deleteDatabase(db.name));");
    out.push("});");
    out.push("");

    out.push(`// script tags: ${scripts.length}`);
    out.push("");

    for (let script of scripts) {
        if (script.hasSrc) {
            out.push(`// ---- script (external) src="${script.attrs.src}" ----`);
            out.push("");
            continue;
        }
        out.push(`// ---- script (inline) ----`);
        out.push(script.body);
        if (!script.body.endsWith("\n")) {
            out.push("");
        }
        out.push("");
    }
    return out.join("\n");
}

function looksLikeUspsTrackingResult(html) {
    if (!html || typeof html !== "string") return false;
    return (
        html.includes("USPS Tracking") &&
        html.includes("Tracking Number") &&
        (html.includes("Expected Delivery by") ||
            html.includes("In Transit") ||
            html.includes("Delivered") ||
            html.includes("Latest Update"))
    );
}

function toPlaywrightProxy(proxy) {
    if (!proxy || !proxy.host || !proxy.port) return null;
    const proxyConfig = {
        server: `http://${proxy.host}:${proxy.port}`,
    };
    if (proxy.username && proxy.password) {
        proxyConfig.username = proxy.username;
        proxyConfig.password = proxy.password;
    }
    return proxyConfig;
}

/**
 * 使用 Playwright 原生方式获取 F5 页面数据
 */
function getF5SourcePlaywright({ url, proxy, operationType, operationConfig, maxChallengeRetries = 9, userAgent }) {
    return new Promise(async (resolve, reject) => {
        if (!url) return reject("Missing url parameter");

        let context = null;
        let page = null;
        let isResolved = false;
        let contextClosed = false;
        let challengeScripts;
        let challengeAttempts = 0;
        let challengeInProgress = false;
        const timeoutMs = global.timeOut || 120000;
        const cleanupTimeoutMs = 8000;
        const proxyConfig = toPlaywrightProxy(proxy);

        const cleanupWithTimeout = async () => {
            await Promise.race([
                cleanup(),
                new Promise((resolveCleanup) => {
                    setTimeout(resolveCleanup, cleanupTimeoutMs);
                }),
            ]);
        };

        const finalizeResolve = async (value, reason = "unknown") => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(timeoutHandler);
            resolve(value);
            cleanupWithTimeout().catch(() => {});
        };

        const finalizeReject = async (err, reason = "unknown") => {
            if (isResolved) return;
            isResolved = true;
            clearTimeout(timeoutHandler);
            reject(err);
            cleanupWithTimeout().catch(() => {});
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
                    if (
                        global.playwrightContextPool &&
                        typeof global.playwrightContextPool.releaseContext === "function"
                    ) {
                        await global.playwrightContextPool.releaseContext(context);
                    } else {
                        await context.close();
                    }
                } catch (e) {
                    console.error("Error releasing Playwright context:", e.message);
                }
            }
        };

        const timeoutHandler = setTimeout(async () => {
            await finalizeReject("Timeout Error - page operation not completed", "global_timeout");
        }, timeoutMs);

        try {
            // 获取或创建 Playwright 浏览器上下文
            const contextOptions = {
                ignoreHTTPSErrors: true,
                userAgent:
                    userAgent ||
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                viewport: { width: 1280, height: 720 },

            };
            if (proxyConfig) {
                contextOptions.proxy = proxyConfig;
            }

            if (
                global.playwrightContextPool &&
                typeof global.playwrightContextPool.getContext === "function"
            ) {
                context = await global.playwrightContextPool.getContext(proxy);
            } else if (global.playwrightBrowser) {
                context = await global.playwrightBrowser.newContext(contextOptions).catch(() => null);
            } else {
                // 仅使用 WebKit；代理由浏览器启动参数和 context 参数共同承载
                const headless =
                    typeof global.playwrightHeadless === "boolean" ? global.playwrightHeadless : false;
                const browserKey = `webkit:${proxyConfig?.server || "direct"}`;

                if (!global.playwrightBrowserMap) {
                    global.playwrightBrowserMap = new Map();
                }

                let browser = global.playwrightBrowserMap.get(browserKey);
                if (!browser || !browser.isConnected()) {
                    const launchOptions = { headless };
                    if (proxyConfig) {
                        launchOptions.proxy = proxyConfig;
                    }
                    browser = await webkit.launch(launchOptions);
                    global.playwrightBrowserMap.set(browserKey, browser);
                }

                global.playwrightBrowser = browser;
                context = await browser.newContext(contextOptions);
            }

            if (!context) {
                return finalizeReject("Failed to create Playwright browser context", "context_create_failed");
            }

            page = await context.newPage();

            // Playwright 使用 page.on('response') 进行响应拦截
            page.on("response", async (res) => {
                try {
                    if (isResolved) return;

                    const responseUrl = res.url();
                    // 异常页面 直接关闭
                    if (responseUrl.includes("anyapp_outage_apology")) {
                        console.log(responseUrl, "anyapp_outage_apology");

                        if (challengeScripts && !challengeInProgress) {
                            if (challengeAttempts < maxChallengeRetries) {
                                challengeAttempts++;
                                console.log(
                                    `Executing challenge scripts, attempt ${challengeAttempts}/${maxChallengeRetries}`
                                );
                                challengeInProgress = true;
                                try {
                                    await page.evaluate(challengeScripts);
                                    console.log("Executed challenge scripts on the page");
                                } finally {
                                    challengeInProgress = false;
                                }
                            } else {
                                await page.reload({ waitUntil: "domcontentloaded" });
                                console.warn(
                                    `Max challenge retries reached (${maxChallengeRetries}). Not executing challenge scripts anymore.`
                                );
                            }
                        }

                        await finalizeResolve("Accessed an outage apology page", "outage_apology_page");
                        return;
                    }

                    console.log(url);
                    // challenge 页面
                    if (responseUrl.includes("TrackConfirmAction")) {
                        const html = await res.text().catch(() => "");
                        console.log("Received TrackConfirmAction response, status:", res.status());
                        if (html.includes("afterReadyCbCalled") || res.status() === 302) {
                            const jsScripts = extractScripts(html).filter((s) => !s.hasSrc);
                            challengeScripts = buildOutput(jsScripts);
                            return;
                        }

                        if (
                            html.includes(
                                "Sorry, we're currently experiencing technical difficulties with our tracking application. We thank you for your patience while we work to resolve the issue. Please check back."
                            )
                        ) {
                            await finalizeResolve("Blocked by F5 without challenge", "blocked_without_challenge");
                            return;
                        }

                        if (html.includes("Tracking Number:")) {
                            resolve(html);

                        }

                    }
                } catch (e) {}
            });

            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
            });

            // await page.waitForSelector(".tracking-number", { timeout: 3500000 });
            await page.waitForSelector("//p[@class='tracking-label']", { timeout: 30000 }).catch(() => {});

            const html = await page.content();
            await finalizeResolve(html, "content_captured");
        } catch (e) {
            await finalizeReject(e.message || "Unknown error while getting source info", "exception");
        }
    });
}

module.exports = getF5SourcePlaywright;

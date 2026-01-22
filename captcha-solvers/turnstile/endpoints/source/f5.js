const { max } = require("@xenova/transformers");
const { executePageOperation } = require("../operations/query");


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

    // Match patterns like:
    //   M.Jy[M.Jy.length-2]=M.Jy[M.Jy.length-2][M.Jy[M.Jy.length-1]];
    // and inject a debug print right before this statement.
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
    // clear cookies
    // out.push("document.cookie.split(';').forEach(cookie => {");
    // out.push("  const eqPos = cookie.indexOf('=');");
    // out.push("  const name = eqPos > -1 ? cookie.substr(0, eqPos) : cookie;");
    // out.push("  document.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';");
    // out.push("});");
    // out.push("");

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

function getF5Source({ url, proxy, operationType, operationConfig, maxChallengeRetries = 9 }) {
    return new Promise(async (resolve, reject) => {
        if (!url) return reject("Missing url parameter");

        let context = null;
        let page = null;
        let isResolved = false;
        let contextClosed = false;

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

            if (proxy?.username && proxy?.password) {
                await page.authenticate({
                    username: proxy.username,
                    password: proxy.password,
                });
            }

            let challegeScripts;
            let challengeAttempts = 0;

            await page.setRequestInterception(true);
            page.on("request", async (request) => request.continue());
            page.on("response", async (res) => {
                try {
                    // 异常页面 直接关闭
                    if (
                        res.url().includes("anyapp_outage_apology")
                    ) {
                        console.log(res.url(), "anyapp_outage_apology");

                        if (challegeScripts) {
                            if (challengeAttempts < maxChallengeRetries) {
                                challengeAttempts++;
                                console.log(`Executing challenge scripts, attempt ${challengeAttempts}/${maxChallengeRetries}`);
                                await page.evaluate(challegeScripts);
                                console.log('Executed challenge scripts on the page');
                            } else {
                                await page.reload({ waitUntil: "domcontentloaded" });
                                console.warn(`Max challenge retries reached (${maxChallengeRetries}). Not executing challenge scripts anymore.`);
                            }
                        }

                        isResolved = true;
                        clearTimeout(timeoutHandler);
                        await cleanup();
                        resolve("Accessed an outage apology page");
                    }

                    // chanllege 页面
                    if (
                        res.url().includes("TrackConfirmAction")
                    ) {
                        const html = await res.text();
                        if (html.includes("afterReadyCbCalled")) {
                            const jsScripts = extractScripts(html).filter((s) => !s.hasSrc);
                            challegeScripts = buildOutput(jsScripts);
                        }

                        if (html.includes("Sorry, we're currently experiencing technical difficulties with our tracking application. We thank you for your patience while we work to resolve the issue. Please check back.")) {
                            // blocked by f5, but not challenge page, just resolve with empty content
                            isResolved = true;
                            clearTimeout(timeoutHandler);
                            await cleanup();
                            resolve("Blocked by F5 without challenge");
                        }
                    }
                } catch (e) { }
            });

            await page.goto(url, {
                waitUntil: "domcontentloaded",
                timeout: 30000,
            });

            // await page.waitForTimeout(5000); // 等待 2 秒，确保页面加载完成
            await page.waitForSelector(".tracking-number", { timeout: 3500000 });

            const html = await page.content();
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(html);

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
                reject(e.message || "Unknown error while getting source info");
            }
        }
    });
}
module.exports = getF5Source;

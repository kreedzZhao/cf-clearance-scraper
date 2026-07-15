const { connect } = require("puppeteer-real-browser")

async function createBrowser(options = {}) {
    try {
        if (global.finished === true) return
        if (global.restarting === true) {
            console.log('Skipping browser creation during restart...')
            return
        }

        if (global.browser) {
            try {
                await global.browser.close().catch(() => {})
            } catch (e) {
                console.log("Error closing previous browser:", e.message)
            }
        }

        global.browser = null
        global.browserContexts = new Set()
        global.contextPool = {
            available: new Map(),
            maxSize: Number(process.env.CONTEXT_POOL_SIZE) || 20,
            used: 0,
            waitingQueue: [], // 等待队列
            contextUsage: new Map(), // 跟踪每个上下文的使用次数
            contextMeta: new WeakMap(),
            directProxyKey: "__direct__",

            normalizeProxy(proxy) {
                if (!proxy || !proxy.host || !proxy.port) {
                    return null
                }

                return {
                    host: String(proxy.host),
                    port: String(proxy.port),
                    username: proxy.username ? String(proxy.username) : "",
                    password: proxy.password ? String(proxy.password) : "",
                }
            },

            getProxyKey(proxy) {
                const normalizedProxy = this.normalizeProxy(proxy)
                if (!normalizedProxy) {
                    return this.directProxyKey
                }
                return JSON.stringify(normalizedProxy)
            },

            getProxyLabel(proxy) {
                const normalizedProxy = this.normalizeProxy(proxy)
                if (!normalizedProxy) {
                    return "direct"
                }

                const authLabel = normalizedProxy.username ? `@${normalizedProxy.username}` : ""
                return `${normalizedProxy.host}:${normalizedProxy.port}${authLabel}`
            },

            getContextMeta(context) {
                return this.contextMeta.get(context) || {
                    proxy: null,
                    proxyKey: this.directProxyKey,
                }
            },

            setContextMeta(context, proxy) {
                const normalizedProxy = this.normalizeProxy(proxy)
                const meta = {
                    proxy: normalizedProxy,
                    proxyKey: this.getProxyKey(normalizedProxy),
                }

                this.contextMeta.set(context, meta)
                return meta
            },

            getBucket(proxyKey) {
                if (!this.available.has(proxyKey)) {
                    this.available.set(proxyKey, [])
                }

                return this.available.get(proxyKey)
            },

            getAvailableCount() {
                let count = 0
                for (const bucket of this.available.values()) {
                    count += bucket.length
                }
                return count
            },

            getTotalContexts() {
                return this.used + this.getAvailableCount()
            },

            takeLeastUsedFromBucket(bucket) {
                if (!bucket || bucket.length === 0) {
                    return null
                }

                bucket.sort((a, b) =>
                    (this.contextUsage.get(a) || 0) - (this.contextUsage.get(b) || 0)
                )

                return bucket.shift()
            },

            takeMatchingAvailableContext(proxyKey) {
                return this.takeLeastUsedFromBucket(this.getBucket(proxyKey))
            },

            takeEvictableContext(targetProxyKey) {
                let candidate = null

                for (const [proxyKey, bucket] of this.available.entries()) {
                    if (proxyKey === targetProxyKey || bucket.length === 0) {
                        continue
                    }

                    for (const context of bucket) {
                        const usage = this.contextUsage.get(context) || 0
                        if (!candidate || usage < candidate.usage) {
                            candidate = { context, usage, proxyKey }
                        }
                    }
                }

                if (!candidate) {
                    return null
                }

                const bucket = this.available.get(candidate.proxyKey)
                if (bucket) {
                    const index = bucket.indexOf(candidate.context)
                    if (index !== -1) {
                        bucket.splice(index, 1)
                    }
                    if (bucket.length === 0) {
                        this.available.delete(candidate.proxyKey)
                    }
                }

                return candidate.context
            },

            async createFreshContext(proxy) {
                try {
                    const normalizedProxy = this.normalizeProxy(proxy)
                    const contextOptions = {
                        ignoreHTTPSErrors: true,
                    }

                    if (normalizedProxy) {
                        contextOptions.proxyServer = `http://${normalizedProxy.host}:${normalizedProxy.port}`
                    }

                    const context = await global.browser.createBrowserContext(contextOptions)
                    this.used++
                    this.contextUsage.set(context, 1)

                    const meta = this.setContextMeta(context, normalizedProxy)
                    // console.log(
                    //     `🆕 Created new ${this.getProxyLabel(meta.proxy)} context (${this.used} active, ${this.getAvailableCount()} available, total: ${this.getTotalContexts()})`
                    // )

                    return context
                } catch (e) {
                    console.error("Failed to create browser context:", e.message)
                    return null
                }
            },

            async resetContext(context) {
                const pages = await context.pages()
                await Promise.all(pages.map(async page => {
                    try {
                        await page.evaluate(async () => {
                            try {
                                localStorage.clear()
                                sessionStorage.clear()
                            } catch (_) {}

                            try {
                                if (indexedDB && typeof indexedDB.databases === "function") {
                                    const databases = await indexedDB.databases()
                                    await Promise.all(
                                        databases
                                            .filter(database => database && database.name)
                                            .map(database => indexedDB.deleteDatabase(database.name))
                                    )
                                }
                            } catch (_) {}
                        }).catch(() => {})
                    } catch (e) {}

                    await page.close().catch(() => {})
                }))

                if (typeof context.clearCookies === "function") {
                    await context.clearCookies().catch(() => {})
                }

                if (typeof context.clearPermissions === "function") {
                    await context.clearPermissions().catch(() => {})
                }
            },

            async disposeContext(context, reason = "") {
                if (!context) return

                const meta = this.getContextMeta(context)
                const bucket = this.available.get(meta.proxyKey)
                if (bucket) {
                    const index = bucket.indexOf(context)
                    if (index !== -1) {
                        bucket.splice(index, 1)
                    }
                    if (bucket.length === 0) {
                        this.available.delete(meta.proxyKey)
                    }
                }

                this.contextUsage.delete(context)
                this.contextMeta.delete(context)

                try {
                    await context.close()
                    // console.log(`🗑️  Closed ${this.getProxyLabel(meta.proxy)} context${reason ? ` (${reason})` : ""}`)
                } catch (e) {
                    console.error("Error closing context:", e.message)
                }
            },

            async getContext(proxy) {
                const normalizedProxy = this.normalizeProxy(proxy)
                const proxyKey = this.getProxyKey(normalizedProxy)
                const proxyLabel = this.getProxyLabel(normalizedProxy)

                const availableContext = this.takeMatchingAvailableContext(proxyKey)
                if (availableContext) {
                    this.used++

                    const usage = (this.contextUsage.get(availableContext) || 0) + 1
                    this.contextUsage.set(availableContext, usage)

                    // console.log(
                    //     `🔄 Reusing ${proxyLabel} context (usage: ${usage}, ${this.used} active, ${this.getAvailableCount()} available)`
                    // )
                    return availableContext
                }

                if (this.getTotalContexts() < this.maxSize) {
                    return await this.createFreshContext(normalizedProxy)
                }

                const evictableContext = this.takeEvictableContext(proxyKey)
                if (evictableContext) {
                    await this.disposeContext(evictableContext, `evicted for ${proxyLabel}`)
                    return await this.createFreshContext(normalizedProxy)
                }

                // console.log(
                //     `⏳ Context pool full, waiting for ${proxyLabel} context (${this.used} active, ${this.waitingQueue.length} waiting)`
                // )

                return new Promise((resolve, reject) => {
                    let isResolved = false

                    const wrappedResolve = (value) => {
                        if (!isResolved) {
                            isResolved = true
                            resolve(value)
                        }
                    }

                    const wrappedReject = (error) => {
                        if (!isResolved) {
                            isResolved = true
                            reject(error)
                        }
                    }

                    const timeout = setTimeout(() => {
                        if (!isResolved) {
                            const index = this.waitingQueue.findIndex(item => item.wrappedResolve === wrappedResolve)
                            if (index !== -1) {
                                this.waitingQueue.splice(index, 1)
                            }
                            wrappedReject(new Error(`Context pool timeout for ${proxyLabel}`))
                        }
                    }, 30000)

                    this.waitingQueue.push({
                        proxyKey,
                        resolve: wrappedResolve,
                        reject: wrappedReject,
                        timeout,
                        wrappedResolve,
                        wrappedReject,
                    })
                })
            },

            async releaseContext(context, options = {}) {
                if (!context) return

                const { forceClose = false, reason = "" } = options
                const meta = this.getContextMeta(context)
                const proxyLabel = this.getProxyLabel(meta.proxy)

                this.used = Math.max(0, this.used - 1)

                if (forceClose) {
                    await this.disposeContext(context, reason || `discarded after ${proxyLabel} request`)
                    return
                }

                const usage = this.contextUsage.get(context) || 0
                if (usage > 100) {
                    await this.disposeContext(context, `recycled after ${usage} uses`)
                    return
                }

                try {
                    await this.resetContext(context)
                } catch (e) {
                    console.error("Error cleaning context for reuse:", e.message)
                    await this.disposeContext(context, `cleanup failure: ${e.message}`)
                    return
                }

                const waitingIndex = this.waitingQueue.findIndex(item => item.proxyKey === meta.proxyKey)
                if (waitingIndex !== -1) {
                    const waitingRequest = this.waitingQueue.splice(waitingIndex, 1)[0]

                    if (waitingRequest.timeout) {
                        clearTimeout(waitingRequest.timeout)
                    }

                    this.used++
                    const nextUsage = (this.contextUsage.get(context) || 0) + 1
                    this.contextUsage.set(context, nextUsage)

                    // console.log(
                    //     `🚀 Context passed to waiting ${proxyLabel} request (${this.used} active, ${this.waitingQueue.length} waiting)`
                    // )
                    waitingRequest.resolve(context)
                    return
                }

                this.getBucket(meta.proxyKey).push(context)
                // console.log(
                //     `♻️  ${proxyLabel} context returned to pool (usage: ${usage}, ${this.used} active, ${this.getAvailableCount()} available)`
                // )
            },

            async cleanup() {
                for (const waitingRequest of this.waitingQueue) {
                    if (waitingRequest.timeout) {
                        clearTimeout(waitingRequest.timeout)
                    }
                    waitingRequest.reject(new Error("Context pool cleaned up"))
                }
                this.waitingQueue = []

                for (const bucket of this.available.values()) {
                    while (bucket.length > 0) {
                        const context = bucket.pop()
                        try {
                            await context.close()
                        } catch (e) {
                            console.error("Error closing pooled context:", e.message)
                        }
                    }
                }

                this.available.clear()
                this.contextUsage.clear()
                this.contextMeta = new WeakMap()
                this.used = 0
                console.log('🧹 Context pool cleaned up')
            }
        }

        console.log('Launching the browser...')

        const defaultWidth = 520
        const defaultHeight = 240

        const width = options.width || defaultWidth
        const height = options.height || defaultHeight

        console.log('Browser launch config:', {
            headless: false,
            turnstile: true,
            width,
            height
        })

        const { browser } = await connect({
            headless: false,
            turnstile: true,
            executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            connectOption: { defaultViewport: null },
            disableXvfb: true,
            // args: ['--start-maximized']
        }).catch(e => {
            console.error("Browser connection error:", e.message)
            console.error("Full error:", e)
            return { browser: null }
        })

        if (!browser) {
            console.error("Failed to connect to browser")
            // 检查是否在重启中，如果是则不重试
            if (global.restarting === true) {
                console.log('Browser connection failed during restart, skipping retry...')
                return
            }
            // 延迟重试
            setTimeout(createBrowser, 5000)
            return
        }

        console.log('Browser launched successfully')

        // 立即创建一个初始浏览器上下文以准备服务
        try {
            const initialContext = await browser.createBrowserContext()
            console.log('Initial browser context created successfully')
            global.browserContexts.add(initialContext)
            
            // 设置上下文关闭处理
            const originalClose = initialContext.close.bind(initialContext)
            initialContext.close = async function() {
                try {
                    await originalClose()
                } catch (e) {
                    console.error("Error closing context:", e.message)
                } finally {
                    global.browserContexts.delete(initialContext)
                }
            }
        } catch (e) {
            console.error("Failed to create initial context:", e.message)
        }

        const originalCreateContext = browser.createBrowserContext.bind(browser)
        browser.createBrowserContext = async function(...args) {
            const context = await originalCreateContext(...args)
            if (context) {
                global.browserContexts.add(context)
                
                const originalClose = context.close.bind(context)
                context.close = async function() {
                    try {
                        await originalClose()
                    } catch (e) {
                        console.error("Error closing context:", e.message)
                    } finally {
                        global.browserContexts.delete(context)
                    }
                }
            }
            return context
        }

        global.browser = browser

        browser.on('disconnected', async () => {
            if (global.finished === true) return
            if (global.restarting === true) {
                console.log('Browser disconnected during restart, skipping reconnect...')
                return
            }
            
            console.log('Browser disconnected, attempting to reconnect...')
            
            try {
                for (const context of global.browserContexts) {
                    try {
                        await context.close().catch(() => {})
                    } catch (e) {
                        console.error("Error closing context during reconnect:", e.message)
                    }
                }
                global.browserContexts.clear()
            } catch (e) {
                console.error("Error cleaning up contexts:", e.message)
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000))
            await createBrowser()
        })

    } catch (e) {
        console.error("Browser creation error:", e.message)
        if (global.finished === true) return
        if (global.restarting === true) {
            console.log('Browser creation error during restart, skipping retry...')
            return
        }
        await new Promise(resolve => setTimeout(resolve, 5000))
        await createBrowser()
    }
}

process.on('SIGINT', async () => {
    console.log('Received SIGINT, cleaning up...')
    global.finished = true
    
    if (global.browser) {
        try {
            // 关闭所有上下文
            if (global.browserContexts) {
                for (const context of global.browserContexts) {
                    await context.close().catch(() => {})
                }
            }
            await global.browser.close().catch(() => {})
        } catch (e) {
            console.error("Error during cleanup:", e.message)
        }
    }
    
    process.exit(0)
})

module.exports = createBrowser

// 自动启动浏览器
if (process.env.SKIP_LAUNCH !== 'true') {
    createBrowser()
}

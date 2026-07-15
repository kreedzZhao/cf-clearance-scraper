const express = require('express')
const app = express()
const port = process.env.PORT || 3000
const bodyParser = require('body-parser')
const authToken = process.env.authToken || null
const cors = require('cors')
const reqValidate = require('./module/reqValidate')

global.browserLength = 0
global.browserLimit = Number(process.env.browserLimit) || 20
global.timeOut = Number(process.env.timeOut || 60000)

// 内存管理配置
const GC_INTERVAL = 30000 // 30秒执行一次垃圾回收
const MEMORY_THRESHOLD = 200 * 1024 * 1024 // 200MB内存阈值
let requestCount = 0
let lastGCTime = Date.now()

// 强制垃圾回收函数
function forceGC() {
    if (global.gc) {
        try {
            const memBefore = process.memoryUsage().heapUsed
            global.gc()
            const memAfter = process.memoryUsage().heapUsed
            console.log(`GC executed: freed ${Math.round((memBefore - memAfter) / 1024 / 1024)}MB memory`)
        } catch (e) {
            console.error('Error during garbage collection:', e.message)
        }
    }
}

// 检查内存使用情况
function checkMemoryUsage() {
    const memUsage = process.memoryUsage()
    const heapUsed = memUsage.heapUsed
    const heapTotal = memUsage.heapTotal
    
    console.log(`Memory usage: ${Math.round(heapUsed / 1024 / 1024)}MB / ${Math.round(heapTotal / 1024 / 1024)}MB`)
    
    // 如果内存使用超过阈值或者距离上次GC超过设定时间间隔
    if (heapUsed > MEMORY_THRESHOLD || (Date.now() - lastGCTime) > GC_INTERVAL) {
        forceGC()
        lastGCTime = Date.now()
    }
}

// 定期检查内存使用情况
setInterval(checkMemoryUsage, 10000) // 每10秒检查一次

app.use(bodyParser.json({}))
app.use(bodyParser.urlencoded({ extended: true }))
app.use(cors())
if (process.env.NODE_ENV !== 'development') {
    let server = app.listen(port, () => { console.log(`Server running on port ${port}`) })
    try {
        server.timeout = global.timeOut
    } catch (e) { }
}
if (process.env.SKIP_LAUNCH != 'true') require('./module/createBrowser')

const getSource = require('./endpoints/getSource')
const solveTurnstileMin = require('./endpoints/solveTurnstile.min')
const solveTurnstileMax = require('./endpoints/solveTurnstile.max')
const wafSession = require('./endpoints/wafSession')


// 健康检查端点
app.get('/health', (req, res) => {
    const memUsage = process.memoryUsage()
    const uptime = process.uptime()
    
    const healthData = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: uptime,
        memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            external: Math.round(memUsage.external / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024)
        },
        browser: {
            status: global.browser ? 'connected' : 'disconnected',
            activeContexts: global.browserLength || 0,
            maxContexts: global.browserLimit || 20
        }
    }
    
    res.json(healthData)
})

app.post('/cf-clearance-scraper', async (req, res) => {
    requestCount++
    
    const data = req.body
    
    // 转换参数格式以兼容旧版本
    if (data.type === 'cftoken' && data.websiteUrl && data.websiteKey) {
        data.mode = 'turnstile-min'
        data.url = data.websiteUrl
        data.siteKey = data.websiteKey
    }

    const check = reqValidate(data)

    if (check !== true) return res.status(400).json({ code: 400, message: 'Bad Request', schema: check })

    if (authToken && data.authToken !== authToken) return res.status(401).json({ code: 401, message: 'Unauthorized' })

    if (global.browserLength >= global.browserLimit) return res.status(429).json({ code: 429, message: 'Too Many Requests' })

    if (process.env.SKIP_LAUNCH != 'true' && !global.browser) return res.status(500).json({ code: 500, message: 'The scanner is not ready yet. Please try again a little later.' })

    var result = { code: 500, message: 'Internal Server Error', token: null }

    global.browserLength++

    try {
        // 默认使用最小模式
        const mode = data.mode || 'turnstile-min'
        
        switch (mode) {
            case "source":
                const sourceRes = await getSource(data)
                if (sourceRes && sourceRes.__browserRenderResult === true) {
                    result = {
                        code: 200,
                        message: sourceRes.message || 'Success',
                        status: sourceRes.status || 'ok',
                        token: null,
                        source: sourceRes.source ?? null,
                        ...(sourceRes.reason ? { reason: sourceRes.reason } : {})
                    }
                } else {
                    result = { code: 200, message: 'Success', token: null, source: sourceRes }
                }
                break;
            case "turnstile-min":
                const tokenMin = await solveTurnstileMin(data)
                result = { code: 200, message: 'Success', token: tokenMin }
                break;
            case "turnstile-max":
                const tokenMax = await solveTurnstileMax(data)
                result = { code: 200, message: 'Success', token: tokenMax }
                break;
            case "waf-session":
                const sessionRes = await wafSession(data)
                result = { code: 200, message: 'Success', token: null, ...sessionRes }
                break;
            default:
                result = { code: 400, message: 'Invalid mode', token: null }
        }
    } catch (err) {
        result = { code: 500, message: err.message || 'Internal Server Error', token: null }
        console.error('Request processing error:', err)
    }

    global.browserLength--
    
    // 每处理50个请求或内存使用过高时触发垃圾回收
    if (requestCount % 50 === 0) {
        setTimeout(checkMemoryUsage, 1000)
    }

    res.status(result.code ?? 500).json(result)
})

app.use((req, res) => { res.status(404).json({ code: 404, message: 'Not Found' }) })

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.use((err, req, res, next) => {
  console.error('Express error handler:', err);
  res.status(500).json({
    code: 500,
    message: 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

if (process.env.NODE_ENV == 'development') module.exports = app

class RoyalMailPoolError extends Error {
    constructor(message, statusCode) {
        super(message)
        this.name = "RoyalMailPoolError"
        this.statusCode = statusCode
    }
}

function positiveInteger(value, fallback) {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function createRoyalMailPool({
    browser,
    size = 3,
    waitMs = 2000,
    maxQueue = 6,
    logger = console,
} = {}) {
    if (!browser || typeof browser.createBrowserContext !== "function") {
        throw new Error("Royal Mail pool requires a browser")
    }

    const targetSize = positiveInteger(size, 3)
    const acquireWaitMs = positiveInteger(waitMs, 2000)
    const queueLimit = positiveInteger(maxQueue, targetSize * 2)
    const activeContexts = new Set()
    const creationPromises = new Set()
    const waitingQueue = []
    let nextLeaseId = 1
    let slotsInUse = 0
    let dispatching = false
    let closed = false

    const log = (message, data) => {
        if (!logger || typeof logger.log !== "function") return
        if (data === undefined) logger.log(`[royal-mail:pool] ${message}`)
        else logger.log(`[royal-mail:pool] ${message}`, data)
    }

    const rejectWaiter = (waiter, error) => {
        if (!waiter || waiter.settled) return
        waiter.settled = true
        clearTimeout(waiter.timeout)
        waiter.reject(error)
    }

    const releaseContext = async (context, leaseId) => {
        const wasActive = activeContexts.delete(context)
        try {
            await context.close()
        } catch (error) {
            log("context close failed", {
                leaseId,
                error: String(error?.message || error),
            })
        }

        if (wasActive) {
            slotsInUse = Math.max(0, slotsInUse - 1)
            log("slot released", { leaseId, active: slotsInUse })
        }
        dispatchWaiters()
    }

    const makeLease = (context, leaseId) => {
        let released = false
        return {
            context,
            workerId: leaseId,
            async release() {
                if (released) return
                released = true
                await releaseContext(context, leaseId)
            },
        }
    }

    const reserveAndCreateLease = () => {
        slotsInUse += 1
        const leaseId = nextLeaseId++

        const creationPromise = (async () => {
            let context = null
            try {
                context = await browser.createBrowserContext({ ignoreHTTPSErrors: true })
                // Dedicated contexts are always closed by this controller and must
                // not be swept by the general context/memory cleanup path.
                global.browserContexts?.delete?.(context)

                if (closed) {
                    await context.close().catch(() => {})
                    context = null
                    throw new RoyalMailPoolError(
                        "Royal Mail dedicated browser pool unavailable",
                        503,
                    )
                }

                activeContexts.add(context)
                log("on-demand context created", { leaseId, active: slotsInUse })
                return makeLease(context, leaseId)
            } catch (error) {
                if (context) await context.close().catch(() => {})
                slotsInUse = Math.max(0, slotsInUse - 1)
                dispatchWaiters()
                if (error instanceof RoyalMailPoolError) throw error
                throw new RoyalMailPoolError(
                    `Royal Mail dedicated browser context creation failed: ${String(error?.message || error)}`,
                    503,
                )
            }
        })()

        creationPromises.add(creationPromise)
        creationPromise.finally(() => {
            creationPromises.delete(creationPromise)
        }).catch(() => {})
        return creationPromise
    }

    function dispatchWaiters() {
        if (dispatching || closed) return
        dispatching = true
        try {
            while (slotsInUse < targetSize && waitingQueue.length > 0) {
                const waiter = waitingQueue.shift()
                if (!waiter || waiter.settled) continue
                waiter.settled = true
                clearTimeout(waiter.timeout)
                reserveAndCreateLease().then(waiter.resolve, waiter.reject)
            }
        } finally {
            dispatching = false
        }
    }

    return {
        async start() {
            // Intentionally empty: Royal Mail contexts are created only when a
            // request acquires one of the three dedicated slots.
        },

        async acquire() {
            if (closed) {
                throw new RoyalMailPoolError(
                    "Royal Mail dedicated browser pool unavailable",
                    503,
                )
            }

            if (slotsInUse < targetSize) {
                return await reserveAndCreateLease()
            }

            if (waitingQueue.length >= queueLimit) {
                throw new RoyalMailPoolError("Royal Mail dedicated browser pool busy", 429)
            }

            return await new Promise((resolve, reject) => {
                const waiter = { resolve, reject, settled: false, timeout: null }
                waiter.timeout = setTimeout(() => {
                    if (waiter.settled) return
                    const index = waitingQueue.indexOf(waiter)
                    if (index !== -1) waitingQueue.splice(index, 1)
                    rejectWaiter(
                        waiter,
                        new RoyalMailPoolError("Royal Mail dedicated browser pool busy", 429),
                    )
                }, acquireWaitMs)
                waitingQueue.push(waiter)
            })
        },

        getStats() {
            return {
                targetSize,
                ready: closed ? 0 : targetSize,
                active: slotsInUse,
                available: closed ? 0 : Math.max(0, targetSize - slotsInUse),
                waiting: waitingQueue.filter(waiter => !waiter.settled).length,
                warming: 0,
            }
        },

        async cleanup() {
            if (closed) return
            closed = true
            while (waitingQueue.length > 0) {
                rejectWaiter(
                    waitingQueue.shift(),
                    new RoyalMailPoolError(
                        "Royal Mail dedicated browser pool unavailable",
                        503,
                    ),
                )
            }

            await Promise.allSettled(Array.from(creationPromises))
            const contexts = Array.from(activeContexts)
            activeContexts.clear()
            await Promise.all(contexts.map(context => context.close().catch(() => {})))
            slotsInUse = 0
            log("pool cleaned up")
        },
    }
}

module.exports = {
    RoyalMailPoolError,
    createRoyalMailPool,
}

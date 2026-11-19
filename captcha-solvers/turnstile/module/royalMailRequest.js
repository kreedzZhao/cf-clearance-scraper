const ROYAL_MAIL_HOSTS = new Set(["royalmail.com", "www.royalmail.com"])

function isRoyalMailTrackingUrl(value) {
    try {
        const parsed = new URL(String(value || ""))
        return ROYAL_MAIL_HOSTS.has(parsed.hostname) && parsed.pathname === "/track-your-item"
    } catch (e) {
        return false
    }
}

function normalizeTrackingNumber(value) {
    const trackingNumber = String(value || "").trim().replace(/\s+/g, "")
    return /^[A-Za-z0-9]{6,40}$/.test(trackingNumber) ? trackingNumber : null
}

function parseRoyalMailTrackingNumber(value) {
    if (!value) return null

    if (typeof value === "object") {
        return normalizeTrackingNumber(
            value.trackingNumber ||
            value.tracking_number ||
            value.operationConfig?.trackingNumber ||
            value.operationConfig?.tracking_number
        ) || parseRoyalMailTrackingNumber(value.url || value.pageUrl || value.websiteUrl)
    }

    try {
        const parsed = new URL(String(value))
        const candidates = [parsed.hash, parsed.pathname, parsed.href]
        for (const candidate of candidates) {
            const match = String(candidate || "").match(/\/tracking-results\/([^/?#]+)/i)
            if (match) return normalizeTrackingNumber(decodeURIComponent(match[1]))
        }
    } catch (e) {
        const match = String(value).match(/\/tracking-results\/([^/?#]+)/i)
        if (match) return normalizeTrackingNumber(decodeURIComponent(match[1]))
    }

    return null
}

function hasConfiguredProxy(config) {
    if (!config || typeof config !== "object") return false
    if (config.proxy?.host || config.proxy?.port) return true
    if (typeof config.proxyString === "string" && config.proxyString.trim()) return true
    return Boolean(config.proxyProvider)
}

function isDedicatedRoyalMailRequest(config) {
    if (!config || typeof config !== "object") return false
    return (
        config.mode === "source" &&
        config.action === "hcaptcha" &&
        isRoyalMailTrackingUrl(config.url) &&
        Boolean(parseRoyalMailTrackingNumber(config)) &&
        !hasConfiguredProxy(config)
    )
}

module.exports = {
    hasConfiguredProxy,
    isDedicatedRoyalMailRequest,
    isRoyalMailTrackingUrl,
    normalizeTrackingNumber,
    parseRoyalMailTrackingNumber,
}

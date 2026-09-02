/**
 * 响应 URL 匹配工具。
 *
 * 匹配规则（按顺序，命中即返回）：
 *   1. 字符串包含（含完全相等），可直接用 URL 前缀作为模式
 *   2. 同源 + 路径（前缀）相等，容忍查询参数顺序或数量不同
 *
 * 刻意不支持「只比 pathname、忽略域名」的宽松匹配，避免跨站误命中。
 */

function normalizePatterns(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => String(item || "").trim()).filter(Boolean);
}

function trimTrailingSlash(pathname) {
  return String(pathname || "").replace(/\/+$/, "");
}

function matchesPattern(responseUrl, pattern) {
  if (!responseUrl || !pattern) return false;
  if (responseUrl.includes(pattern)) return true;

  try {
    const response = new URL(responseUrl);
    const target = new URL(pattern);
    if (response.origin !== target.origin) return false;

    const responsePath = trimTrailingSlash(response.pathname);
    const targetPath = trimTrailingSlash(target.pathname);
    return responsePath === targetPath || responsePath.startsWith(`${targetPath}/`);
  } catch (e) {
    return false;
  }
}

function matchesResponseUrl(responseUrl, patterns) {
  const list = normalizePatterns(patterns);
  if (list.length === 0) return false;

  const value = String(responseUrl || "");
  return list.some((pattern) => matchesPattern(value, pattern));
}

module.exports = { matchesResponseUrl, normalizePatterns };

async function applyUserAgent(page, userAgent) {
  if (!page || typeof page.setUserAgent !== "function") return;
  if (typeof userAgent !== "string" || userAgent.trim() === "") return;

  await page.setUserAgent(userAgent);
}

module.exports = {
  applyUserAgent,
};

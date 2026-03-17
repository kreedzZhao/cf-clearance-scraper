const getCfSource = require("./source/cloudflare.js");
const getHcapSource = require("./source/hcaptcha.js");
const getF5Source = require("./source/f5.js");
const getF5SourcePlaywright = require("./source/f5_playwright.js");

function getSource(config) {
  const action = config.action || "cloudflare";
  switch (action) {
    case "cloudflare":
      return getCfSource(config);
    case "hcaptcha":
      return getHcapSource(config);
    case "f5":
      return getF5Source(config);
    case "f5_playwright":
      return getF5SourcePlaywright(config);
  }
}
module.exports = getSource;

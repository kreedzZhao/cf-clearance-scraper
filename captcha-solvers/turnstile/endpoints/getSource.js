const getCfSource = require("./source/cloudflare.js");
const getHcapSource = require("./source/hcaptcha.js");
const getF5Source = require("./source/f5.js");
const getF5SourcePlaywright = require("./source/f5_playwright.js");
const getAkMSource = require("./source/akm.js");
const getRecaptchaSource = require("./source/recaptcha.js");
const getArcoTrackingSource = require("./source/arco_tracking.js");

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
    case "akm":
      return getAkMSource(config);
    case "recaptcha":
      return getRecaptchaSource(config);
    case "arco_tracking":
      return getArcoTrackingSource(config);
    default:
      return Promise.reject(`Unsupported action: ${action}`);
  }
}
module.exports = getSource;

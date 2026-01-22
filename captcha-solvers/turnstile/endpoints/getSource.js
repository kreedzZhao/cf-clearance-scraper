const getCfSource = require("./source/cloudflare.js");
const getHcapSource = require("./source/hcaptcha.js");
const getF5Source = require("./source/f5.js");

function getSource({ url, proxy, operationType, operationConfig }) {
  const antiType = "f5"; // 目前仅支持 Cloudflare，可根据需求扩展
  switch (antiType) {
    case "cloudflare":
      return getCfSource({ url, proxy, operationType, operationConfig });
    case "hcaptcha":
      return getHcapSource({ url, proxy, operationType, operationConfig });
    case "f5":
      return getF5Source({ url, proxy, operationType, operationConfig });
  }
}
module.exports = getSource;

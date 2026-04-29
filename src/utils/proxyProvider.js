const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const CONFIG_DIR = path.resolve(__dirname, "../config/data");

function loadYamlConfig(configName) {
  const filePath = path.join(CONFIG_DIR, configName);
  return yaml.load(fs.readFileSync(filePath, "utf-8"));
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function weightedRandomChoice(population, weights) {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalWeight;
  for (let i = 0; i < population.length; i++) {
    r -= weights[i];
    if (r <= 0) return population[i];
  }
  return population[population.length - 1];
}

function randomString(len) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let result = "";
  for (let i = 0; i < len; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function joinProxyUrl({ host, port, username, password, protocol = "http" }) {
  const auth = username || password
    ? `${encodeURIComponent(username || "")}:${encodeURIComponent(password || "")}@`
    : "";
  return `${protocol}://${auth}${host}:${port}`;
}

// ==================== Providers ====================

class BrightDataProvider {
  constructor() {
    this.config = loadYamlConfig("brightdata.yaml");
  }

  getProxyUrl({ region } = {}) {
    const username = process.env.BRIGHTDATA_USERNAME;
    const password = process.env.BRIGHTDATA_PASSWORD;
    if (!username || !password) throw new Error("BRIGHTDATA_USERNAME/BRIGHTDATA_PASSWORD not set in env");

    let user = this.config.brightdata_username_template.replace("{username}", username);
    const supportedRegions = this.config.regions || [];

    if (region && supportedRegions.includes(region)) {
      user = `${user}-country-${region}`;
    }

    return joinProxyUrl({
      host: this.config.host,
      port: this.config.port,
      username: user,
      password,
    });
  }
}

class BrightDataByUsageProvider {
  constructor() {
    this.config = loadYamlConfig("brightdata_by_usage.yaml");
  }

  getProxyUrl({ region } = {}) {
    const username = process.env.BRIGHTDATA_BY_USAGE_USERNAME;
    const password = process.env.BRIGHTDATA_BY_USAGE_PASSWORD;
    if (!username || !password) throw new Error("BRIGHTDATA_BY_USAGE_USERNAME/BRIGHTDATA_BY_USAGE_PASSWORD not set in env");

    let user = this.config.brightdata_username_template.replace("{username}", username);
    const supportedRegions = this.config.regions || [];

    if (region && supportedRegions.includes(region)) {
      user = `${user}-country-${region}`;
    }

    return joinProxyUrl({
      host: this.config.host,
      port: this.config.port,
      username: user,
      password,
    });
  }
}

class SmartProxyProvider {
  constructor() {
    this.config = loadYamlConfig("smartproxy.yaml");
  }

  getProxyUrl() {
    const username = process.env.SMARTPROXY_USERNAME;
    const password = process.env.SMARTPROXY_PASSWORD;
    if (!username || !password) throw new Error("SMARTPROXY_USERNAME/SMARTPROXY_PASSWORD not set in env");

    const [portMin, portMax] = this.config.port_range;
    const port = randomInt(portMin, portMax);

    return joinProxyUrl({
      host: this.config.host,
      port,
      username,
      password,
    });
  }
}

class SmartProxyResidentialProvider {
  constructor() {
    const raw = loadYamlConfig("smartproxy_residential.yaml");
    this.regionMapping = {};
    for (const r of raw.regions) {
      this.regionMapping[r.country_iso] = {
        host: r.domain,
        stickyPort: randomInt(r.sticky_port_first, r.sticky_port_last),
        rotatePort: r.random_port,
      };
    }
  }

  getProxyUrl({ region, lock = true, lockTime = 5 } = {}) {
    const username = process.env.SMARTPROXY_RESIDENTIAL_USERNAME;
    const password = process.env.SMARTPROXY_RESIDENTIAL_PASSWORD;
    if (!username || !password) throw new Error("SMARTPROXY_RESIDENTIAL_USERNAME/SMARTPROXY_RESIDENTIAL_PASSWORD not set in env");

    const regionConfig = this.regionMapping[region] || this.regionMapping["worldwide"];
    if (!regionConfig) throw new Error(`Region not found: ${region}`);

    let user = lock
      ? `user-${encodeURIComponent(username)}-sessionduration-${lockTime}`
      : username;

    const port = lock ? regionConfig.stickyPort : regionConfig.rotatePort;

    return joinProxyUrl({
      host: regionConfig.host,
      port,
      username: user,
      password,
    });
  }
}

class IpIdeaResidentialProvider {
  constructor() {
    this.config = loadYamlConfig("ipidea.yaml");
  }

  getProxyUrl({ region, lock = true, lockTime = 5 } = {}) {
    const username = process.env.IPIDEA_USERNAME;
    const password = process.env.IPIDEA_PASSWORD;
    if (!username || !password) throw new Error("IPIDEA_USERNAME/IPIDEA_PASSWORD not set in env");

    let user = this.config.ipidea_username_template.replace("{username}", username);
    const supportedRegions = this.config.regions || [];

    if (region && supportedRegions.includes(region)) {
      user = `${user}-region-${region}`;
    }
    if (lock) {
      user = `${user}-session-${randomString(9)}-sessTime-${lockTime}`;
    }

    return joinProxyUrl({
      host: this.config.host,
      port: this.config.port,
      username: user,
      password,
    });
  }
}

class AgentGoResidentialProvider {
  constructor() {
    this.config = loadYamlConfig("agentgo.yaml");
  }

  getProxyUrl({ region, lock = true } = {}) {
    const username = process.env.AGENTGO_USERNAME;
    const password = process.env.AGENTGO_PASSWORD;
    if (!username || !password) throw new Error("AGENTGO_USERNAME/AGENTGO_PASSWORD not set in env");

    let user = this.config.agent_go_username_template.replace("{username}", username);
    const supportedRegions = this.config.regions || [];

    if (region && supportedRegions.includes(region)) {
      user = `${user}-${region}`;
    }
    if (lock) {
      user = `${user}.${randomInt(100000000, 999999999)}`;
    }

    return joinProxyUrl({
      host: this.config.host,
      port: this.config.port,
      username: user,
      password,
    });
  }
}

// ==================== Registry ====================

const providers = {};

function registerProvider(name, providerClass) {
  // Lazy init: only instantiate when first used
  let instance = null;
  providers[name] = {
    getInstance() {
      if (!instance) instance = new providerClass();
      return instance;
    },
  };
}

registerProvider("brightdata", BrightDataProvider);
registerProvider("brightdata_by_usage", BrightDataByUsageProvider);
registerProvider("smartproxy", SmartProxyProvider);
registerProvider("smartproxy_residential", SmartProxyResidentialProvider);
registerProvider("ipidea_residential", IpIdeaResidentialProvider);
registerProvider("agentgo_residential", AgentGoResidentialProvider);

/**
 * Get proxy URL by provider name and options
 * @param {string} name - Provider name
 * @param {object} options - { region, lock, lockTime, ... }
 * @returns {string} proxy URL string like http://user:pass@host:port
 */
function getProxyUrl(name, options = {}) {
  const entry = providers[name];
  if (!entry) {
    throw new Error(`Unknown proxy provider: ${name}. Available: ${Object.keys(providers).join(", ")}`);
  }
  return entry.getInstance().getProxyUrl(options);
}

/**
 * Get list of available provider names
 * @returns {string[]}
 */
function getAvailableProviders() {
  return Object.keys(providers);
}

module.exports = {
  getProxyUrl,
  getAvailableProviders,
};

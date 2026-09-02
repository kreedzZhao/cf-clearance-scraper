const Ajv = require("ajv")
const addFormats = require("ajv-formats")

const ajv = new Ajv()
addFormats(ajv)

const stopConditionItemSchema = {
    "type": "object",
    "properties": {
        "textIncludes": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 1
        },
        "textExcludes": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 1
        },
        "selectorArr": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 1
        },
        "urlIncludes": {
            "type": "array",
            "items": { "type": "string" },
            "minItems": 1
        },
        "result": {
            "type": "string"
        },
        "reason": {
            "type": "string"
        }
    },
    "anyOf": [
        { "required": ["textIncludes"] },
        { "required": ["selectorArr"] },
        { "required": ["urlIncludes"] }
    ],
    "additionalProperties": false
}

const commonOperationConfigProperties = {
    "postClickTimeoutMs": {
        "type": "integer",
        "minimum": 1000
    },
    "postClickPollIntervalMs": {
        "type": "integer",
        "minimum": 100
    },
    "stopConditions": {
        "type": "array",
        "items": stopConditionItemSchema,
        "minItems": 1
    }
}

const schema = {
    "type": "object",
    "properties": {
        // 新的参数格式
        "type": {
            "type": "string",
            "enum": ["cftoken", "cfcookie", "recaptchav2", "recaptchav3", "interceptor"]
        },
        "websiteUrl": {
            "type": "string",
            "format": "uri"
        },
        "websiteKey": {
            "type": "string"
        },
        // 兼容旧的参数格式
        "mode": {
            "type": "string",
            "enum": ["source", "turnstile-min", "turnstile-max", "waf-session", "cfcookie", "recaptchav2", "recaptchav3", "interceptor"]
        },
        "url": {
            "type": "string",
            "format": "uri"
        },
        "siteKey": {
            "type": "string"
        },
        "proxy": {
            "type": "object",
            "properties": {
                "host": { "type": "string" },
                "port": { "type": "integer" },
                "username": { "type": "string" },
                "password": { "type": "string" }
            },
            "additionalProperties": false
        },
        "proxyString": {
            "type": "string",
            "format": "uri"
        },
        "proxyProvider": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "enum": ["brightdata", "brightdata_by_usage", "smartproxy", "smartproxy_residential", "ipidea_residential", "agentgo_residential"]
                },
                "region": {
                    "type": "string"
                },
                "lock": {
                    "type": "boolean"
                },
                "lockTime": {
                    "type": "integer",
                    "minimum": 1
                }
            },
            "required": ["name"],
            "additionalProperties": false
        },
        "authToken": {
            "type": "string"
        },
        "userAgent": {
            "type": "string",
            "minLength": 1
        },
        // reCAPTCHA 特有参数
        "language": {
            "type": "string",
            "enum": ["en", "es", "fr", "de", "pt", "ru", "it", "nl", "pl"]
        },
        "method": {
            "type": "string",
            "enum": ["audio", "image"]
        },
        "action": {
            "type": "string"
        },
        // interceptor 特有参数
        "targetUrl": {
            "type": "string",
            "format": "uri"
        },
        // arco_tracking source 参数
        "pageUrl": {
            "type": "string",
            "format": "uri"
        },
        "trackingNumber": {
            "type": "string"
        },
        "year": {
            "type": "string"
        },
        "sender": {
            "type": "string"
        },
        "customerCode": {
            "type": "string"
        },
        "customer_code": {
            "type": "string"
        },
        "timeoutMs": {
            "type": "integer",
            "minimum": 1000
        },
        // browser_render source 参数
        "navigationTimeoutMs": {
            "type": "integer",
            "minimum": 1000
        },
        "renderDelayMs": {
            "type": "integer",
            "minimum": 0
        },
        "domStableMs": {
            "type": "integer",
            "minimum": 0
        },
        "pollIntervalMs": {
            "type": "integer",
            "minimum": 25
        },
        "waitForSelector": {
            "type": "string",
            "minLength": 1
        },
        "waitUntil": {
            "type": "string",
            "enum": ["load", "domcontentloaded", "networkidle0", "networkidle2"]
        },
        "renderStopConditions": {
            "type": "array",
            "items": stopConditionItemSchema,
            "minItems": 1
        },
        "stopStableMs": {
            "type": "integer",
            "minimum": 0
        },
        "captureSteps": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 64
                    },
                    "clickSelector": {
                        "type": "string",
                        "minLength": 1
                    },
                    "waitForSelector": {
                        "type": "string",
                        "minLength": 1
                    },
                    "targetContent": {
                        "oneOf": [
                            { "type": "string" },
                            { "type": "array", "items": { "type": "string" }, "minItems": 1 }
                        ]
                    },
                    "timeoutMs": {
                        "type": "integer",
                        "minimum": 1
                    },
                    "renderDelayMs": {
                        "type": "integer",
                        "minimum": 0
                    },
                    "domStableMs": {
                        "type": "integer",
                        "minimum": 0
                    },
                    "pollIntervalMs": {
                        "type": "integer",
                        "minimum": 25
                    }
                },
                "required": ["name", "clickSelector"],
                "additionalProperties": false
            }
        },
        // 页面操作参数（用于 getSource，mode: "source"）
        "operationType": {
            "type": "string",
            "enum": ["CLICK", "INPUT_AND_CLICK", "INPUTS_AND_CLICK", "MULTI_INPUT_AND_CLICK"]
        },
        "operationConfig": {
            "oneOf": [
                {
                    "type": "object",
                    "properties": {
                        "trackingNumber": {
                            "type": "string"
                        },
                        "inputXpath": {
                            "type": "string"
                        },
                        "buttonXpathArr": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        ...commonOperationConfigProperties
                    },
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "minItems": 2,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "inputValue": {
                                        "type": "string"
                                    },
                                    "inputXpath": {
                                        "type": "string"
                                    },
                                    "buttonXpathArr": {
                                        "type": "array",
                                        "items": { "type": "string" }
                                    },
                                    ...commonOperationConfigProperties
                                },
                                "required": ["inputValue", "inputXpath", "buttonXpathArr"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["steps"],
                    "additionalProperties": false
                },
                {
                    "type": "object",
                    "properties": {
                        "inputs": {
                            "type": "array",
                            "minItems": 1,
                            "items": {
                                "type": "object",
                                "properties": {
                                    "inputValue": {
                                        "type": "string"
                                    },
                                    "inputXpath": {
                                        "type": "string"
                                    },
                                    "inputMethod": {
                                        "type": "string",
                                        "enum": ["type", "fill"]
                                    },
                                    "typeDelayMs": {
                                        "type": "integer",
                                        "minimum": 0
                                    }
                                },
                                "required": ["inputValue", "inputXpath"],
                                "additionalProperties": false
                            }
                        },
                        "buttonXpathArr": {
                            "type": "array",
                            "items": { "type": "string" }
                        },
                        "inputMethod": {
                            "type": "string",
                            "enum": ["type", "fill"]
                        },
                        "typeDelayMs": {
                            "type": "integer",
                            "minimum": 0
                        },
                        ...commonOperationConfigProperties
                    },
                    "required": ["inputs", "buttonXpathArr"],
                    "additionalProperties": false
                }
            ]
        },
        "targetContent": {
            "oneOf": [
                { "type": "string" },
                { "type": "array", "items": { "type": "string" }, "minItems": 1 }
            ]
        },
        // 捕获通道参数（用于 getSource，数据由页面异步接口返回而非文档 HTML 时）
        "captureUrl": {
            "oneOf": [
                { "type": "string", "minLength": 1 },
                { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 }
            ]
        },
        "captureNotFoundStatus": {
            "type": "array",
            "items": { "type": "integer", "minimum": 100, "maximum": 599 },
            "minItems": 1
        }
    },
    "anyOf": [
        {
            // 新格式验证 - cftoken
            "required": ["type", "websiteUrl", "websiteKey"],
            "properties": {
                "type": { "const": "cftoken" }
            }
        },
        {
            // 新格式验证 - cfcookie
            "required": ["type", "websiteUrl"],
            "properties": {
                "type": { "const": "cfcookie" }
            }
        },
        {
            // 新格式验证 - recaptchav2
            "required": ["type", "websiteUrl", "websiteKey"],
            "properties": {
                "type": { "const": "recaptchav2" }
            }
        },
        {
            // 新格式验证 - recaptchav3
            "required": ["type", "websiteUrl", "websiteKey"],
            "properties": {
                "type": { "const": "recaptchav3" }
            }
        },
        {
            // 新格式验证 - interceptor
            "required": ["type", "websiteUrl"],
            "properties": {
                "type": { "const": "interceptor" }
            }
        },
        {
            // 旧格式验证
            "required": ["mode", "url"]
        }
    ],
    "additionalProperties": false
}

// Example data formats:
// New format:
// const data = {
//     type: "cftoken",
//     websiteUrl: "https://example.com",
//     websiteKey: "0x4AAAAAABA4JXCaw9E2Py-9"
// }
// 
// Old format (still supported):
// const data = {
//     mode: "turnstile-min",
//     url: "https://example.com",
//     siteKey: "0x4AAAAAABA4JXCaw9E2Py-9",
//     proxy: {
//         host: "localhost",
//         port: 8080,
//         username: "test",
//         password: "test"
//     },
//     authToken: "123456"
// }


function validate(data) {
    const valid = ajv.validate(schema, data)
    if (!valid) return ajv.errors
    else return true
}

module.exports = validate

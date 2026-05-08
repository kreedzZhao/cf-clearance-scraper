# 配置指南

所有配置都在根目录的 `.env` 文件中管理。

## 服务配置

```bash
# 服务端口
PORT=3000

# 认证令牌 (可选)
AUTH_TOKEN=your_secret_token

# 请求超时时间 (毫秒)
TIMEOUT=300000

# 最大并发请求数
MAX_CONCURRENT_REQUESTS=100

# 浏览器实例限制
BROWSER_LIMIT=25
```

### hCaptcha AI 配置

```bash
# Google Gemini API Key (必需)
GEMINI_API_KEY=your_api_key_here

# AI模型配置 (推荐使用免费模型)
IMAGE_CLASSIFIER_MODEL=gemini-2.0-flash
SPATIAL_POINT_REASONER_MODEL=gemini-2.0-flash
SPATIAL_PATH_REASONER_MODEL=gemini-2.0-flash
CHALLENGE_CLASSIFIER_MODEL=gemini-2.0-flash

# hCaptcha超时设置
HCAPTCHA_SOLVER_TIMEOUT=300000
HCAPTCHA_PAGE_TIMEOUT=30000
```

### 性能调优配置

```bash
# 内存管理
MEMORY_CLEANUP_INTERVAL=300000
MAX_MEMORY_USAGE=512

# 浏览器配置
HEADLESS=true
VIEWPORT_WIDTH=520
VIEWPORT_HEIGHT=240
BROWSER_CONNECT_TIMEOUT=120000
```

### 请求级 User-Agent

某些移动端内嵌 H5 页面会根据 UA 重定向。可以在单次请求里传 `userAgent`，服务会在当前页面导航前调用页面级 UA 设置，不会改 Chrome 全局启动参数，也不会影响其他请求。

```json
{
  "type": "cfcookie",
  "websiteUrl": "https://example.com/h5",
  "userAgent": "Emb/iOS/5.0.0"
}
```

### 监控和告警配置

```bash
# 监控数据保留数量
MAX_RECENT_TOKENS=50
MAX_REQUEST_HISTORY=100
MEMORY_MONITOR_INTERVAL=30000

# 告警阈值
ALERT_SUCCESS_RATE_THRESHOLD=90    # 成功率低于90%告警
ALERT_MEMORY_THRESHOLD=0.8         # 内存使用超过80%告警
ALERT_RESPONSE_TIME_THRESHOLD=60000 # 响应时间超过60秒告警
```

### 安全配置

```bash
# 日志级别 (CRITICAL = 最小输出)
LOG_LEVEL=CRITICAL
PYTHON_LOG_LEVEL=CRITICAL

# 开发环境设置
NODE_ENV=production
VERBOSE_ERRORS=false
```

## 快速配置模板

### 开发环境
```bash
BROWSER_LIMIT=10
LOG_LEVEL=INFO
NODE_ENV=development
VERBOSE_ERRORS=true
```

### 生产环境
```bash
BROWSER_LIMIT=25
LOG_LEVEL=CRITICAL
NODE_ENV=production
MAX_CONCURRENT_REQUESTS=100
```

### 轻量环境
```bash
BROWSER_LIMIT=5
MAX_MEMORY_USAGE=256
MAX_CONCURRENT_REQUESTS=20
TIMEOUT=180000
```

## 重要配置说明

### 1. API 密钥配置
- **GEMINI_API_KEY**: 必须配置，从 [Google AI Studio](https://aistudio.google.com/app/apikey) 获取
- 免费API每分钟有限制，建议使用 `gemini-2.0-flash` 模型

### 2. 性能优化
- **BROWSER_LIMIT**: 根据服务器性能调整，建议值：5-25
- **MAX_MEMORY_USAGE**: 单位MB，建议值：256-1024
- **TIMEOUT**: hCaptcha需要较长时间，建议300秒以上

### 3. 安全设置
- **AUTH_TOKEN**: 设置后所有API请求需要提供认证
- **LOG_LEVEL**: 设为CRITICAL可减少输出，提高性能

### 4. 监控配置
- **监控面板**: 访问 `http://localhost:3000/monitor` 查看实时状态
- **监控API**: `GET /api/monitor` 获取监控数据
- **健康检查**: `GET /health` 检查服务状态
- **MAX_RECENT_TOKENS**: 控制内存中保留的token数量
- **告警设置**: 配置性能阈值，及时发现异常

### 5. reCAPTCHA配置

```bash
# reCAPTCHA v2 音频处理 (需要FFmpeg)
RECAPTCHA_V2_AUDIO_ENABLED=true

# reCAPTCHA v2 图像处理 (使用Gemini API)
RECAPTCHA_V2_IMAGE_ENABLED=true

# reCAPTCHA v3 网络监听
RECAPTCHA_V3_ENABLED=true
```

## 配置优先级

1. **环境变量** (最高优先级)
2. **命令行参数**
3. **.env文件**
4. **默认值** (最低优先级)

## 启动方式

### 使用.env配置启动
```bash
npm start
```

### 临时覆盖配置
```bash
PORT=8080 npm start
# 或
node start.js --PORT=8080 --browserLimit=10
```

### 预设模式
```bash
npm run start:dev      # 开发模式 (browserLimit=10)
npm run start:prod     # 生产模式 (browserLimit=25)
npm run start:light    # 轻量模式 (browserLimit=5)
```

## 故障排除

### 1. hCaptcha 503 错误
- 检查 `GEMINI_API_KEY` 是否正确
- 确认使用免费模型 `gemini-2.0-flash`
- 适当增加 `HCAPTCHA_SOLVER_TIMEOUT`

### 2. 内存不足
- 降低 `BROWSER_LIMIT`
- 减少 `MAX_MEMORY_USAGE`
- 启用内存清理 `MEMORY_CLEANUP_INTERVAL`

### 3. 请求超时
- 增加 `TIMEOUT` 值
- 检查网络连接
- 确认服务器性能

### 4. 并发限制
- 调整 `MAX_CONCURRENT_REQUESTS`
- 根据服务器负载能力设置合理值

## 监控功能

### 实时监控面板

访问 `http://localhost:3000/monitor` 查看：
- **服务状态**: 运行时间、实例使用情况
- **请求统计**: 总计/成功/失败/活跃请求数
- **性能指标**: 响应时间趋势、成功率变化
- **内存监控**: 堆内存使用、RSS、外部内存
- **实时日志**: 请求处理过程和状态

### 监控API

```bash
# 获取完整监控数据
GET /api/monitor

# 重置监控统计
POST /api/monitor/reset

# 服务健康检查
GET /health
```

### 性能分析

监控面板提供：
- **响应时间分析**: 平均/最大/最小响应时间
- **服务类型对比**: 不同验证码类型的成功率
- **实时图表**: 动态显示性能趋势
- **活跃请求**: 当前处理中的请求详情

### 自定义监控

```javascript
// 获取监控数据
async function getMonitorData() {
    const response = await fetch('/api/monitor');
    const data = await response.json();
    return data;
}

// 性能检查
function checkPerformance() {
    getMonitorData().then(data => {
        console.log(`成功率: ${data.requests.successRate}%`);
        console.log(`活跃请求: ${data.requests.active}`);
        console.log(`内存使用: ${data.memory.heapUsagePercent * 100}%`);
        
        // 警告检查
        if (data.requests.successRate < 90) {
            console.warn('⚠️ 成功率过低！');
        }
    });
}
```

## 配置文件位置

- **主配置**: `/cf-clearance-scraper/.env`
- **监控面板**: `http://localhost:3000/monitor`
- **API文档**: `http://localhost:3000/api/monitor`
- **健康检查**: `http://localhost:3000/health`

## 兼容性说明

为保持向后兼容，系统仍支持旧的配置方式：
- 命令行参数中的旧格式（如 `timeOut`、`browserLimit`）
- 环境变量中的旧名称（如 `authToken`）

建议逐步迁移到新的统一配置格式。

## 端口配置

### 默认端口
服务默认运行在 `3000` 端口。

### 修改端口的方法

#### 方法1: 修改 .env 文件 (推荐)
```bash
# 编辑根目录的 .env 文件
PORT=8080
```

#### 方法2: 环境变量
```bash
PORT=8080 npm start
```

#### 方法3: 命令行参数
```bash
node start.js --PORT=8080
```

### 端口冲突解决
如果遇到端口被占用的情况：

```bash
# 查看端口占用
lsof -i :3000  # Mac/Linux
netstat -ano | findstr :3000  # Windows

# 终止占用进程
kill -9 <PID>  # Mac/Linux
taskkill /PID <PID> /F  # Windows
```

### 防火墙配置
如果需要外部访问，请确保防火墙允许相应端口：

```bash
# Ubuntu/Debian
sudo ufw allow 3000

# CentOS/RHEL
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload

# macOS
# 系统偏好设置 > 安全性与隐私 > 防火墙 > 防火墙选项
```

## 代理配置

### HTTP代理设置
```bash
# 在.env文件中设置
HTTP_PROXY=http://proxy.example.com:8080
HTTPS_PROXY=https://proxy.example.com:8080
NO_PROXY=localhost,127.0.0.1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
```

### API请求中的代理
```javascript
{
    "url": "https://example.com",
    "mode": "source",
    "proxy": {
        "host": "127.0.0.1",
        "port": 8080,
        "username": "user", // 可选
        "password": "pass"  // 可选
    }
}
```

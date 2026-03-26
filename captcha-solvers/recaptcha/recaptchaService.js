/**
 * Google reCAPTCHA 解决服务
 * 基于 Playwright-reCAPTCHA 项目的思路，适配 Puppeteer
 * 支持 reCAPTCHA v2 和 v3
 */

const RecaptchaBox = require('./recaptchaBox');
const { 
  RecaptchaNotFoundError, 
  RecaptchaSolveError, 
  AudioTranscriptionError 
} = require('./errors');
const { ORIGINAL_LANGUAGE_AUDIO } = require('./translations');

class RecaptchaService {
  constructor() {
    this.supportedLanguages = Object.keys(ORIGINAL_LANGUAGE_AUDIO);
    this.maxAttempts = 3;
  }

  /**
   * 解决 reCAPTCHA v2
   */
  async solveRecaptchaV2({ url, siteKey, proxy, language = 'en', method = 'audio' }) {
    return new Promise(async (resolve, reject) => {
      if (!url) return reject("Missing url parameter");
      if (!siteKey) return reject("Missing siteKey parameter");

      let context = null;
      let page = null;
      let isResolved = false;
      let contextClosed = false;
      let shouldReuseContext = true;
      let discardReason = '';

      const markContextUnhealthy = (reason) => {
        shouldReuseContext = false;
        if (!discardReason) {
          discardReason = reason;
        }
      };

      const cleanup = async () => {
        if (page) {
          try {
            await page.close().catch(() => {});
          } catch (e) {}
        }
        if (context && !contextClosed) {
          try {
            contextClosed = true;
            if (global.contextPool && typeof global.contextPool.releaseContext === 'function') {
              await global.contextPool.releaseContext(context, {
                forceClose: !shouldReuseContext,
                reason: discardReason || undefined,
              });
            } else {
              await context.close();
            }
          } catch (e) {
            console.error("Error releasing context:", e.message);
          }
        }
      };

      const timeoutHandler = setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          markContextUnhealthy('reCAPTCHA v2 timeout');
          await cleanup();
          reject("Timeout Error - reCAPTCHA not solved");
        }
      }, global.timeOut || 180000); // 3分钟超时

      try {
        // 获取浏览器上下文
        if (global.contextPool && typeof global.contextPool.getContext === 'function') {
          context = await global.contextPool.getContext(proxy);
        } else {
          context = await global.browser
            .createBrowserContext({
              proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
            })
            .catch(() => null);
        }

        if (!context) {
          clearTimeout(timeoutHandler);
          return reject("Failed to create browser context");
        }

        page = await context.newPage();

        if (proxy?.username && proxy?.password) {
          await page.authenticate({
            username: proxy.username,
            password: proxy.password,
          });
        }

        console.log(`🤖 开始解决 reCAPTCHA v2: ${url}`);

        // 访问目标页面
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        // 等待页面完全加载
        await page.waitForTimeout(3000);

        // 初始化 reCAPTCHA 处理器
        const recaptchaBox = new RecaptchaBox(page);
        await recaptchaBox.initialize();

        // 点击复选框
        await recaptchaBox.clickCheckbox();

        // 检查是否已经通过验证
        await page.waitForTimeout(2000);
        if (await recaptchaBox.isCheckboxChecked()) {
          const token = await recaptchaBox.getToken();
          if (token) {
            console.log('✅ reCAPTCHA 自动通过验证');
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(token);
            return;
          }
        }

        // 等待挑战出现
        const hasChallenge = await recaptchaBox.waitForChallenge();
        if (!hasChallenge) {
          // 没有挑战，尝试获取token
          const token = await recaptchaBox.getToken();
          if (token) {
            console.log('✅ reCAPTCHA 无挑战直接通过');
            isResolved = true;
            clearTimeout(timeoutHandler);
            await cleanup();
            resolve(token);
            return;
          } else {
            throw new RecaptchaSolveError('No challenge appeared and no token found');
          }
        }

        // 尝试解决挑战
        let attempts = 0;
        let solved = false;

        while (attempts < this.maxAttempts && !solved && !isResolved) {
          attempts++;
          console.log(`🎯 挑战解决尝试 ${attempts}/${this.maxAttempts}`);

          try {
            if (method === 'audio') {
              solved = await this._solveAudioChallenge(recaptchaBox, language);
            } else {
              solved = await this._solveImageChallenge(recaptchaBox);
            }

            if (solved) {
              const token = await recaptchaBox.getToken();
              if (token) {
                console.log('✅ reCAPTCHA v2 挑战解决成功');
                isResolved = true;
                clearTimeout(timeoutHandler);
                await cleanup();
                resolve(token);
                return;
              }
            }

            // 如果失败，等待一下再重试
            if (!solved && attempts < this.maxAttempts) {
              await page.waitForTimeout(2000);
            }

          } catch (error) {
            console.log(`❌ 尝试 ${attempts} 失败: ${error.message}`);
            if (attempts >= this.maxAttempts) {
              throw error;
            }
          }
        }

        if (!solved) {
          throw new RecaptchaSolveError('All solve attempts failed');
        }

      } catch (e) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandler);
          markContextUnhealthy(e.message || 'reCAPTCHA v2 failed');
          await cleanup();
          reject(e.message || 'Unknown error while solving reCAPTCHA v2');
        }
      }
    });
  }

  /**
   * 解决 reCAPTCHA v3
   */
  async solveRecaptchaV3({ url, siteKey, action = 'submit', proxy }) {
    return new Promise(async (resolve, reject) => {
      if (!url) return reject("Missing url parameter");
      if (!siteKey) return reject("Missing siteKey parameter");

      let context = null;
      let page = null;
      let isResolved = false;
      let contextClosed = false;
      let shouldReuseContext = true;
      let discardReason = '';

      const markContextUnhealthy = (reason) => {
        shouldReuseContext = false;
        if (!discardReason) {
          discardReason = reason;
        }
      };

      const cleanup = async () => {
        if (page) {
          try {
            await page.close().catch(() => {});
          } catch (e) {}
        }
        if (context && !contextClosed) {
          try {
            contextClosed = true;
            if (global.contextPool && typeof global.contextPool.releaseContext === 'function') {
              await global.contextPool.releaseContext(context, {
                forceClose: !shouldReuseContext,
                reason: discardReason || undefined,
              });
            } else {
              await context.close();
            }
          } catch (e) {
            console.error("Error releasing context:", e.message);
          }
        }
      };

      const timeoutHandler = setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          markContextUnhealthy('reCAPTCHA v3 timeout');
          await cleanup();
          reject("Timeout Error - reCAPTCHA v3 not solved");
        }
      }, global.timeOut || 120000);

      try {
        // 获取浏览器上下文
        if (global.contextPool && typeof global.contextPool.getContext === 'function') {
          context = await global.contextPool.getContext(proxy);
        } else {
          context = await global.browser
            .createBrowserContext({
              proxyServer: proxy ? `http://${proxy.host}:${proxy.port}` : undefined,
            })
            .catch(() => null);
        }

        if (!context) {
          clearTimeout(timeoutHandler);
          return reject("Failed to create browser context");
        }

        page = await context.newPage();

        if (proxy?.username && proxy?.password) {
          await page.authenticate({
            username: proxy.username,
            password: proxy.password,
          });
        }

        console.log(`正在解决 reCAPTCHA v3: ${url}`);

        // 监听网络请求，捕获 reCAPTCHA v3 token
        let capturedToken = null;
        
        page.on('response', async (response) => {
          if (response.url().includes('recaptcha/api2/reload') || 
              response.url().includes('recaptcha/api2/userverify')) {
            try {
              const responseText = await response.text();
              const tokenMatch = responseText.match(/"([A-Za-z0-9_-]{100,})"/);
              if (tokenMatch && tokenMatch[1]) {
                capturedToken = tokenMatch[1];
                console.log('✅ 捕获到 reCAPTCHA v3 token');
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        });

        // 访问目标页面
        await page.goto(url, {
          waitUntil: "networkidle0",
          timeout: 30000
        });

        // 等待 reCAPTCHA v3 脚本加载
        await page.waitForFunction(() => {
          return window.grecaptcha && window.grecaptcha.execute;
        }, { timeout: 15000 });

        // 执行 reCAPTCHA v3
        const token = await page.evaluate(async (siteKey, action) => {
          try {
            return await window.grecaptcha.execute(siteKey, { action: action });
          } catch (e) {
            console.error('reCAPTCHA execute error:', e);
            return null;
          }
        }, siteKey, action);

        if (token || capturedToken) {
          const finalToken = token || capturedToken;
          console.log('✅ reCAPTCHA v3 解决成功');
          isResolved = true;
          clearTimeout(timeoutHandler);
          await cleanup();
          resolve(finalToken);
        } else {
          throw new Error('Failed to get reCAPTCHA v3 token');
        }

      } catch (e) {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutHandler);
          markContextUnhealthy(e.message || 'reCAPTCHA v3 failed');
          await cleanup();
          reject(e.message || 'Unknown error while solving reCAPTCHA v3');
        }
      }
    });
  }

  /**
   * 解决音频挑战（私有方法）
   */
  async _solveAudioChallenge(recaptchaBox, language = 'en') {
    try {
      console.log('🎵 开始音频挑战解决...');
      
      // 切换到音频挑战
      await recaptchaBox.switchToAudio();
      
      // 获取音频URL
      const audioUrl = await recaptchaBox.getAudioUrl();
      if (!audioUrl) {
        throw new AudioTranscriptionError('Could not get audio URL');
      }
      
      console.log('🎵 音频URL获取成功，准备转录...');
      
      // 这里应该调用语音识别服务
      // 目前作为占位符，返回失败
      throw new AudioTranscriptionError('Audio transcription service not implemented. Please integrate Google Speech API or similar service.');
      
    } catch (error) {
      console.error('音频挑战失败:', error.message);
      throw error;
    }
  }

  /**
   * 解决图像挑战（私有方法）
   */
  async _solveImageChallenge(recaptchaBox) {
    try {
      console.log('🖼️ 开始图像挑战解决...');
      
      // 获取挑战标题
      const challengeTitle = await recaptchaBox.getChallengeTitle();
      if (!challengeTitle) {
        throw new RecaptchaSolveError('Could not get challenge title');
      }
      
      console.log(`🖼️ 挑战内容: ${challengeTitle}`);
      
      // 获取图像瓦片
      const tiles = await recaptchaBox.getImageTiles();
      if (tiles.length === 0) {
        throw new RecaptchaSolveError('No image tiles found');
      }
      
      console.log(`🖼️ 找到 ${tiles.length} 个图像瓦片`);
      
      // 这里应该调用图像识别服务（如CapSolver）
      // 目前作为占位符，返回失败
      throw new RecaptchaSolveError('Image recognition service not implemented. Please integrate CapSolver API or similar service.');
      
    } catch (error) {
      console.error('图像挑战失败:', error.message);
      throw error;
    }
  }
}

module.exports = RecaptchaService;

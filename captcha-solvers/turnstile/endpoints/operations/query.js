// 页面操作类型枚举
const PageOperationType = {
    CLICK: 'CLICK',                // 仅点击按钮
  INPUT_AND_CLICK: 'INPUT_AND_CLICK',  // 输入文本到 input 并点击按钮
  MULTI_INPUT_AND_CLICK: 'MULTI_INPUT_AND_CLICK',  // 多步骤：输入+点击，等待导航，再输入+点击
  // 未来可扩展：CLICK_ONLY, INPUT_ONLY, WAIT, SCROLL 等
};

/**
 * 执行输入文本并点击按钮的操作
 * @param {Object} page - Puppeteer page 对象
 * @param {Object} config - 操作配置
 * @param {string} config.trackingNumber - 要输入的文本
 * @param {string} config.inputXpath - input 元素的 xpath
 * @param {string} config.buttonXpath - 按钮元素的 xpath
 */
async function executeInputAndClick(page, config) {
  const { trackingNumber, inputXpath, buttonXpathArr } = config;
  
  if (!trackingNumber) {
    throw new Error('trackingNumber is required for INPUT_AND_CLICK operation');
  }
  if (!inputXpath) {
    throw new Error('inputXpath is required for INPUT_AND_CLICK operation');
  }
  if (!buttonXpathArr) {
    throw new Error('buttonXpathArr is required for INPUT_AND_CLICK operation');
  }
  
  // 等待 input 元素出现（使用轮询方式，兼容性更好）
  const inputWaitStartTime = Date.now();
  const inputWaitTimeout = 10000;
  let inputElement;
  while (!inputElement && (Date.now() - inputWaitStartTime) < inputWaitTimeout) {
    inputElement = await page.locator(inputXpath);
    if (!inputElement) {
      await page.waitForTimeout(200); // 等待 200ms 后重试
    }
  }
  if (!inputElement) {
    throw new Error(`Input element not found within ${inputWaitTimeout}ms: ${inputXpath}`);
  }
  
  // 定位并输入文本
  try {
    await inputElement.fill(trackingNumber);
  } catch (typeError) {
    throw new Error(`Failed to fill input element: ${typeError.message}`);
  }

  // 点击可能有多次
  for (let btnXpath of buttonXpathArr) {
        // 等待按钮元素出现
        // const buttonWaitStartTime = Date.now();
        // const buttonWaitTimeout = 10000;
        // let buttonElement;
        // while (!buttonElement && (Date.now() - buttonWaitStartTime) < buttonWaitTimeout) {
        //     buttonElement = await page.locator(btnXpath);
        //     if (!buttonElement) {
        //     await page.waitForTimeout(200); // 等待 200ms 后重试
        //     }
        // }
        // if (!buttonElement) {
        //     throw new Error(`Button element not found within ${buttonWaitTimeout}ms: ${btnXpath}`);
        // }

        let buttonElement = await page.locator(btnXpath);
        if (!buttonElement) {
          continue; // 如果按钮不存在，跳过此次点击
        }
        
        // 定位并点击按钮
        try {
          console.log(`Clicking button with xpath: ${btnXpath}`);
            await buttonElement.click();
        } catch (clickError) {
            throw new Error(`Failed to click button element: ${clickError.message}`);
        }
        
        // 等待操作完成（给页面一些时间处理点击事件）
        // await page
        //             .waitForNavigation({ waitUntil: "load", timeout: 5000 })
        //             .catch(() => {});
    }
}

/**
 * 执行多步骤输入+点击操作
 * 每一步：等待 input 出现 → 输入文本 → 点击按钮
 * 非最后一步会等待页面导航完成后再执行下一步
 * @param {Object} page - Puppeteer page 对象
 * @param {Object} config - 操作配置
 * @param {Array} config.steps - 步骤数组，每项包含 inputValue, inputXpath, buttonXpathArr
 */
async function executeMultiInputAndClick(page, config) {
  const { steps } = config;

  if (!steps || !Array.isArray(steps) || steps.length < 2) {
    throw new Error('steps array with at least 2 items is required for MULTI_INPUT_AND_CLICK');
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const { inputValue, inputXpath, buttonXpathArr } = step;

    if (!inputValue) {
      throw new Error(`Step ${i + 1}: inputValue is required`);
    }
    if (!inputXpath) {
      throw new Error(`Step ${i + 1}: inputXpath is required`);
    }
    if (!buttonXpathArr) {
      throw new Error(`Step ${i + 1}: buttonXpathArr is required`);
    }

    // 等待 input 元素出现（使用轮询方式）
    const inputWaitStartTime = Date.now();
    const inputWaitTimeout = 15000;
    let inputElement;
    while (!inputElement && (Date.now() - inputWaitStartTime) < inputWaitTimeout) {
      inputElement = await page.locator(inputXpath);
      if (!inputElement) {
        await page.waitForTimeout(200);
      }
    }
    if (!inputElement) {
      throw new Error(`Step ${i + 1}: Input element not found within ${inputWaitTimeout}ms: ${inputXpath}`);
    }

    // 输入文本
    try {
      await inputElement.fill(inputValue);
    } catch (typeError) {
      throw new Error(`Step ${i + 1}: Failed to fill input: ${typeError.message}`);
    }

    // 点击按钮
    for (let btnXpath of buttonXpathArr) {
      let buttonElement = await page.locator(btnXpath);
      if (!buttonElement) {
        continue;
      }

      try {
        console.log(`Step ${i + 1}: Clicking button with xpath: ${btnXpath}`);
        if (i < steps.length - 1) {
          // 非最后一步：点击后等待页面导航完成
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
            buttonElement.click()
          ]);
        } else {
          // 最后一步：仅点击，response handler 会捕获最终结果
          await buttonElement.click();
        }
      } catch (clickError) {
        throw new Error(`Step ${i + 1}: Failed to click button: ${clickError.message}`);
      }
    }
  }
}

async function executeClick(page, config) {
    const { buttonXpathArr } = config;
    if (!buttonXpathArr) {
        throw new Error('buttonXpath is required for CLICK operation');
        }
    for (let buttonXpath of buttonXpathArr) {
        // 等待按钮元素出现
        // const buttonWaitStartTime = Date.now();
        // const buttonWaitTimeout = 10000;
        // let buttonElement;
        // while (!buttonElement && (Date.now() - buttonWaitStartTime) < buttonWaitTimeout) {
        //     buttonElement = await page.locator(buttonXpath);
        //     if (!buttonElement) {
        //         await page.waitForTimeout(200); // 等待 200ms 后重试
        //     }
        // }
        // if (!buttonElement) {
        //     throw new Error(`Button element not found within ${buttonWaitTimeout}ms: ${buttonXpath}`);
        // }


        let buttonElement = await page.locator(buttonXpath);
        if (!buttonElement) {
          continue; // 如果按钮不存在，跳过此次点击
        }
        
        // 定位并点击按钮
        try {
          console.log(`Clicking button with xpath: ${buttonXpath}`);
            await buttonElement.click();
        } catch (clickError) {
            throw new Error(`Failed to click button element: ${clickError.message}`);
        }
        // 等待操作完成（给页面一些时间处理点击事件）
        await page
                .waitForNavigation({ waitUntil: "load", timeout: 5000 })
                .catch(() => {});
    }
}

/**
 * 页面操作执行器 - 根据操作类型分发到对应的执行函数
 * @param {Object} page - Puppeteer page 对象
 * @param {string} operationType - 操作类型
 * @param {Object} operationConfig - 操作配置
 */
async function executePageOperation(page, operationType, operationConfig) {
  if (!operationType) {
    return; // 如果没有指定操作类型，直接返回
  }
  
  switch (operationType) {
    case PageOperationType.INPUT_AND_CLICK:
      return await executeInputAndClick(page, operationConfig);
    case PageOperationType.CLICK:
      // 仅点击按钮的操作可以复用 INPUT_AND_CLICK 逻辑，传入空的 trackingNumber
      return await executeClick(page, operationConfig);
    case PageOperationType.MULTI_INPUT_AND_CLICK:
      return await executeMultiInputAndClick(page, operationConfig);
    // 未来可扩展其他操作类型
    default:
      throw new Error(`Unsupported operation type: ${operationType}`);
  }
}

module.exports = {
  PageOperationType,
  executePageOperation
};
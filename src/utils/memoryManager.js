const os = require('os');

class MemoryManager {
    constructor() {
        this.maxHeapUsage = Number(process.env.maxMemoryUsage) || 512; // MB
        this.gcThreshold = 0.6; // 60% of max heap - 更积极的GC
        this.forceGcThreshold = 0.8; // 80% of max heap - 降低强制GC阈值
        this.monitoringInterval = 15000; // 15 seconds - 更频繁的监控
        this.monitoring = false;
        
        // CPU监控相关 - 系统级监控
        this.cpuUsageHistory = [];
        this.maxCpuHistory = 20;
        this.lastSystemCpuTotal = null;
        this.lastSystemCpuIdle = null;
    }

    startMonitoring() {
        if (this.monitoring) return;
        
        this.monitoring = true;
        this.monitorInterval = setInterval(() => {
            this.checkMemoryUsage();
        }, this.monitoringInterval);

        console.log('Memory monitoring started');
    }

    stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitoring = false;
            console.log('Memory monitoring stopped');
        }
    }

    checkMemoryUsage() {
        const memUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
        const rssMB = Math.round(memUsage.rss / 1024 / 1024);
        const systemFreeMB = Math.round(os.freemem() / 1024 / 1024);
        const systemTotalMB = Math.round(os.totalmem() / 1024 / 1024);

        // 使用配置的最大值来计算使用率，而不是动态的堆总量
        const maxHeapMB = this.maxHeapUsage;
        const heapUsagePercent = maxHeapMB > 0 ? heapUsedMB / maxHeapMB : 0;

        // 记录内存使用情况
        if (heapUsagePercent > 0.7) {
            console.log(`⚠️  High memory usage: ${heapUsedMB}MB/${maxHeapMB}MB (${Math.round(heapUsagePercent * 100)}%)`);
            console.log(`   RSS: ${rssMB}MB, HeapTotal: ${heapTotalMB}MB`);
            console.log(`   System: ${systemTotalMB - systemFreeMB}MB/${systemTotalMB}MB used`);
        }

        // 执行垃圾回收
        if (heapUsagePercent > this.forceGcThreshold) {
            this.forceGarbageCollection();
            // 不阻塞监控循环，异步清理
            this.cleanupBrowserContexts().catch(err => {
                console.error('Error during async cleanup:', err.message);
            });
        } else if (heapUsagePercent > this.gcThreshold) {
            this.softGarbageCollection();
        }

        return {
            heapUsedMB,
            heapTotalMB,
            rssMB,
            systemFreeMB,
            heapUsagePercent
        };
    }

    forceGarbageCollection() {
        console.log('🔄 Forcing garbage collection due to high memory usage');
        if (global.gc) {
            try {
                global.gc();
                console.log('✅ Forced GC completed');
            } catch (e) {
                console.error('❌ Failed to force GC:', e.message);
            }
        } else {
            console.warn('⚠️  global.gc() not available. Start with --expose-gc flag');
        }
    }

    softGarbageCollection() {
        // 在高并发情况下，更积极的GC策略
        if (global.gc && Math.random() < 0.5) { // 50% chance
            setImmediate(() => {
                try {
                    global.gc();
                } catch (e) {}
            });
        }
    }

    async cleanupBrowserContexts() {
        if (global.browserContexts && global.browserContexts.size > 0) {
            console.log(`🧹 Cleaning up ${global.browserContexts.size} browser contexts`);
            
            const contextsToClean = Array.from(global.browserContexts);
            let cleaned = 0;
            
            // 使用 Promise.all 并行关闭所有上下文
            const cleanupPromises = contextsToClean.map(async (context) => {
                try {
                    await context.close().catch(() => {});
                    global.browserContexts.delete(context);
                    cleaned++;
                } catch (e) {
                    console.error('Error closing context:', e.message);
                }
            });
            
            await Promise.all(cleanupPromises);
            
            if (cleaned > 0) {
                console.log(`✅ Cleaned up ${cleaned} browser contexts`);
            }
        }
    }

    async forceCleanup() {
        console.log('🔧 执行强制内存清理...');
        
        // 强制垃圾回收
        this.forceGarbageCollection();
        
        // 清理浏览器上下文
        await this.cleanupBrowserContexts();
        
        // 额外的清理步骤
        if (global.gc) {
            // 多次调用GC确保彻底清理
            setTimeout(() => {
                try {
                    global.gc();
                    console.log('✅ 延迟GC完成');
                } catch (e) {}
            }, 1000);
        }
        
        console.log('✅ 强制内存清理完成');
    }

    getCpuUsage() {
        const cpus = os.cpus();
        const numCpus = cpus.length;
        
        // 获取系统CPU使用率
        let totalIdle = 0;
        let totalTick = 0;
        
        cpus.forEach((cpu) => {
            for (let type in cpu.times) {
                totalTick += cpu.times[type];
            }
            totalIdle += cpu.times.idle;
        });
        
        const idle = totalIdle / numCpus;
        const total = totalTick / numCpus;
        
        // 计算当前时刻的系统CPU使用率
        if (this.lastSystemCpuTotal && this.lastSystemCpuIdle) {
            const totalDiff = total - this.lastSystemCpuTotal;
            const idleDiff = idle - this.lastSystemCpuIdle;
            const cpuPercent = 100 - ~~(100 * idleDiff / totalDiff);
            
            // 更新历史记录
            this.cpuUsageHistory.push(cpuPercent);
            if (this.cpuUsageHistory.length > this.maxCpuHistory) {
                this.cpuUsageHistory.shift();
            }
            
            // 更新上次记录
            this.lastSystemCpuTotal = total;
            this.lastSystemCpuIdle = idle;
            
            // 计算平均CPU使用率
            const avgCpuUsage = this.cpuUsageHistory.length > 0 
                ? this.cpuUsageHistory.reduce((sum, val) => sum + val, 0) / this.cpuUsageHistory.length
                : 0;
            
            return {
                current: Math.min(Math.max(cpuPercent, 0), 100),
                average: Math.min(Math.max(avgCpuUsage, 0), 100),
                history: this.cpuUsageHistory.slice(-10)
            };
        } else {
            // 首次调用，初始化基准值
            this.lastSystemCpuTotal = total;
            this.lastSystemCpuIdle = idle;
            
            return {
                current: 0,
                average: 0,
                history: []
            };
        }
    }

    getMemoryStats() {
        const memUsage = process.memoryUsage();
        const systemMem = {
            free: os.freemem(),
            total: os.totalmem()
        };

        const cpuStats = this.getCpuUsage();

        // 计算更准确的内存使用情况
        // 在 macOS/Linux 中，可用内存应该包括缓存和缓冲区
        const actualUsed = this.getActualMemoryUsage();
        const usedMemoryMB = actualUsed ? Math.round(actualUsed / 1024 / 1024) : 
                           Math.round((systemMem.total - systemMem.free) / 1024 / 1024);

        // 计算堆内存使用率
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
        const heapUsagePercent = heapTotalMB > 0 ? (heapUsedMB / heapTotalMB) * 100 : 0;

        return {
            process: {
                heapUsed: `${heapUsedMB}MB`,
                heapTotal: heapTotalMB,
                heapUsagePercent: Math.round(heapUsagePercent * 10) / 10, // 保留一位小数
                rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
                external: Math.round(memUsage.external / 1024 / 1024)
            },
            system: {
                free: Math.round(systemMem.free / 1024 / 1024),
                total: Math.round(systemMem.total / 1024 / 1024),
                used: usedMemoryMB,
                // 添加实际可用内存（包括可回收的缓存）
                available: Math.round(systemMem.total / 1024 / 1024) - usedMemoryMB
            },
            cpu: cpuStats,
            browserContexts: global.browserContexts ? global.browserContexts.size : 0,
            activeBrowsers: global.browserLength || 0
        };
    }

    // 获取更准确的内存使用情况
    getActualMemoryUsage() {
        const platform = process.platform;
        
        if (platform === 'darwin') {
            // macOS: 使用 vm_stat 获取内存压力信息
            try {
                const { execSync } = require('child_process');
                const vmstat = execSync('vm_stat', { encoding: 'utf8' });
                
                // 从vm_stat输出中提取页面大小
                let pageSize = 16384; // 默认值，可能是16KB或4KB
                if (vmstat.includes('page size of ')) {
                    const match = vmstat.match(/page size of (\d+) bytes/);
                    if (match) {
                        pageSize = parseInt(match[1]);
                    }
                }
                
                const lines = vmstat.split('\n');
                let activePages = 0;
                let wiredPages = 0;
                let compressedPages = 0;
                let freePages = 0;
                let speculativePages = 0;
                
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine.includes('Pages free:')) {
                        freePages = parseInt(trimmedLine.split(':')[1].trim().replace('.', ''));
                    } else if (trimmedLine.includes('Pages active:')) {
                        activePages = parseInt(trimmedLine.split(':')[1].trim().replace('.', ''));
                    } else if (trimmedLine.includes('Pages wired down:')) {
                        wiredPages = parseInt(trimmedLine.split(':')[1].trim().replace('.', ''));
                    } else if (trimmedLine.includes('Pages occupied by compressor:')) {
                        compressedPages = parseInt(trimmedLine.split(':')[1].trim().replace('.', ''));
                    } else if (trimmedLine.includes('Pages speculative:')) {
                        speculativePages = parseInt(trimmedLine.split(':')[1].trim().replace('.', ''));
                    }
                }
                
                // 计算内存压力：类似Activity Monitor的内存压力算法
                // App内存 = active + wired + compressed
                // 不包括free和speculative（这些是可用的）
                const memoryPressurePages = activePages + wiredPages + compressedPages;
                return memoryPressurePages * pageSize;
            } catch (error) {
                // 如果获取失败，返回 null 使用默认计算
                return null;
            }
        } else if (platform === 'linux') {
            // Linux: 尝试读取 /proc/meminfo
            try {
                const fs = require('fs');
                const meminfo = fs.readFileSync('/proc/meminfo', 'utf8');
                const lines = meminfo.split('\n');
                
                let memTotal = 0;
                let memAvailable = 0;
                
                for (const line of lines) {
                    if (line.startsWith('MemTotal:')) {
                        memTotal = parseInt(line.split(/\s+/)[1]) * 1024; // 转换为字节
                    } else if (line.startsWith('MemAvailable:')) {
                        memAvailable = parseInt(line.split(/\s+/)[1]) * 1024; // 转换为字节
                    }
                }
                
                if (memTotal && memAvailable) {
                    return memTotal - memAvailable;
                }
            } catch (error) {
                // 如果获取失败，返回 null 使用默认计算
                return null;
            }
        }
        
        // 其他平台或获取失败时返回 null
        return null;
    }
}

module.exports = new MemoryManager();
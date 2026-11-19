#!/bin/zsh


# cron 不加载 shell 环境，必须写死 PATH
export PATH="$PATH:/opt/homebrew/bin"
#export PATH="$HOME/.vfox/sdks/nodejs/bin:$PATH"

# 如果你用 vfox / fnm / nvm，node 一定要在 PATH 里
export PM2_HOME="$HOME/.pm2"

echo "[ $(/bin/date '+%Y-%m-%d %H:%M:%S') ] restarting browser-service"

pm2 restart browser-service
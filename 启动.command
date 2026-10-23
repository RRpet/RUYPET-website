#!/bin/bash
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo '请先从 https://nodejs.org 安装 Node.js 24 LTS，然后重新双击此文件。'
  read -r -p '按回车退出…'
  exit 1
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0])>=24?0:1)'; then
  echo '请安装 Node.js 24 LTS 或更新版本。'
  read -r -p '按回车退出…'
  exit 1
fi
if [ ! -d node_modules ]; then
  echo '首次打开：正在安装依赖，需要网络连接。'
  npm ci --no-audit --no-fund
fi
(sleep 2; open http://127.0.0.1:5173) &
echo '浏览器中使用工具。结束使用后在此窗口按 Control+C 关闭服务。'
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort

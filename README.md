# CoinTrace BTC 实时行情分析平台

技术栈：React + Lightweight Charts + Node.js。

## 功能

- 聚合 Binance / Coinbase / Kraken 实时价格 + 1分钟K线。
- 实时计算交易所价差，并在超过阈值时记录预警。
- 本地持久化最近24小时K线至 `data/klines.json`。
- 主图展示价格曲线，叠加 MA5 / MA10 / MA30。
- 副图展示成交量柱状图 + RSI。
- 支持趋势线/支撑压力位标记、价格预警、截图分享、方向键时间轴控制。
- 响应式布局，支持移动端。

## 启动

```bash
npm install
npm run dev
```

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3001`

可通过 `SPREAD_ALERT_THRESHOLD` 环境变量设置价差预警阈值。

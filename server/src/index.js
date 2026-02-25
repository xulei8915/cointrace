import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.resolve(__dirname, '../../data/klines.json');
const PORT = process.env.PORT || 3001;
const SPREAD_ALERT_THRESHOLD = Number(process.env.SPREAD_ALERT_THRESHOLD || 80);

const app = express();
app.use(cors());
app.use(express.json());

const state = {
  latest: null,
  alerts: [],
  klines: loadKlineStore()
};

function loadKlineStore() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      return { binance: [], coinbase: [], kraken: [] };
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return { binance: [], coinbase: [], kraken: [] };
  }
}

function persistKlineStore() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state.klines, null, 2));
}

function pruneLast24Hours(candles) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return candles.filter((c) => c.time * 1000 >= cutoff);
}

async function fetchJson(url) {
  const response = await fetch(url, { timeout: 10000 });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchBinance() {
  const [ticker, klines] = await Promise.all([
    fetchJson('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT'),
    fetchJson('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60')
  ]);

  return {
    exchange: 'binance',
    price: Number(ticker.price),
    volume: klines.reduce((sum, k) => sum + Number(k[5]), 0),
    candles: klines.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5])
    }))
  };
}

async function fetchCoinbase() {
  const [ticker, candles] = await Promise.all([
    fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/ticker'),
    fetchJson('https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60')
  ]);

  return {
    exchange: 'coinbase',
    price: Number(ticker.price),
    volume: Number(ticker.volume || 0),
    candles: candles.slice(0, 60).map((c) => ({
      time: Number(c[0]),
      low: Number(c[1]),
      high: Number(c[2]),
      open: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5])
    })).sort((a, b) => a.time - b.time)
  };
}

async function fetchKraken() {
  const [ticker, ohlc] = await Promise.all([
    fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD'),
    fetchJson('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1')
  ]);

  const key = Object.keys(ticker.result)[0];
  const ohlcKey = Object.keys(ohlc.result).find((k) => k !== 'last');

  return {
    exchange: 'kraken',
    price: Number(ticker.result[key].c[0]),
    volume: Number(ticker.result[key].v[1]),
    candles: ohlc.result[ohlcKey].slice(-60).map((c) => ({
      time: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[6])
    }))
  };
}

function calculateSpreads(prices) {
  const names = Object.keys(prices);
  const spreads = [];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i];
      const b = names[j];
      const diff = Math.abs(prices[a] - prices[b]);
      spreads.push({ pair: `${a}-${b}`, diff });
    }
  }
  return spreads;
}

function checkSpreadAlerts(spreads) {
  const timestamp = Date.now();
  const triggered = spreads
    .filter((s) => s.diff >= SPREAD_ALERT_THRESHOLD)
    .map((s) => ({ ...s, type: 'spread', timestamp }));

  if (triggered.length > 0) {
    state.alerts = [...triggered, ...state.alerts].slice(0, 100);
  }

  return triggered;
}

async function pollMarket() {
  try {
    const [binance, coinbase, kraken] = await Promise.all([
      fetchBinance(),
      fetchCoinbase(),
      fetchKraken()
    ]);

    [binance, coinbase, kraken].forEach((snapshot) => {
      const merged = [...state.klines[snapshot.exchange], ...snapshot.candles];
      const uniqueByTime = Object.values(
        merged.reduce((acc, candle) => {
          acc[candle.time] = candle;
          return acc;
        }, {})
      );
      state.klines[snapshot.exchange] = pruneLast24Hours(uniqueByTime).sort((a, b) => a.time - b.time);
    });

    persistKlineStore();

    const prices = {
      binance: binance.price,
      coinbase: coinbase.price,
      kraken: kraken.price
    };
    const spreads = calculateSpreads(prices);
    const spreadAlerts = checkSpreadAlerts(spreads);

    state.latest = {
      timestamp: Date.now(),
      exchanges: { binance, coinbase, kraken },
      prices,
      spreads,
      spreadAlerts,
      benchmark: Object.values(prices).reduce((sum, p) => sum + p, 0) / 3
    };

    broadcast(state.latest);
  } catch (error) {
    console.error('pollMarket error', error.message);
  }
}

app.get('/api/market/latest', (req, res) => {
  res.json({
    latest: state.latest,
    alerts: state.alerts.slice(0, 20)
  });
});

app.get('/api/market/klines', (req, res) => {
  const exchange = req.query.exchange || 'binance';
  res.json({ exchange, candles: state.klines[exchange] || [] });
});

const server = app.listen(PORT, () => {
  console.log(`cointrace server running on ${PORT}`);
  pollMarket();
  setInterval(pollMarket, 5000);
});

const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(payload) {
  const text = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(text);
    }
  });
}

wss.on('connection', (ws) => {
  if (state.latest) {
    ws.send(JSON.stringify(state.latest));
  }
});

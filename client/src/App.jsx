import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import html2canvas from 'html2canvas';

const PRICE_ALERT_DEFAULT = 70000;

const averageByTime = (seriesList) => {
  const bucket = new Map();
  seriesList.forEach((candles) => {
    candles.forEach((candle) => {
      if (!bucket.has(candle.time)) {
        bucket.set(candle.time, []);
      }
      bucket.get(candle.time).push(candle);
    });
  });

  return Array.from(bucket.entries())
    .map(([time, entries]) => {
      const close = entries.reduce((sum, x) => sum + x.close, 0) / entries.length;
      const volume = entries.reduce((sum, x) => sum + x.volume, 0);
      return { time: Number(time), value: close, volume };
    })
    .sort((a, b) => a.time - b.time);
};

const movingAverage = (data, period) =>
  data.map((item, idx) => {
    if (idx < period - 1) return { time: item.time, value: null };
    const values = data.slice(idx - period + 1, idx + 1).map((d) => d.value);
    return { time: item.time, value: values.reduce((s, v) => s + v, 0) / period };
  }).filter((d) => d.value !== null);

const calculateRSI = (data, period = 14) => {
  if (data.length <= period) return [];
  const deltas = [];
  for (let i = 1; i < data.length; i += 1) {
    deltas.push(data[i].value - data[i - 1].value);
  }

  const result = [];
  for (let i = period; i < deltas.length; i += 1) {
    const slice = deltas.slice(i - period, i);
    const gains = slice.filter((x) => x > 0).reduce((s, x) => s + x, 0) / period;
    const losses = Math.abs(slice.filter((x) => x < 0).reduce((s, x) => s + x, 0)) / period;
    const rs = losses === 0 ? 100 : gains / losses;
    const rsi = 100 - 100 / (1 + rs);
    result.push({ time: data[i + 1].time, value: Number(rsi.toFixed(2)) });
  }
  return result;
};

const normalizeCandles = (candles) => (Array.isArray(candles) ? candles : []);

const mergeCandles = (existing, incoming) => {
  const safeExisting = normalizeCandles(existing);
  const safeIncoming = normalizeCandles(incoming);
  if (!safeIncoming.length) return safeExisting;

  const cutoff = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
  const byTime = new Map();

  [...safeExisting, ...safeIncoming].forEach((candle) => {
    byTime.set(candle.time, candle);
  });

  return Array.from(byTime.values())
    .filter((candle) => candle.time >= cutoff)
    .sort((a, b) => a.time - b.time);
};

export default function App() {
  const [market, setMarket] = useState(null);
  const [klines, setKlines] = useState({ binance: [], coinbase: [], kraken: [] });
  const [priceAlert, setPriceAlert] = useState(PRICE_ALERT_DEFAULT);
  const [alertEnabled, setAlertEnabled] = useState(false);
  const [drawMode, setDrawMode] = useState('none');
  const [drawings, setDrawings] = useState([]);
  const [pendingPoint, setPendingPoint] = useState(null);
  const chartRootRef = useRef(null);
  const priceChartRef = useRef(null);
  const volumeChartRef = useRef(null);

  const mergedData = useMemo(
    () => averageByTime([klines.binance, klines.coinbase, klines.kraken]),
    [klines]
  );

  useEffect(() => {
    const load = async () => {
      const [b, c, k, latest] = await Promise.all([
        fetch('/api/market/klines?exchange=binance').then((r) => r.json()),
        fetch('/api/market/klines?exchange=coinbase').then((r) => r.json()),
        fetch('/api/market/klines?exchange=kraken').then((r) => r.json()),
        fetch('/api/market/latest').then((r) => r.json())
      ]);
      setKlines((prev) => ({
        binance: mergeCandles(prev.binance, b.candles),
        coinbase: mergeCandles(prev.coinbase, c.candles),
        kraken: mergeCandles(prev.kraken, k.candles)
      }));
      setMarket(latest.latest);
    };

    load().catch(console.error);

    const ws = new WebSocket(`${window.location.origin.replace('http', 'ws')}/ws`);
    ws.onmessage = (event) => {
      const incoming = JSON.parse(event.data);
      setMarket(incoming);
      setKlines((prev) => ({
        binance: mergeCandles(prev.binance, incoming.exchanges?.binance?.candles),
        coinbase: mergeCandles(prev.coinbase, incoming.exchanges?.coinbase?.candles),
        kraken: mergeCandles(prev.kraken, incoming.exchanges?.kraken?.candles)
      }));
    };

    return () => ws.close();
  }, []);

  useEffect(() => {
    if (!market || !alertEnabled) return;
    if (market.benchmark >= priceAlert) {
      if (Notification.permission === 'granted') {
        new Notification('BTC Price Alert', {
          body: `Benchmark price reached ${market.benchmark.toFixed(2)} (target ${priceAlert})`
        });
      }
    }
  }, [market, alertEnabled, priceAlert]);

  useEffect(() => {
    if (!chartRootRef.current || mergedData.length === 0) return undefined;
    chartRootRef.current.innerHTML = '';

    const baseOptions = {
      layout: { background: { color: '#101826' }, textColor: '#d1d5db' },
      grid: { vertLines: { color: '#233045' }, horzLines: { color: '#233045' } },
      rightPriceScale: { borderColor: '#334155' },
      timeScale: { borderColor: '#334155', timeVisible: true }
    };

    const priceContainer = document.createElement('div');
    priceContainer.className = 'pane price-pane';
    const volumeContainer = document.createElement('div');
    volumeContainer.className = 'pane sub-pane';

    chartRootRef.current.appendChild(priceContainer);
    chartRootRef.current.appendChild(volumeContainer);

    const priceChart = createChart(priceContainer, { ...baseOptions, height: 380 });
    const priceSeries = priceChart.addLineSeries({ color: '#38bdf8', lineWidth: 2, title: 'BTC' });
    priceSeries.setData(mergedData);

    priceChart.addLineSeries({ color: '#f59e0b', lineWidth: 1, title: 'MA5' }).setData(movingAverage(mergedData, 5));
    priceChart.addLineSeries({ color: '#22c55e', lineWidth: 1, title: 'MA10' }).setData(movingAverage(mergedData, 10));
    priceChart.addLineSeries({ color: '#f97316', lineWidth: 1, title: 'MA30' }).setData(movingAverage(mergedData, 30));

    const volumeChart = createChart(volumeContainer, { ...baseOptions, height: 220 });
    volumeChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (range) priceChart.timeScale().setVisibleRange(range);
    });
    priceChart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (range) volumeChart.timeScale().setVisibleRange(range);
    });

    const volumeSeries = volumeChart.addHistogramSeries({ color: '#64748b', priceFormat: { type: 'volume' } });
    volumeSeries.setData(mergedData.map((d) => ({ time: d.time, value: d.volume, color: '#334155' })));

    const rsiSeries = volumeChart.addLineSeries({ color: '#c084fc', lineWidth: 2, title: 'RSI' });
    rsiSeries.setData(calculateRSI(mergedData));

    priceChartRef.current = priceChart;
    volumeChartRef.current = volumeChart;

    return () => {
      priceChart.remove();
      volumeChart.remove();
    };
  }, [mergedData]);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (!priceChartRef.current) return;
      if (e.key === 'ArrowLeft') {
        priceChartRef.current.timeScale().scrollToPosition(-10, true);
      }
      if (e.key === 'ArrowRight') {
        priceChartRef.current.timeScale().scrollToPosition(10, true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const togglePriceAlert = async () => {
    if (Notification.permission !== 'granted') {
      await Notification.requestPermission();
    }
    setAlertEnabled((prev) => !prev);
  };

  const takeSnapshot = async () => {
    if (!chartRootRef.current) return;
    const canvas = await html2canvas(chartRootRef.current, { backgroundColor: '#0b1220' });
    const url = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `cointrace-${Date.now()}.png`;
    link.href = url;
    link.click();
  };

  const onChartClick = (event) => {
    if (drawMode === 'none' || !priceChartRef.current || !priceChartRef.current.timeScale()) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    if (drawMode === 'line') {
      if (!pendingPoint) {
        setPendingPoint({ x, y });
      } else {
        setDrawings((prev) => [...prev, { type: 'line', start: pendingPoint, end: { x, y } }]);
        setPendingPoint(null);
      }
    }

    if (drawMode === 'support') {
      setDrawings((prev) => [...prev, { type: 'support', y }]);
    }
  };

  return (
    <div className="app">
      <header>
        <h1>CoinTrace BTC 实时行情分析</h1>
        <div className="toolbar">
          <label>
            目标价
            <input type="number" value={priceAlert} onChange={(e) => setPriceAlert(Number(e.target.value))} />
          </label>
          <button onClick={togglePriceAlert}>{alertEnabled ? '关闭预警' : '开启预警'}</button>
          <button onClick={takeSnapshot}>截图分享</button>
          <button className={drawMode === 'line' ? 'active' : ''} onClick={() => setDrawMode('line')}>趋势线</button>
          <button className={drawMode === 'support' ? 'active' : ''} onClick={() => setDrawMode('support')}>支撑/压力位</button>
          <button onClick={() => { setDrawMode('none'); setPendingPoint(null); }}>退出画线</button>
        </div>
      </header>

      <section className="market-cards">
        {market?.prices && Object.entries(market.prices).map(([exchange, price]) => (
          <article key={exchange}>
            <h3>{exchange}</h3>
            <p>${price.toFixed(2)}</p>
          </article>
        ))}
        <article>
          <h3>价差预警阈值</h3>
          <p>${80}</p>
        </article>
      </section>

      <section className="chart-shell" onClick={onChartClick}>
        <div ref={chartRootRef} className="chart-root" />
        <svg className="draw-overlay">
          {drawings.map((drawing, idx) => {
            if (drawing.type === 'line') {
              return <line key={idx} x1={drawing.start.x} y1={drawing.start.y} x2={drawing.end.x} y2={drawing.end.y} stroke="#ef4444" strokeWidth="2" />;
            }
            return <line key={idx} x1="0" y1={drawing.y} x2="100%" y2={drawing.y} stroke="#22c55e" strokeWidth="2" strokeDasharray="6 4" />;
          })}
          {pendingPoint && <circle cx={pendingPoint.x} cy={pendingPoint.y} r="4" fill="#f97316" />}
        </svg>
      </section>

      <section className="spread-panel">
        <h2>实时价差</h2>
        <ul>
          {(market?.spreads || []).map((s) => (
            <li key={s.pair}>{s.pair}: ${s.diff.toFixed(2)}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

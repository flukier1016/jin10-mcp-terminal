import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { KlineBar } from '../types';

/** lightweight-charts 按 UTC 渲染时间轴，整体平移 8 小时即可显示北京时间。 */
const BJ_SHIFT = 8 * 3600;

interface Props {
  bars: KlineBar[];
  /** 最新成交价：在两次 K 线拉取之间用它顶住最后一根蜡烛，图表才跟着报价一起跳。 */
  livePrice?: number;
  scheme: 'cn' | 'western';
  theme: 'dark' | 'light';
  loading: boolean;
}

/** 图表由 canvas 绘制，拿不到 CSS 变量，只能把主题色显式读出来传进去。 */
function chartPalette(theme: 'dark' | 'light') {
  return theme === 'light'
    ? {
        text: '#5a6376',
        grid: 'rgba(12,20,40,0.07)',
        border: 'rgba(12,20,40,0.16)',
        cross: 'rgba(168,106,6,0.55)',
        crossLabel: '#a86a06',
      }
    : {
        text: '#98a1b5',
        grid: 'rgba(255,255,255,0.055)',
        border: 'rgba(255,255,255,0.12)',
        cross: 'rgba(255,196,92,0.5)',
        crossLabel: '#8a6a20',
      };
}

export function Chart({ bars, livePrice, scheme, theme, loading }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const lastBarRef = useRef<KlineBar | null>(null);

  const strong = theme === 'light';
  const up = scheme === 'cn' ? (strong ? '#d81e3c' : '#ff5c72') : strong ? '#06865c' : '#19cb96';
  const down = scheme === 'cn' ? (strong ? '#06865c' : '#19cb96') : strong ? '#d81e3c' : '#ff5c72';

  // 建图只做一次；主题/配色变化通过 applyOptions 热更新，不重建实例
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p = chartPalette(theme);

    const chart = createChart(host, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: p.text,
        fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: p.grid },
        horzLines: { color: p.grid },
      },
      rightPriceScale: {
        borderColor: p.border,
        scaleMargins: { top: 0.08, bottom: 0.26 },
      },
      timeScale: {
        borderColor: p.border,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: p.cross, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.crossLabel },
        horzLine: { color: p.cross, width: 1, style: LineStyle.Dashed, labelBackgroundColor: p.crossLabel },
      },
      handleScale: { axisPressedMouseMove: { price: false } },
      autoSize: true,
    });

    const candle = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
      priceLineColor: 'rgba(245,181,68,0.55)',
      priceLineStyle: LineStyle.Dotted,
    });

    const vol = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
      priceLineVisible: false,
      lastValueVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;
    candleRef.current = candle;
    volRef.current = vol;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, []);

  // 涨跌配色切换
  useEffect(() => {
    candleRef.current?.applyOptions({
      upColor: up,
      downColor: down,
      borderUpColor: up,
      borderDownColor: down,
      wickUpColor: up,
      wickDownColor: down,
    });
  }, [up, down]);

  // 日/夜主题切换
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const p = chartPalette(theme);
    chart.applyOptions({
      layout: { textColor: p.text },
      grid: { vertLines: { color: p.grid }, horzLines: { color: p.grid } },
      rightPriceScale: { borderColor: p.border },
      timeScale: { borderColor: p.border },
      crosshair: {
        vertLine: { color: p.cross, labelBackgroundColor: p.crossLabel },
        horzLine: { color: p.cross, labelBackgroundColor: p.crossLabel },
      },
    });
  }, [theme]);

  // 数据装载
  useEffect(() => {
    const candle = candleRef.current;
    const vol = volRef.current;
    if (!candle || !vol || !bars.length) return;

    candle.setData(
      bars.map((b) => ({
        time: (b.time + BJ_SHIFT) as UTCTimestamp,
        open: Number(b.open),
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      })),
    );
    vol.setData(
      bars.map((b) => ({
        time: (b.time + BJ_SHIFT) as UTCTimestamp,
        value: b.volume,
        color: Number(b.close) >= Number(b.open) ? `${up}44` : `${down}44`,
      })),
    );
    lastBarRef.current = bars[bars.length - 1] ?? null;
    chartRef.current?.timeScale().fitContent();
  }, [bars, up, down]);

  // 实时价推动最后一根蜡烛
  useEffect(() => {
    const candle = candleRef.current;
    const last = lastBarRef.current;
    if (!candle || !last || !livePrice || !Number.isFinite(livePrice)) return;
    candle.update({
      time: (last.time + BJ_SHIFT) as UTCTimestamp,
      open: Number(last.open),
      high: Math.max(Number(last.high), livePrice),
      low: Math.min(Number(last.low), livePrice),
      close: livePrice,
    });
  }, [livePrice]);

  return (
    <div className="chart-wrap">
      <div className="chart-host" ref={hostRef} />
      {!bars.length && <div className="chart-empty">{loading ? '加载 K 线…' : '暂无 K 线数据'}</div>}
    </div>
  );
}

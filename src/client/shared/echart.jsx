/* =============================================================
   Shared ECharts wrapper — single chart lifecycle used by every
   page so init/resize/dispose and option updates behave identically.
   ============================================================= */

import { useEffect, useRef, useState } from 'react';

let runtimePromise;
function loadRuntime() {
  runtimePromise ||= import('./chart-runtime.js').catch(error => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

export function EChart({ option, height = 320, onEvents }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!('IntersectionObserver' in window)) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let chart;
    let observer;
    const onResize = () => chart?.resize();
    setError(false);
    loadRuntime().then(runtime => {
      if (cancelled || !ref.current) return;
      chart = runtime.init(ref.current, null, { renderer: 'canvas' });
      chartRef.current = chart;
      window.addEventListener('resize', onResize);
      if ('ResizeObserver' in window) {
        observer = new ResizeObserver(onResize);
        observer.observe(ref.current);
      }
      setReady(true);
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
      chart?.dispose();
      chartRef.current = null;
    };
  }, [visible, attempt]);

  useEffect(() => {
    if (chartRef.current) chartRef.current.setOption(option, true);
  }, [option, ready]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onEvents) return;
    for (const [name, handler] of Object.entries(onEvents)) chart.on(name, handler);
    return () => {
      for (const [name, handler] of Object.entries(onEvents)) chart.off(name, handler);
    };
  }, [onEvents, ready]);

  return <div style={{ position: 'relative', width: '100%', height }} aria-busy={!ready && !error}>
    <div ref={ref} style={{ width: '100%', height: '100%' }} />
    {!ready && <div role="status" style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', color: 'var(--muted)', fontSize: 12 }}>
      {error ? <button className="btn" onClick={() => setAttempt(value => value + 1)}>图表加载失败，点击重试</button> : '图表加载中…'}
    </div>}
  </div>;
}

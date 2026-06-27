/* =============================================================
   Shared ECharts wrapper — single chart lifecycle used by every
   page so init/resize/dispose and option updates behave identically.
   ============================================================= */

import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

export function EChart({ option, height = 320, onEvents }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current) return;
    chartRef.current = echarts.init(ref.current, null, { renderer: 'canvas' });
    const onResize = () => chartRef.current?.resize();
    window.addEventListener('resize', onResize);
    if (onEvents) {
      for (const [name, handler] of Object.entries(onEvents)) {
        chartRef.current.on(name, handler);
      }
    }
    return () => {
      window.removeEventListener('resize', onResize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (chartRef.current) chartRef.current.setOption(option, true);
  }, [option]);

  return <div ref={ref} style={{ width: '100%', height }} />;
}

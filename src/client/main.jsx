import { createRoot } from 'react-dom/client';
import { Component, lazy, Suspense, useEffect, useState } from 'react';
import { MotionConfig } from 'motion/react';
import { ThemeProvider } from './shared/theme.js';
import { setDisplayTimeZone } from './shared/display-time.js';

const App = lazy(() => import('./dashboard/App.jsx').then(module => ({ default: module.App })));
const ReviewApp = lazy(() => import('./review/ReviewApp.jsx').then(module => ({ default: module.ReviewApp })));

class PageBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">页面加载失败。<button onClick={() => window.location.reload()}>重新加载</button></p> : this.props.children;
  }
}

function Root() {
  const [status, setStatus] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    fetch('/api/config', { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();
      if (controller.signal.aborted) return;
      setDisplayTimeZone(config.displayTimeZone);
      setStatus('ready');
    }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [attempt]);
  if (status === 'loading') return <p role="status">正在加载展示配置…</p>;
  if (status === 'error') return <p role="alert">展示配置加载失败。<button onClick={() => setAttempt(value => value + 1)}>重试</button></p>;

  if (window.location.pathname === '/review') {
    document.title = 'AI Token 复盘 · Token Studio';
    return <ReviewApp />;
  }

  document.title = 'Token Studio · AI Token Dashboard';
  return <App />;
}

createRoot(document.getElementById('root')).render(
  <ThemeProvider>
    <MotionConfig reducedMotion="user">
      <PageBoundary><Suspense fallback={<p role="status">正在加载页面…</p>}><Root /></Suspense></PageBoundary>
    </MotionConfig>
  </ThemeProvider>
);

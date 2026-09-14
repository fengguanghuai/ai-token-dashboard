import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import { App } from './dashboard/App.jsx';
import { ReviewApp } from './review/ReviewApp.jsx';
import { ThemeProvider } from './shared/theme.js';

function Root() {
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
      <Root />
    </MotionConfig>
  </ThemeProvider>
);

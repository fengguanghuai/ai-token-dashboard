import { createRoot } from 'react-dom/client';
import { App } from './dashboard/App.jsx';
import { ReviewApp } from './review/ReviewApp.jsx';

function Root() {
  if (window.location.pathname === '/review') {
    document.title = 'AI Token 复盘 · Token Studio';
    return <ReviewApp />;
  }

  document.title = 'Token Studio · AI Token Dashboard';
  return <App />;
}

createRoot(document.getElementById('root')).render(<Root />);

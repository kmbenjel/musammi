import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

// Unregister all service workers and wipe stale caches completely
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) {
      reg.unregister();
    }
  });
}
if ('caches' in window) {
  caches.keys().then((keys) => {
    for (const key of keys) {
      caches.delete(key);
    }
  });
}

// Error boundary & fallback display for diagnostics
class RootErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('App Crash:', error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '24px', direction: 'rtl', fontFamily: 'sans-serif', color: '#ffb4b4', backgroundColor: '#1a0505', minHeight: '100vh' }}>
          <h2>حدث خطأ أثناء تحميل الواجهة</h2>
          <pre style={{ direction: 'ltr', background: '#2a0a0a', padding: '12px', borderRadius: '8px', overflowX: 'auto' }}>
            {this.state.error?.stack || this.state.error?.message}
          </pre>
          <button onClick={() => { localStorage.clear(); window.location.reload(); }} style={{ padding: '10px 16px', background: '#d32f2f', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', marginTop: '16px' }}>
            مسح الذاكرة المؤقتة وإعادة التحميل
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <RootErrorBoundary>
    <App />
  </RootErrorBoundary>
);

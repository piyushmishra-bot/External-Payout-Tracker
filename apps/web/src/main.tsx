import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './app';
import { HttpApi } from './api/http';
import { DemoApi } from './api/demo';

const isDemo = import.meta.env.VITE_DEMO === '1' || import.meta.env.MODE === 'demo';
const demo = isDemo ? new DemoApi() : undefined;
const api = demo ?? new HttpApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App api={api} demo={demo} />
  </StrictMode>,
);

/** Browser entry point. React owns screens; the engine owns game state and legality. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './style.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

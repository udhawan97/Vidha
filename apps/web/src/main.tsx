import '@fontsource-variable/manrope';
import '@fontsource-variable/newsreader';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('Vidha could not find its application root.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

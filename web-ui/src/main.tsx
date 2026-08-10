import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Sprite } from './marks';
import './styles.css';

/** Dark is a comfort setting from the system, never a switch of its own. */
const dark = window.matchMedia('(prefers-color-scheme: dark)');
const paint = (on: boolean): void => {
  document.documentElement.classList.toggle('theme-dark', on);
};
paint(dark.matches);
dark.addEventListener('change', (e) => paint(e.matches));

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Sprite />
    <App />
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AuthRoot from './AuthRoot';
import './styles.css';
import './accounts.css';

createRoot(document.getElementById('root')!).render(<StrictMode><AuthRoot /></StrictMode>);

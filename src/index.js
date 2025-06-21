import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { BrowserRouter } from 'react-router-dom';

import { SessionContextProvider } from '@supabase/auth-helpers-react';
import { supabase } from './supabaseClient';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <SessionContextProvider supabaseClient={supabase}>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </SessionContextProvider>
);

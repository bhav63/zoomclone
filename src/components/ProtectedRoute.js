// src/components/ProtectedRoute.js
import { Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';

export default function ProtectedRoute({ children }) {
  const [authChecked, setAuthChecked] = useState(false);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const checkUser = async () => {
      const { data, error } = await supabase.auth.getUser();
      if (!error) {
        setUser(data.user);
      }
      setAuthChecked(true);
    };

    checkUser();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setAuthChecked(true);
    });

    return () => {
      authListener.subscription?.unsubscribe();
    };
  }, []);

  if (!authChecked) return <div>Loading...</div>;

  // 🔁 Redirect to "/login" instead of "/"
  return user ? children : <Navigate to="/login" replace />;
}

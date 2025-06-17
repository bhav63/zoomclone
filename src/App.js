// src/App.js
import React from 'react';
import { Routes, Route } from 'react-router-dom';
import MeetingRoom from './pages/MeetingRoom';
import Home from './pages/Home';
import Auth from './pages/Auth'; // ✅ import your Auth component
import ProtectedRoute from './components/ProtectedRoute';

function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Auth />} /> 
      <Route
        path="/room/:roomId"
        element={
          <ProtectedRoute>
            <MeetingRoom />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default App;

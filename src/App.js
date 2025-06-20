import React from 'react';
import { Routes, Route } from 'react-router-dom';
import MeetingRoom from './pages/MeetingRoom';
import Home from './pages/Home';
import Auth from './pages/Auth';
import WaitingRoom from './pages/WaitingRoom'; // ✅ Add this line
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
      <Route
        path="/waiting-room/:roomId" 
        element={
          <ProtectedRoute>
            <WaitingRoom />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default App;

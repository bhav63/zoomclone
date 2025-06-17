// src/RoomPage.js
import React from 'react';
import { useParams } from 'react-router-dom';

function RoomPage() {
  const { code } = useParams();

  return (
    <div>
      <h1>🔴 You are in Room: {code}</h1>
      {/* Later: video call screen */}
    </div>
  );
}

export default RoomPage;

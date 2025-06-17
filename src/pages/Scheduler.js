// src/pages/Scheduler.jsx
import { useState } from "react";
import { supabase } from "../supabaseClient";
import { useNavigate } from "react-router-dom";

export default function Scheduler() {
  const [roomId, setRoomId] = useState("");
  const [title, setTitle] = useState("");
  const [passcode, setPasscode] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const navigate = useNavigate();

  const scheduleMeeting = async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error } = await supabase.from("meetings").insert({
      room_id: roomId,
      title,
      passcode,
      scheduled_at: scheduledAt,
      creator_id: user.id,
    });

    if (error) return alert("Error scheduling: " + error.message);
    alert("✅ Meeting scheduled!");
    navigate(`/meeting/${roomId}`);
  };

  return (
    <div className="p-4 max-w-md mx-auto">
      <h2 className="text-xl font-bold mb-4">Schedule a Meeting</h2>
      <input value={roomId} onChange={e => setRoomId(e.target.value)} placeholder="Room ID" className="border p-2 mb-2 w-full" />
      <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className="border p-2 mb-2 w-full" />
      <input value={passcode} onChange={e => setPasscode(e.target.value)} placeholder="Passcode" className="border p-2 mb-2 w-full" />
      <input type="datetime-local" value={scheduledAt} onChange={e => setScheduledAt(e.target.value)} className="border p-2 mb-4 w-full" />
      <button onClick={scheduleMeeting} className="bg-blue-600 text-white px-4 py-2 rounded w-full">
        Schedule
      </button>
    </div>
  );
}

// src/pages/WaitingRoom.js
import React, { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "../supabaseClient";

export default function WaitingRoom() {
  const { roomId } = useParams();
  const [waitingList, setWaitingList] = useState([]);
  const [isHost, setIsHost] = useState(false);
  const [meetingId, setMeetingId] = useState(null);
  const channelRef = useRef(null);

  useEffect(() => {
    initialize();
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  async function initialize() {
    // Get current logged in user
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    // Get meeting info from DB
    const { data: meeting, error } = await supabase
      .from("meetings")
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle();

    if (error || !meeting) {
      console.error("Meeting not found");
      return;
    }

    setMeetingId(meeting.id);

    const userIsHost = user.id === meeting.creator_id;
    setIsHost(userIsHost);

    if (!userIsHost) return;

    await fetchWaitingUsers(meeting.id);

    // Live updates
    channelRef.current = supabase
      .channel(`room-approvals-${meeting.id}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "participants",
          filter: `meeting_id=eq.${meeting.id}`,
        },
        () => fetchWaitingUsers(meeting.id)
      )
      .subscribe();
  }

  async function fetchWaitingUsers(meetingId) {
    const { data, error } = await supabase
      .from("participants")
      .select("user_id, status, users(email)")
      .eq("meeting_id", meetingId)
      .eq("status", "pending");

    if (!error) setWaitingList(data || []);
  }

  async function approveUser(userId) {
    await supabase
      .from("participants")
      .update({ status: "approved" })
      .eq("meeting_id", meetingId)
      .eq("user_id", userId);
  }

  async function denyUser(userId) {
    await supabase
      .from("participants")
      .update({ status: "denied" })
      .eq("meeting_id", meetingId)
      .eq("user_id", userId);
  }

  if (!isHost) return <div className="p-4">❌ You are not the meeting host.</div>;

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-4">👑 Waiting Room (Host Panel)</h2>

      {waitingList.length === 0 ? (
        <p>No users waiting for approval.</p>
      ) : (
        <ul className="space-y-4">
          {waitingList.map((user) => (
            <li
              key={user.user_id}
              className="border rounded p-4 flex justify-between items-center"
            >
              <span>{user.users?.email || user.user_id}</span>
              <div className="space-x-2">
                <button
                  className="bg-green-500 text-white px-3 py-1 rounded"
                  onClick={() => approveUser(user.user_id)}
                >
                  ✅ Approve
                </button>
                <button
                  className="bg-red-500 text-white px-3 py-1 rounded"
                  onClick={() => denyUser(user.user_id)}
                >
                  ❌ Deny
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

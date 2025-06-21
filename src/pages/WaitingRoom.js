import React, { useEffect, useState } from "react";
import { useSupabaseClient, useUser } from "@supabase/auth-helpers-react";

export default function WaitingRoom() {
  const supabase = useSupabaseClient();
  const user = useUser();
  const [pendingParticipants, setPendingParticipants] = useState([]);
  const [meetingId, setMeetingId] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchPending = async () => {
      if (!user) return;

      const { data: userMeetingData } = await supabase
        .from("participants")
        .select("meeting_id, role")
        .eq("user_id", user.id)
        .maybeSingle();

      if (!userMeetingData) {
        setLoading(false);
        return;
      }

      setMeetingId(userMeetingData.meeting_id);
      const isHostUser = userMeetingData.role === "host";
      setIsHost(isHostUser);

      if (isHostUser) {
        const { data, error } = await supabase
          .from("participants")
          .select("id, user_id, status")
          .eq("meeting_id", userMeetingData.meeting_id)
          .eq("status", "pending");

        if (!error) setPendingParticipants(data || []);
      }

      setLoading(false);
    };

    fetchPending();
  }, [supabase, user]);

  if (loading) return <div>Loading...</div>;

  return (
    <div className="p-4">
      <h1>🕒 Waiting Room</h1>
      {isHost ? (
        <div>
          <h2>Pending Join Requests</h2>
          <ul>
            {pendingParticipants.map((p) => (
              <li key={p.id}>{p.user_id}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p>Waiting for the host to let you in...</p>
      )}
    </div>
  );
}

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
      if (!user) return; // ✅ early exit if user not ready

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

        if (!error) setPendingParticipants(data);
      }

      setLoading(false);
    };

    fetchPending();
  }, [user]);

  if (!user || loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-screen space-y-6">
      <h1 className="text-3xl font-bold">🕐 Waiting Room</h1>
      <p className="text-gray-600">
        Users will wait here until approved by the host.
      </p>

      {isHost && (
        <div className="w-full max-w-md space-y-4">
          <h2 className="text-xl font-semibold text-center">Pending Participants</h2>
          {pendingParticipants.length === 0 ? (
            <p className="text-center text-gray-500">No pending users.</p>
          ) : (
            pendingParticipants.map((participant) => (
              <div
                key={participant.id}
                className="flex justify-between items-center bg-gray-100 px-4 py-2 rounded shadow"
              >
                <span>User ID: {participant.user_id}</span>
                <div className="space-x-2">
                  <button
                    onClick={() => updateStatus(participant.id, "approved")}
                    className="px-3 py-1 bg-green-500 text-white rounded"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => updateStatus(participant.id, "denied")}
                    className="px-3 py-1 bg-red-500 text-white rounded"
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );

  async function updateStatus(id, status) {
    const { error } = await supabase
      .from("participants")
      .update({ status })
      .eq("id", id);

    if (!error) {
      setPendingParticipants((prev) =>
        prev.filter((p) => p.id !== id)
      );
    }
  }
}

// src/pages/Join.jsx
import React, { useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { supabase } from "../supabaseClient";

export default function Join() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState("");
  const room = params.get("room");
  const code = params.get("code");

  useEffect(() => {
    (async () => {
      if (!room || !code) return setError("Invalid link");
      const { data, error } = await supabase
        .from("meetings")
        .select("passcode")
        .eq("room_id", room)
        .single();
      if (error || !data || data.passcode !== code) {
        setError("Invalid room or code");
      } else {
        navigate(`/room/${room}`);
      }
    })();
  }, []);

  return (
    <div className="p-6">
      {error ? <div className="text-red-600">{error}</div> : <div>Redirecting...</div>}
    </div>
  );
}

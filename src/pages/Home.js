import React, { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { useNavigate } from "react-router-dom";


export default function Home() {
  const nav = useNavigate();
  const [user, setUser] = useState(null);
  const [meetings, setMeetings] = useState([]);
  const [instPass, setInstPass] = useState("");
  const [schedTitle, setSchedTitle] = useState("");
  const [schedRoom, setSchedRoom] = useState("");
  const [schedPass, setSchedPass] = useState("");
  const [schedTime, setSchedTime] = useState("");
  const [joinRoom, setJoinRoom] = useState("");
  const [joinPass, setJoinPass] = useState("");
  const [joinLink, setJoinLink] = useState("");
  const [lastRoomLink, setLastRoomLink] = useState("");

  const BASE_URL = process.env.REACT_APP_PUBLIC_URL || "https://zoomclone-v3.vercel.app";

  useEffect(() => {
    const fetchUserAndMeetings = async () => {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data?.user) {
        nav("/login");
        return;
      }
      setUser(data.user);
      loadMeetings(data.user.id);
    };

    fetchUserAndMeetings();
  }, [nav]);

  const loadMeetings = async (userId) => {
    const { data, error } = await supabase
      .from("meetings")
      .select("*")
      .eq("creator_id", userId)
      .order("scheduled_start", { ascending: true });

    if (!error && data) {
      const now = new Date();
      const upcoming = data.filter(
        (m) =>
          m.scheduled_start && new Date(m.scheduled_start) > now
      );
      setMeetings(upcoming);
    }
  };

  const randomRoom = () => crypto.randomUUID().slice(0, 8);

  const createInstant = async () => {
    const room = randomRoom();

    const { data, error } = await supabase
      .from("meetings")
      .insert({
        room_id: room,
        title: "Instant Meeting",
        creator_id: user.id,
        passcode: instPass || null,
        scheduled_start: null,
      })
      .select()
      .single();

    if (error || !data) {
      return alert("Error creating meeting: " + (error?.message || ""));
    }

    const link = `${BASE_URL}/room/${room}${instPass ? `?passcode=${encodeURIComponent(instPass)}` : ""}`;
    setLastRoomLink(link);
    nav(`/room/${room}${instPass ? `?passcode=${encodeURIComponent(instPass)}` : ""}`);
  };

  const scheduleMeeting = async () => {
    const room = schedRoom || randomRoom();

    if (!schedTitle || !schedTime) {
      return alert("Title and scheduled date/time are required.");
    }

    const { error } = await supabase.from("meetings").insert({
      room_id: room,
      title: schedTitle,
      creator_id: user.id,
      passcode: schedPass || null,
      scheduled_start: schedTime,
    });

    if (error) {
      return alert("Error scheduling meeting: " + error.message);
    }

    alert("Meeting scheduled!");
    setSchedTitle("");
    setSchedRoom("");
    setSchedPass("");
    setSchedTime("");
    loadMeetings(user.id);
  };

  const join = () => {
    if (!joinRoom) return alert("Room ID is required.");
    const path = `/room/${joinRoom}${joinPass ? `?passcode=${encodeURIComponent(joinPass)}` : ""}`;
    nav(path);
  };

  const joinByLink = () => {
    try {
      const url = new URL(joinLink);
      const pathname = url.pathname;
      const passcode = url.searchParams.get("passcode");
      const parts = pathname.split("/");
      const roomId = parts[2];
      if (!roomId) throw new Error("Room ID not found in link.");

      const path = `/room/${roomId}${passcode ? `?passcode=${encodeURIComponent(passcode)}` : ""}`;
      nav(path);
    } catch (err) {
      alert("Invalid meeting link.");
    }
  };

  return (
    <div style={{ padding: "2rem", maxWidth: 600, margin: "auto" }}>
      <h1>📹 MT Video App</h1>

      {/* Instant Meeting */}
      <section>
        <h2>Instant Meeting</h2>
        <input
          placeholder="Passcode (optional)"
          value={instPass}
          onChange={(e) => setInstPass(e.target.value)}
        />
        <button onClick={createInstant}>Create & Start</button>
        {lastRoomLink && (
          <p>
            Meeting link:{" "}
            <a href={lastRoomLink} target="_blank" rel="noopener noreferrer">
              {lastRoomLink}
            </a>
          </p>
        )}
      </section>

      {/* Schedule Meeting */}
      <section style={{ marginTop: 30 }}>
        <h2>Schedule Meeting</h2>
        <input
          placeholder="Title"
          value={schedTitle}
          onChange={(e) => setSchedTitle(e.target.value)}
        />
        <input
          placeholder="Room ID (optional)"
          value={schedRoom}
          onChange={(e) => setSchedRoom(e.target.value)}
        />
        <input
          placeholder="Passcode (optional)"
          value={schedPass}
          onChange={(e) => setSchedPass(e.target.value)}
        />
        <input
          type="datetime-local"
          value={schedTime}
          onChange={(e) => setSchedTime(e.target.value)}
        />
        <button onClick={scheduleMeeting}>Schedule Meeting</button>
      </section>

      {/* Join Meeting */}
      <section style={{ marginTop: 30 }}>
        <h2>Join Meeting</h2>
        <input
          placeholder="Room ID"
          value={joinRoom}
          onChange={(e) => setJoinRoom(e.target.value)}
        />
        <input
          placeholder="Passcode (if any)"
          value={joinPass}
          onChange={(e) => setJoinPass(e.target.value)}
        />
        <button onClick={join}>Join</button>

        <hr style={{ margin: "1rem 0" }} />

        <input
          placeholder="Or paste full meeting link"
          value={joinLink}
          onChange={(e) => setJoinLink(e.target.value)}
        />
        <button onClick={joinByLink}>Join via Link</button>
      </section>

      {/* Upcoming Scheduled Meetings */}
      <section style={{ marginTop: 30 }}>
        <h2>Upcoming Scheduled Meetings</h2>
        {meetings.length === 0 ? (
          <p>No upcoming meetings.</p>
        ) : (
          <ul>
            {meetings.map((m) => {
              const fullLink = `${BASE_URL}/room/${m.room_id}${
                m.passcode ? `?passcode=${encodeURIComponent(m.passcode)}` : ""
              }`;
              return (
                <li key={m.id} style={{ marginBottom: 12 }}>
                  <strong>{m.title}</strong>{" "}
                  – {new Date(m.scheduled_start).toLocaleString()}
                  <br />
                  Room: {m.room_id}{" "}
                  <button
                    onClick={() =>
                      nav(`/room/${m.room_id}${m.passcode ? `?passcode=${encodeURIComponent(m.passcode)}` : ""}`)
                    }
                  >
                    Join
                  </button>
                  <br />
                  Link:{" "}
                  <a href={fullLink} target="_blank" rel="noopener noreferrer">
                    {fullLink}
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

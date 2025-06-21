import React, { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import Peer from "peerjs";
import RecordRTC from "recordrtc";
import { supabase } from "../supabaseClient";

export default function MeetingRoom() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();

  const [isHost, setIsHost] = useState(false);
  const [waitingList, setWaitingList] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [meetingDbId, setMeetingDbId] = useState(null);
  const [passcodeRequired, setPasscodeRequired] = useState(false);

  const localVideoRef = useRef();
  const remoteVideosRef = useRef({});
  const localStreamRef = useRef();
  const peerRef = useRef();
  const recorderRef = useRef();

  const signalsChannel = useRef();
  const participantsChannel = useRef();
  const waitingChannel = useRef();
  const refreshInterval = useRef();

  const BASE_URL = "https://zoomclone-v3.vercel.app";
  const shareLink = `${BASE_URL}/room/${roomId}${
    passcodeRequired
      ? `?passcode=${new URLSearchParams(search).get("passcode")}`
      : ""
  }`;

  useEffect(() => {
    initRoom();
    return () => leaveRoom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function initRoom() {
    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) return navigate("/login");
    const user = userData.user;

    const { data: meeting } = await supabase
      .from("meetings")
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle();

    if (!meeting) return navigate("/");

    setMeetingDbId(meeting.id);
    setIsHost(user.id === meeting.creator_id);
    setPasscodeRequired(!!meeting.passcode);

    const providedPass = new URLSearchParams(search).get("passcode");
    if (meeting.passcode && providedPass !== meeting.passcode) {
      const attempt = prompt("Enter passcode:");
      if (attempt !== meeting.passcode) return navigate("/");
    }

    if (user.id === meeting.creator_id) {
      await joinMeeting(meeting.id, user.id);
      setupWaitingListener(meeting.id);
      return;
    }

    const { data: participantEntry } = await supabase
      .from("participants")
      .select("status")
      .eq("meeting_id", meeting.id)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!participantEntry) {
      await supabase.from("participants").insert({
        meeting_id: meeting.id,
        user_id: user.id,
        status: "pending",
      });
      setupParticipantListener(meeting.id, user.id);
      return navigate("/waiting");
    }

    const { status } = participantEntry;
    if (status === "pending") {
      setupParticipantListener(meeting.id, user.id);
      return navigate("/waiting");
    }

    if (status === "denied") {
      alert("⛔ You have been denied entry by host.");
      return navigate("/");
    }
    if (status === "approved") {
      await joinMeeting(meeting.id, user.id);
    }
  }

  function setupWaitingListener(meetingId) {
    updateWaitingList(meetingId);
    waitingChannel.current = supabase
      .channel(`waiting:${meetingId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "participants",
          filter: `meeting_id=eq.${meetingId}`,
        },
        () => updateWaitingList(meetingId)
      )
      .subscribe();
  }

  async function updateWaitingList(meetingId) {
    const { data, error } = await supabase
      .from("participants")
      .select("user_id, users(email)")
      .eq("meeting_id", meetingId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (!error) setWaitingList(data || []);
  }

  function setupParticipantListener(meetingId, userId) {
    participantsChannel.current = supabase
      .channel(`participants:you:${meetingId}:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "participants",
          filter: `meeting_id=eq.${meetingId},user_id=eq.${userId}`,
        },
        (payload) => {
          const newStatus = payload.new.status;
          if (newStatus === "approved") joinMeeting(meetingId, userId);
          if (newStatus === "denied") {
            alert("⛔ Your request was denied.");
            navigate("/");
          }
        }
      )
      .subscribe();
  }

  async function approveUser(user_id) {
    await supabase
      .from("participants")
      .update({ status: "approved" })
      .eq("meeting_id", meetingDbId)
      .eq("user_id", user_id);
  }

  async function denyUser(user_id) {
    await supabase
      .from("participants")
      .update({ status: "denied" })
      .eq("meeting_id", meetingDbId)
      .eq("user_id", user_id);
  }

  async function joinMeeting(meetingId, userId) {
    updateParticipants(meetingId);

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localStreamRef.current = stream;
    localVideoRef.current.srcObject = stream;

    const peer = new Peer();
    peerRef.current = peer;

    peer.on("open", async (peerId) => {
      await supabase
        .from("signals")
        .insert({ room_id: roomId, peer_id: peerId });

      const { data: others } = await supabase
        .from("signals")
        .select("*")
        .eq("room_id", roomId)
        .neq("peer_id", peerId);

      others.forEach((o) => setupCall(peer.call(o.peer_id, stream), o.peer_id));

      signalsChannel.current = supabase
        .channel(`signals:${roomId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "signals",
            filter: `room_id=eq.${roomId}`,
          },
          (payload) => {
            if (payload.new.peer_id !== peerId)
              setupCall(
                peer.call(payload.new.peer_id, stream),
                payload.new.peer_id
              );
          }
        )
        .subscribe();
    });

    peer.on("call", (call) => {
      call.answer(stream);
      setupCall(call, call.peer);
    });

    const { data: oldMsgs } = await supabase
      .from("messages")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });
    setMessages(oldMsgs || []);

    supabase
      .channel(`messages:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => setMessages((m) => [...m, payload.new])
      )
      .subscribe();

    supabase
      .channel(`reactions:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "reactions",
          filter: `room_id=eq.${roomId}`,
        },
        (payload) => {
          setReactions((r) => [...r, payload.new]);
          setTimeout(
            () => setReactions((r) => r.filter((x) => x.id !== payload.new.id)),
            10000
          );
        }
      )
      .subscribe();

    refreshInterval.current = setInterval(iceRestart, 5000);
  }

  async function updateParticipants(meetingId) {
    const { data } = await supabase
      .from("participants")
      .select("user_id")
      .eq("meeting_id", meetingId)
      .eq("status", "approved");
    setParticipants(data.map((p) => p.user_id));
  }

  function setupCall(call, peerId) {
    call.on("stream", (stream) => addRemote(peerId, stream));
    call.on("close", () => removeRemote(peerId));
    call.on("error", () => removeRemote(peerId));
  }

  function addRemote(id, stream) {
    if (remoteVideosRef.current[id]) return;
    const container = document.createElement("div");
    const video = document.createElement("video");
    video.srcObject = stream;
    video.autoplay = true;
    video.playsInline = true;
    container.appendChild(video);
    remoteVideosRef.current[id] = container;
    document.getElementById("remote-videos")?.appendChild(container);
  }

  function removeRemote(id) {
    const el = remoteVideosRef.current[id];
    if (el) el.remove();
    delete remoteVideosRef.current[id];
  }

  function iceRestart() {
    Object.values(peerRef.current.connections || {})
      .flat()
      .forEach((conn) => {
        conn.peerConnection.restartIce?.();
      });
  }

  function toggleMute() {
    const t = localStreamRef.current?.getAudioTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      setIsMuted(!t.enabled);
    }
  }

  function toggleCam() {
    const t = localStreamRef.current?.getVideoTracks()[0];
    if (t) {
      t.enabled = !t.enabled;
      setCameraOn(t.enabled);
    }
  }

  async function shareScreen() {
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const track = display.getVideoTracks()[0];
      Object.values(peerRef.current.connections || {})
        .flat()
        .forEach((conn) => {
          const sender = conn.peerConnection
            .getSenders()
            .find((s) => s.track.kind === "video");
          sender?.replaceTrack(track);
        });
      track.onended = toggleCam;
    } catch {
      alert("Screen sharing failed.");
    }
  }

  function startRecording() {
    const mix = new MediaStream();
    localStreamRef.current.getTracks().forEach((t) => mix.addTrack(t));
    Object.values(remoteVideosRef.current)
      .map((el) => el.querySelector("video"))
      .forEach((v) => v?.srcObject.getTracks().forEach((t) => mix.addTrack(t)));
    const rec = RecordRTC(mix, { mimeType: "video/webm" });
    rec.startRecording();
    recorderRef.current = rec;
    setIsRecording(true);
  }

  async function stopRecording() {
  const rec = recorderRef.current;
  if (!rec) return;

  await rec.stopRecording();
  const blob = rec.getBlob();
  const filename = `rec-${roomId}-${Date.now()}.webm`;

  const { data: u } = await supabase.auth.getUser();
  if (!u?.user?.email) {
    alert("User not authenticated.");
    return;
  }

  const { data, error } = await supabase.storage
    .from("recordings")
    .upload(filename, blob);
  if (error) return alert("Upload failed.");

  await supabase.from("recordings").insert({
    room_id: roomId,
    uploaded_by: u.user.email,
    file_name: filename,
    file_url: data.path,
  });

  setIsRecording(false);
  alert("Recording saved!");
}


  async function leaveRoom() {
    if (isRecording) await stopRecording();
    peerRef.current?.destroy();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    Object.values(remoteVideosRef.current).forEach((el) => el.remove());
    clearInterval(refreshInterval.current);
    const { data: me } = await supabase.auth.getUser();
    await supabase
      .from("participants")
      .delete()
      .eq("meeting_id", meetingDbId)
      .eq("user_id", me?.user?.id);
    signalsChannel.current?.unsubscribe();
    participantsChannel.current?.unsubscribe();
    waitingChannel.current?.unsubscribe();
    navigate("/");
  }

  async function sendMessage() {
    if (!chatInput.trim()) return;
    const { data: u } = await supabase.auth.getUser();
    const msg = {
      room_id: roomId,
      sender: u.user.email,
      text: chatInput,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, msg]);
    await supabase.from("messages").insert(msg);
    setChatInput("");
  }

  async function sendReaction(emoji) {
    const { data: u } = await supabase.auth.getUser();
    const r = {
      room_id: roomId,
      user_id: u.user.id,
      emoji,
      created_at: new Date().toISOString(),
    };
    setReactions((r0) => [...r0, r]);
    setTimeout(() => setReactions((r0) => r0.filter((x) => x !== r)), 10000);
    await supabase.from("reactions").insert(r);
    await supabase.from("messages").insert({
      room_id: roomId,
      sender: u.user.email,
      text: `reacted with ${emoji}`,
      created_at: new Date().toISOString(),
    });
  }

  return (
    <div className="p-4 space-y-4">
      <h1>🖥 Room: {roomId}</h1>
      <div>
        <strong>Share link:</strong>{" "}
        <input
          type="text"
          readOnly
          value={shareLink}
          onClick={(e) => e.target.select()}
        />
        <button
          onClick={() => {
            navigator.clipboard.writeText(shareLink);
            alert("Link copied!");
          }}
        >
          Copy
        </button>
      </div>

      {isHost && waitingList.length > 0 && (
        <div className="bg-gray-100 p-4 rounded">
          <h2>Waiting Room ({waitingList.length})</h2>
          {waitingList.map((w) => (
            <div key={w.user_id} className="flex items-center gap-2">
              <span>{w.users?.email || w.user_id}</span>
              <button onClick={() => approveUser(w.user_id)}>✅ Approve</button>
              <button onClick={() => denyUser(w.user_id)}>❌ Deny</button>
            </div>
          ))}
        </div>
      )}

      <p>
        {isHost ? "Host" : "Guest"} — Participants: {participants.length}
      </p>

      <div className="grid grid-cols-2 gap-4">
        <video
          ref={localVideoRef}
          muted
          autoPlay
          playsInline
          className="border"
        />
        <div id="remote-videos" className="flex flex-wrap gap-2" />
      </div>

      <div className="flex gap-2 flex-wrap">
        <button onClick={toggleMute}>{isMuted ? "Unmute" : "Mute"}</button>
        <button onClick={toggleCam}>
          {cameraOn ? "Camera Off" : "Camera On"}
        </button>
        <button onClick={shareScreen}>Share Screen</button>
        {!isRecording ? (
          <button onClick={startRecording}>Start Rec</button>
        ) : (
          <button onClick={stopRecording}>Stop Rec</button>
        )}
        <button onClick={() => sendReaction("👋")}>👋</button>
        <button className="text-red-600" onClick={leaveRoom}>
          Leave
        </button>
      </div>

      <div className="space-y-2">
        <div className="border p-2 h-40 overflow-y-auto bg-gray-50">
          {messages.map((m, i) => (
            <div key={i}>
              <strong>{m.sender}:</strong> {m.text}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="flex-1 border p-2"
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && sendMessage()}
            placeholder="Type message..."
          />
          <button onClick={sendMessage}>Send</button>
        </div>
      </div>

      <div>
        <strong>Reactions:</strong>
        <div className="mt-2 flex gap-2 text-2xl">
          {["👍", "❤️", "😂", "🎉", "😮"].map((emoji) => (
            <button key={emoji} onClick={() => sendReaction(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
        <div className="mt-2 flex gap-2 text-3xl">
          {reactions.map((r, i) => (
            <span key={i}>{r.emoji}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

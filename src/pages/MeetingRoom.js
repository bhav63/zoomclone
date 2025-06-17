// src/components/MeetingRoom.jsx
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
  const [chatInput, setChatInput] = useState("");
  const [reactions, setReactions] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [meetingDbId, setMeetingDbId] = useState(null);
  const [passcodeRequired, setPasscodeRequired] = useState(false);

  const localVideoRef = useRef(null);
  const remoteVideosRef = useRef({});
  const localStreamRef = useRef(null);
  const peerRef = useRef(null);
  const recorderRef = useRef(null);

  const signalsChannel = useRef(null);
  const messagesChannel = useRef(null);
  const reactionsChannel = useRef(null);
  const participantsChannel = useRef(null);
  const waitingChannel = useRef(null);

  useEffect(() => {
    initRoom();
    return () => leaveRoom();
    // eslint-disable-next-line
  }, []);

  async function initRoom() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return navigate("/");

    const { data: meeting } = await supabase
      .from("meetings")
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle();
    if (!meeting) return navigate("/");

    setMeetingDbId(meeting.id);
    const host = user.id === meeting.creator_id;
    setIsHost(host);
    setPasscodeRequired(!!meeting.passcode);

    const passFromUrl = new URLSearchParams(search).get("passcode") || "";
    if (meeting.passcode && passFromUrl !== meeting.passcode) {
      const attempt = prompt("Enter passcode:");
      if (attempt !== meeting.passcode) return navigate("/");
    }

    if (!host) {
      await supabase
        .from("waiting_room")
        .insert({ room_id: roomId, user_id: user.id, email: user.email });
      alert("Waiting for approval...");
    }

    await joinMeeting(meeting.id);
    if (host) listenWaitingRoom();
  }

  function listenWaitingRoom() {
    if (waitingChannel.current) return;
    waitingChannel.current = supabase
      .channel(`waiting:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "waiting_room",
          filter: `room_id=eq.${roomId}`,
        },
        fetchWaiting
      )
      .subscribe();
    fetchWaiting();
  }

  async function fetchWaiting() {
    const { data } = await supabase
      .from("waiting_room")
      .select("*")
      .eq("room_id", roomId);
    setWaitingList(data || []);
  }

  async function approveUser(user_id) {
    await supabase
      .from("waiting_room")
      .delete()
      .eq("room_id", roomId)
      .eq("user_id", user_id);
    await supabase
      .from("participants")
      .insert({ meeting_id: meetingDbId, user_id });
  }

  async function joinMeeting(meetingId) {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    // 🔒 Wait until local video ref is ready
    if (!localVideoRef.current) {
      await new Promise((resolve) => {
        const interval = setInterval(() => {
          if (localVideoRef.current) {
            clearInterval(interval);
            resolve();
          }
        }, 50);
      });
    }

    // ✅ Continue after ref is available
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    localStreamRef.current = stream;
    localVideoRef.current.srcObject = stream;

    const peer = new Peer();
    peerRef.current = peer;

    peer.on("open", async (id) => {
      await supabase.from("signals").insert({ room_id: roomId, peer_id: id });
      const { data: others } = await supabase
        .from("signals")
        .select("*")
        .eq("room_id", roomId)
        .neq("peer_id", id);

      others.forEach((o) => {
        const call = peer.call(o.peer_id, stream);
        call.on("stream", (s) => addRemote(o.peer_id, s));
      });

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
          (p) => {
            if (p.new.peer_id !== id) {
              const call = peer.call(p.new.peer_id, stream);
              call.on("stream", (s) => addRemote(p.new.peer_id, s));
            }
          }
        )
        .subscribe();
    });

    peer.on("call", (c) => {
      c.answer(localStreamRef.current);
      c.on("stream", (s) => addRemote(c.peer, s));
    });

    const { data: oldMsgs } = await supabase
      .from("messages")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at");
    setMessages(oldMsgs || []);

    messagesChannel.current = supabase
      .channel(`messages:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `room_id=eq.${roomId}`,
        },
        (p) => {
          setMessages((prev) => [...prev, p.new]);
        }
      )
      .subscribe();

    reactionsChannel.current = supabase
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
          setReactions((prev) => [...prev, payload.new]);
          setTimeout(() => {
            setReactions((prev) => prev.filter((r) => r.id !== payload.new.id));
          }, 3000);
        }
      )
      .subscribe();

    const { data: parts } = await supabase
      .from("participants")
      .select("user_id")
      .eq("meeting_id", meetingId);
    setParticipants(parts.map((p) => p.user_id));

    participantsChannel.current = supabase
      .channel(`participants:${roomId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "participants" },
        async () => {
          const { data: up } = await supabase
            .from("participants")
            .select("user_id")
            .eq("meeting_id", meetingId);
          setParticipants(up.map((p) => p.user_id));
        }
      )
      .subscribe();
  }

  function addRemote(id, stream) {
    if (remoteVideosRef.current[id]) return;
    const container = document.createElement("div");
    const v = document.createElement("video");
    v.srcObject = stream;
    v.autoplay = v.playsInline = true;
    v.width = 160;
    container.append(v);
    remoteVideosRef.current[id] = container;
    document.getElementById("remote-videos")?.append(container);
  }

  const toggleMute = () => {
    const t = localStreamRef.current.getAudioTracks()[0];
    t.enabled = !t.enabled;
    setIsMuted(!t.enabled);
  };

  const toggleCam = async () => {
    if (cameraOn) {
      localStreamRef.current.getVideoTracks().forEach((t) => t.stop());
      localVideoRef.current.srcObject = null;
    } else {
      const s = await navigator.mediaDevices.getUserMedia({ video: true });
      localStreamRef.current.addTrack(s.getVideoTracks()[0]);
      localVideoRef.current.srcObject = localStreamRef.current;
    }
    setCameraOn(!cameraOn);
  };

  const shareScreen = async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const screenTrack = screenStream.getVideoTracks()[0];

      for (const connArray of Object.values(peerRef.current.connections)) {
        connArray.forEach((conn) => {
          const sender = conn.peerConnection
            .getSenders()
            .find((s) => s.track.kind === "video");
          sender?.replaceTrack(screenTrack);
        });
      }

      screenTrack.onended = () => {
        const camTrack = localStreamRef.current.getVideoTracks()[0];
        for (const connArray of Object.values(peerRef.current.connections)) {
          connArray.forEach((conn) => {
            const sender = conn.peerConnection
              .getSenders()
              .find((s) => s.track.kind === "video");
            sender?.replaceTrack(camTrack);
          });
        }
        localVideoRef.current.srcObject = localStreamRef.current;
      };
    } catch (e) {
      alert("Screen share failed.");
    }
  };

  const startRecording = () => {
    const mix = new MediaStream();
    localStreamRef.current.getTracks().forEach((t) => mix.addTrack(t));
    Object.values(remoteVideosRef.current).forEach((dom) => {
      dom
        .querySelector("video")
        ?.srcObject?.getTracks()
        .forEach((t) => mix.addTrack(t));
    });

    const recorder = RecordRTC(mix, { mimeType: "video/webm" });
    recorder.startRecording();
    recorderRef.current = recorder;
    setIsRecording(true);
  };

  const stopRecording = async () => {
    if (!recorderRef.current) return;

    await recorderRef.current.stopRecording(async () => {
      const blob = recorderRef.current.getBlob();
      const filename = `rec-${roomId}-${Date.now()}.webm`;

      const { data, error: upError } = await supabase.storage
        .from("recordings")
        .upload(filename, blob, { contentType: "video/webm" });
      if (upError) return alert("Upload failed.");

      await supabase.from("recordings").insert({
        room_id: roomId,
        uploaded_by: (await supabase.auth.getUser()).data.user.email,
        file_name: filename,
        file_url: `${process.env.REACT_APP_SUPABASE_URL}/storage/v1/object/public/${data.path}`,
      });

      alert("Recording saved!");
    });

    setIsRecording(false);
  };

  const leaveRoom = async () => {
    if (isRecording) await stopRecording();
    peerRef.current?.destroy();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    Object.values(remoteVideosRef.current).forEach((n) => n.remove());

    for (const ch of [
      signalsChannel,
      messagesChannel,
      reactionsChannel,
      participantsChannel,
      waitingChannel,
    ]) {
      await ch.current?.unsubscribe();
    }

    navigate("/");
  };

  const sendMessage = async () => {
    if (!chatInput.trim()) return;
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const newMsg = {
      room_id: roomId,
      sender: user.email,
      text: chatInput,
      created_at: new Date().toISOString(),
    };

    setMessages((prev) => [...prev, newMsg]); // Optimistic UI

    await supabase.from("messages").insert(newMsg);
    setChatInput("");
  };

  const sendReaction = async (emoji) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const newReaction = {
      room_id: roomId,
      user_id: user.id,
      emoji,
      created_at: new Date().toISOString(), // optional: just for local state
    };

    // Optimistic UI update
    setReactions((prev) => [...prev, newReaction]);
    setTimeout(() => {
      setReactions((prev) => prev.filter((r) => r !== newReaction));
    }, 3000);

    await supabase.from("reactions").insert(newReaction);
  };

  return (
    <div className="p-4">
      <h1>Room: {roomId}</h1>
      <p>Passcode: {passcodeRequired ? "Yes" : "No"}</p>
      <p>Host: {isHost ? "Yes" : "No"}</p>
      <p>Participants: {participants.length}</p>
      <div className="my-2">
  <label className="font-semibold">Share this meeting link:</label>
  <div className="flex items-center gap-2 mt-1">
    <input
      type="text"
      readOnly
      className="border p-2 rounded w-full"
      value={`https://zoomclone.vercel.app/room/${roomId}`}
      onClick={(e) => e.target.select()}
    />
    <button
      className="px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700"
      onClick={() => {
        navigator.clipboard.writeText(
          `https://zoomclone.vercel.app/room/${roomId}`
        );
        alert("Meeting link copied to clipboard!");
      }}
    >
      Copy
    </button>
  </div>
</div>


      {isHost && waitingList.length > 0 && (
        <div className="bg-yellow-100 p-2">
          <h3>Waiting Room</h3>
          {waitingList.map((w) => (
            <div key={w.user_id}>
              {w.email}{" "}
              <button onClick={() => approveUser(w.user_id)}>✔️</button>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4">
        <video
          ref={localVideoRef}
          muted
          autoPlay
          playsInline
          className="border"
        />
        <div id="remote-videos" className="flex flex-wrap" />
      </div>

      <div className="mt-4 space-x-2">
        <button onClick={toggleMute}>{isMuted ? "Unmute" : "Mute"}</button>
        <button onClick={toggleCam}>{cameraOn ? "Cam Off" : "Cam On"}</button>
        <button onClick={shareScreen}>Share Screen</button>
        {!isRecording ? (
          <button onClick={startRecording}>Start Rec</button>
        ) : (
          <button onClick={stopRecording}>Stop Rec</button>
        )}
        <button onClick={() => sendReaction("👋")}>👋</button>
        <button onClick={leaveRoom}>Leave</button>
      </div>

      <div className="mt-4">
        <div className="h-40 overflow-y-auto border p-2">
          {messages.map((m) => (
            <div key={m.id}>
              <strong>{m.sender}:</strong> {m.text}
            </div>
          ))}
        </div>
        <input
          className="border w-full p-2"
          placeholder="Message..."
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
        />
      </div>

      <div className="fixed bottom-24 left-4 flex space-x-2 z-50">
        {reactions.map((r, index) => (
          <span key={index} className="text-4xl animate-bounce">
            {r.emoji}
          </span>
        ))}
      </div>

      <div className="mt-2 flex gap-2">
        {["👍", "❤️", "😂", "🎉", "😮"].map((e) => (
          <button
            key={e}
            onClick={() => sendReaction(e)}
            className="text-2xl hover:scale-110 transition-transform"
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

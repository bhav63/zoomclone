// src/components/MeetingRoom.jsx

import React, {
  useEffect,
  useRef,
  useState,
  useCallback
} from "react";
import {
  useParams,
  useNavigate,
  useLocation
} from "react-router-dom";
import Peer from "peerjs";
import RecordRTC from "recordrtc";
import { supabase } from "../supabaseClient";

export default function MeetingRoom() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();

  const [user, setUser] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [waitingList, setWaitingList] = useState([]);
  const [participants, setParticipants] = useState([]);
  const [permitToJoin, setPermitToJoin] = useState(false);
  const [meetingDbId, setMeetingDbId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [reactions, setReactions] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [inputPasscode, setInputPasscode] = useState("");
  const [passcodeRequired, setPasscodeRequired] = useState(false);
  const [needPasscode, setNeedPasscode] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [isRecording, setIsRecording] = useState(false);

  const peerRef = useRef();
  const localStreamRef = useRef();
  const recorderRef = useRef();
  const localVideoRef = useRef();
  const remoteVideosRef = useRef({});
  const refreshInterval = useRef();

  const waitingChannel = useRef();
  const participantListener = useRef();
  const signalsChannel = useRef();
  const messagesChannel = useRef();
  const reactionsChannel = useRef();

  const BASE_URL = "https://zoomclone-v3.vercel.app";
  const shareLink = `${BASE_URL}/room/${roomId}${
    passcodeRequired ? `?passcode=${encodeURIComponent(inputPasscode)}` : ""
  }`;

  // STOP recording & save blob
  async function stopRecording() {
    if (!recorderRef.current) return;
    await recorderRef.current.stopRecording();
    const blob = recorderRef.current.getBlob();
    const filename = `rec-${roomId}-${Date.now()}.webm`;
    const { error, data } = await supabase.storage
      .from("recordings")
      .upload(filename, blob);
    if (error) {
      console.error("Upload error:", error);
      alert("Upload failed.");
      return;
    }
    const { data: ur } = await supabase.auth.getUser();
    await supabase.from("recordings").insert({
      room_id: roomId,
      uploaded_by: ur.user.email,
      file_name: filename,
      file_url: data.path
    });
    alert("✅ Recording saved!");
    setIsRecording(false);
  }

  // INIT & authorize/join logic
  const initRoom = useCallback(async () => {
    // 1. Check auth
    const { data: auth } = await supabase.auth.getUser();
    if (!auth?.user) return navigate("/login");
    setUser(auth.user);

    // 2. Fetch meeting row
    const { data: mt, error: mtErr } = await supabase
      .from("meetings")
      .select("*")
      .eq("room_id", roomId)
      .maybeSingle();
    if (mtErr || !mt) return navigate("/");

    setMeetingDbId(mt.id);
    setIsHost(auth.user.id === mt.creator_id);
    setPasscodeRequired(!!mt.passcode);

    // 3. Check passcode
    const providedPass =
      new URLSearchParams(search).get("passcode") || inputPasscode;
    if (mt.passcode && providedPass !== mt.passcode) {
      setNeedPasscode(true);
      return;
    }

    setNeedPasscode(false);

    // 4. Host: join + listen for waiting
    if (auth.user.id === mt.creator_id) {
      setPermitToJoin(true);
      await joinMeeting(mt.id, auth.user.id);
      setupWaitingListener(mt.id);

    } else {
      // Participant: check existing status
      const { data: existing } = await supabase
        .from("participants")
        .select("status")
        .eq("meeting_id", mt.id)
        .eq("user_id", auth.user.id)
        .maybeSingle();

      if (!existing) {
        // no record -> create a pending request
        await supabase
          .from("participants")
          .insert({
            meeting_id: mt.id,
            user_id: auth.user.id,
            status: "pending"
          });
        setupParticipantListener(mt.id, auth.user.id);
      } else if (existing.status === "pending") {
        setupParticipantListener(mt.id, auth.user.id);
      } else if (existing.status === "approved") {
        setPermitToJoin(true);
        await joinMeeting(mt.id, auth.user.id);
      } else {
        alert("⛔ Access denied.");
        navigate("/");
      }
    }
  }, [
    inputPasscode,
    navigate,
    roomId,
    search
  ]);

  // Apply passcode query param to state
  useEffect(() => {
    const pass = new URLSearchParams(search).get("passcode") || "";
    setInputPasscode(pass);
  }, [search]);

  // call init on passcode change
  useEffect(() => {
    if (!needPasscode) {
      initRoom();
    }
    return () => leaveRoom();
  }, [needPasscode]);

  // JOIN logic
  async function joinMeeting(meetingId, userId) {
    updateParticipants(meetingId);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
      localStreamRef.current = stream;
      localVideoRef.current.srcObject = stream;

      const peer = new Peer({ debug: 2 });
      peerRef.current = peer;

      peer.on("open", async (pid) => {
        await supabase
          .from("signals")
          .insert({ room_id: roomId, peer_id: pid });

        const { data: others } = await supabase
          .from("signals")
          .select("*")
          .eq("room_id", roomId)
          .neq("peer_id", pid);

        others.forEach((o) =>
          setupCall(peer.call(o.peer_id, stream), o.peer_id)
        );

        signalsChannel.current = supabase
          .channel(`signals:${roomId}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "signals",
              filter: `room_id=eq.${roomId}`
            },
            (pl) => {
              if (pl.new.peer_id !== pid) {
                setupCall(peer.call(pl.new.peer_id, stream), pl.new.peer_id);
              }
            }
          )
          .subscribe();
      });

      peer.on("call", (call) => {
        call.answer(stream);
        setupCall(call, call.peer);
      });

      refreshInterval.current = setInterval(() => {
        Object.values(peerRef.current.connections || {})
          .flat()
          .forEach((c) => c.peerConnection?.restartIce?.());
      }, 6000);

      loadMessagesAndReactions();
    } catch (err) {
      console.error("Join error", err);
      alert("🛑 Please allow camera & mic access.");
      navigate("/");
    }
  }

  function setupCall(call, peerId) {
    call.on("stream", (st) => addRemote(peerId, st));
    call.on("close", () => removeRemote(peerId));
    call.on("error", () => removeRemote(peerId));
  }

  function addRemote(id, st) {
    if (remoteVideosRef.current[id]) return;
    const div = document.createElement("div");
    const vid = document.createElement("video");
    vid.srcObject = st;
    vid.autoplay = true;
    vid.playsInline = true;
    div.appendChild(vid);
    remoteVideosRef.current[id] = div;
    document.getElementById("remote-videos")?.appendChild(div);
  }

  function removeRemote(id) {
    const el = remoteVideosRef.current[id];
    if (el) el.remove();
    delete remoteVideosRef.current[id];
  }

  // CLEANUP on leave/unmount
  async function leaveRoom() {
    try {
      if (isRecording) await stopRecording();
      peerRef.current?.destroy();
      localStreamRef.current?.getTracks()?.forEach((t) => t.stop());
      Object.values(remoteVideosRef.current).forEach((el) => el.remove());
      clearInterval(refreshInterval.current);

      if (meetingDbId && user?.id) {
        await supabase
          .from("participants")
          .delete()
          .eq("meeting_id", meetingDbId)
          .eq("user_id", user.id);
      }

      signalsChannel.current?.unsubscribe();
      waitingChannel.current?.unsubscribe();
      participantListener.current?.unsubscribe();
      messagesChannel.current?.unsubscribe();
      reactionsChannel.current?.unsubscribe();
    } catch (err) {
      console.warn(err);
    }
  }

  // WAITING LIST (host)
  function setupWaitingListener(mtId) {
    updateWaitingList(mtId);
    waitingChannel.current = supabase
      .channel(`waiting:${mtId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "participants",
          filter: `meeting_id=eq.${mtId},status=eq.pending`
        },
        () => updateWaitingList(mtId)
      )
      .subscribe();
  }

  async function updateWaitingList(mtId) {
    const { data } = await supabase
      .from("participants")
      .select("user_id, users!inner(email)")
      .eq("meeting_id", mtId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    setWaitingList(data || []);
  }

  async function approveUser(uid) {
    await supabase
      .from("participants")
      .update({ status: "approved" })
      .eq("meeting_id", meetingDbId)
      .eq("user_id", uid);
    updateWaitingList(meetingDbId);
  }

  async function denyUser(uid) {
    await supabase
      .from("participants")
      .update({ status: "denied" })
      .eq("meeting_id", meetingDbId)
      .eq("user_id", uid);
    updateWaitingList(meetingDbId);
  }

  // PARTICIPANT: listen for approval/denial
  function setupParticipantListener(mtId, uid) {
    participantListener.current = supabase
      .channel(`participants:${mtId}:${uid}`)
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "participants",
          filter: `meeting_id=eq.${mtId},user_id=eq.${uid}`
        },
        async (pl) => {
          if (pl.new.status === "approved") {
            alert("✅ Approved! Joining...");
            setPermitToJoin(true);
            await joinMeeting(mtId, uid);
          } else if (pl.new.status === "denied") {
            alert("⛔ Denied by host.");
            navigate("/");
          }
        }
      )
      .subscribe();
  }

  // UPDATE APPROVED LIST
  async function updateParticipants(mtId) {
    const { data } = await supabase
      .from("participants")
      .select("user_id")
      .eq("meeting_id", mtId)
      .eq("status", "approved");
    setParticipants(data.map((p) => p.user_id));
  }

  // CHAT + REACTIONS
  async function loadMessagesAndReactions() {
    const { data: oldMsgs } = await supabase
      .from("messages")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });
    setMessages(oldMsgs || []);

    messagesChannel.current = supabase
      .channel(`messages:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `room_id=eq.${roomId}`
        },
        (pl) => setMessages((m) => [...m, pl.new])
      )
      .subscribe();

    const { data: oldReacts } = await supabase
      .from("reactions")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });
    setReactions(oldReacts || []);

    reactionsChannel.current = supabase
      .channel(`reactions:${roomId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "reactions",
          filter: `room_id=eq.${roomId}`
        },
        (pl) => setReactions((r) => [...r, pl.new])
      )
      .subscribe();
  }

  async function sendMessage() {
    if (!chatInput.trim()) return;
    await supabase.from("messages").insert({
      room_id: roomId,
      sender: user.email,
      text: chatInput,
      created_at: new Date().toISOString()
    });
    setChatInput("");
  }

  async function sendReaction(emoji) {
    await supabase.from("reactions").insert({
      room_id: roomId,
      user_id: user.id,
      emoji,
      created_at: new Date().toISOString()
    });
  }

  // UI render
  if (needPasscode) {
    return (
      <div className="p-4">
        <h2>🔐 Enter Passcode</h2>
        <input
          type="password"
          className="border p-2"
          value={inputPasscode}
          onChange={(e) => setInputPasscode(e.target.value)}
        />
        <button
          onClick={() => {
            setNeedPasscode(false);
          }}
          className="p-2 bg-blue-500 text-white mt-2"
        >
          Join
        </button>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <h1>📹 Room: {roomId}</h1>
      <div>
        <input
          value={shareLink}
          readOnly
          onClick={(e) => e.target.select()}
          className="border p-1 w-3/4"
        />
        <button
          onClick={() => {
            navigator.clipboard.writeText(shareLink);
            alert("Copied!");
          }}
          className="ml-2 p-2 bg-gray-200"
        >
          Copy
        </button>
      </div>

      {isHost && waitingList.length > 0 && (
        <div>
          <h2>Waiting Participants ({waitingList.length})</h2>
          {waitingList.map((w) => (
            <div
              key={w.user_id}
              className="flex items-center gap-2 my-1"
            >
              <span>{w.users.email}</span>
              <button
                onClick={() => approveUser(w.user_id)}
              >
                ✅
              </button>
              <button onClick={() => denyUser(w.user_id)}>
                ❌
              </button>
            </div>
          ))}
        </div>
      )}

      <p>
        {isHost
          ? "You are Host"
          : permitToJoin
          ? "🎉 Approved Participant"
          : "Guest — waiting for approval"}
      </p>

      {!localStreamRef.current && !isHost && !permitToJoin && (
        <button
          onClick={initRoom}
          className="bg-green-600 text-white p-2"
        >
          Request to Join
        </button>
      )}

      <div className="grid grid-cols-2 gap-4">
        <video
          ref={localVideoRef}
          muted
          autoPlay
          playsInline
          className="border bg-black"
        />
        <div
          id="remote-videos"
          className="flex flex-wrap gap-2"
        />
      </div>

      {/* Controls */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => {
            const t =
              localStreamRef.current?.getAudioTracks()[0];
            if (t) {
              t.enabled = !t.enabled;
              setIsMuted(!t.enabled);
            }
          }}
          className="px-3 py-1 bg-gray-200 rounded"
        >
          {isMuted ? "Unmute" : "Mute"}
        </button>
        <button
          onClick={() => {
            const t =
              localStreamRef.current?.getVideoTracks()[0];
            if (t) {
              t.enabled = !t.enabled;
              setCameraOn(t.enabled);
            }
          }}
          className="px-3 py-1 bg-gray-200 rounded"
        >
          {cameraOn ? "Cam Off" : "Cam On"}
        </button>
        <button
          onClick={async () => {
            try {
              const d =
                await navigator.mediaDevices.getDisplayMedia({
                  video: true
                });
              const tr = d.getVideoTracks()[0];
              Object.values(peerRef.current.connections || {})
                .flat()
                .forEach((c) => {
                  const s =
                    c.peerConnection
                      .getSenders()
                      .find(
                        (s) =>
                          s.track.kind === "video"
                      );
                  if (s && tr) {
                    s.replaceTrack(tr);
                  }
                });
              tr.onended = () => {
                const orig =
                  localStreamRef.current?.getVideoTracks()[0];
                Object.values(peerRef.current.connections || {})
                  .flat()
                  .forEach((c) => {
                    const s =
                      c.peerConnection
                        .getSenders()
                        .find(
                          (s) =>
                            s.track.kind === "video"
                        );
                    s?.replaceTrack(orig);
                  });
              };
            } catch {
              alert("Sharing failed");
            }
          }}
          className="px-3 py-1 bg-gray-200 rounded"
        >
          Share
        </button>
        {!isRecording ? (
          <button
            onClick={() => {
              const mix = new MediaStream();
              localStreamRef.current
                .getTracks()
                .forEach((t) => mix.addTrack(t));
              Object.values(
                remoteVideosRef.current
              )
                .map((div) =>
                  div.querySelector("video")
                )
                .forEach((v) =>
                  v?.srcObject
                    .getTracks()
                    .forEach((t) => mix.addTrack(t))
                );
              const r = RecordRTC(mix, {
                mimeType: "video/webm"
              });
              r.startRecording();
              recorderRef.current = r;
              setIsRecording(true);
            }}
            className="px-3 py-1 bg-blue-500 text-white rounded"
          >
            Start Rec
          </button>
        ) : (
          <button
            onClick={stopRecording}
            className="px-3 py-1 bg-red-500 text-white rounded"
          >
            Stop Rec
          </button>
        )}
        <button
          onClick={leaveRoom}
          className="px-3 py-1 bg-red-600 text-white rounded"
        >
          Leave
        </button>
      </div>

      {/* Chat */}
      <div className="space-y-2">
        <div className="border p-2 h-40 overflow-y-auto bg-gray-100">
          {messages.map((m, i) => (
            <div key={i}>
              <strong>{m.sender}:</strong> {m.text}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className="border p-2 flex-1"
            placeholder="Type..."
            value={chatInput}
            onChange={(e) =>
              setChatInput(e.target.value)
            }
            onKeyDown={(e) =>
              e.key === "Enter" && sendMessage()
            }
          />
          <button
            onClick={sendMessage}
            className="px-4 py-2 bg-blue-500 text-white rounded"
          >
            Send
          </button>
        </div>
      </div>

      {/* Reactions */}
      <div>
        <strong>Reactions:</strong>
        <div className="flex gap-2 text-2xl">
          {["👍", "❤️", "😂", "🎉", "😮"].map((e) => (
            <button
              key={e}
              onClick={() => sendReaction(e)}
            >
              {e}
            </button>
          ))}
        </div>
        <div className="flex gap-2 text-3xl mt-2">
          {reactions.map((r, i) => (
            <span key={i}>{r.emoji}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

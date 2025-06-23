// src/pages/MeetingRoom.jsx

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
  const [isInitialized, setIsInitialized] = useState(false);

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
    try {
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
    } catch (err) {
      console.error("Recording stop error:", err);
      setIsRecording(false);
    }
  }

  // INIT & authorize/join logic
  const initRoom = useCallback(async () => {
    if (isInitialized) return;
    
    try {
      // Clean up any existing subscriptions first
      await cleanupSubscriptions();
      
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
      if (mtErr || !mt) {
        console.error("Meeting fetch error:", mtErr);
        return navigate("/");
      }

      setMeetingDbId(mt.id);
      const hostStatus = auth.user.id === mt.creator_id;
      setIsHost(hostStatus);
      setPasscodeRequired(!!mt.passcode);

      // 3. Check passcode
      const providedPass =
        new URLSearchParams(search).get("passcode") || inputPasscode;
      if (mt.passcode && providedPass !== mt.passcode) {
        setNeedPasscode(true);
        return;
      }

      setNeedPasscode(false);
      setIsInitialized(true);

      // 4. Host: join + listen for waiting
      if (hostStatus) {
        console.log("Setting up host...");
        setPermitToJoin(true);
        await joinMeeting(mt.id, auth.user.id);
        setupWaitingListener(mt.id);
      } else {
        // Participant: check existing status
        console.log("Checking participant status...");
        const { data: existing } = await supabase
          .from("participants")
          .select("status")
          .eq("meeting_id", mt.id)
          .eq("user_id", auth.user.id)
          .maybeSingle();

        console.log("Existing participant record:", existing);

        if (!existing) {
          // no record -> create a pending request
          console.log("Creating pending request...");
          const { error: insertError } = await supabase
            .from("participants")
            .insert({
              meeting_id: mt.id,
              user_id: auth.user.id,
              status: "pending"
            });
          
          if (insertError) {
            console.error("Error creating pending request:", insertError);
          } else {
            console.log("Pending request created successfully");
          }
          
          setupParticipantListener(mt.id, auth.user.id);
        } else if (existing.status === "pending") {
          console.log("Already pending, setting up listener...");
          setupParticipantListener(mt.id, auth.user.id);
        } else if (existing.status === "approved") {
          console.log("Already approved, joining meeting...");
          setPermitToJoin(true);
          await joinMeeting(mt.id, auth.user.id);
        } else {
          alert("⛔ Access denied.");
          navigate("/");
        }
      }
    } catch (error) {
      console.error("Init room error:", error);
      alert("Failed to initialize room. Please try again.");
    }
  }, [
    inputPasscode,
    navigate,
    roomId,
    search,
    isInitialized
  ]);

  // Apply passcode query param to state
  useEffect(() => {
    const pass = new URLSearchParams(search).get("passcode") || "";
    setInputPasscode(pass);
  }, [search]);

  // call init on mount and passcode change
  useEffect(() => {
    if (!needPasscode && !isInitialized) {
      initRoom();
    }
    
    return () => {
      leaveRoom();
    };
  }, [needPasscode, initRoom]);

  // JOIN logic
  async function joinMeeting(meetingId, userId) {
    console.log("Joining meeting...", meetingId, userId);
    updateParticipants(meetingId);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      const peer = new Peer({ debug: 2 });
      peerRef.current = peer;

      peer.on("open", async (pid) => {
        console.log("Peer opened with ID:", pid);
        await supabase
          .from("signals")
          .insert({ room_id: roomId, peer_id: pid });

        const { data: others } = await supabase
          .from("signals")
          .select("*")
          .eq("room_id", roomId)
          .neq("peer_id", pid);

        others?.forEach((o) =>
          setupCall(peer.call(o.peer_id, stream), o.peer_id)
        );

        // Only create signals channel if it doesn't exist
        if (!signalsChannel.current) {
          signalsChannel.current = supabase
            .channel(`signals:${roomId}:${Date.now()}`) // Add timestamp to make unique
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
        }
      });

      peer.on("call", (call) => {
        call.answer(stream);
        setupCall(call, call.peer);
      });

      refreshInterval.current = setInterval(() => {
        Object.values(peerRef.current?.connections || {})
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
    div.className = "relative";
    const vid = document.createElement("video");
    vid.srcObject = st;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.className = "border bg-black w-full h-32";
    div.appendChild(vid);
    remoteVideosRef.current[id] = div;
    document.getElementById("remote-videos")?.appendChild(div);
  }

  function removeRemote(id) {
    const el = remoteVideosRef.current[id];
    if (el) el.remove();
    delete remoteVideosRef.current[id];
  }

  // Clean up all subscriptions
  async function cleanupSubscriptions() {
    try {
      if (signalsChannel.current) {
        await signalsChannel.current.unsubscribe();
        signalsChannel.current = null;
      }
      if (waitingChannel.current) {
        await waitingChannel.current.unsubscribe();
        waitingChannel.current = null;
      }
      if (participantListener.current) {
        await participantListener.current.unsubscribe();
        participantListener.current = null;
      }
      if (messagesChannel.current) {
        await messagesChannel.current.unsubscribe();
        messagesChannel.current = null;
      }
      if (reactionsChannel.current) {
        await reactionsChannel.current.unsubscribe();
        reactionsChannel.current = null;
      }
    } catch (error) {
      console.warn("Error cleaning up subscriptions:", error);
    }
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

      // Clean up all subscriptions
      await cleanupSubscriptions();
      
      // Reset state
      setIsInitialized(false);
    } catch (err) {
      console.warn("Leave room error:", err);
    }
  }

  // WAITING LIST (host)
  function setupWaitingListener(mtId) {
    console.log("Setting up waiting listener for meeting:", mtId);
    updateWaitingList(mtId);
    
    // Only create channel if it doesn't exist
    if (!waitingChannel.current) {
      waitingChannel.current = supabase
        .channel(`waiting:${mtId}:${Date.now()}`) // Add timestamp to make unique
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "participants",
            filter: `meeting_id=eq.${mtId}`
          },
          (payload) => {
            console.log("New participant request:", payload.new);
            if (payload.new.status === "pending") {
              updateWaitingList(mtId);
            }
          }
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "participants",
            filter: `meeting_id=eq.${mtId}`
          },
          (payload) => {
            console.log("Participant status updated:", payload.new);
            updateWaitingList(mtId);
          }
        )
        .subscribe((status) => {
          console.log("Waiting channel subscription status:", status);
        });
    }
  }

  async function updateWaitingList(mtId) {
    try {
      const { data, error } = await supabase
        .from("participants")
        .select("user_id, users!inner(email)")
        .eq("meeting_id", mtId)
        .eq("status", "pending")
        .order("created_at", { ascending: true });
      
      if (error) {
        console.error("Error fetching waiting list:", error);
        return;
      }
      
      console.log("Updated waiting list:", data);
      setWaitingList(data || []);
    } catch (error) {
      console.error("Error in updateWaitingList:", error);
    }
  }

  async function approveUser(uid) {
    try {
      console.log("Approving user:", uid);
      const { error } = await supabase
        .from("participants")
        .update({ status: "approved" })
        .eq("meeting_id", meetingDbId)
        .eq("user_id", uid);
      
      if (error) {
        console.error("Error approving user:", error);
      } else {
        console.log("User approved successfully");
        updateWaitingList(meetingDbId);
      }
    } catch (error) {
      console.error("Error in approveUser:", error);
    }
  }

  async function denyUser(uid) {
    try {
      console.log("Denying user:", uid);
      const { error } = await supabase
        .from("participants")
        .update({ status: "denied" })
        .eq("meeting_id", meetingDbId)
        .eq("user_id", uid);
      
      if (error) {
        console.error("Error denying user:", error);
      } else {
        console.log("User denied successfully");
        updateWaitingList(meetingDbId);
      }
    } catch (error) {
      console.error("Error in denyUser:", error);
    }
  }

  // PARTICIPANT: listen for approval/denial
  function setupParticipantListener(mtId, uid) {
    console.log("Setting up participant listener for:", mtId, uid);
    
    // Only create channel if it doesn't exist
    if (!participantListener.current) {
      participantListener.current = supabase
        .channel(`participants:${mtId}:${uid}:${Date.now()}`) // Add timestamp to make unique
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "participants",
            filter: `meeting_id=eq.${mtId},user_id=eq.${uid}`
          },
          async (payload) => {
            console.log("Participant status change received:", payload.new);
            if (payload.new.status === "approved") {
              alert("✅ Approved! Joining...");
              setPermitToJoin(true);
              await joinMeeting(mtId, uid);
            } else if (payload.new.status === "denied") {
              alert("⛔ Denied by host.");
              navigate("/");
            }
          }
        )
        .subscribe((status) => {
          console.log("Participant listener subscription status:", status);
        });
    }
  }

  // UPDATE APPROVED LIST
  async function updateParticipants(mtId) {
    try {
      const { data } = await supabase
        .from("participants")
        .select("user_id")
        .eq("meeting_id", mtId)
        .eq("status", "approved");
      setParticipants(data?.map((p) => p.user_id) || []);
    } catch (error) {
      console.error("Error updating participants:", error);
    }
  }

  // CHAT + REACTIONS
  async function loadMessagesAndReactions() {
    try {
      const { data: oldMsgs } = await supabase
        .from("messages")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });
      setMessages(oldMsgs || []);

      // Only create messages channel if it doesn't exist
      if (!messagesChannel.current) {
        messagesChannel.current = supabase
          .channel(`messages:${roomId}:${Date.now()}`) // Add timestamp to make unique
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
      }

      const { data: oldReacts } = await supabase
        .from("reactions")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });
      setReactions(oldReacts || []);

      // Only create reactions channel if it doesn't exist
      if (!reactionsChannel.current) {
        reactionsChannel.current = supabase
          .channel(`reactions:${roomId}:${Date.now()}`) // Add timestamp to make unique
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
    } catch (error) {
      console.error("Error loading messages and reactions:", error);
    }
  }

  async function sendMessage() {
    if (!chatInput.trim()) return;
    try {
      await supabase.from("messages").insert({
        room_id: roomId,
        sender: user.email,
        text: chatInput,
        created_at: new Date().toISOString()
      });
      setChatInput("");
    } catch (error) {
      console.error("Error sending message:", error);
    }
  }

  async function sendReaction(emoji) {
    try {
      await supabase.from("reactions").insert({
        room_id: roomId,
        user_id: user.id,
        emoji,
        created_at: new Date().toISOString()
      });
    } catch (error) {
      console.error("Error sending reaction:", error);
    }
  }

  // Manual request to join (for non-host users)
  async function requestToJoin() {
    if (!meetingDbId || !user?.id) return;
    
    try {
      console.log("Requesting to join...");
      const { error } = await supabase
        .from("participants")
        .upsert({
          meeting_id: meetingDbId,
          user_id: user.id,
          status: "pending"
        }, {
          onConflict: "meeting_id,user_id"
        });
      
      if (error) {
        console.error("Error requesting to join:", error);
        alert("Failed to send request. Please try again.");
      } else {
        console.log("Join request sent successfully");
        setupParticipantListener(meetingDbId, user.id);
        alert("Request sent! Waiting for host approval...");
      }
    } catch (error) {
      console.error("Error in requestToJoin:", error);
      alert("Failed to send request. Please try again.");
    }
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
          onKeyDown={(e) => e.key === "Enter" && setNeedPasscode(false)}
        />
        <button
          onClick={() => {
            setNeedPasscode(false);
          }}
          className="p-2 bg-blue-500 text-white mt-2 ml-2 rounded"
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
          className="ml-2 p-2 bg-gray-200 rounded"
        >
          Copy
        </button>
      </div>

      {isHost && waitingList.length > 0 && (
        <div className="border p-4 rounded bg-yellow-50">
          <h2 className="font-bold">Waiting Participants ({waitingList.length})</h2>
          {waitingList.map((w) => (
            <div
              key={w.user_id}
              className="flex items-center gap-2 my-2 p-2 bg-white rounded border"
            >
              <span className="flex-1">{w.users.email}</span>
              <button
                onClick={() => approveUser(w.user_id)}
                className="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600"
              >
                ✅ Approve
              </button>
              <button 
                onClick={() => denyUser(w.user_id)}
                className="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600"
              >
                ❌ Deny
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="p-2 bg-gray-100 rounded">
        <p className="font-medium">
          Status: {isHost
            ? "🎯 You are the Host"
            : permitToJoin
            ? "🎉 Approved Participant"
            : "👋 Guest — waiting for approval"}
        </p>
      </div>

      {!permitToJoin && !isHost && (
        <button
          onClick={requestToJoin}
          className="bg-green-600 text-white p-3 rounded font-medium hover:bg-green-700"
        >
          Request to Join Meeting
        </button>
      )}

      {(permitToJoin || isHost) && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h3 className="font-medium mb-2">Your Video</h3>
              <video
                ref={localVideoRef}
                muted
                autoPlay
                playsInline
                className="border bg-black w-full h-48 rounded"
              />
            </div>
            <div>
              <h3 className="font-medium mb-2">Other Participants</h3>
              <div
                id="remote-videos"
                className="flex flex-wrap gap-2 min-h-48 border rounded p-2 bg-gray-50"
              />
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => {
                const t = localStreamRef.current?.getAudioTracks()[0];
                if (t) {
                  t.enabled = !t.enabled;
                  setIsMuted(!t.enabled);
                }
              }}
              className={`px-3 py-2 rounded font-medium ${
                isMuted ? "bg-red-500 text-white" : "bg-gray-200"
              }`}
            >
              {isMuted ? "🔇 Unmute" : "🔊 Mute"}
            </button>
            <button
              onClick={() => {
                const t = localStreamRef.current?.getVideoTracks()[0];
                if (t) {
                  t.enabled = !t.enabled;
                  setCameraOn(t.enabled);
                }
              }}
              className={`px-3 py-2 rounded font-medium ${
                !cameraOn ? "bg-red-500 text-white" : "bg-gray-200"
              }`}
            >
              {cameraOn ? "📹 Cam Off" : "📷 Cam On"}
            </button>
            <button
              onClick={async () => {
                try {
                  const d = await navigator.mediaDevices.getDisplayMedia({
                    video: true
                  });
                  const tr = d.getVideoTracks()[0];
                  Object.values(peerRef.current?.connections || {})
                    .flat()
                    .forEach((c) => {
                      const s = c.peerConnection
                        ?.getSenders()
                        ?.find((s) => s.track?.kind === "video");
                      if (s && tr) {
                        s.replaceTrack(tr);
                      }
                    });
                  tr.onended = () => {
                    const orig = localStreamRef.current?.getVideoTracks()[0];
                    Object.values(peerRef.current?.connections || {})
                      .flat()
                      .forEach((c) => {
                        const s = c.peerConnection
                          ?.getSenders()
                          ?.find((s) => s.track?.kind === "video");
                        if (s && orig) {
                          s.replaceTrack(orig);
                        }
                      });
                  };
                } catch {
                  alert("Screen sharing failed");
                }
              }}
              className="px-3 py-2 bg-blue-500 text-white rounded font-medium hover:bg-blue-600"
            >
              🖥️ Share Screen
            </button>
            {!isRecording ? (
              <button
                onClick={() => {
                  try {
                    const mix = new MediaStream();
                    localStreamRef.current
                      ?.getTracks()
                      ?.forEach((t) => mix.addTrack(t));
                    Object.values(remoteVideosRef.current)
                      .map((div) => div.querySelector("video"))
                      .forEach((v) =>
                        v?.srcObject
                          ?.getTracks()
                          ?.forEach((t) => mix.addTrack(t))
                      );
                    const r = RecordRTC(mix, {
                      mimeType: "video/webm"
                    });
                    r.startRecording();
                    recorderRef.current = r;
                    setIsRecording(true);
                  } catch (error) {
                    console.error("Recording start error:", error);
                    alert("Failed to start recording");
                  }
                }}
                className="px-3 py-2 bg-purple-500 text-white rounded font-medium hover:bg-purple-600"
              >
                🔴 Start Recording
              </button>
            ) : (
              <button
                onClick={stopRecording}
                className="px-3 py-2 bg-red-500 text-white rounded font-medium hover:bg-red-600 animate-pulse"
              >
                ⏹️ Stop Recording
              </button>
            )}
            <button
              onClick={() => {
                if (window.confirm("Are you sure you want to leave the meeting?")) {
                  leaveRoom();
                  navigate("/");
                }
              }}
              className="px-3 py-2 bg-red-600 text-white rounded font-medium hover:bg-red-700"
            >
              🚪 Leave
            </button>
          </div>

          {/* Chat */}
          <div className="space-y-2">
            <h3 className="font-medium">💬 Chat</h3>
            <div className="border p-2 h-40 overflow-y-auto bg-gray-100 rounded">
              {messages.length === 0 ? (
                <p className="text-gray-500">No messages yet...</p>
              ) : (
                messages.map((m, i) => (
                  <div key={i} className="mb-1">
                    <strong className="text-blue-600">{m.sender}:</strong> {m.text}
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2">
              <input
                className="border p-2 flex-1 rounded"
                placeholder="Type your message..."
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
              />
              <button
                onClick={sendMessage}
                className="px-4 py-2 bg-blue-500 text-white rounded font-medium hover:bg-blue-600"
              >
                Send
              </button>
            </div>
          </div>

          {/* Reactions */}
          <div>
            <h3 className="font-medium mb-2">😊 Quick Reactions</h3>
            <div className="flex gap-2 text-2xl mb-2">
              {["👍", "❤️", "😂", "🎉", "😮"].map((e) => (
                <button
                  key={e}
                  onClick={() => sendReaction(e)}
                  className="hover:scale-125 transition-transform"
                  title={`Send ${e} reaction`}
                >
                  {e}
                </button>
              ))}
            </div>
            {reactions.length > 0 && (
              <div className="flex gap-1 text-2xl bg-gray-100 p-2 rounded">
                {reactions.slice(-10).map((r, i) => (
                  <span key={i} className="animate-bounce">
                    {r.emoji}
                  </span>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
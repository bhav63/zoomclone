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
  const [mediaPermissionGranted, setMediaPermissionGranted] = useState(false);
  const [isJoining, setIsJoining] = useState(false);
  const [waitingForApproval, setWaitingForApproval] = useState(false);
  const [showChat, setShowChat] = useState(false);

  const peerRef = useRef();
  const localStreamRef = useRef();
  const recorderRef = useRef();
  const localVideoRef = useRef();
  const remoteVideosRef = useRef({});
  const refreshInterval = useRef();
  const isMountedRef = useRef(true);

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

  // START recording
  async function startRecording() {
    if (!localStreamRef.current) {
      alert("Please join the meeting first to start recording.");
      return;
    }
    try {
      const recorder = new RecordRTC(localStreamRef.current, {
        type: 'video',
        mimeType: 'video/webm',
        bitsPerSecond: 128000
      });
      recorder.startRecording();
      recorderRef.current = recorder;
      setIsRecording(true);
      alert("🔴 Recording started!");
    } catch (err) {
      console.error("Recording start error:", err);
      alert("Failed to start recording.");
    }
  }

  // Toggle mute
  function toggleMute() {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach(track => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  }

  // Toggle camera
  function toggleCamera() {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      videoTracks.forEach(track => {
        track.enabled = !track.enabled;
      });
      setCameraOn(!cameraOn);
    }
  }

  // Request media permissions
  async function requestMediaPermissions() {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    try {
      console.log("Requesting media permissions...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true
      });
      
      localStreamRef.current = stream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
      
      setMediaPermissionGranted(true);
      console.log("Media permissions granted");
      return stream;
    } catch (err) {
      console.error("Media permission error:", err);
      alert("🛑 Please allow camera & mic access to join the meeting.");
      throw err;
    }
  }

  // INIT & authorize/join logic
  const initRoom = useCallback(async () => {
    if (isInitialized || !isMountedRef.current) return;
    
    try {
      console.log("Initializing room...");
      setIsInitialized(true);
      
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
        alert("Meeting not found.");
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

      // 4. Host: automatically join + listen for waiting
      if (hostStatus) {
        console.log("Setting up host...");
        setPermitToJoin(true);
        
        try {
          await requestMediaPermissions();
          await joinMeeting(mt.id, auth.user.id);
          setupWaitingListener(mt.id);
        } catch (err) {
          console.error("Host setup error:", err);
          navigate("/");
        }
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

        if (!existing || existing.status === "pending") {
          console.log("Participant needs to request access");
          setupParticipantListener(mt.id, auth.user.id);
          
          if (!existing) {
            await createPendingRequest(mt.id, auth.user.id);
          } else {
            setWaitingForApproval(true);
          }
        } else if (existing.status === "approved") {
          console.log("Already approved, requesting permissions and joining...");
          setPermitToJoin(true);
          try {
            await requestMediaPermissions();
            await joinMeeting(mt.id, auth.user.id);
          } catch (err) {
            console.error("Approved participant setup error:", err);
            navigate("/");
          }
        } else if (existing.status === "denied") {
          alert("⛔ Access denied by host.");
          navigate("/");
        }
      }
    } catch (error) {
      console.error("Init room error:", error);
      if (isMountedRef.current) {
        setIsInitialized(false);
        alert("Failed to initialize room. Please try again.");
      }
      navigate("/");
    }
  }, [inputPasscode, navigate, roomId, search]);

  // Create pending request
  async function createPendingRequest(meetingId, userId) {
    try {
      console.log("Creating pending request...");
      const { error } = await supabase
        .from("participants")
        .insert({
          meeting_id: meetingId,
          user_id: userId,
          status: "pending"
        });
      
      if (error) {
        console.error("Error creating pending request:", error);
      } else {
        console.log("Pending request created successfully");
        setWaitingForApproval(true);
      }
    } catch (error) {
      console.error("Error in createPendingRequest:", error);
    }
  }

  // Apply passcode query param to state
  useEffect(() => {
    const pass = new URLSearchParams(search).get("passcode") || "";
    setInputPasscode(pass);
  }, [search]);

  // call init on mount and passcode change
  useEffect(() => {
    isMountedRef.current = true;
    
    if (!needPasscode && !isInitialized) {
      initRoom();
    }
    
    return () => {
      isMountedRef.current = false;
      leaveRoom();
    };
  }, [needPasscode]); // Removed isInitialized from dependencies

  // JOIN logic
  async function joinMeeting(meetingId, userId) {
    if (isJoining) return;
    setIsJoining(true);
    
    console.log("Joining meeting...", meetingId, userId);
    
    try {
      const stream = await requestMediaPermissions();
      updateParticipants(meetingId);

      const peer = new Peer({ 
        debug: 2,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        },
        reconnectTimer: 5000
      });
      peerRef.current = peer;

      peer.on("open", async (pid) => {
        console.log("Peer opened with ID:", pid);
        
        try {
          await supabase
            .from("signals")
            .insert({ room_id: roomId, peer_id: pid });

          const { data: others } = await supabase
            .from("signals")
            .select("*")
            .eq("room_id", roomId)
            .neq("peer_id", pid);

          others?.forEach((o) => {
            console.log("Calling peer:", o.peer_id);
            setupCall(peer.call(o.peer_id, stream), o.peer_id);
          });

          if (!signalsChannel.current) {
            signalsChannel.current = supabase
              .channel(`signals:${roomId}:${Date.now()}`)
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
                    console.log("New peer joined, calling:", pl.new.peer_id);
                    setupCall(peer.call(pl.new.peer_id, stream), pl.new.peer_id);
                  }
                }
              )
              .subscribe();
          }
        } catch (err) {
          console.error("Error in peer open handler:", err);
        }
      });

      peer.on("call", (call) => {
        console.log("Receiving call from:", call.peer);
        call.answer(stream);
        setupCall(call, call.peer);
      });

      peer.on("error", (err) => {
        console.error("Peer error:", err);
      });

      refreshInterval.current = setInterval(() => {
        try {
          Object.values(peerRef.current?.connections || {})
            .flat()
            .forEach((c) => {
              if (c.peerConnection && c.peerConnection.restartIce) {
                c.peerConnection.restartIce();
              }
            });
        } catch (err) {
          console.warn("ICE restart error:", err);
        }
      }, 10000);

      loadMessagesAndReactions();
      setIsJoining(false);
      
    } catch (err) {
      console.error("Join meeting error:", err);
      setIsJoining(false);
      alert("🛑 Failed to join meeting. Please check your camera and microphone permissions.");
    }
  }

  function setupCall(call, peerId) {
    console.log("Setting up call with:", peerId);
    
    call.on("stream", (st) => {
      console.log("Received stream from:", peerId);
      addRemote(peerId, st);
    });
    
    call.on("close", () => {
      console.log("Call closed with:", peerId);
      removeRemote(peerId);
    });
    
    call.on("error", (err) => {
      console.error("Call error with", peerId, ":", err);
      removeRemote(peerId);
    });
  }

  function addRemote(id, st) {
    if (remoteVideosRef.current[id]) {
      console.log("Remote video already exists for:", id);
      return;
    }
    
    console.log("Adding remote video for:", id);
    const div = document.createElement("div");
    div.className = "relative bg-black rounded";
    const vid = document.createElement("video");
    vid.srcObject = st;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.className = "border bg-black w-full h-32 rounded";
    
    const label = document.createElement("div");
    label.className = "absolute top-1 left-1 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded";
    label.textContent = id.substring(0, 8);
    
    div.appendChild(vid);
    div.appendChild(label);
    remoteVideosRef.current[id] = div;
    
    const container = document.getElementById("remote-videos");
    if (container) {
      container.appendChild(div);
    }
  }

  function removeRemote(id) {
    console.log("Removing remote video for:", id);
    const el = remoteVideosRef.current[id];
    if (el) {
      el.remove();
      delete remoteVideosRef.current[id];
    }
  }

  // Clean up all subscriptions
  async function cleanupSubscriptions() {
    try {
      const channels = [
        signalsChannel,
        waitingChannel,
        participantListener,
        messagesChannel,
        reactionsChannel
      ];

      for (const channelRef of channels) {
        if (channelRef.current) {
          await channelRef.current.unsubscribe();
          channelRef.current = null;
        }
      }
    } catch (error) {
      console.warn("Error cleaning up subscriptions:", error);
    }
  }

  // CLEANUP on leave/unmount
  async function leaveRoom() {
    if (!isMountedRef.current) return;
    
    try {
      console.log("Leaving room...");
      
      if (isRecording) await stopRecording();
      
      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }
      
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          track.stop();
        });
        localStreamRef.current = null;
      }
      
      Object.values(remoteVideosRef.current).forEach((el) => el.remove());
      remoteVideosRef.current = {};
      
      if (refreshInterval.current) {
        clearInterval(refreshInterval.current);
        refreshInterval.current = null;
      }

      if (meetingDbId && user?.id) {
        await supabase
          .from("participants")
          .delete()
          .eq("meeting_id", meetingDbId)
          .eq("user_id", user.id);
      }

      await cleanupSubscriptions();
      
      setIsInitialized(false);
      setMediaPermissionGranted(false);
      setPermitToJoin(false);
      setWaitingForApproval(false);
      
    } catch (err) {
      console.warn("Leave room error:", err);
    }
  }

  // WAITING LIST (host)
  function setupWaitingListener(mtId) {
    console.log("Setting up waiting listener for meeting:", mtId);
    updateWaitingList(mtId);
    
    if (!waitingChannel.current) {
      waitingChannel.current = supabase
        .channel(`waiting:${mtId}:${Date.now()}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "participants",
            filter: `meeting_id=eq.${mtId}`
          },
          () => updateWaitingList(mtId)
        )
        .subscribe();
    }
  }

  async function updateWaitingList(mtId) {
    try {
      const { data, error } = await supabase
        .from("participants")
        .select(`
          user_id,
          created_at,
          users!inner(email, id)
        `)
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
      
      if (error) throw error;
      console.log("User approved successfully");
    } catch (error) {
      console.error("Error approving user:", error);
      alert("Failed to approve user. Please try again.");
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
      
      if (error) throw error;
      console.log("User denied successfully");
    } catch (error) {
      console.error("Error denying user:", error);
      alert("Failed to deny user. Please try again.");
    }
  }

  // PARTICIPANT: listen for approval/denial
  function setupParticipantListener(mtId, uid) {
    console.log("Setting up participant listener for:", mtId, uid);
    
    if (!participantListener.current) {
      participantListener.current = supabase
        .channel(`participants:${mtId}:${uid}:${Date.now()}`)
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
              setWaitingForApproval(false);
              setPermitToJoin(true);
              alert("✅ Approved! Joining meeting...");
              try {
                await requestMediaPermissions();
                await joinMeeting(mtId, uid);
              } catch (err) {
                console.error("Error joining after approval:", err);
                alert("Failed to join meeting. Please refresh and try again.");
              }
            } else if (payload.new.status === "denied") {
              setWaitingForApproval(false);
              alert("⛔ Access denied by host.");
              navigate("/");
            }
          }
        )
        .subscribe();
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

      if (!messagesChannel.current) {
        messagesChannel.current = supabase
          .channel(`messages:${roomId}:${Date.now()}`)
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

      if (!reactionsChannel.current) {
        reactionsChannel.current = supabase
          .channel(`reactions:${roomId}:${Date.now()}`)
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
      
      if (error) throw error;
      console.log("Join request sent successfully");
      setWaitingForApproval(true);
      setupParticipantListener(meetingDbId, user.id);
    } catch (error) {
      console.error("Error in requestToJoin:", error);
      alert("Failed to send request. Please try again.");
    }
  }

  // UI render
  if (needPasscode) {
    return (
      <div className="p-4 max-w-md mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-6">
          <h2 className="text-xl font-bold mb-4">🔐 Enter Meeting Passcode</h2>
          <input
            type="password"
            className="border border-gray-300 p-3 w-full rounded-lg mb-4"
            placeholder="Enter passcode"
            value={inputPasscode}
            onChange={(e) => setInputPasscode(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && setNeedPasscode(false)}
          />
          <button
            onClick={() => setNeedPasscode(false)}
            className="w-full p-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-600"
          >
            Join Meeting
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-6xl mx-auto">
      <div className="bg-white rounded-lg shadow-sm border p-4">
        <h1 className="text-2xl font-bold mb-4">📹 Meeting Room: {roomId}</h1>
        <div className="flex gap-2">
          <input
            value={shareLink}
            readOnly
            onClick={(e) => e.target.select()}
            className="border border-gray-300 p-2 flex-1 rounded-lg"
          />
          <button
            onClick={() => {
              navigator.clipboard.writeText(shareLink);
              alert("Meeting link copied!");
            }}
            className="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600"
          >
            Copy Link
          </button>
        </div>
      </div>

      {/* Waiting List for Host */}
      {isHost && waitingList.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <h2 className="font-bold text-lg mb-3">
            👥 Participants Waiting to Join ({waitingList.length})
          </h2>
          <div className="space-y-2">
            {waitingList.map((w) => (
              <div
                key={w.user_id}
                className="flex items-center gap-3 p-3 bg-white rounded-lg border shadow-sm"
              >
                <div className="flex-1">
                  <p className="font-medium">{w.users.email}</p>
                  <p className="text-sm text-gray-500">
                    Requested at: {new Date(w.created_at).toLocaleTimeString()}
                  </p>
                </div>
                <button
                  onClick={() => approveUser(w.user_id)}
                  className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 font-medium"
                >
                  ✅ Approve
                </button>
                <button 
                  onClick={() => denyUser(w.user_id)}
                  className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 font-medium"
                >
                  ❌ Deny
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Status Display */}
      <div className="bg-gray-50 border rounded-lg p-4">
        <div className="flex items-center gap-4 text-sm">
          <span className={`px-3 py-1 rounded-full font-medium ${
            isHost ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'
          }`}>
            {isHost ? '👑 Host' : '👤 Participant'}
          </span>
          
          {waitingForApproval && (
            <span className="px-3 py-1 bg-yellow-100 text-yellow-800 rounded-full font-medium">
              ⏳ Waiting for host approval...
            </span>
          )}
          
          {permitToJoin && mediaPermissionGranted && (
            <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full font-medium">
              ✅ Connected
            </span>
          )}
          
          {isRecording && (
            <span className="px-3 py-1 bg-red-100 text-red-800 rounded-full font-medium animate-pulse">
              🔴 Recording
            </span>
          )}
        </div>
      </div>

      {/* Request to Join Button (for non-host users) */}
      {!isHost && !permitToJoin && !waitingForApproval && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6 text-center">
          <h2 className="text-xl font-bold mb-3">🚪 Ready to Join?</h2>
          <p className="text-gray-600 mb-4">
            Click the button below to request access to this meeting.
          </p>
          <button
            onClick={requestToJoin}
            disabled={isJoining}
            className="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isJoining ? '⏳ Requesting...' : '🙋 Request to Join Meeting'}
          </button>
        </div>
      )}

      {/* Main Meeting Interface */}
      {permitToJoin && (
        <>
          {/* Video Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
            {/* Local Video */}
            <div className="lg:col-span-3">
              <div className="bg-black rounded-lg overflow-hidden relative">
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="w-full h-64 lg:h-96 object-cover"
                />
                <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-sm px-2 py-1 rounded">
                  You {isMuted ? '🔇' : '🎤'} {cameraOn ? '📹' : '📹❌'}
                </div>
              </div>
              
              {/* Remote Videos */}
              <div 
                id="remote-videos" 
                className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 mt-4"
              />
            </div>

            {/* Chat Panel */}
            <div className="lg:col-span-1">
              <div className="bg-white rounded-lg shadow border h-96 flex flex-col">
                <div className="flex border-b">
                  <button
                    onClick={() => setShowChat(true)}
                    className={`flex-1 p-3 font-medium ${
                      showChat ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-600'
                    }`}
                  >
                    💬 Chat
                  </button>
                  <button
                    onClick={() => setShowChat(false)}
                    className={`flex-1 p-3 font-medium ${
                      !showChat ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600' : 'text-gray-600'
                    }`}
                  >
                    😊 Reactions
                  </button>
                </div>

                {showChat ? (
                  <>
                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-2">
                      {messages.map((msg, idx) => (
                        <div key={idx} className="text-sm">
                          <div className="font-medium text-blue-600">{msg.sender}</div>
                          <div className="text-gray-800">{msg.text}</div>
                          <div className="text-xs text-gray-500">
                            {new Date(msg.created_at).toLocaleTimeString()}
                          </div>
                        </div>
                      ))}
                    </div>
                    
                    {/* Chat Input */}
                    <div className="p-3 border-t">
                      <div className="flex gap-2">
                        <input
                          value={chatInput}
                          onChange={(e) => setChatInput(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                          placeholder="Type a message..."
                          className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        />
                        <button
                          onClick={sendMessage}
                          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 text-sm"
                        >
                          Send
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {/* Reactions Display */}
                    <div className="flex-1 overflow-y-auto p-3 space-y-1">
                      {reactions.slice(-20).map((reaction, idx) => (
                        <div key={idx} className="text-sm flex items-center gap-2">
                          <span className="text-2xl">{reaction.emoji}</span>
                          <span className="text-xs text-gray-500">
                            {new Date(reaction.created_at).toLocaleTimeString()}
                          </span>
                        </div>
                      ))}
                    </div>
                    
                    {/* Reaction Buttons */}
                    <div className="p-3 border-t">
                      <div className="grid grid-cols-4 gap-2">
                        {['👍', '❤️', '😂', '😮', '😢', '👏', '🔥', '🎉'].map((emoji) => (
                          <button
                            key={emoji}
                            onClick={() => sendReaction(emoji)}
                            className="p-2 text-2xl hover:bg-gray-100 rounded-lg transition-colors"
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Control Bar */}
          <div className="bg-white rounded-lg shadow border p-4">
            <div className="flex justify-center items-center gap-4">
              {/* Mute Button */}
              <button
                onClick={toggleMute}
                className={`p-3 rounded-full font-medium transition-colors ${
                  isMuted 
                    ? 'bg-red-500 hover:bg-red-600 text-white' 
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                }`}
              >
                {isMuted ? '🔇' : '🎤'}
              </button>

              {/* Camera Button */}
              <button
                onClick={toggleCamera}
                className={`p-3 rounded-full font-medium transition-colors ${
                  !cameraOn 
                    ? 'bg-red-500 hover:bg-red-600 text-white' 
                    : 'bg-gray-200 hover:bg-gray-300 text-gray-700'
                }`}
              >
                {cameraOn ? '📹' : '📹❌'}
              </button>

              {/* Recording Button */}
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`px-4 py-3 rounded-full font-medium transition-colors ${
                  isRecording 
                    ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse' 
                    : 'bg-blue-500 hover:bg-blue-600 text-white'
                }`}
              >
                {isRecording ? '⏹️ Stop Recording' : '🔴 Start Recording'}
              </button>

              {/* Leave Button */}
              <button
                onClick={() => {
                  if (window.confirm('Are you sure you want to leave the meeting?')) {
                    leaveRoom();
                    navigate('/');
                  }
                }}
                className="px-4 py-3 bg-red-500 hover:bg-red-600 text-white rounded-full font-medium transition-colors"
              >
                📞❌ Leave Meeting
              </button>
            </div>
          </div>

          {/* Meeting Info */}
          <div className="bg-gray-50 rounded-lg p-4 text-center text-sm text-gray-600">
            <p>
              Meeting ID: <span className="font-mono font-bold">{roomId}</span> | 
              Participants: <span className="font-bold">{participants.length + 1}</span> |
              Status: <span className="font-bold">
                {mediaPermissionGranted ? 'Connected' : 'Connecting...'}
              </span>
            </p>
          </div>
        </>
      )}

      {/* Loading State */}
      {!permitToJoin && !waitingForApproval && !needPasscode && (
        <div className="text-center py-8">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          <p className="mt-2 text-gray-600">Initializing meeting room...</p>
        </div>
      )}
    </div>
  );
}
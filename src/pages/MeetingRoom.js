import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import Peer from "peerjs";
import RecordRTC from "recordrtc";
import { supabase } from "../supabaseClient";

export default function MeetingRoom() {
  // State declarations
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
  const [connectionStatus, setConnectionStatus] = useState("Connecting...");
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // Refs
  const peerRef = useRef();
  const localStreamRef = useRef();
  const screenStreamRef = useRef();
  const recorderRef = useRef();
  const localVideoRef = useRef();
  const remoteVideosRef = useRef({});
  const refreshInterval = useRef();
  const isMountedRef = useRef(true);
  const retryCountsRef = useRef({});

  // Supabase channels
  const waitingChannel = useRef();
  const participantListener = useRef();
  const signalsChannel = useRef();
  const messagesChannel = useRef();
  const reactionsChannel = useRef();

  const BASE_URL = "https://zoomclone-v3.vercel.app";
  const shareLink = `${BASE_URL}/room/${roomId}${
    passcodeRequired ? `?passcode=${encodeURIComponent(inputPasscode)}` : ""
  }`;

  // Helper functions
  async function ensureProfileExists(userId) {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError) throw authError;

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: userId, email: user.email }, { onConflict: "id" });

    if (error) throw error;
  }

  async function createPendingRequest(meetingId, userId) {
    try {
      console.log("Creating pending request...");
      await ensureProfileExists(userId);

      const { error } = await supabase.from("participants").upsert(
        {
          meeting_id: meetingId,
          user_id: userId,
          status: "pending",
          created_at: new Date().toISOString(),
        },
        { onConflict: "meeting_id,user_id" }
      );

      if (error) throw error;
      console.log("Pending request created successfully");
      setWaitingForApproval(true);
    } catch (error) {
      console.error("Error in createPendingRequest:", error);
      alert("Failed to create join request. Please try again.");
    }
  }

  // Media functions
  async function requestMediaPermissions() {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    try {
      console.log("Requesting media permissions...");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: true,
      });

      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      stream.getAudioTracks().forEach((track) => (track.enabled = true));
      stream.getVideoTracks().forEach((track) => (track.enabled = true));

      setIsMuted(false);
      setCameraOn(true);
      setMediaPermissionGranted(true);
      console.log("Media permissions granted");
      return stream;
    } catch (err) {
      console.error("Media permission error:", err);
      alert("🛑 Please allow camera & mic access to join the meeting.");
      throw err;
    }
  }

  async function toggleScreenShare() {
    try {
      if (isScreenSharing) {
        // Stop screen sharing
        if (screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach(track => track.stop());
          screenStreamRef.current = null;
        }
        
        // Switch back to camera
        if (localStreamRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
          // Update all peer connections with the camera stream
          if (peerRef.current) {
            Object.keys(peerRef.current.connections).forEach(peerId => {
              peerRef.current.connections[peerId].forEach(connection => {
                if (connection.peerConnection && connection.peerConnection.getSenders) {
                  const videoSender = connection.peerConnection.getSenders().find(s => 
                    s.track && s.track.kind === 'video'
                  );
                  const audioSender = connection.peerConnection.getSenders().find(s => 
                    s.track && s.track.kind === 'audio'
                  );
                  if (videoSender && localStreamRef.current) {
                    videoSender.replaceTrack(localStreamRef.current.getVideoTracks()[0])
                      .catch(err => console.error("Error replacing video track:", err));
                  }
                  if (audioSender && localStreamRef.current) {
                    audioSender.replaceTrack(localStreamRef.current.getAudioTracks()[0])
                      .catch(err => console.error("Error replacing audio track:", err));
                  }
                }
              });
            });
          }
        }
        
        setIsScreenSharing(false);
      } else {
        // Start screen sharing
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: "always",
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
          },
          audio: true
        });

        screenStreamRef.current = screenStream;
        localVideoRef.current.srcObject = screenStream;
        setIsScreenSharing(true);

        // Handle when user stops sharing via browser UI
        screenStream.getVideoTracks()[0].onended = () => {
          if (localStreamRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
          }
          setIsScreenSharing(false);
        };

        // Replace the stream for all existing connections
        if (peerRef.current) {
          Object.keys(peerRef.current.connections).forEach(peerId => {
            peerRef.current.connections[peerId].forEach(connection => {
              if (connection.peerConnection && connection.peerConnection.getSenders) {
                const videoSender = connection.peerConnection.getSenders().find(s => 
                  s.track && s.track.kind === 'video'
                );
                const audioSender = connection.peerConnection.getSenders().find(s => 
                  s.track && s.track.kind === 'audio'
                );
                if (videoSender) {
                  videoSender.replaceTrack(screenStream.getVideoTracks()[0])
                    .catch(err => console.error("Error replacing video track:", err));
                }
                if (audioSender) {
                  const audioTrack = screenStream.getAudioTracks()[0];
                  if (audioTrack) {
                    audioSender.replaceTrack(audioTrack)
                      .catch(err => console.error("Error replacing audio track:", err));
                  }
                }
              }
            });
          });
        }
      }
    } catch (err) {
      console.error("Screen share error:", err);
      if (localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      setIsScreenSharing(false);
    }
  }

  function toggleMute() {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  }

  function toggleCamera() {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      videoTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setCameraOn(!cameraOn);
    }
  }

  async function startRecording() {
    if (!localStreamRef.current) {
      alert("Please join the meeting first to start recording.");
      return;
    }
    try {
      // Combine audio and video streams
      const combinedStream = new MediaStream();
      localStreamRef.current.getAudioTracks().forEach(track => combinedStream.addTrack(track));
      
      // Use screen share if available, otherwise use camera
      const videoSource = isScreenSharing && screenStreamRef.current ? 
        screenStreamRef.current : 
        localStreamRef.current;
      
      videoSource.getVideoTracks().forEach(track => combinedStream.addTrack(track));

      const recorder = new RecordRTC(combinedStream, {
        type: "video",
        mimeType: "video/webm;codecs=vp9",
        bitsPerSecond: 1280000,
        videoBitsPerSecond: 1000000,
        audioBitsPerSecond: 128000
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

  async function stopRecording() {
    if (!recorderRef.current) return;
    try {
      // Stop recording
      await new Promise((resolve) => {
        recorderRef.current.stopRecording(resolve);
      });
      
      // Get the recorded blob
      const blob = recorderRef.current.getBlob();
      
      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `recording-${roomId}-${timestamp}.webm`;
      
      // Upload to Supabase Storage
      const { data, error } = await supabase.storage
        .from("recordings")
        .upload(`public/${filename}`, blob, {
          contentType: 'video/webm',
          upsert: false
        });
      
      if (error) {
        console.error("Upload error:", error);
        alert("Failed to upload recording.");
        return;
      }
      
      // Get public URL
      const { data: { publicUrl } } = supabase.storage
        .from("recordings")
        .getPublicUrl(`public/${filename}`);
      
      // Insert recording metadata into database
      const { data: userData } = await supabase.auth.getUser();
      await supabase.from("recordings").insert({
        room_id: roomId,
        uploaded_by: userData.user.id,
        file_name: filename,
        file_url: publicUrl,
        file_size: blob.size,
        duration: Math.floor(recorderRef.current.getBlob().duration),
        created_at: new Date().toISOString()
      });
      
      alert("✅ Recording saved and uploaded successfully!");
      setIsRecording(false);
      recorderRef.current = null;
    } catch (err) {
      console.error("Recording stop error:", err);
      setIsRecording(false);
      recorderRef.current = null;
      alert("Failed to save recording. Please try again.");
    }
  }

  // PeerJS functions
  const createPeer = () => {
    const peer = new Peer({
      debug: 2,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
        ],
        iceTransportPolicy: "all",
        iceCandidatePoolSize: 3,
      },
    });

    peer.on("error", (err) => {
      console.error("PeerJS error:", err);
      setConnectionStatus(`Error: ${err.type}`);

      if (err.type === "peer-unavailable") {
        console.warn("Peer unavailable, will retry...");
      } else if (err.type === "socket-error") {
        console.error("Socket error, attempting to reconnect...");
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
          }
        }, 2000);
      }
    });

    peer.on("iceConnectionStateChange", (state) => {
      console.log("ICE connection state:", state);
      setConnectionStatus(state.charAt(0).toUpperCase() + state.slice(1));

      if (state === "failed") {
        console.warn("ICE connection failed, attempting recovery...");
        setTimeout(() => {
          if (isMountedRef.current) {
            reconnectPeers();
          }
        }, 2000);
      }
    });

    return peer;
  };

  const reconnectPeers = async () => {
    if (!peerRef.current || !peerRef.current.id) return;

    try {
      const { data: others } = await supabase
        .from("signals")
        .select("peer_id")
        .eq("room_id", roomId)
        .neq("peer_id", peerRef.current.id);

      if (others && others.length > 0) {
        others.forEach(({ peer_id }) => {
          connectToPeer(peer_id);
        });
      }
    } catch (error) {
      console.error("Reconnection error:", error);
    }
  };

  const connectToPeer = async (peerId) => {
    if (!peerRef.current || !localStreamRef.current) return;

    if (peerRef.current.connections[peerId]?.length > 0) return;

    if (!retryCountsRef.current[peerId]) {
      retryCountsRef.current[peerId] = 0;
    }

    if (retryCountsRef.current[peerId] >= 5) {
      console.warn(`Max retries reached for peer ${peerId}`);
      return;
    }

    try {
      console.log(
        `Connecting to peer: ${peerId}, attempt: ${
          retryCountsRef.current[peerId] + 1
        }`
      );

      const streamToSend = isScreenSharing && screenStreamRef.current ? 
        screenStreamRef.current : 
        localStreamRef.current;

      const call = peerRef.current.call(peerId, streamToSend);
      setupCall(call, peerId);

      retryCountsRef.current[peerId] = 0;
    } catch (err) {
      console.error(`Connection attempt failed to ${peerId}:`, err);
      retryCountsRef.current[peerId] += 1;

      const delay = Math.min(
        1000 * Math.pow(2, retryCountsRef.current[peerId]),
        8000
      );
      setTimeout(() => connectToPeer(peerId), delay);
    }
  };

  const setupCall = (call, peerId) => {
    call.on("stream", (remoteStream) => {
      console.log("Received stream from:", peerId);
      addRemote(peerId, remoteStream);
      setConnectionStatus("Connected");
    });

    call.on("close", () => {
      console.log("Call closed with:", peerId);
      removeRemote(peerId);
      setConnectionStatus("Disconnected");
    });

    call.on("error", (err) => {
      console.error("Call error with", peerId, ":", err);
      removeRemote(peerId);
      setConnectionStatus("Error: " + err.message);
    });

    call.on("iceStateChanged", (state) => {
      console.log(`ICE state with ${peerId}:`, state);
      if (state === "disconnected" || state === "failed") {
        console.warn(
          `Connection to ${peerId} is ${state}, attempting recovery`
        );
        setTimeout(() => connectToPeer(peerId), 2000);
      }
    });
  };

  function addRemote(id, stream) {
    if (remoteVideosRef.current[id]) return;

    const div = document.createElement("div");
    div.className = "relative bg-black rounded";
    const vid = document.createElement("video");
    vid.srcObject = stream;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.className = "border bg-black w-full h-32 rounded";

    const label = document.createElement("div");
    label.className =
      "absolute top-1 left-1 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded";
    label.textContent = id.substring(0, 8);

    div.appendChild(vid);
    div.appendChild(label);
    remoteVideosRef.current[id] = div;

    const container = document.getElementById("remote-videos");
    if (container) container.appendChild(div);
  }

  function removeRemote(id) {
    const el = remoteVideosRef.current[id];
    if (el) {
      el.remove();
      delete remoteVideosRef.current[id];
    }
  }

  // Database functions
  async function updateWaitingList(mtId) {
    try {
      const { data, error } = await supabase
        .from("participants")
        .select(
          `
          id,
          user_id,
          status,
          profiles:user_id(email),
          created_at
        `
        )
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

  function setupWaitingListener(mtId) {
    console.log("Setting up waiting listener for meeting:", mtId);

    updateWaitingList(mtId);

    if (!waitingChannel.current) {
      waitingChannel.current = supabase
        .channel(`waiting:${mtId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "participants",
            filter: `meeting_id=eq.${mtId}`,
          },
          (payload) => {
            console.log("Participant change detected:", payload);
            updateWaitingList(mtId);
          }
        )
        .subscribe((status) => {
          console.log("Waiting channel subscription status:", status);
        });
    }
  }

  async function approveUser(uid) {
    try {
      console.log("Approving user:", uid);
      const { error } = await supabase
        .from("participants")
        .update({
          status: "approved",
          updated_at: new Date().toISOString(),
        })
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
        .update({
          status: "denied",
          updated_at: new Date().toISOString(),
        })
        .eq("meeting_id", meetingDbId)
        .eq("user_id", uid);

      if (error) throw error;
      console.log("User denied successfully");
    } catch (error) {
      console.error("Error denying user:", error);
      alert("Failed to deny user. Please try again.");
    }
  }

  function setupParticipantListener(mtId, uid) {
    console.log("Setting up participant listener for:", mtId, uid);

    if (!participantListener.current) {
      participantListener.current = supabase
        .channel(`participant:${mtId}:${uid}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "participants",
            filter: `meeting_id=eq.${mtId},user_id=eq.${uid}`,
          },
          async (payload) => {
            console.log("Participant status update:", payload.new);
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
        .subscribe((status) => {
          console.log("Participant listener subscription status:", status);
        });
    }
  }

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
          .channel(`messages:${roomId}`)
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "messages",
              filter: `room_id=eq.${roomId}`,
            },
            (payload) => {
              setMessages((prev) => [...prev, payload.new]);
            }
          )
          .subscribe();
      }

      const { data: oldReacts, error: reactsError } = await supabase
        .from("reactions")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });

      if (reactsError) throw reactsError;
      setReactions(oldReacts || []);

      if (!reactionsChannel.current) {
        reactionsChannel.current = supabase
          .channel(`reactions:${roomId}`)
          .on(
            "postgres_changes",
            {
              event: "*",
              schema: "public",
              table: "reactions",
              filter: `room_id=eq.${roomId}`,
            },
            (payload) => {
              try {
                if (payload.eventType === "INSERT") {
                  setReactions((prev) => [...prev, payload.new]);
                } else if (payload.eventType === "DELETE") {
                  setReactions((prev) =>
                    prev.filter((r) => r.id !== payload.old.id)
                  );
                }
              } catch (e) {
                console.error("Error processing reaction update:", e);
              }
            }
          )
          .subscribe((status, err) => {
            if (err) {
              console.error("Reactions channel error:", err);
              setTimeout(() => {
                if (reactionsChannel.current) {
                  reactionsChannel.current.subscribe();
                }
              }, 2000);
            }
          });
      }
    } catch (error) {
      console.error("Error loading messages and reactions:", error);
    }
  }

  async function sendMessage() {
    if (!chatInput.trim() || !user?.email) return;
    try {
      const { error } = await supabase.from("messages").insert({
        room_id: roomId,
        sender: user.email,
        text: chatInput,
        created_at: new Date().toISOString(),
      });

      if (error) throw error;
      setChatInput("");
    } catch (error) {
      console.error("Error sending message:", error);
      alert("Failed to send message. Please try again.");
    }
  }

  async function sendReaction(emoji) {
    if (!user?.id || !roomId) {
      console.error("User or room information missing");
      return;
    }

    // Validate emoji
    if (!emoji || typeof emoji !== "string" || emoji.length > 10) {
      alert("Invalid emoji selected");
      return;
    }

    try {
      // First ensure profile exists
      const { error: profileError } = await supabase
        .from("profiles")
        .upsert({ id: user.id, email: user.email }, { onConflict: "id" });

      if (profileError) throw profileError;

      // Insert reaction
      const { error } = await supabase.from("reactions").insert({
        room_id: roomId,
        user_id: user.id,
        emoji,
        created_at: new Date().toISOString(),
      });

      if (error) throw error;

      // Also add to messages as a system message
      await supabase.from("messages").insert({
        room_id: roomId,
        sender: "System",
        text: `${user.email} reacted with ${emoji}`,
        created_at: new Date().toISOString(),
      });

      // Optimistic update
      setReactions((prev) => [
        ...prev.filter((r) => !(r.user_id === user.id && r.emoji === emoji)),
        {
          id: crypto.randomUUID(),
          room_id: roomId,
          user_id: user.id,
          emoji,
          created_at: new Date().toISOString(),
        },
      ]);
    } catch (error) {
      console.error("Error sending reaction:", error);
      if (error.code === "23503") {
        alert("Your account isn't properly set up. Please refresh the page.");
      } else {
        alert(`Failed to send reaction: ${error.message}`);
      }
    }
  }

  async function requestToJoin() {
    if (!meetingDbId || !user?.id) return;

    try {
      console.log("Requesting to join...");
      const { error } = await supabase.from("participants").upsert(
        {
          meeting_id: meetingDbId,
          user_id: user.id,
          status: "pending",
          created_at: new Date().toISOString(),
        },
        { onConflict: "meeting_id,user_id" }
      );

      if (error) throw error;
      console.log("Join request sent successfully");
      setWaitingForApproval(true);
      setupParticipantListener(meetingDbId, user.id);
    } catch (error) {
      console.error("Error in requestToJoin:", error);
      alert("Failed to send request. Please try again.");
    }
  }

  // Room initialization
  const initRoom = useCallback(async () => {
    if (isInitialized || !isMountedRef.current) return;

    try {
      console.log("Initializing room...");
      setIsInitialized(true);

      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth?.user) throw new Error("Not authenticated");

      await ensureProfileExists(auth.user.id);
      setUser(auth.user);

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

      const providedPass =
        new URLSearchParams(search).get("passcode") || inputPasscode;
      if (mt.passcode && providedPass !== mt.passcode) {
        setNeedPasscode(true);
        return;
      }

      setNeedPasscode(false);

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
          console.log(
            "Already approved, requesting permissions and joining..."
          );
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
        alert(error.message || "Failed to initialize room");
      }
      navigate("/");
    }
  }, [inputPasscode, navigate, roomId, search]);

  async function joinMeeting(meetingId, userId) {
    if (isJoining) return;
    setIsJoining(true);
    setConnectionStatus("Connecting...");

    console.log("Joining meeting...", meetingId, userId);

    try {
      const stream = await requestMediaPermissions();
      updateParticipants(meetingId);

      const peer = createPeer();
      peerRef.current = peer;

      peer.on("open", async (pid) => {
        console.log("Peer opened with ID:", pid);
        try {
          const { error } = await supabase.from("signals").upsert(
            {
              room_id: roomId,
              peer_id: pid,
              last_active: new Date().toISOString(),
            },
            {
              onConflict: "room_id,peer_id",
              ignoreDuplicates: false,
            }
          );

          if (error) throw error;

          const { data: others, error: fetchError } = await supabase
            .from("signals")
            .select("*")
            .eq("room_id", roomId)
            .neq("peer_id", pid)
            .order("last_active", { ascending: false });

          if (fetchError) throw fetchError;

          others?.forEach((o) => connectToPeer(o.peer_id));

          if (!signalsChannel.current) {
            signalsChannel.current = supabase
              .channel(`signals:${roomId}`)
              .on(
                "postgres_changes",
                {
                  event: "*",
                  schema: "public",
                  table: "signals",
                  filter: `room_id=eq.${roomId}`,
                },
                (payload) => {
                  if (payload.new.peer_id !== pid) {
                    console.log("Peer activity change:", payload);
                    if (
                      payload.eventType === "INSERT" ||
                      payload.eventType === "UPDATE"
                    ) {
                      connectToPeer(payload.new.peer_id);
                    } else if (payload.eventType === "DELETE") {
                      removeRemote(payload.old.peer_id);
                    }
                  }
                }
              )
              .subscribe((status, err) => {
                if (err) {
                  console.error("Signals channel error:", err);
                  setTimeout(() => {
                    if (signalsChannel.current) {
                      signalsChannel.current.subscribe();
                    }
                  }, 2000);
                }
                console.log("Signals channel status:", status);
              });
          }
        } catch (err) {
          console.error("Error in peer open handler:", err);
          setTimeout(() => {
            if (peerRef.current && !peerRef.current.destroyed) {
              joinMeeting(meetingId, userId);
            }
          }, 3000);
        }
      });

      peer.on("call", (call) => {
        console.log("Receiving call from:", call.peer);
        try {
          const streamToAnswerWith = isScreenSharing && screenStreamRef.current ? 
            screenStreamRef.current : 
            localStreamRef.current;
            
          call.answer(streamToAnswerWith);
          setupCall(call, call.peer);
        } catch (err) {
          console.error("Error answering call:", err);
          setTimeout(() => {
            if (localStreamRef.current) {
              call.answer(localStreamRef.current);
              setupCall(call, call.peer);
            }
          }, 1000);
        }
      });

      loadMessagesAndReactions();
      setIsJoining(false);
    } catch (err) {
      console.error("Join meeting error:", err);
      setIsJoining(false);
      setConnectionStatus("Connection failed");
      alert(
        "🛑 Failed to join meeting. Please check your network connection and try again."
      );
    }
  }

  async function cleanupSubscriptions() {
    try {
      const channels = [
        signalsChannel,
        waitingChannel,
        participantListener,
        messagesChannel,
        reactionsChannel,
      ];

      for (const channelRef of channels) {
        if (channelRef.current) {
          await supabase.removeChannel(channelRef.current);
          channelRef.current = null;
        }
      }
    } catch (error) {
      console.warn("Error cleaning up subscriptions:", error);
    }
  }

  async function leaveRoom() {
    if (!isMountedRef.current) return;

    try {
      console.log("Leaving room...");

      if (isRecording) await stopRecording();
      
      if (isScreenSharing && screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach(track => track.stop());
        screenStreamRef.current = null;
        setIsScreenSharing(false);
      }

      if (peerRef.current?.id) {
        await supabase
          .from("signals")
          .delete()
          .eq("room_id", roomId)
          .eq("peer_id", peerRef.current.id);
      }

      if (peerRef.current) {
        peerRef.current.destroy();
        peerRef.current = null;
      }

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
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
      
      // Navigate after cleanup
      navigate("/");
    } catch (err) {
      console.warn("Leave room error:", err);
      navigate("/");
    }
  }

  // Effects
  useEffect(() => {
    const pass = new URLSearchParams(search).get("passcode") || "";
    setInputPasscode(pass);
  }, [search]);

  useEffect(() => {
    isMountedRef.current = true;

    if (!needPasscode && !isInitialized) {
      initRoom();
    }

    return () => {
      isMountedRef.current = false;
      leaveRoom();
    };
  }, [needPasscode, initRoom]);

  // UI Render
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
            className="p-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Copy
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Main video area */}
        <div className="lg:col-span-2 space-y-4">
          {/* Local video */}
          <div className="bg-black rounded-lg overflow-hidden relative">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-64 object-contain"
            />
            <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-sm">
              {user?.email || "You"}
              {isMuted ? " 🔇" : " 🔊"}
              {!cameraOn ? " 📷❌" : " 📷"}
              {isScreenSharing && " 🖥️"}
            </div>
          </div>

          {/* Remote videos */}
          <div
            id="remote-videos"
            className="grid grid-cols-1 sm:grid-cols-2 gap-2"
          />

          {/* Controls */}
          <div className="flex flex-wrap gap-2 justify-center bg-gray-100 p-3 rounded-lg">
            <button
              onClick={toggleMute}
              className={`p-3 rounded-full flex items-center gap-2 ${isMuted ? 'bg-red-500 text-white' : 'bg-gray-300'} hover:bg-gray-400`}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? "🔇" : "🔊"}
              <span className="text-sm hidden sm:inline">{isMuted ? "Unmute" : "Mute"}</span>
            </button>
            <button
              onClick={toggleCamera}
              className={`p-3 rounded-full flex items-center gap-2 ${cameraOn ? 'bg-gray-300' : 'bg-red-500 text-white'} hover:bg-gray-400`}
              title={cameraOn ? "Turn off camera" : "Turn on camera"}
            >
              {cameraOn ? "📷" : "📷❌"}
              <span className="text-sm hidden sm:inline">{cameraOn ? "Stop Video" : "Start Video"}</span>
            </button>
            <button
              onClick={toggleScreenShare}
              className={`p-3 rounded-full flex items-center gap-2 ${isScreenSharing ? 'bg-blue-500 text-white' : 'bg-gray-300'} hover:bg-gray-400`}
              title={isScreenSharing ? "Stop sharing" : "Share screen"}
            >
              🖥️
              <span className="text-sm hidden sm:inline">{isScreenSharing ? "Stop Share" : "Share Screen"}</span>
            </button>
            {isHost && (
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`p-3 rounded-full flex items-center gap-2 ${isRecording ? 'bg-red-500 text-white' : 'bg-gray-300'} hover:bg-gray-400`}
                title={isRecording ? "Stop recording" : "Start recording"}
              >
                {isRecording ? "⏹️" : "🔴"}
                <span className="text-sm hidden sm:inline">{isRecording ? "Stop Recording" : "Record"}</span>
              </button>
            )}
            <button
              onClick={() => {
                leaveRoom();
                navigate("/");
              }}
              className="p-3 bg-red-500 text-white rounded-full flex items-center gap-2 hover:bg-red-600"
              title="Leave meeting"
            >
              🚪
              <span className="text-sm hidden sm:inline">Leave</span>
            </button>
          </div>

          {/* Status */}
          <div className="text-center text-sm text-gray-600">
            {connectionStatus}
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Waiting list (host only) */}
          {isHost && waitingList.length > 0 && (
            <div className="bg-white border rounded-lg p-3">
              <h3 className="font-bold mb-2">👥 Waiting Room ({waitingList.length})</h3>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {waitingList.map((req) => (
                  <div key={req.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">+
                    <span className="text-sm truncate">{req.profiles?.email || req.user_id}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => approveUser(req.user_id)}
                        className="p-1 bg-green-500 text-white rounded hover:bg-green-600"
                        title="Approve"
                      >
                        ✓Admit
                      </button>
                      <button
                        onClick={() => denyUser(req.user_id)}
                        className="p-1 bg-red-500 text-white rounded hover:bg-red-600"
                        title="Deny"
                      >
                        ✗Deny
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Waiting for approval */}
          {waitingForApproval && (
            <div className="bg-yellow-100 border border-yellow-300 rounded-lg p-4">
              <p className="text-yellow-800">
                ⏳ Your request to join has been sent to the host. Please wait for approval...
              </p>
            </div>
          )}

          {/* Chat */}
          <div className={`bg-white border rounded-lg ${showChat ? 'block' : 'hidden'}`}>
            <div className="p-3 border-b flex justify-between items-center">
              <h3 className="font-bold">💬 Chat</h3>
              <button
                onClick={() => setShowChat(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ×
              </button>
            </div>
            <div className="p-3 h-60 overflow-y-auto space-y-2">
              {messages.map((msg) => (
                <div key={msg.id} className="text-sm">
                  <span className="font-semibold">{msg.sender}: </span>
                  <span>{msg.text}</span>
                </div>
              ))}
            </div>
            <div className="p-3 border-t flex">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendMessage()}
                placeholder="Type a message..."
                className="flex-1 border p-2 rounded-l"
              />
              <button
                onClick={sendMessage}
                className="bg-blue-500 text-white p-2 rounded-r hover:bg-blue-600"
              >
                Send
              </button>
            </div>
          </div>

          {/* Reactions */}
          <div className="bg-white border rounded-lg p-3">
            <h3 className="font-bold mb-2">🎉 Reactions</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {['👍', '👎', '😄', '😕', '❤️', '🔥', '👏', '🎉'].map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => sendReaction(emoji)}
                  className="text-2xl hover:scale-110 transition-transform"
                >
                  {emoji}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              {reactions.map((r) => (
                <span key={r.id} className="text-2xl">
                  {r.emoji}
                </span>
              ))}
            </div>
          </div>

          {/* Chat toggle */}
          {!showChat && (
            <button
              onClick={() => setShowChat(true)}
              className="w-full p-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
            >
              Show Chat
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
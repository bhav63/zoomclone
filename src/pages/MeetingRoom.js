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
  const [participantNames, setParticipantNames] = useState({});
  const [activeSpeakers, setActiveSpeakers] = useState({});
  const [connectionStats, setConnectionStats] = useState({});

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
  const audioContextRef = useRef();
  const analysersRef = useRef({});
  const peerConnectionsRef = useRef({});
  const statsIntervalRef = useRef();

  // Supabase channels
  const waitingChannel = useRef();
  const participantListener = useRef();
  const signalsChannel = useRef();
  const messagesChannel = useRef();
  const reactionsChannel = useRef();
  const participantsChannel = useRef();

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
                
                if (peerRef.current?.id) {
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
                }
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

  function setupParticipantsListener(mtId) {
    if (!participantsChannel.current) {
      participantsChannel.current = supabase
        .channel(`participants:${mtId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "participants",
            filter: `meeting_id=eq.${mtId}`,
          },
          (payload) => {
            console.log("Participants change detected:", payload);
            updateParticipants(mtId);
          }
        )
        .subscribe((status) => {
          console.log("Participants channel subscription status:", status);
        });
    }
  }

  async function updateParticipants(mtId) {
    try {
      const { data } = await supabase
        .from("participants")
        .select("user_id, profiles:user_id(email)")
        .eq("meeting_id", mtId)
        .eq("status", "approved");
      
      if (data) {
        setParticipants(data.map((p) => p.user_id));
        
        const names = {};
        data.forEach(p => {
          names[p.user_id] = p.profiles?.email || p.user_id.substring(0, 8);
        });
        setParticipantNames(names);
        
        Object.keys(remoteVideosRef.current).forEach(peerId => {
          const label = remoteVideosRef.current[peerId].querySelector('div');
          if (label) {
            label.textContent = names[peerId] || peerId.substring(0, 8);
          }
        });
      }
    } catch (error) {
      console.error("Error updating participants:", error);
    }
  }

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

  // Enhanced media functions with error handling
  async function requestMediaPermissions() {
    if (localStreamRef.current) {
      return localStreamRef.current;
    }

    try {
      console.log("Requesting media permissions...");
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);

      // Handle cases where browser might return stream without tracks
      if (!stream.getAudioTracks().length && !stream.getVideoTracks().length) {
        throw new Error("No media tracks received");
      }

      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      stream.getAudioTracks().forEach((track) => (track.enabled = !isMuted));
      stream.getVideoTracks().forEach((track) => (track.enabled = cameraOn));

      setMediaPermissionGranted(true);
      console.log("Media permissions granted");
      
      setupAudioContext(stream);
      
      return stream;
    } catch (err) {
      console.error("Media permission error:", err);
      
      // Try fallback constraints if the ideal ones fail
      if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
        try {
          console.log("Trying fallback media constraints...");
          const fallbackStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: true
          });
          
          localStreamRef.current = fallbackStream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = fallbackStream;
          }
          
          setMediaPermissionGranted(true);
          return fallbackStream;
        } catch (fallbackError) {
          console.error("Fallback media error:", fallbackError);
          throw fallbackError;
        }
      }
      
      alert("🛑 Please allow camera & mic access to join the meeting.");
      throw err;
    }
  }

  function setupAudioContext(stream) {
    try {
      if (!audioContextRef.current) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new AudioContext();
      }
      
      const audioContext = audioContextRef.current;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      
      analysersRef.current['local'] = analyser;
      
      analyzeAudio();
    } catch (err) {
      console.error("Audio context setup error:", err);
    }
  }

  function analyzeAudio() {
    if (!isMountedRef.current) return;
    
    const bufferLength = analysersRef.current['local']?.frequencyBinCount || 0;
    const dataArray = new Uint8Array(bufferLength);
    const newActiveSpeakers = {...activeSpeakers};
    
    // Analyze local audio
    if (analysersRef.current['local']) {
      analysersRef.current['local'].getByteFrequencyData(dataArray);
      const volume = Math.max(...dataArray);
      newActiveSpeakers['local'] = volume > 30;
    }
    
    // Analyze remote audio
    Object.keys(analysersRef.current).forEach(peerId => {
      if (peerId !== 'local') {
        analysersRef.current[peerId].getByteFrequencyData(dataArray);
        const volume = Math.max(...dataArray);
        newActiveSpeakers[peerId] = volume > 30;
      }
    });
    
    setActiveSpeakers(newActiveSpeakers);
    requestAnimationFrame(analyzeAudio);
  }

  // Enhanced screen sharing with aspect ratio preservation
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
          updateAllPeerConnections(localStreamRef.current);
        }
        
        setIsScreenSharing(false);
      } else {
        // Start screen sharing with better constraints
        const screenStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            cursor: "always",
            width: { ideal: 1920, max: 1920 },
            height: { ideal: 1080, max: 1080 },
            frameRate: { ideal: 30, max: 30 },
            resizeMode: "crop-and-scale" // Preserve aspect ratio
          },
          audio: false
        });

        screenStreamRef.current = screenStream;
        
        // Combine with audio from local stream
        const combinedStream = new MediaStream([
          ...screenStream.getVideoTracks(),
          ...(localStreamRef.current?.getAudioTracks() || [])
        ]);
        
        localVideoRef.current.srcObject = combinedStream;
        setIsScreenSharing(true);

        // Handle when user stops sharing via browser UI
        screenStream.getVideoTracks()[0].onended = () => {
          if (localStreamRef.current) {
            localVideoRef.current.srcObject = localStreamRef.current;
          }
          setIsScreenSharing(false);
        };

        // Update all peer connections with the screen share stream
        updateAllPeerConnections(combinedStream);
      }
    } catch (err) {
      console.error("Screen share error:", err);
      if (localStreamRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      setIsScreenSharing(false);
    }
  }

  function updateAllPeerConnections(stream) {
    if (!peerRef.current) return;

    Object.keys(peerRef.current.connections).forEach(peerId => {
      peerRef.current.connections[peerId].forEach(connection => {
        if (connection.peerConnection && connection.peerConnection.getSenders) {
          const senders = connection.peerConnection.getSenders();
          const videoTrack = stream.getVideoTracks()[0];
          const audioTrack = stream.getAudioTracks()[0];
          
          senders.forEach(sender => {
            if (sender.track.kind === 'video' && videoTrack) {
              sender.replaceTrack(videoTrack)
                .catch(err => console.error("Error replacing video track:", err));
            } else if (sender.track.kind === 'audio' && audioTrack) {
              sender.replaceTrack(audioTrack)
                .catch(err => console.error("Error replacing audio track:", err));
            }
          });
        }
      });
    });
  }

  function toggleMute() {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      const newMuteState = !isMuted;
      audioTracks.forEach((track) => {
        track.enabled = newMuteState;
      });
      setIsMuted(newMuteState);
    }
  }

  function toggleCamera() {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      const newCameraState = !cameraOn;
      videoTracks.forEach((track) => {
        track.enabled = newCameraState;
      });
      setCameraOn(newCameraState);
    }
  }

  async function startRecording() {
    if (!localStreamRef.current) {
      alert("Please join the meeting first to start recording.");
      return;
    }
    try {
      const combinedStream = new MediaStream();
      
      const videoSource = isScreenSharing && screenStreamRef.current ? 
        screenStreamRef.current.getVideoTracks()[0] : 
        localStreamRef.current.getVideoTracks()[0];
      
      const audioSource = localStreamRef.current.getAudioTracks()[0];
      
      if (videoSource) combinedStream.addTrack(videoSource);
      if (audioSource) combinedStream.addTrack(audioSource);

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
      await new Promise((resolve) => {
        recorderRef.current.stopRecording(resolve);
      });
      
      const blob = recorderRef.current.getBlob();
      
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `recording-${roomId}-${timestamp}.webm`;
      
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
      
      const { data: { publicUrl } } = supabase.storage
        .from("recordings")
        .getPublicUrl(`public/${filename}`);
      
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

  // Enhanced PeerJS functions with better connection handling
  const createPeer = () => {
    const peer = new Peer({
      debug: 3, // More verbose logging
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          {
            urls: "turn:global.turn.twilio.com:3478?transport=udp",
            username: "your-twilio-username",
            credential: "your-twilio-credential"
          }
        ],
        iceTransportPolicy: "all",
        iceCandidatePoolSize: 5, // Increased pool size
        rtcpMuxPolicy: "require", // Better for mobile
        bundlePolicy: "max-bundle", // More efficient
        sdpSemantics: "unified-plan" // Modern SDP
      },
      reconnectTimer: 5000, // Faster reconnection
    });

    peer.on("error", (err) => {
      console.error("PeerJS error:", err);
      setConnectionStatus(`Error: ${err.type}`);

      if (err.type === "peer-unavailable") {
        console.warn("Peer unavailable, will retry...");
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
          }
        }, 2000);
      } else if (err.type === "socket-error") {
        console.error("Socket error, attempting to reconnect...");
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
          }
        }, 2000);
      } else if (err.type === "network") {
        console.error("Network error, will retry...");
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
          }
        }, 3000);
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
      } else if (state === "disconnected") {
        console.warn("ICE connection disconnected, attempting recovery...");
        setTimeout(() => {
          if (isMountedRef.current) {
            reconnectPeers();
          }
        }, 1000);
      }
    });

    peer.on("connectionStateChange", (state) => {
      console.log("Peer connection state:", state);
      if (state === "disconnected") {
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
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
        .select("peer_id, user_id")
        .eq("room_id", roomId)
        .neq("peer_id", peerRef.current.id);

      if (others && others.length > 0) {
        console.log("Reconnecting to peers:", others);
        others.forEach(({ peer_id, user_id }) => {
          // Only reconnect if we don't already have an active connection
          if (!peerConnectionsRef.current[peer_id]) {
            connectToPeer(peer_id);
          }
        });
      }
    } catch (error) {
      console.error("Reconnection error:", error);
    }
  };

  const connectToPeer = async (peerId) => {
    if (!peerRef.current || !localStreamRef.current) return;

    // Skip if already connected
    if (peerConnectionsRef.current[peerId]) {
      console.log(`Already connected to ${peerId}, skipping`);
      return;
    }

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
        new MediaStream([
          ...screenStreamRef.current.getVideoTracks(),
          ...localStreamRef.current.getAudioTracks()
        ]) : 
        localStreamRef.current;

      const call = peerRef.current.call(peerId, streamToSend);
      peerConnectionsRef.current[peerId] = call;
      setupCall(call, peerId);

      retryCountsRef.current[peerId] = 0;
    } catch (err) {
      console.error(`Connection attempt failed to ${peerId}:`, err);
      retryCountsRef.current[peerId] += 1;
      delete peerConnectionsRef.current[peerId];

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
      
      // Setup audio analysis for remote stream
      if (!audioContextRef.current) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new AudioContext();
      }
      
      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 512;
      const source = audioContextRef.current.createMediaStreamSource(remoteStream);
      source.connect(analyser);
      analysersRef.current[peerId] = analyser;
      
      addRemote(peerId, remoteStream);
      setConnectionStatus("Connected");
      
      // Start connection stats monitoring
      if (!statsIntervalRef.current) {
        startConnectionStats();
      }
    });

    call.on("close", () => {
      console.log("Call closed with:", peerId);
      removeRemote(peerId);
      delete peerConnectionsRef.current[peerId];
      setConnectionStatus("Disconnected");
      
      if (analysersRef.current[peerId]) {
        delete analysersRef.current[peerId];
      }
    });

    call.on("error", (err) => {
      console.error("Call error with", peerId, ":", err);
      removeRemote(peerId);
      delete peerConnectionsRef.current[peerId];
      setConnectionStatus("Error: " + err.message);
      
      if (analysersRef.current[peerId]) {
        delete analysersRef.current[peerId];
      }
    });

    call.on("iceStateChanged", (state) => {
      console.log(`ICE state with ${peerId}:`, state);
      if (state === "disconnected" || state === "failed") {
        console.warn(`Connection to ${peerId} is ${state}, attempting recovery`);
        setTimeout(() => connectToPeer(peerId), 2000);
      }
    });
  };

  function startConnectionStats() {
    if (statsIntervalRef.current) return;

    statsIntervalRef.current = setInterval(() => {
      if (!peerRef.current) return;

      const stats = {};
      
      Object.entries(peerConnectionsRef.current).forEach(([peerId, call]) => {
        if (call.peerConnection) {
          try {
            call.peerConnection.getStats().then(results => {
              results.forEach(report => {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                  stats[peerId] = {
                    rtt: report.currentRoundTripTime,
                    packetsLost: report.packetsLost,
                    bytesSent: report.bytesSent,
                    bytesReceived: report.bytesReceived
                  };
                }
              });
              setConnectionStats(stats);
            });
          } catch (err) {
            console.error("Error getting stats for peer", peerId, err);
          }
        }
      });
    }, 5000); // Update stats every 5 seconds
  }

  function addRemote(id, stream) {
    if (remoteVideosRef.current[id]) return;

    const div = document.createElement("div");
    div.className = "relative bg-black rounded-lg overflow-hidden";
    div.id = `remote-${id}`;
    
    const vid = document.createElement("video");
    vid.srcObject = stream;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.className = "w-full h-full object-cover";
    
    // Add audio context for this remote stream
    if (!audioContextRef.current) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      audioContextRef.current = new AudioContext();
    }
    
    const analyser = audioContextRef.current.createAnalyser();
    analyser.fftSize = 512;
    const source = audioContextRef.current.createMediaStreamSource(stream);
    source.connect(analyser);
    analysersRef.current[id] = analyser;

    const label = document.createElement("div");
    label.className =
      "absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded";
    label.textContent = participantNames[id] || id.substring(0, 8);
    
    // Add speaking indicator
    const speakingIndicator = document.createElement("div");
    speakingIndicator.className = "absolute top-2 right-2 w-3 h-3 rounded-full bg-transparent";
    speakingIndicator.id = `speaking-${id}`;

    // Add connection stats
    const statsElement = document.createElement("div");
    statsElement.className = "absolute top-2 left-2 bg-black bg-opacity-50 text-white text-xs px-1 rounded";
    statsElement.id = `stats-${id}`;

    div.appendChild(vid);
    div.appendChild(label);
    div.appendChild(speakingIndicator);
    div.appendChild(statsElement);
    remoteVideosRef.current[id] = div;

    const container = document.getElementById("remote-videos");
    if (container) container.appendChild(div);
    
    // Update UI elements periodically
    const updateUIElements = () => {
      if (!isMountedRef.current) return;
      
      // Update speaking indicator
      const indicator = document.getElementById(`speaking-${id}`);
      if (indicator) {
        indicator.className = `absolute top-2 right-2 w-3 h-3 rounded-full ${
          activeSpeakers[id] ? 'bg-green-500' : 'bg-transparent'
        }`;
      }
      
      // Update stats
      const statsDisplay = document.getElementById(`stats-${id}`);
      if (statsDisplay && connectionStats[id]) {
        const { rtt, packetsLost } = connectionStats[id];
        statsDisplay.textContent = `${Math.round(rtt * 1000)}ms ${packetsLost > 0 ? '⚠️' : ''}`;
      }
      
      requestAnimationFrame(updateUIElements);
    };
    
    updateUIElements();
  }

  function removeRemote(id) {
    const el = remoteVideosRef.current[id];
    if (el) {
      el.remove();
      delete remoteVideosRef.current[id];
    }
    
    if (analysersRef.current[id]) {
      delete analysersRef.current[id];
    }
    
    if (peerConnectionsRef.current[id]) {
      delete peerConnectionsRef.current[id];
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

    if (!emoji || typeof emoji !== "string" || emoji.length > 10) {
      alert("Invalid emoji selected");
      return;
    }

    try {
      const { error: profileError } = await supabase
        .from("profiles")
        .upsert({ id: user.id, email: user.email }, { onConflict: "id" });

      if (profileError) throw profileError;

      const { error } = await supabase.from("reactions").insert({
        room_id: roomId,
        user_id: user.id,
        emoji,
        created_at: new Date().toISOString(),
      });

      if (error) throw error;

      await supabase.from("messages").insert({
        room_id: roomId,
        sender: "System",
        text: `${user.email} reacted with ${emoji}`,
        created_at: new Date().toISOString(),
      });

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

      if (permitToJoin && peerRef.current?.id) {
        const { data: signal } = await supabase
          .from("signals")
          .select("peer_id")
          .eq("room_id", roomId)
          .eq("user_id", uid)
          .single();

        if (signal?.peer_id) {
          connectToPeer(signal.peer_id);
        }
      }
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
      
      navigate("/");
    } catch (err) {
      console.warn("Leave room error:", err);
      navigate("/");
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
        participantsChannel
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

  // Enhanced room initialization with better error recovery
  const initRoom = useCallback(async () => {
    if (isInitialized || !isMountedRef.current) return;

    try {
      console.log("Initializing room...");
      setIsInitialized(true);

      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth?.user) throw new Error("Not authenticated");

      await ensureProfileExists(auth.user.id);
      setUser(auth.user);

      // Retry meeting fetch with exponential backoff
      let mt;
      let retries = 0;
      while (retries < 3) {
        try {
          const { data, error } = await supabase
            .from("meetings")
            .select("*")
            .eq("room_id", roomId)
            .maybeSingle();
          
          if (error) throw error;
          if (!data) throw new Error("Meeting not found");
          
          mt = data;
          break;
        } catch (err) {
          retries++;
          if (retries >= 3) throw err;
          await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        }
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
          setupParticipantsListener(mt.id);
        } catch (err) {
          console.error("Host setup error:", err);
          // Attempt recovery
          setTimeout(() => initRoom(), 3000);
        }
      } else {
        console.log("Checking participant status...");
        let existing;
        try {
          const { data } = await supabase
            .from("participants")
            .select("status")
            .eq("meeting_id", mt.id)
            .eq("user_id", auth.user.id)
            .maybeSingle();
          existing = data;
        } catch (err) {
          console.error("Error checking participant status:", err);
          // Retry after delay
          setTimeout(() => initRoom(), 2000);
          return;
        }

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
            setupParticipantsListener(mt.id);
          } catch (err) {
            console.error("Approved participant setup error:", err);
            // Attempt recovery
            setTimeout(() => initRoom(), 3000);
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
        // Retry initialization after delay
        setTimeout(() => initRoom(), 5000);
      }
    }
  }, [inputPasscode, navigate, roomId, search]);

  // Enhanced joinMeeting function with better connection handling
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
          // Update participant names with our own info
          setParticipantNames(prev => ({
            ...prev,
            [pid]: user?.email || pid.substring(0, 8)
          }));

          // Upsert our signal with retry logic
          let attempts = 0;
          const maxAttempts = 3;
          
          while (attempts < maxAttempts) {
            try {
              const { error } = await supabase.from("signals").upsert(
                {
                  room_id: roomId,
                  peer_id: pid,
                  user_id: userId,
                  last_active: new Date().toISOString(),
                },
                {
                  onConflict: "room_id,peer_id",
                  ignoreDuplicates: false,
                }
              );

              if (error) throw error;
              break; // Success, exit retry loop
            } catch (err) {
              attempts++;
              if (attempts >= maxAttempts) throw err;
              await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
            }
          }

          // Connect to all existing participants with parallel connections
          const { data: others, error: fetchError } = await supabase
            .from("signals")
            .select("*")
            .eq("room_id", roomId)
            .neq("peer_id", pid)
            .order("last_active", { ascending: false });

          if (fetchError) throw fetchError;

          if (others && others.length > 0) {
            console.log(`Connecting to ${others.length} existing participants`);
            // Use Promise.all to connect in parallel but limit concurrency
            const MAX_CONCURRENT_CONNECTIONS = 3;
            const connectionGroups = [];
            
            for (let i = 0; i < others.length; i += MAX_CONCURRENT_CONNECTIONS) {
              connectionGroups.push(others.slice(i, i + MAX_CONCURRENT_CONNECTIONS));
            }
            
            for (const group of connectionGroups) {
              await Promise.all(group.map(o => connectToPeer(o.peer_id)));
            }
          }

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
                      // Only connect if we don't already have a connection
                      if (!peerConnectionsRef.current[payload.new.peer_id]) {
                        connectToPeer(payload.new.peer_id);
                      }
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
            new MediaStream([
              ...screenStreamRef.current.getVideoTracks(),
              ...localStreamRef.current.getAudioTracks()
            ]) : 
            localStreamRef.current;
            
          call.answer(streamToAnswerWith);
          peerConnectionsRef.current[call.peer] = call;
          setupCall(call, call.peer);
        } catch (err) {
          console.error("Error answering call:", err);
          setTimeout(() => {
            if (localStreamRef.current) {
              call.answer(localStreamRef.current);
              peerConnectionsRef.current[call.peer] = call;
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
      // Attempt recovery
      setTimeout(() => joinMeeting(meetingId, userId), 5000);
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
      
      // Clean up audio context
      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }
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
              className="w-full h-64 object-cover"
            />
            <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-sm">
              {user?.email || "You"}
              {isMuted ? " 🔇" : " 🔊"}
              {!cameraOn ? " 📷❌" : " 📷"}
              {isScreenSharing && " 🖥️"}
              {activeSpeakers['local'] && " 🗣️"}
            </div>
            <div className={`absolute top-2 right-2 w-3 h-3 rounded-full ${
              activeSpeakers['local'] ? 'bg-green-500' : 'bg-transparent'
            }`}></div>
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
          <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${
              connectionStatus === 'Connected' ? 'bg-green-500' : 
              connectionStatus.includes('Error') ? 'bg-red-500' : 'bg-yellow-500'
            }`}></div>
            <span className="text-sm">{connectionStatus}</span>
          </div>
        </div>

        {/* Sidebar */}
        <div className="space-y-4">
          {/* Participants list */}
          {permitToJoin && (
            <div className="bg-white border rounded-lg p-3">
              <h3 className="font-bold mb-2">👥 Participants ({participants.length})</h3>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {participants.map((participantId) => (
                  <div key={participantId} className="flex items-center p-2 bg-gray-50 rounded">
                    <span className="text-sm truncate">
                      {participantNames[participantId] || participantId.substring(0, 8)}
                    </span>
                    {participantId === user?.id && (
                      <span className="ml-2 text-xs text-gray-500">(You)</span>
                    )}
                    {activeSpeakers[participantId] && (
                      <span className="ml-2 w-2 h-2 rounded-full bg-green-500"></span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Waiting list (host only) */}
          {isHost && waitingList.length > 0 && (
            <div className="bg-white border rounded-lg p-3">
              <h3 className="font-bold mb-2">👥 Waiting Room ({waitingList.length})</h3>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {waitingList.map((req) => (
                  <div key={req.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                    <span className="text-sm truncate">{req.profiles?.email || req.user_id}</span>
                    <div className="flex gap-1">
                      <button
                        onClick={() => approveUser(req.user_id)}
                        className="p-1 bg-green-500 text-white rounded hover:bg-green-600"
                        title="Approve"
                      >
                        ✓ Admit
                      </button>
                      <button
                        onClick={() => denyUser(req.user_id)}
                        className="p-1 bg-red-500 text-white rounded hover:bg-red-600"
                        title="Deny"
                      >
                        ✗ Deny
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
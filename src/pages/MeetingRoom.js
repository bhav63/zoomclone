import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import Peer from "peerjs";
import RecordRTC from "recordrtc";
import { supabase } from "../supabaseClient";

// Utility function to get a stable peer ID for reconnections
const getStablePeerId = (userId) => {
  const storedId = sessionStorage.getItem(`peerId-${userId}`);
  if (storedId) return storedId;

  const newId = `peer-${userId}-${Math.random().toString(36).substr(2, 9)}`;
  sessionStorage.setItem(`peerId-${userId}`, newId);
  return newId;
};

// Auto-refresh interval in milliseconds
const AUTO_REFRESH_INTERVAL = 1000;

export default function MeetingRoom(){  // State declarations
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
  const [showRecordingAlert, setShowRecordingAlert] = useState(false);
  const [recordingAlertMessage, setRecordingAlertMessage] = useState("");
  const [autoReconnectAttempts, setAutoReconnectAttempts] = useState(0);
  const [isMobile, setIsMobile] = useState(false);
  const [reconnectionState, setReconnectionState] = useState({
    isReconnecting: false,
    attempts: 0,
  });
  const [lastRefreshTime, setLastRefreshTime] = useState(Date.now());

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
  const recordingTimerRef = useRef();
  const reconnectTimerRef = useRef();
  const participantUpdateTimeoutRef = useRef();
  const pendingPeerConnections = useRef(new Set());
  const activePeerConnections = useRef(new Set());
  const screenShareContainerRef = useRef(null);
  const autoRefreshIntervalRef = useRef();

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

  // Auto-refresh function
  const refreshMeetingState = useCallback(async () => {
    if (!isMountedRef.current || !meetingDbId || !user?.id) return;

    try {
      setLastRefreshTime(Date.now());

      // Refresh participants list
      if (permitToJoin) {
        await updateParticipants(meetingDbId);
      }

      // Refresh waiting list if host
      if (isHost) {
        await updateWaitingList(meetingDbId);
      }

      // Refresh peer connections
      if (peerRef.current?.id) {
        const { data: others } = await supabase
          .from("signals")
          .select("peer_id, user_id")
          .eq("room_id", roomId)
          .neq("peer_id", peerRef.current.id);

        if (others?.length > 0) {
          others.forEach(({ peer_id }) => {
            if (!peerConnectionsRef.current[peer_id] && !pendingPeerConnections.current.has(peer_id)) {
              connectToPeer(peer_id);
            }
          });
        }
      }

      // Update connection status
      if (peerRef.current) {
        if (peerRef.current.disconnected) {
          setConnectionStatus("Reconnecting...");
          peerRef.current.reconnect();
        } else if (peerRef.current.open) {
          setConnectionStatus("Connected");
        }
      }
    } catch (error) {
      console.error("Auto-refresh error:", error);
    }
  }, [meetingDbId, user?.id, permitToJoin, isHost, roomId]);

  // Setup auto-refresh interval
  useEffect(() => {
    if (permitToJoin && !autoRefreshIntervalRef.current) {
      autoRefreshIntervalRef.current = setInterval(() => {
        refreshMeetingState();
      }, AUTO_REFRESH_INTERVAL);
    }

    return () => {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
      }
    };
  }, [permitToJoin, refreshMeetingState]);

  // Check if mobile device
  useEffect(() => {
    const checkIfMobile = () => {
      const isMobileDevice =
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
          navigator.userAgent
        );
      setIsMobile(isMobileDevice);
    };
    checkIfMobile();
  }, []);

  // Helper functions
  const ensureProfileExists = async (userId) => {
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (authError) throw authError;

    const { error } = await supabase
      .from("profiles")
      .upsert({ id: userId, email: user.email }, { onConflict: "id" });

    if (error) throw error;
  };

  const createPendingRequest = async (meetingId, userId) => {
    try {
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
      setWaitingForApproval(true);
    } catch (error) {
      console.error("Error in createPendingRequest:", error);
      alert("Failed to create join request. Please try again.");
    }
  };

  const setupWaitingListener = (mtId) => {
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
            updateWaitingList(mtId);
          }
        )
        .subscribe();
    }
  };

  const setupParticipantListener = (mtId, uid) => {
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
            if (payload.new.status === "approved") {
              setWaitingForApproval(false);
              setPermitToJoin(true);
              try {
                await requestMediaPermissions();
                await joinMeeting(mtId, uid);

                if (peerRef.current?.id) {
                  const { data: others } = await supabase
                    .from("signals")
                    .select("peer_id, user_id")
                    .eq("room_id", roomId)
                    .neq("peer_id", peerRef.current.id);

                  if (others?.length > 0) {
                    await Promise.all(
                      others.map(({ peer_id }) => connectToPeer(peer_id))
                    );

                    // Update last_active to trigger connection from others
                    await supabase
                      .from("signals")
                      .update({ last_active: new Date().toISOString() })
                      .eq("room_id", roomId)
                      .eq("peer_id", peerRef.current.id);
                  }
                }
              } catch (err) {
                console.error("Error joining after approval:", err);
              }
            } else if (payload.new.status === "denied") {
              setWaitingForApproval(false);
              navigate("/");
            }
          }
        )
        .subscribe();
    }
  };

  const updateParticipants = async (mtId) => {
    try {
      const { data } = await supabase
        .from("participants")
        .select("user_id, profiles:user_id(email)")
        .eq("meeting_id", mtId)
        .eq("status", "approved");

      if (data) {
        setParticipants(data.map((p) => p.user_id));

        const names = {};
        data.forEach((p) => {
          names[p.user_id] = p.profiles?.email || p.user_id;
        });
        setParticipantNames(names);

        Object.keys(remoteVideosRef.current).forEach((peerId) => {
          const label =
            remoteVideosRef.current[peerId]?.querySelector(
              ".participant-label"
            );
          if (label) {
            label.textContent = names[peerId] || peerId;
          }
        });
      }
    } catch (error) {
      console.error("Error updating participants:", error);
    }
  };

  const updateWaitingList = async (mtId) => {
    try {
      const { data } = await supabase
        .from("participants")
        .select("id, user_id, status, profiles:user_id(email), created_at")
        .eq("meeting_id", mtId)
        .eq("status", "pending")
        .order("created_at", { ascending: true });

      setWaitingList(data || []);
    } catch (error) {
      console.error("Error in updateWaitingList:", error);
    }
  };

  const requestMediaPermissions = async () => {
    if (localStreamRef.current) return localStreamRef.current;

    try {
      const constraints = {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: {
          width: { ideal: isMobile ? 640 : 1280 },
          height: { ideal: isMobile ? 480 : 720 },
          frameRate: { ideal: isMobile ? 15 : 30 },
          facingMode: isMobile ? "user" : "environment",
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        // Mirror video for front-facing camera on mobile
        if (isMobile) {
          localVideoRef.current.style.transform = "scaleX(-1)";
        }
      }

      stream.getAudioTracks().forEach((track) => (track.enabled = !isMuted));
      stream.getVideoTracks().forEach((track) => (track.enabled = cameraOn));

      setMediaPermissionGranted(true);
      setupAudioContext(stream);

      return stream;
    } catch (err) {
      console.error("Media permission error:", err);
      try {
        const fallbackConstraints = {
          audio: true,
          video: {
            width: { min: 320, ideal: 640, max: 1280 },
            height: { min: 240, ideal: 480, max: 720 },
            frameRate: { ideal: 15 },
          },
        };

        const fallbackStream = await navigator.mediaDevices.getUserMedia(
          isMobile ? { audio: true, video: true } : fallbackConstraints
        );

        localStreamRef.current = fallbackStream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = fallbackStream;
          if (isMobile) {
            localVideoRef.current.style.transform = "scaleX(-1)";
          }
        }

        setMediaPermissionGranted(true);
        return fallbackStream;
      } catch (fallbackError) {
        console.error("Fallback media error:", fallbackError);
        // Handle cases where only audio is available
        try {
          const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          localStreamRef.current = audioOnlyStream;
          setMediaPermissionGranted(true);
          return audioOnlyStream;
        } catch (audioError) {
          console.error("Audio only fallback failed:", audioError);
          throw audioError;
        }
      }
    }
  };

  const setupAudioContext = (stream) => {
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

      analysersRef.current["local"] = analyser;
      analyzeAudio();
    } catch (err) {
      console.error("Audio context setup error:", err);
    }
  };

  const analyzeAudio = () => {
    if (!isMountedRef.current) return;

    const bufferLength = analysersRef.current["local"]?.frequencyBinCount || 0;
    const dataArray = new Uint8Array(bufferLength);
    const newActiveSpeakers = { ...activeSpeakers };

    if (analysersRef.current["local"]) {
      analysersRef.current["local"].getByteFrequencyData(dataArray);
      const volume = Math.max(...dataArray);
      newActiveSpeakers["local"] = volume > 30;
    }

    Object.keys(analysersRef.current).forEach((peerId) => {
      if (peerId !== "local") {
        analysersRef.current[peerId].getByteFrequencyData(dataArray);
        const volume = Math.max(...dataArray);
        newActiveSpeakers[peerId] = volume > 30;
      }
    });

    setActiveSpeakers(newActiveSpeakers);
    requestAnimationFrame(analyzeAudio);
  };

  const toggleScreenShare = async () => {
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
    } catch {
      alert("Screen share failed.");
    }

  };

  const updateAllPeerConnections = (stream) => {
    if (!peerRef.current || !stream) return;

    Object.keys(peerRef.current.connections).forEach((peerId) => {
      peerRef.current.connections[peerId].forEach((connection) => {
        if (connection.peerConnection?.getSenders) {
          const senders = connection.peerConnection.getSenders();
          const videoTrack = stream.getVideoTracks()[0];
          const audioTrack = stream.getAudioTracks()[0];

          senders.forEach((sender) => {
            if (sender.track.kind === "video" && videoTrack) {
              sender.replaceTrack(videoTrack).catch(console.error);
            } else if (sender.track.kind === "audio" && audioTrack) {
              sender.replaceTrack(audioTrack).catch(console.error);
            }
          });
        }
      });
    });
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTracks = localStreamRef.current.getAudioTracks();
      const newMuteState = !isMuted;
      audioTracks.forEach((track) => {
        track.enabled = !newMuteState;
      });
      setIsMuted(newMuteState);
    }
  };

  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTracks = localStreamRef.current.getVideoTracks();
      const newCameraState = !cameraOn;
      videoTracks.forEach((track) => {
        track.enabled = newCameraState;
      });
      setCameraOn(newCameraState);
    }
  };

  const startRecording = async () => {
    if (!localStreamRef.current) {
      alert("Please join the meeting first to start recording.");
      return;
    }
    try {
      const combinedStream = new MediaStream();

      const videoSource =
        isScreenSharing && screenStreamRef.current
          ? screenStreamRef.current.getVideoTracks()[0]
          : localStreamRef.current.getVideoTracks()[0];

      const audioSource = localStreamRef.current.getAudioTracks()[0];

      if (videoSource) combinedStream.addTrack(videoSource);
      if (audioSource) combinedStream.addTrack(audioSource);

      const recorder = new RecordRTC(combinedStream, {
        type: "video",
        mimeType: "video/webm;codecs=vp9",
        bitsPerSecond: 1280000,
        videoBitsPerSecond: 1000000,
        audioBitsPerSecond: 128000,
      });

      recorder.startRecording();
      recorderRef.current = recorder;
      setIsRecording(true);

      setRecordingAlertMessage("Recording started");
      setShowRecordingAlert(true);
      setTimeout(() => setShowRecordingAlert(false), 3000);

      let seconds = 0;
      recordingTimerRef.current = setInterval(() => {
        seconds++;
        setRecordingAlertMessage(`Recording (${formatTime(seconds)})`);
      }, 1000);
    } catch (err) {
      console.error("Recording start error:", err);
      alert("Failed to start recording.");
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const stopRecording = async () => {
    if (!recorderRef.current) return;
    try {
      clearInterval(recordingTimerRef.current);

      await new Promise((resolve) => {
        recorderRef.current.stopRecording(resolve);
      });

      const blob = recorderRef.current.getBlob();
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `recording-${roomId}-${timestamp}.webm`;

      const { data, error } = await supabase.storage
        .from("recordings")
        .upload(`public/${filename}`, blob, {
          contentType: "video/webm",
          upsert: false,
        });

      if (error) throw error;

      const {
        data: { publicUrl },
      } = supabase.storage
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
        created_at: new Date().toISOString(),
      });

      setIsRecording(false);
      recorderRef.current = null;

      setRecordingAlertMessage("Recording saved successfully");
      setShowRecordingAlert(true);
      setTimeout(() => setShowRecordingAlert(false), 3000);
    } catch (err) {
      console.error("Recording stop error:", err);
      setIsRecording(false);
      recorderRef.current = null;
      setRecordingAlertMessage("Failed to save recording");
      setShowRecordingAlert(true);
      setTimeout(() => setShowRecordingAlert(false), 3000);
    }
  };

  const createPeer = (userId) => {
    const peerId = getStablePeerId(userId);
    const peer = new Peer(peerId, {
      debug: 3,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun1.l.google.com:19302" },
          { urls: "stun:stun2.l.google.com:19302" },
          {
            urls: "turn:global.turn.twilio.com:3478?transport=udp",
            username: "your-twilio-username",
            credential: "your-twilio-credential",
          },
        ],
        iceTransportPolicy: "all",
        iceCandidatePoolSize: 5,
        rtcpMuxPolicy: "require",
        bundlePolicy: "max-bundle",
        sdpSemantics: "unified-plan",
      },
      reconnectTimer: 5000,
    });

    peer.on("error", (err) => {
      console.error("PeerJS error:", err);
      setConnectionStatus(`Error: ${err.type}`);

      if (err.type === "peer-unavailable") {
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
          }
        }, 2000);
      } else if (err.type === "socket-error") {
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
          }
        }, 2000);
      } else if (err.type === "network") {
        setTimeout(() => {
          if (isMountedRef.current && peerRef.current?.disconnected) {
            peerRef.current.reconnect();
          }
        }, 3000);
      }
    });

    peer.on("iceConnectionStateChange", (state) => {
      setConnectionStatus(state.charAt(0).toUpperCase() + state.slice(1));

      if (state === "failed" || state === "disconnected") {
        setTimeout(() => {
          if (isMountedRef.current) {
            reconnectPeers();
          }
        }, 2000);
      }
    });

    peer.on("connectionStateChange", (state) => {
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
    if (!peerRef.current?.id || reconnectionState.isReconnecting) return;

    try {
      setReconnectionState({ isReconnecting: true, attempts: 0 });

      const { data: others } = await supabase
        .from("signals")
        .select("peer_id, user_id")
        .eq("room_id", roomId)
        .neq("peer_id", peerRef.current.id);

      if (others?.length > 0) {
        const MAX_CONCURRENT_CONNECTIONS = 3;
        const connectionGroups = [];

        for (let i = 0; i < others.length; i += MAX_CONCURRENT_CONNECTIONS) {
          connectionGroups.push(
            others.slice(i, i + MAX_CONCURRENT_CONNECTIONS)
          );
        }

        for (const group of connectionGroups) {
          await Promise.all(group.map((o) => connectToPeer(o.peer_id)));
        }
      }

      setReconnectionState({ isReconnecting: false, attempts: 0 });
    } catch (error) {
      console.error("Reconnection error:", error);
      const nextAttempt = reconnectionState.attempts + 1;
      if (nextAttempt <= 5) {
        setTimeout(() => {
          reconnectPeers();
        }, Math.min(5000, 1000 * nextAttempt));
        setReconnectionState({ isReconnecting: true, attempts: nextAttempt });
      } else {
        setReconnectionState({ isReconnecting: false, attempts: 0 });
      }
    }
  };

  const connectToPeer = async (peerId) => {
    if (!peerRef.current || !localStreamRef.current) return;

    if (pendingPeerConnections.current.has(peerId)) return;

    pendingPeerConnections.current.add(peerId);

    try {
      if (peerConnectionsRef.current[peerId]) {
        const existingConnection = peerConnectionsRef.current[peerId];
        if (existingConnection.open) {
          pendingPeerConnections.current.delete(peerId);
          return;
        }
      }

      if (!retryCountsRef.current[peerId]) {
        retryCountsRef.current[peerId] = 0;
      }

      if (retryCountsRef.current[peerId] >= 5) {
        pendingPeerConnections.current.delete(peerId);
        return;
      }

      const streamToSend =
        isScreenSharing && screenStreamRef.current
          ? new MediaStream([
              ...screenStreamRef.current.getVideoTracks(),
              ...localStreamRef.current.getAudioTracks(),
            ])
          : localStreamRef.current;

      const call = peerRef.current.call(peerId, streamToSend);
      peerConnectionsRef.current[peerId] = call;
      activePeerConnections.current.add(peerId);
      setupCall(call, peerId);

      retryCountsRef.current[peerId] = 0;
    } catch (err) {
      console.error(`Connection attempt failed to ${peerId}:`, err);
      retryCountsRef.current[peerId] += 1;
      delete peerConnectionsRef.current[peerId];
      activePeerConnections.current.delete(peerId);

      const delay = Math.min(
        1000 * Math.pow(2, retryCountsRef.current[peerId]),
        8000
      );
      setTimeout(() => connectToPeer(peerId), delay);
    } finally {
      pendingPeerConnections.current.delete(peerId);
    }
  };

  const setupCall = (call, peerId) => {
    call.on("stream", (remoteStream) => {
      if (!audioContextRef.current) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new AudioContext();
      }

      const analyser = audioContextRef.current.createAnalyser();
      analyser.fftSize = 512;
      const source =
        audioContextRef.current.createMediaStreamSource(remoteStream);
      source.connect(analyser);
      analysersRef.current[peerId] = analyser;

      addRemote(peerId, remoteStream);
      setConnectionStatus("Connected");
      setAutoReconnectAttempts(0);

      if (!statsIntervalRef.current) {
        startConnectionStats();
      }
    });

    call.on("close", () => {
      removeRemote(peerId);
      delete peerConnectionsRef.current[peerId];
      activePeerConnections.current.delete(peerId);
      setConnectionStatus("Disconnected");
      delete analysersRef.current[peerId];
    });

    call.on("error", (err) => {
      console.error("Call error with", peerId, ":", err);
      removeRemote(peerId);
      delete peerConnectionsRef.current[peerId];
      activePeerConnections.current.delete(peerId);
      setConnectionStatus("Error: " + err.message);
      delete analysersRef.current[peerId];
    });

    call.on("iceStateChanged", (state) => {
      if (state === "disconnected" || state === "failed") {
        setTimeout(() => connectToPeer(peerId), 2000);
      }
    });
  };

  const startConnectionStats = () => {
    if (statsIntervalRef.current) return;

    statsIntervalRef.current = setInterval(() => {
      if (!peerRef.current) return;

      const stats = {};

      Object.entries(peerConnectionsRef.current).forEach(([peerId, call]) => {
        if (call.peerConnection) {
          call.peerConnection
            .getStats()
            .then((results) => {
              results.forEach((report) => {
                if (
                  report.type === "candidate-pair" &&
                  report.state === "succeeded"
                ) {
                  stats[peerId] = {
                    rtt: report.currentRoundTripTime,
                    packetsLost: report.packetsLost,
                    bytesSent: report.bytesSent,
                    bytesReceived: report.bytesReceived,
                  };
                }
              });
              setConnectionStats(stats);
            })
            .catch(console.error);
        }
      });
    }, 5000);
  };

  const addRemote = (id, stream) => {
    if (remoteVideosRef.current[id]) return;

    const div = document.createElement("div");
    div.className = "relative bg-black rounded-lg overflow-hidden";
    div.id = `remote-${id}`;

    const vid = document.createElement("video");
    vid.srcObject = stream;
    vid.autoplay = true;
    vid.playsInline = true;
    vid.className = "w-full h-full object-cover";

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
      "participant-label absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded";
    label.textContent = participantNames[id] || id;

    const speakingIndicator = document.createElement("div");
    speakingIndicator.className =
      "absolute top-2 right-2 w-3 h-3 rounded-full bg-transparent";
    speakingIndicator.id = `speaking-${id}`;

    const statsElement = document.createElement("div");
    statsElement.className =
      "absolute top-2 left-2 bg-black bg-opacity-50 text-white text-xs px-1 rounded";
    statsElement.id = `stats-${id}`;

    div.appendChild(vid);
    div.appendChild(label);
    div.appendChild(speakingIndicator);
    div.appendChild(statsElement);
    remoteVideosRef.current[id] = div;

    const container = document.getElementById("remote-videos");
    if (container) container.appendChild(div);

    const updateUIElements = () => {
      if (!isMountedRef.current) return;

      const indicator = document.getElementById(`speaking-${id}`);
      if (indicator) {
        indicator.className = `absolute top-2 right-2 w-3 h-3 rounded-full ${
          activeSpeakers[id] ? "bg-green-500" : "bg-transparent"
        }`;
      }

      const statsDisplay = document.getElementById(`stats-${id}`);
      if (statsDisplay && connectionStats[id]) {
        const { rtt, packetsLost } = connectionStats[id];
        statsDisplay.textContent = `${Math.round(rtt * 1000)}ms ${
          packetsLost > 0 ? "⚠️" : ""
        }`;
      }

      requestAnimationFrame(updateUIElements);
    };

    updateUIElements();
  };

  const removeRemote = (id) => {
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
  };

  const loadMessagesAndReactions = async () => {
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

      const { data: oldReacts } = await supabase
        .from("reactions")
        .select("*")
        .eq("room_id", roomId)
        .order("created_at", { ascending: true });

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
  };

  const sendMessage = async () => {
  if (!chatInput.trim() || !user?.email) return;

  const tempId = Date.now().toString();
  const newMessage = {
    id: tempId,
    room_id: roomId,
    sender: user.email,
    text: chatInput,
    created_at: new Date().toISOString(),
  };

  setMessages((prev) => [...prev, newMessage]);
  setChatInput("");

  try {
    const { error } = await supabase.from("messages").insert({
      room_id: roomId,
      sender: user.email,
      text: chatInput,
      created_at: new Date().toISOString(),
    });

    if (error) {
      setMessages((prev) => prev.filter((msg) => msg.id !== tempId));
      throw error;
    }
  } catch (error) {
    console.error("Error sending message:", error);
    alert("Failed to send message. Please try again.");
  }
};

  const sendReaction = async (emoji) => {
    if (!user?.id || !roomId) return;
    if (!emoji || typeof emoji !== "string" || emoji.length > 10) return;

    const tempId = Date.now().toString();
    const newReaction = {
      id: tempId,
      room_id: roomId,
      user_id: user.id,
      emoji,
      created_at: new Date().toISOString(),
    };

    setReactions((prev) => [...prev, newReaction]);

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

      if (error) {
        setReactions((prev) => prev.filter((r) => r.id !== tempId));
        throw error;
      }

      // Add system message for reaction
      const { error: messageError } = await supabase.from("messages").insert({
        room_id: roomId,
        sender: "System",
        text: `${user.email} reacted with ${emoji}`,
        created_at: new Date().toISOString(),
      });

      if (messageError) throw messageError;

      // Update messages list to show the reaction
      const newSystemMessage = {
        id: `sys-${Date.now()}`,
        room_id: roomId,
        sender: "System",
        text: `${user.email} reacted with ${emoji}`,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, newSystemMessage]);
    } catch (error) {
      console.error("Error sending reaction:", error);
      if (error.code === "23503") {
        alert("Your account isn't properly set up. Please refresh the page.");
      } else {
        alert(`Failed to send reaction: ${error.message}`);
      }
    }
  };

  const approveUser = async (uid) => {
    try {
      // First update the participant status
      const { error: updateError } = await supabase
        .from("participants")
        .update({
          status: "approved",
          updated_at: new Date().toISOString(),
        })
        .eq("meeting_id", meetingDbId)
        .eq("user_id", uid);

      if (updateError) throw updateError;

      // Get the newly approved user's peer ID
      const { data: signal } = await supabase
        .from("signals")
        .select("peer_id")
        .eq("room_id", roomId)
        .eq("user_id", uid)
        .single();

      if (signal?.peer_id) {
        // Connect to the newly approved user
        await connectToPeer(signal.peer_id);

        // Notify all other participants to connect to the new user
        const { data: otherParticipants } = await supabase
          .from("signals")
          .select("peer_id")
          .eq("room_id", roomId)
          .neq("peer_id", signal.peer_id);

        if (otherParticipants?.length > 0) {
          await Promise.all(
            otherParticipants.map(async (p) => {
              try {
                await supabase
                  .from("signals")
                  .update({ last_active: new Date().toISOString() })
                  .eq("room_id", roomId)
                  .eq("peer_id", p.peer_id);
              } catch (err) {
                console.error("Error notifying participant:", err);
              }
            })
          );
        }
      }

      // Update the participants list
      await updateParticipants(meetingDbId);
    } catch (error) {
      console.error("Error approving user:", error);
      alert("Failed to approve user. Please try again.");
    }
  };

  const denyUser = async (uid) => {
    try {
      const { error } = await supabase
        .from("participants")
        .update({
          status: "denied",
          updated_at: new Date().toISOString(),
        })
        .eq("meeting_id", meetingDbId)
        .eq("user_id", uid);

      if (error) throw error;
    } catch (error) {
      console.error("Error denying user:", error);
      alert("Failed to deny user. Please try again.");
    }
  };

  const leaveRoom = async () => {
    if (!isMountedRef.current) return;

    try {
      if (isRecording) await stopRecording();

      if (isScreenSharing && screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => track.stop());
        screenStreamRef.current = null;
        setIsScreenSharing(false);
      }

      if (screenShareContainerRef.current) {
        screenShareContainerRef.current.remove();
        screenShareContainerRef.current = null;
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

      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (participantUpdateTimeoutRef.current) {
        clearTimeout(participantUpdateTimeoutRef.current);
        participantUpdateTimeoutRef.current = null;
      }

      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current);
        autoRefreshIntervalRef.current = null;
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
  };

  const cleanupSubscriptions = async () => {
    try {
      const channels = [
        signalsChannel,
        waitingChannel,
        participantListener,
        messagesChannel,
        reactionsChannel,
        participantsChannel,
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
  };

  const initRoom = useCallback(async () => {
    if (isInitialized || !isMountedRef.current) return;

    try {
      setIsInitialized(true);

      const { data: auth, error: authError } = await supabase.auth.getUser();
      if (authError || !auth?.user) throw new Error("Not authenticated");

      await ensureProfileExists(auth.user.id);
      setUser(auth.user);

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
          await new Promise((resolve) => setTimeout(resolve, 1000 * retries));
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

      loadMessagesAndReactions();

      if (hostStatus) {
        setPermitToJoin(true);

        try {
          await requestMediaPermissions();
          await joinMeeting(mt.id, auth.user.id);
          setupWaitingListener(mt.id);
          setupParticipantsListener(mt.id);
        } catch (err) {
          console.error("Host setup error:", err);
          setTimeout(() => initRoom(), 3000);
        }
      } else {
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
          setTimeout(() => initRoom(), 2000);
          return;
        }

        if (!existing || existing.status === "pending") {
          setupParticipantListener(mt.id, auth.user.id);

          if (!existing) {
            await createPendingRequest(mt.id, auth.user.id);
          } else {
            setWaitingForApproval(true);
          }
        } else if (existing.status === "approved") {
          setPermitToJoin(true);
          try {
            await requestMediaPermissions();
            await joinMeeting(mt.id, auth.user.id);
            setupParticipantsListener(mt.id);
          } catch (err) {
            console.error("Approved participant setup error:", err);
            setTimeout(() => initRoom(), 3000);
          }
        } else if (existing.status === "denied") {
          navigate("/");
        }
      }
    } catch (error) {
      console.error("Init room error:", error);
      if (isMountedRef.current) {
        setIsInitialized(false);
        alert(error.message || "Failed to initialize room");
        setTimeout(() => initRoom(), 5000);
      }
    }
  }, [inputPasscode, navigate, roomId, search]);

  const joinMeeting = async (meetingId, userId) => {
    if (isJoining) return;
    setIsJoining(true);
    setConnectionStatus("Connecting...");

    try {
      const stream = await requestMediaPermissions();
      updateParticipants(meetingId);

      const peer = createPeer(userId);
      peerRef.current = peer;

      peer.on("open", async (pid) => {
        try {
          setParticipantNames((prev) => ({
            ...prev,
            [pid]: user?.email || pid,
          }));

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
              break;
            } catch (err) {
              attempts++;
              if (attempts >= maxAttempts) throw err;
              await new Promise((resolve) =>
                setTimeout(resolve, 1000 * attempts)
              );
            }
          }

          const { data: others } = await supabase
            .from("signals")
            .select("*")
            .eq("room_id", roomId)
            .neq("peer_id", pid)
            .order("last_active", { ascending: false });

          if (others?.length > 0) {
            const MAX_CONCURRENT_CONNECTIONS = 3;
            const connectionGroups = [];

            for (
              let i = 0;
              i < others.length;
              i += MAX_CONCURRENT_CONNECTIONS
            ) {
              connectionGroups.push(
                others.slice(i, i + MAX_CONCURRENT_CONNECTIONS)
              );
            }

            for (const group of connectionGroups) {
              await Promise.all(group.map((o) => connectToPeer(o.peer_id)));
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
                    if (
                      payload.eventType === "INSERT" ||
                      payload.eventType === "UPDATE"
                    ) {
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
                  setTimeout(() => {
                    if (signalsChannel.current) {
                      signalsChannel.current.subscribe();
                    }
                  }, 2000);
                }
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
        try {
          const streamToAnswerWith =
            isScreenSharing && screenStreamRef.current
              ? new MediaStream([
                  ...screenStreamRef.current.getVideoTracks(),
                  ...localStreamRef.current.getAudioTracks(),
                ])
              : localStreamRef.current;

          call.answer(streamToAnswerWith);
          peerConnectionsRef.current[call.peer] = call;
          activePeerConnections.current.add(call.peer);
          setupCall(call, call.peer);
        } catch (err) {
          console.error("Error answering call:", err);
          setTimeout(() => {
            if (localStreamRef.current) {
              call.answer(localStreamRef.current);
              peerConnectionsRef.current[call.peer] = call;
              activePeerConnections.current.add(call.peer);
              setupCall(call, call.peer);
            }
          }, 1000);
        }
      });

      setIsJoining(false);
    } catch (err) {
      console.error("Join meeting error:", err);
      setIsJoining(false);
      setTimeout(() => joinMeeting(meetingId, userId), 5000);
    }
  };

  const setupParticipantsListener = (mtId) => {
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
            if (participantUpdateTimeoutRef.current) {
              clearTimeout(participantUpdateTimeoutRef.current);
            }
            participantUpdateTimeoutRef.current = setTimeout(() => {
              updateParticipants(mtId);
            }, 500);
          }
        )
        .subscribe();
    }
  };

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

      if (audioContextRef.current) {
        audioContextRef.current.close();
        audioContextRef.current = null;
      }

      if (screenShareContainerRef.current) {
        screenShareContainerRef.current.remove();
        screenShareContainerRef.current = null;
      }
    };
  }, [needPasscode, initRoom]);

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
    <div className="p-4 space-y-4 max-w-6xl mx-auto relative">
      {/* Recording Alert */}
      {showRecordingAlert && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-80 text-white px-4 py-2 rounded-lg z-50">
          {recordingAlertMessage}
        </div>
      )}

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
        <div className="lg:col-span-2 space-y-4">
          <div className="bg-black rounded-lg overflow-hidden relative aspect-video">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover"
            />
            <div className="absolute bottom-2 left-2 bg-black bg-opacity-50 text-white px-2 py-1 rounded text-sm">
              {user?.email || "You"}
              {isMuted ? " 🔇" : " 🔊"}
              {!cameraOn ? " 📷❌" : " 📷"}
              {isScreenSharing && " 🖥️"}
              {activeSpeakers["local"] && " 🗣️"}
            </div>
            <div
              className={`absolute top-2 right-2 w-3 h-3 rounded-full ${
                activeSpeakers["local"] ? "bg-green-500" : "bg-transparent"
              }`}
            ></div>
          </div>

          <div
            id="remote-videos"
            className="grid grid-cols-1 sm:grid-cols-2 gap-2"
          />

          <div className="flex flex-wrap gap-2 justify-center bg-gray-100 p-3 rounded-lg">
            <button
              onClick={toggleMute}
              className={`p-3 rounded-full flex items-center gap-2 ${
                isMuted ? "bg-red-500 text-white" : "bg-gray-300"
              } hover:bg-gray-400`}
              title={isMuted ? "Unmute" : "Mute"}
            >
              {isMuted ? "🔇" : "🔊"}
              <span className="text-sm hidden sm:inline">
                {isMuted ? "Unmute" : "Mute"}
              </span>
            </button>
            <button
              onClick={toggleCamera}
              className={`p-3 rounded-full flex items-center gap-2 ${
                cameraOn ? "bg-gray-300" : "bg-red-500 text-white"
              } hover:bg-gray-400`}
              title={cameraOn ? "Turn off camera" : "Turn on camera"}
            >
              {cameraOn ? "📷" : "📷❌"}
              <span className="text-sm hidden sm:inline">
                {cameraOn ? "Stop Video" : "Start Video"}
              </span>
            </button>
            {!isMobile && (
              <button
                onClick={toggleScreenShare}
                className={`p-3 rounded-full flex items-center gap-2 ${
                  isScreenSharing ? "bg-blue-500 text-white" : "bg-gray-300"
                } hover:bg-gray-400`}
                disabled={isMobile}
              >
                🖥️
                <span className="text-sm hidden sm:inline">
                  {isScreenSharing ? "Stop Share" : "Share Screen"}
                </span>
              </button>
            )}
            {isHost && (
              <button
                onClick={isRecording ? stopRecording : startRecording}
                className={`p-3 rounded-full flex items-center gap-2 ${
                  isRecording ? "bg-red-500 text-white" : "bg-gray-300"
                } hover:bg-gray-400`}
                title={isRecording ? "Stop recording" : "Start recording"}
              >
                {isRecording ? "⏹️" : "🔴"}
                <span className="text-sm hidden sm:inline">
                  {isRecording ? "Stop Recording" : "Record"}
                </span>
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

          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                connectionStatus === "Connected"
                  ? "bg-green-500"
                  : connectionStatus.includes("Error")
                  ? "bg-red-500"
                  : "bg-yellow-500"
              }`}
            ></div>
            <span className="text-sm">{connectionStatus}</span>
          </div>
        </div>

        <div className="space-y-4">
          {permitToJoin && (
            <div className="bg-white border rounded-lg p-3">
              <h3 className="font-bold mb-2">
                👥 Participants ({participants.length})
              </h3>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {participants.map((participantId) => (
                  <div
                    key={participantId}
                    className="flex items-center p-2 bg-gray-50 rounded"
                  >
                    <span className="text-sm truncate">
                      {participantNames[participantId] || participantId}
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

          {isHost && waitingList.length > 0 && (
            <div className="bg-white border rounded-lg p-3">
              <h3 className="font-bold mb-2">
                👥 Waiting Room ({waitingList.length})
              </h3>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {waitingList.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-center justify-between p-2 bg-gray-50 rounded"
                  >
                    <span className="text-sm truncate">
                      {req.profiles?.email || req.user_id}
                    </span>
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

          {waitingForApproval && (
            <div className="bg-yellow-100 border border-yellow-300 rounded-lg p-4">
              <p className="text-yellow-800">
                ⏳ Your request to join has been sent to the host. Please wait
                for approval...
              </p>
            </div>
          )}

          <div
            className={`bg-white border rounded-lg ${
              showChat ? "block" : "hidden"
            }`}
          >
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
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
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

          <div className="bg-white border rounded-lg p-3">
            <h3 className="font-bold mb-2">🎉 Reactions</h3>
            <div className="flex flex-wrap gap-2 mb-3">
              {["👍", "👎", "😄", "😕", "❤️", "🔥", "👏", "🎉"].map((emoji) => (
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
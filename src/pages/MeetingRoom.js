import React, { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import Peer from "peerjs";
import RecordRTC from "recordrtc";
import { supabase } from "../supabaseClient";

const getStablePeerId = (userId) => {
  const storedId = sessionStorage.getItem(`peerId-${userId}`);
  if (storedId) return storedId;

  const newId = `peer-${userId}-${Math.random().toString(36).substr(2, 9)}`;
  sessionStorage.setItem(`peerId-${userId}`, newId);
  return newId;
};

const AUTO_REFRESH_INTERVAL = 1000;

export default function MeetingRoom() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { search } = useLocation();

  const [user, setUser] = useState({ id: null, email: null });
  const [isHost, setIsHost] = useState(false);
  const [waitingList, setWaitingList] = useState([]);

  const [peerToUserIdMap, setPeerToUserIdMap] = useState({});
  
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
  const [isMobile, setIsMobile] = useState(false);
  const [reconnectionState, setReconnectionState] = useState({
    isReconnecting: false,
    attempts: 0,
  });

  const peerRef = useRef();
  const localStreamRef = useRef();
  const screenStreamRef = useRef();
  const recorderRef = useRef();
  const localVideoRef = useRef();
  const remoteVideosRef = useRef({});
  const autoRefreshIntervalRef = useRef();
  const isMountedRef = useRef(true);
  const retryCountsRef = useRef({});
  const audioContextRef = useRef();
  const analysersRef = useRef({});
  const peerConnectionsRef = useRef({});
  const statsIntervalRef = useRef();

  const recordingTimerRef = useRef();
  const participantUpdateTimeoutRef = useRef();
  const pendingPeerConnections = useRef(new Set());
  const activePeerConnections = useRef(new Set());
  const screenShareContainerRef = useRef(null);
  const waitingChannel = useRef();
  const participantListener = useRef();
  const signalsChannel = useRef();
  const messagesChannel = useRef();
  const reactionsChannel = useRef();
  const participantsChannel = useRef();
  const refreshInterval = useRef();
  const reconnectTimerRef = useRef();

  const BASE_URL = "https://zoomclone-v3.vercel.app";
  const shareLink = `${BASE_URL}/room/${roomId}${
    passcodeRequired ? `?passcode=${encodeURIComponent(inputPasscode)}` : ""
  }`;

  const refreshMeetingState = useCallback(async () => {
    if (!isMountedRef.current || !meetingDbId || !user?.id) return;

    try {
      if (permitToJoin) {
        await updateParticipants(meetingDbId);
      }

      if (isHost) {
        await updateWaitingList(meetingDbId);
      }

      if (peerRef.current?.id) {
        const { data: others } = await supabase
          .from("signals")
          .select("peer_id, user_id")
          .eq("room_id", roomId)
          .neq("peer_id", peerRef.current.id);

        if (others?.length > 0) {
          others.forEach(({ peer_id }) => {
            if (
              !peerConnectionsRef.current[peer_id] &&
              !pendingPeerConnections.current.has(peer_id)
            ) {
              connectToPeer(peer_id);
            }
          });
        }
      }

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

  useEffect(() => {
    const checkIfMobile = () => {
      setIsMobile(
        /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
          navigator.userAgent
        )
      );
    };
    checkIfMobile();
  }, []);

  useEffect(() => {
    if (!meetingDbId || !isHost) return;

    // Set up real-time listener for participant changes
    const participantListener = supabase
      .channel(`participant_changes:${meetingDbId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "participants",
          filter: `meeting_id=eq.${meetingDbId}`,
        },
        (payload) => {
          console.log("Participant change detected:", payload);
          updateWaitingList(meetingDbId);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(participantListener);
    };
  }, [meetingDbId, isHost]);

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

  const setupWaitingListener = useCallback((mtId) => {
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
  }, []);

  // In setupParticipantListener
  const setupParticipantListener = useCallback(
    (mtId, uid) => {
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
                  // Initialize media and peer connection if not already done
                  if (!localStreamRef.current) {
                    await requestMediaPermissions();
                  }

                  if (!peerRef.current) {
                    const peer = createPeer(user.id);
                    peerRef.current = peer;

                    peer.on("open", async (id) => {
                      await supabase.from("signals").upsert({
                        room_id: roomId,
                        peer_id: id,
                        user_id: user.id,
                        last_active: new Date().toISOString(),
                      });

                      // Connect to existing participants
                      const { data: others } = await supabase
                        .from("signals")
                        .select("peer_id")
                        .eq("room_id", roomId)
                        .neq("peer_id", id);

                      if (others?.length > 0) {
                        others.forEach(({ peer_id }) => connectToPeer(peer_id));
                      }
                    });

                    peer.on("call", (call) => {
                      call.answer(localStreamRef.current);
                      setupCall(call, call.peer);
                    });
                  }

                  // Force refresh of participants list
                  await updateParticipants(mtId);
                  setConnectionStatus("Connected to meeting");
                } catch (error) {
                  console.error("Approval handling error:", error);
                  setConnectionStatus("Connection failed - retrying...");
                  setTimeout(() => setupParticipantListener(mtId, uid), 3000);
                }
              }
            }
          )
          .subscribe();
      }
    },
    [roomId, user?.id]
  );

const updateParticipants = async (meetingId) => {
  try {
    // Get all approved participants with their user_ids
    const { data: participantsData, error: participantsError } = await supabase
      .from('participants')
      .select('user_id, status, email, display_name')
      .eq('meeting_id', meetingId)
      .eq('status', 'approved');

    if (participantsError) throw participantsError;

    // Get all active signals (peer connections)
    const { data: signalsData, error: signalsError } = await supabase
      .from('signals')
      .select('peer_id, user_id')
      .eq('room_id', roomId);

    if (signalsError) throw signalsError;

    if (participantsData && signalsData) {
      setParticipants(participantsData);

      // Get unique user IDs from participants and signals
      const participantUserIds = participantsData.map(p => p.user_id);
      const signalUserIds = signalsData.map(s => s.user_id);
      const allUserIds = [...new Set([...participantUserIds, ...signalUserIds])];

      // Fetch profile data for all users who might be missing emails
      const { data: profilesData, error: profilesError } = await supabase
        .from('profiles')
        .select('id, email, name')
        .in('id', allUserIds);

      if (profilesError) throw profilesError;

      // Create mapping of user_id to display info
      const userInfoMap = {};
      
      // First use participant data (which may have display_name)
      participantsData.forEach(p => {
        userInfoMap[p.user_id] = {
          email: p.email || null,
          displayName: p.display_name || null
        };
      });

      // Then supplement with profile data where needed
      profilesData.forEach(profile => {
        if (!userInfoMap[profile.id] || !userInfoMap[profile.id].email) {
          userInfoMap[profile.id] = {
            email: profile.email || null,
            displayName: profile.name || null
          };
        }
      });

      // Create mapping of peer_id to user_id
      const newPeerToUserIdMap = {};
      signalsData.forEach(s => {
        newPeerToUserIdMap[s.peer_id] = s.user_id;
      });
      setPeerToUserIdMap(newPeerToUserIdMap);

      // Create mapping of peer_id to display info
      const newParticipantNames = {};
      signalsData.forEach(s => {
        const userInfo = userInfoMap[s.user_id];
        if (userInfo) {
          // Prefer display_name from participants, then name from profiles, then email
          newParticipantNames[s.peer_id] = 
            userInfo.displayName || 
            userInfo.email || 
            `User ${s.user_id.slice(0, 4)}`;
        }
      });
      setParticipantNames(newParticipantNames);

      // Update any existing remote video labels
      Object.keys(remoteVideosRef.current).forEach(peerId => {
        const videoDiv = remoteVideosRef.current[peerId];
        if (videoDiv) {
          const label = videoDiv.querySelector('.participant-label');
          if (label && newParticipantNames[peerId]) {
            label.textContent = newParticipantNames[peerId];
          }
        }
      });
    }
  } catch (error) {
    console.error("Error updating participants:", error);
  }
};

  const updateWaitingList = async (meetingId) => {
    try {
      // Now we can query just the participants table since it contains emails
      const { data, error } = await supabase
        .from("participants")
        .select("id, user_id, email, status, created_at")
        .eq("meeting_id", meetingId)
        .eq("status", "pending")
        .order("created_at", { ascending: true });

      if (error) throw error;

      console.log("Waiting list data:", data);
      setWaitingList(data || []);
    } catch (error) {
      console.error("Error fetching waiting list:", error);
      setWaitingList([]);
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
          facingMode: "user", // Always use front camera by default
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.style.transform = "scaleX(-1)";
      }

      stream.getAudioTracks().forEach((track) => (track.enabled = !isMuted));
      stream.getVideoTracks().forEach((track) => (track.enabled = cameraOn));

      setupAudioContext(stream);
      return stream;
    } catch (err) {
      console.error("Media permission error:", err);
      try {
        const fallbackConstraints = {
          audio: true,
          video: isMobile ? { facingMode: "user" } : true,
        };

        const fallbackStream = await navigator.mediaDevices.getUserMedia(
          fallbackConstraints
        );
        localStreamRef.current = fallbackStream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = fallbackStream;
          localVideoRef.current.style.transform = "scaleX(-1)";
        }

        return fallbackStream;
      } catch (fallbackError) {
        console.error("Fallback media error:", fallbackError);
        try {
          const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          localStreamRef.current = audioOnlyStream;
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
      if (isScreenSharing && screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => track.stop());
        screenStreamRef.current = null;
        setIsScreenSharing(false);
        return;
      }

      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      screenStreamRef.current = screenStream;
      setIsScreenSharing(true);

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
        setIsScreenSharing(false);
        screenStreamRef.current = null;
      };
    } catch (err) {
      console.error("Screen share error:", err);
      setIsScreenSharing(false);
    }
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

  // Get display info for this participant
  const displayInfo = participantNames[id];
  if (displayInfo) {
    const label = document.createElement("div");
    label.className = 
      "participant-label absolute bottom-2 left-2 bg-black bg-opacity-50 text-white text-xs px-2 py-1 rounded";
    label.textContent = displayInfo;
    div.appendChild(label);
  }

  // Speaking indicator
  const speakingIndicator = document.createElement("div");
  speakingIndicator.className = 
    "absolute top-2 right-2 w-3 h-3 rounded-full bg-transparent";
  speakingIndicator.id = `speaking-${id}`;

  // Add elements to DOM
  div.appendChild(vid);
  div.appendChild(speakingIndicator);
  remoteVideosRef.current[id] = div;

  const container = document.getElementById("remote-videos");
  if (container) container.appendChild(div);

  // Update the UI periodically to reflect changes
  const updateLabel = () => {
    if (!isMountedRef.current) return;
    
    if (displayInfo) {
      const currentLabel = div.querySelector('.participant-label');
      if (currentLabel) {
        currentLabel.textContent = participantNames[id] || `User ${id.slice(-4)}`;
      }
    }
    
    const indicator = div.querySelector(`#speaking-${id}`);
    if (indicator) {
      indicator.className = `absolute top-2 right-2 w-3 h-3 rounded-full ${
        activeSpeakers[id] ? "bg-green-500" : "bg-transparent"
      }`;
    }
    
    requestAnimationFrame(updateLabel);
  };
  
  updateLabel();
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

      const { error: messageError } = await supabase.from("messages").insert({
        room_id: roomId,
        sender: "System",
        text: `${user.email} reacted with ${emoji}`,
        created_at: new Date().toISOString(),
      });

      if (messageError) throw messageError;

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
      // First get the user's email from profiles
      const { data: userProfile } = await supabase
        .from("profiles")
        .select("email")
        .eq("id", uid)
        .single();

      const { error: updateError } = await supabase
        .from("participants")
        .update({
          status: "approved",
          email: userProfile?.email, // Store the email in participants table
          updated_at: new Date().toISOString(),
        })
        .eq("meeting_id", meetingDbId)
        .eq("user_id", uid);

      if (updateError) throw updateError;

      // Rest of the approval logic...
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

  // Add this state
const [approvalCheckCount, setApprovalCheckCount] = useState(0);

// Enhanced approval handling
useEffect(() => {
  if (!waitingForApproval || !meetingDbId || !user?.id) return;

  // Real-time listener (primary method)
  const listener = supabase
    .channel(`approval:${meetingDbId}:${user.id}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "participants",
        filter: `meeting_id=eq.${meetingDbId},user_id=eq.${user.id}`,
      },
      (payload) => {
        if (payload.new.status === "approved") {
          handleApproval();
        }
      }
    )
    .subscribe();

  // Polling fallback
  const interval = setInterval(async () => {
    try {
      const { data } = await supabase
        .from("participants")
        .select("status")
        .eq("meeting_id", meetingDbId)
        .eq("user_id", user.id)
        .single();

      if (data?.status === "approved") {
        handleApproval();
        clearInterval(interval);
      } else {
        setApprovalCheckCount(prev => prev + 1);
      }
    } catch (error) {
      console.error("Approval check error:", error);
    }
  }, 10000); // Check every 10 seconds

  const handleApproval = () => {
    setWaitingForApproval(false);
    setPermitToJoin(true);
    clearInterval(interval);
    supabase.removeChannel(listener);
    
    // Initialize meeting connection
    initializeAfterApproval();
  };

  return () => {
    clearInterval(interval);
    supabase.removeChannel(listener);
  };
}, [waitingForApproval, meetingDbId, user?.id]);

const initializeAfterApproval = async () => {
  try {
    await requestMediaPermissions();
    
    if (!peerRef.current) {
      const peer = createPeer(user.id);
      peerRef.current = peer;
      
      peer.on("open", async (id) => {
        await supabase.from("signals").upsert({
          room_id: roomId,
          peer_id: id,
          user_id: user.id,
          last_active: new Date().toISOString(),
        });
        
        // Connect to existing participants
        const { data: others } = await supabase
          .from("signals")
          .select("peer_id")
          .eq("room_id", roomId)
          .neq("peer_id", id);
          
        if (others?.length > 0) {
          others.forEach(({ peer_id }) => connectToPeer(peer_id));
        }
      });
      
      peer.on("call", (call) => {
        call.answer(localStreamRef.current);
        setupCall(call, call.peer);
      });
    }
    
    await updateParticipants(meetingDbId);
    setConnectionStatus("Connected to meeting");
  } catch (error) {
    console.error("Post-approval initialization error:", error);
    setConnectionStatus("Connection failed - retrying...");
    setTimeout(initializeAfterApproval, 3000);
  }
};

  const joinMeeting = useCallback(
    async (meetingId, userId) => {
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
    },
    [isJoining, isScreenSharing, roomId, user?.email]
  );

  const setupParticipantsListener = useCallback((mtId) => {
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
  }, []);

  // Add this function
  const setupApprovalEventSource = useCallback((meetingId, userId) => {
    const eventSource = new EventSource(
      `/api/approval-events?meeting=${meetingId}&user=${userId}`
    );

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.status === "approved") {
        setWaitingForApproval(false);
        setPermitToJoin(true);
        eventSource.close();
      }
    };

    eventSource.onerror = () => {
      setTimeout(() => setupApprovalEventSource(meetingId, userId), 5000);
    };

    return () => eventSource.close();
  }, []);

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
  }, [
    inputPasscode,
    navigate,
    roomId,
    search,
    setupParticipantListener,
    setupParticipantsListener,
    setupWaitingListener,
  ]);

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
  }, [needPasscode, initRoom, leaveRoom, isInitialized]);

  // Add to your useEffect hooks
  useEffect(() => {
    if (waitingForApproval && !permitToJoin) {
      const approvalCheckInterval = setInterval(async () => {
        try {
          const { data } = await supabase
            .from("participants")
            .select("status")
            .eq("meeting_id", meetingDbId)
            .eq("user_id", user?.id)
            .single();

          if (data?.status === "approved") {
            setWaitingForApproval(false);
            setPermitToJoin(true);
            clearInterval(approvalCheckInterval);
            window.location.reload(); // Last resort if other methods fail
          }
        } catch (error) {
          console.error("Approval check error:", error);
        }
      }, 5000); // Check every 5 seconds

      return () => clearInterval(approvalCheckInterval);
    }
  }, [waitingForApproval, permitToJoin, meetingDbId, user?.id]);

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
                {participants.map((participant) => (
                  <div
                    key={participant.id}
                    className="flex items-center p-2 bg-gray-50 rounded hover:bg-gray-100"
                  >
                    <span className="text-sm truncate flex items-center">
                      {participant.email}
                      {participant.id === user?.id && (
                        <span className="ml-2 text-xs text-gray-500">
                          (You)
                        </span>
                      )}
                    </span>
                    {activeSpeakers[participant.id] && (
                      <span className="ml-2 w-2 h-2 rounded-full bg-green-500"></span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {isHost && (
            <div className="bg-white border rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold">
                  👥 Waiting Room ({waitingList.length})
                </h3>
                <button
                  onClick={() => updateWaitingList(meetingDbId)}
                  className="text-sm bg-blue-100 px-2 py-1 rounded hover:bg-blue-200"
                >
                  Refresh
                </button>
              </div>

              {waitingList.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No users currently waiting
                </p>
              ) : (
                <div className="space-y-2 max-h-60 overflow-y-auto">
                  {waitingList.map((participant) => (
                    <div
                      key={participant.id}
                      className="flex items-center justify-between p-2 bg-gray-50 rounded hover:bg-gray-100"
                    >
                      <div className="flex items-center min-w-0">
                        <span className="text-sm font-medium truncate">
                          {participant.email || `User (${participant.user_id})`}
                        </span>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <button
                          onClick={() => approveUser(participant.user_id)}
                          className="px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600 text-sm"
                        >
                          Admit
                        </button>
                        <button
                          onClick={() => denyUser(participant.user_id)}
                          className="px-2 py-1 bg-red-500 text-white rounded hover:bg-red-600 text-sm"
                        >
                          Deny
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {waitingForApproval && (
  <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
    <div className="flex items-center gap-3">
      <div className="animate-spin text-blue-500">
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </div>
      <div>
        <h3 className="font-medium text-blue-800">Waiting for host approval</h3>
        <p className="text-sm text-blue-600">
          {approvalCheckCount > 0 
            ? `Still waiting... (checked ${approvalCheckCount} times)`
            : "Your request has been sent to the host"}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => window.location.reload()}
            className="text-sm bg-blue-100 text-blue-800 px-3 py-1 rounded hover:bg-blue-200"
          >
            Refresh Status
          </button>
          <button
            onClick={() => navigate("/")}
            className="text-sm bg-gray-100 text-gray-800 px-3 py-1 rounded hover:bg-gray-200"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
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

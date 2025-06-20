import React, { useEffect, useState } from "react";
import io from "socket.io-client";

// Connect to your backend server (update with your real backend URL)
const socket = io("https://your-server.com");

const Room = ({ roomId, username }) => {
  const [approved, setApproved] = useState(false);
  const [waiting, setWaiting] = useState(true);
  const [isHost, setIsHost] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [waitingUsers, setWaitingUsers] = useState([]);
  const [chat, setChat] = useState([]);
  const [message, setMessage] = useState("");

  useEffect(() => {
    socket.emit("join-room", { roomId, username });

    socket.on("waiting-approval", () => setWaiting(true));
    socket.on("approved", () => {
      setApproved(true);
      setWaiting(false);
    });
    socket.on("rejected", () => {
      alert("Rejected by host.");
      window.location.href = "/";
    });

    socket.on("participant-list", (users) => setParticipants(users));
    socket.on("waiting-users", (users) => setWaitingUsers(users));
    socket.on("host-status", (status) => setIsHost(status));

    socket.on("receive-message", (msg) => {
      setChat((prev) => [...prev, msg]);
    });

    return () => {
      socket.disconnect();
    };
  }, [roomId, username]);

  const sendMessage = () => {
    if (message.trim()) {
      socket.emit("send-message", { roomId, username, message });
      setMessage("");
    }
  };

  const approveUser = (userId) => {
    socket.emit("approve-user", { roomId, userId });
  };

  const rejectUser = (userId) => {
    socket.emit("reject-user", { roomId, userId });
  };

  if (waiting && !approved) {
    return (
      <div className="waiting-room">
        <h2>Waiting for host approval...</h2>
      </div>
    );
  }

  return (
    <div className="room">
      <h2>Room ID: {roomId}</h2>
      <h3>Welcome, {username}</h3>

      <div className="participants">
        <h4>Participants:</h4>
        <ul>
          {participants.map((p) => (
            <li key={p.id}>{p.username}</li>
          ))}
        </ul>
      </div>

      {isHost && (
        <div className="host-panel">
          <h4>Waiting for Approval:</h4>
          {waitingUsers.map((user) => (
            <div key={user.id}>
              {user.username}
              <button onClick={() => approveUser(user.id)}>Approve</button>
              <button onClick={() => rejectUser(user.id)}>Reject</button>
            </div>
          ))}
        </div>
      )}

      <div className="chat">
        <div className="chat-box">
          {chat.map((msg, idx) => (
            <div key={idx}><strong>{msg.username}:</strong> {msg.message}</div>
          ))}
        </div>
        <input
          type="text"
          placeholder="Message..."
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button onClick={sendMessage}>Send</button>
      </div>
    </div>
  );
};

export default Room;

function RoomControl({ user }) {
  const [roomCode, setRoomCode] = useState('');
  const navigate = useNavigate();

  const createRoom = async () => {
    if (!user) {
      alert("You must be logged in to create a room.");
      return;
    }

    const code = uuidv4().slice(0, 6);
    const { error } = await supabase.from('rooms').insert([
      { host_id: user.id, room_code: code },
    ]);
    if (error) {
      console.error('Error:', error);
      alert('Error creating room');
      return;
    }
    navigate(`/room/${code}`);
  };

  const joinRoom = () => {
    if (!roomCode) return alert('Enter room code');
    navigate(`/room/${roomCode}`);
  };

  return (
    <div style={{ padding: '1rem' }}>
      <h2>Start or Join a Meeting</h2>
      <button onClick={createRoom}>🎥 Create Room</button>
      <hr />
      <input
        type="text"
        placeholder="Enter Room Code"
        value={roomCode}
        onChange={(e) => setRoomCode(e.target.value)}
      />
      <button onClick={joinRoom}>🔗 Join Room</button>
    </div>
  );
}

export default RoomControl;

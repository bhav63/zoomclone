import RoomControl from './RoomControl';

function Dashboard({ user }) {
  return (
    <div>
      <h1>Welcome {user?.email || 'Guest'}!</h1>
      <RoomControl user={user} />
    </div>
  );
}

export default Dashboard;

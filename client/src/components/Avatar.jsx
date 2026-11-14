// Round profile picture, or the first letter of the name when there is no photo.
// Pass className="avatar-lg" for the big version.
export default function Avatar({ user, className = '' }) {
  const name = user?.name || '?';
  return (
    <div className={`avatar ${className}`.trim()}>
      {user?.avatar ? <img src={user.avatar} alt="" draggable="false" /> : name.charAt(0)}
    </div>
  );
}

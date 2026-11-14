import { Phone, PhoneOff } from './Icons';
import Avatar from './Avatar';
import './IncomingCall.css';

export default function IncomingCall({ peer, callType, label, onAccept, onReject }) {
  return (
    <div className="incoming-backdrop">
      <div className="incoming-card">
        <Avatar user={peer} className="avatar-lg" />
        <div className="incoming-name">{peer.name}</div>
        <div className="incoming-type">{label || `Incoming ${callType} call…`}</div>

        <div className="incoming-actions">
          <button className="btn btn-red" title="Decline" onClick={onReject}>
            <PhoneOff size={26} />
          </button>
          <button className="btn btn-green" title="Accept" onClick={onAccept}>
            <Phone size={26} />
          </button>
        </div>
      </div>
    </div>
  );
}

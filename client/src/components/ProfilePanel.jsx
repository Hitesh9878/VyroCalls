import { useRef, useState } from 'react';
import api, { errorMessage } from '../services/api';
import { fileToAvatar } from '../utils/image';
import Avatar from './Avatar';
import { Camera, Trash, X } from './Icons';
import './ProfilePanel.css';

const ABOUT_MAX = 140;

// "My profile" pop-up: photo, name, about line and password.
export default function ProfilePanel({ user, onSaved, onClose }) {
  const fileRef = useRef(null);

  const [name, setName] = useState(user.name);
  const [about, setAbout] = useState(user.about || '');
  const [avatar, setAvatar] = useState(user.avatar || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwDone, setPwDone] = useState('');

  const dirty =
    name.trim() !== user.name || about.trim() !== (user.about || '') || avatar !== (user.avatar || '');

  const pickPhoto = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file again still fires
    if (!file) return;
    setError('');
    setSaved('');
    try {
      setAvatar(await fileToAvatar(file));
    } catch (err) {
      setError(err.message || 'Could not use that image.');
    }
  };

  const save = async (e) => {
    e.preventDefault();
    setError('');
    setSaved('');
    if (!name.trim()) return setError('Name cannot be empty.');

    setSaving(true);
    try {
      const { data } = await api.patch('/auth/profile', { name: name.trim(), about: about.trim(), avatar });
      onSaved(data.user);
      setName(data.user.name);
      setAbout(data.user.about || '');
      setAvatar(data.user.avatar || '');
      setSaved('Profile saved.');
    } catch (err) {
      setError(errorMessage(err, 'Could not save your profile'));
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPwError('');
    setPwDone('');
    if (next.length < 6) return setPwError('New password must be at least 6 characters.');
    if (next !== confirm) return setPwError('The two new passwords do not match.');

    setPwBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setPwDone('Password updated.');
    } catch (err) {
      setPwError(errorMessage(err, 'Could not change your password'));
    } finally {
      setPwBusy(false);
    }
  };

  return (
    <div className="incoming-backdrop" onClick={onClose}>
      <div className="pf-card" onClick={(e) => e.stopPropagation()}>
        <div className="ngc-head">
          <h2>My profile</h2>
          <button className="btn btn-ghost" title="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <form className="pf-form" onSubmit={save}>
          <div className="pf-photo">
            <Avatar user={{ name, avatar }} className="avatar-lg" />
            <div className="pf-photo-actions">
              <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
                <Camera size={16} /> {avatar ? 'Change photo' : 'Add photo'}
              </button>
              {avatar && (
                <button type="button" className="btn btn-ghost" onClick={() => setAvatar('')}>
                  <Trash size={16} /> Remove
                </button>
              )}
            </div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
          </div>

          <label className="pf-field">
            Name
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} required />
          </label>

          <label className="pf-field">
            About
            <input
              className="input"
              placeholder="A short line your contacts can see"
              value={about}
              maxLength={ABOUT_MAX}
              onChange={(e) => setAbout(e.target.value)}
            />
            <span className="pf-count">{about.length}/{ABOUT_MAX}</span>
          </label>

          <label className="pf-field">
            Email
            <input className="input" value={user.email} disabled />
          </label>

          {error && <p className="error-text">{error}</p>}
          {saved && !dirty && <p className="pf-ok">{saved}</p>}

          <button className="btn btn-primary" type="submit" disabled={saving || !dirty}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </form>

        <form className="pf-form pf-password" onSubmit={changePassword}>
          <h3>Change password</h3>
          <input
            className="input"
            type="password"
            placeholder="Current password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
          <input
            className="input"
            type="password"
            placeholder="New password (at least 6 characters)"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
          />
          <input
            className="input"
            type="password"
            placeholder="Repeat the new password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
          {pwError && <p className="error-text">{pwError}</p>}
          {pwDone && <p className="pf-ok">{pwDone}</p>}
          <button className="btn" type="submit" disabled={pwBusy || !current || !next || !confirm}>
            {pwBusy ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}

const express = require('express');
const Call = require('../models/Call');
const User = require('../models/User');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// ---- ICE servers (STUN + optional TURN) -------------------------------------------------
// A phone on mobile data usually cannot connect straight to another network without a TURN
// relay, so the browser asks for the list here and the TURN secret stays in the server's env.
//   Static TURN:  TURN_URLS=turn:host:3478,turns:host:5349  TURN_USERNAME=...  TURN_CREDENTIAL=...
//   Metered.ca:   METERED_DOMAIN=yourapp.metered.live       METERED_API_KEY=...
const STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
let meteredCache = { at: 0, servers: [] };

async function relayServers() {
  const urls = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (urls.length && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    return [{ urls, username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL }];
  }

  const { METERED_DOMAIN, METERED_API_KEY } = process.env;
  if (METERED_DOMAIN && METERED_API_KEY) {
    if (Date.now() - meteredCache.at < 5 * 60 * 1000 && meteredCache.servers.length) return meteredCache.servers;
    try {
      const r = await fetch(
        `https://${METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`
      );
      if (!r.ok) throw new Error(`Metered responded ${r.status}`);
      const list = await r.json();
      if (Array.isArray(list) && list.length) meteredCache = { at: Date.now(), servers: list };
    } catch (err) {
      console.error('Could not load TURN credentials:', err.message);
    }
    return meteredCache.servers;
  }
  return [];
}

router.get('/ice-servers', async (req, res) => {
  const relay = await relayServers();
  res.json({ iceServers: [STUN, ...relay], relay: relay.length > 0 });
});

// Recent calls (newest first) plus how many missed calls haven't been looked at yet
router.get('/', async (req, res) => {
  try {
    const me = req.user.id;

    const [docs, user] = await Promise.all([
      Call.find({ $or: [{ caller: me }, { callee: me }] })
        .sort({ startedAt: -1 })
        .limit(50)
        .populate('caller callee', 'name email'),
      User.findById(me).select('lastCallsSeenAt'),
    ]);

    const since = user?.lastCallsSeenAt || new Date(0);
    const missedUnseen = await Call.countDocuments({
      callee: me,
      status: 'missed',
      createdAt: { $gt: since },
    });

    const calls = docs
      .filter((d) => d.caller && d.callee) // skip calls with deleted users
      .map((d) => {
        const outgoing = d.caller._id.toString() === me;
        const other = outgoing ? d.callee : d.caller;
        return {
          id: d._id.toString(),
          direction: outgoing ? 'outgoing' : 'incoming',
          status: d.status,
          callType: d.callType,
          duration: d.duration,
          isGroup: !!d.isGroup,
          startedAt: d.startedAt,
          peer: { id: other._id.toString(), name: other.name, email: other.email },
        };
      });

    res.json({ calls, missedUnseen });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not load call history' });
  }
});

// The user has looked at their history: clear the missed-call badge
router.post('/seen', async (req, res) => {
  try {
    await User.updateOne({ _id: req.user.id }, { lastCallsSeenAt: new Date() });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Could not update' });
  }
});

module.exports = router;

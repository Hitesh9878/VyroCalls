require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const setupSocket = require('./socket');
const authRoutes = require('./routes/auth');
const contactRoutes = require('./routes/contacts');
const callRoutes = require('./routes/calls');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);

// Render, Heroku, nginx etc. put one proxy in front of the app. Without this, express-rate-limit
// sees the proxy's IP for every visitor (so one person can lock everybody out) and logs
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. Set TRUST_PROXY=0 if you run without a proxy.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

const origin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
app.use(cors({ origin }));
// Profile photos are sent as small data URLs (see routes/auth.js), so allow a bit more than the 100kb default
app.use(express.json({ limit: '200kb' }));

let dbReady = false;
app.get('/api/health', (req, res) => res.json({ ok: true, db: dbReady }));
app.use('/api/auth', authRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/calls', callRoutes);

// Mobile networks drop connections a lot: give the heartbeat a little more room than the defaults
const io = new Server(server, { cors: { origin }, pingInterval: 20000, pingTimeout: 30000 });
app.set('io', io); // REST routes use it to push live updates (contact requests etc.)
setupSocket(io);

const PORT = process.env.PORT || 5000;

// Start listening straight away so the host's port check (Render) passes even while MongoDB is
// still connecting. Requests that arrive in that moment wait for the database (mongoose buffers them).
server.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));

const hasTurn =
  (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) ||
  (process.env.METERED_DOMAIN && process.env.METERED_API_KEY);
if (!hasTurn) {
  console.warn(
    'No TURN server configured (TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL or METERED_DOMAIN / METERED_API_KEY). ' +
      'Calls between a phone on mobile data and another network will often fail to connect.'
  );
}

connectDB()
  .then(() => {
    dbReady = true;
  })
  .catch((err) => {
    console.error('MongoDB connection failed:', err.message);
    process.exit(1);
  });

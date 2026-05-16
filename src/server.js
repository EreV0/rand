const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const multer = require('multer');
const pool = require('./db');
const { register, login, verifyToken } = require('./auth');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '.webm')
});
const upload = multer({ storage });

app.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await register(username, password);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const data = await login(username, password);
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/users', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    verifyToken(token);
    const result = await pool.query('SELECT id, username FROM users');
    res.json(result.rows);
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

app.post('/upload-audio', upload.single('audio'), async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    verifyToken(token);
    res.json({ url: '/uploads/' + req.file.filename });
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

app.get('/messages/:receiverId', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const user = verifyToken(token);
    const { receiverId } = req.params;
    const result = await pool.query(
      `SELECT m.*, u.username as sender_name,
        r.content as reply_content, ru.username as reply_sender
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       LEFT JOIN messages r ON m.reply_to = r.id
       LEFT JOIN users ru ON r.sender_id = ru.id
       WHERE (m.sender_id = $1 AND m.receiver_id = $2)
          OR (m.sender_id = $2 AND m.receiver_id = $1)
       ORDER BY m.created_at ASC`,
      [user.id, receiverId]
    );
    res.json(result.rows);
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

app.get('/search/:receiverId', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const user = verifyToken(token);
    const { receiverId } = req.params;
    const { q } = req.query;
    const result = await pool.query(
      `SELECT m.*, u.username as sender_name
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE ((m.sender_id = $1 AND m.receiver_id = $2)
          OR (m.sender_id = $2 AND m.receiver_id = $1))
         AND m.content ILIKE $3
       ORDER BY m.created_at ASC`,
      [user.id, receiverId, `%${q}%`]
    );
    res.json(result.rows);
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

app.post('/read/:senderId', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const user = verifyToken(token);
    await pool.query(
      `UPDATE messages SET is_read = TRUE
       WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE`,
      [req.params.senderId, user.id]
    );
    res.json({ success: true });
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

const clients = new Map();

wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', async (data) => {
    const msg = JSON.parse(data);

    if (msg.type === 'auth') {
      try {
        const user = verifyToken(msg.token);
        currentUser = user;
        clients.set(user.id, ws);
        ws.send(JSON.stringify({ type: 'auth', success: true }));
      } catch {
        ws.send(JSON.stringify({ type: 'auth', success: false }));
      }
    }

    if (msg.type === 'message' && currentUser) {
      const { receiverId, content, audioUrl, replyTo } = msg;

      const result = await pool.query(
        `INSERT INTO messages (sender_id, receiver_id, content, audio_url, reply_to)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [currentUser.id, receiverId, audioUrl ? '[audio]' : content, audioUrl || null, replyTo || null]
      );

      const msgId = result.rows[0].id;

      let replyContent = null, replySender = null;
      if (replyTo) {
        const r = await pool.query(
          `SELECT m.content, u.username FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = $1`,
          [replyTo]
        );
        if (r.rows[0]) {
          replyContent = r.rows[0].content;
          replySender = r.rows[0].username;
        }
      }

      const payload = JSON.stringify({
        type: 'message',
        id: msgId,
        senderId: currentUser.id,
        senderName: currentUser.username,
        content: audioUrl ? null : content,
        audioUrl: audioUrl || null,
        replyTo: replyTo || null,
        replyContent,
        replySender,
        isRead: false,
      });

      const receiverWs = clients.get(receiverId);
      if (receiverWs && receiverWs.readyState === WebSocket.OPEN) {
        receiverWs.send(payload);
        // Mark as read immediately if receiver is online and in same chat
        await pool.query(`UPDATE messages SET is_read = TRUE WHERE id = $1`, [msgId]);
        ws.send(JSON.stringify({ type: 'read', msgId }));
      }

      ws.send(payload);
    }

    if (msg.type === 'read' && currentUser) {
      await pool.query(
        `UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE`,
        [msg.fromId, currentUser.id]
      );
      const senderWs = clients.get(msg.fromId);
      if (senderWs && senderWs.readyState === WebSocket.OPEN) {
        senderWs.send(JSON.stringify({ type: 'read_all', fromId: currentUser.id }));
      }
    }
  });

  ws.on('close', () => {
    if (currentUser) clients.delete(currentUser.id);
  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
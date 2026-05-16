const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const SECRET = 'chatapp_secret_key';

async function register(username, password) {
  const hashed = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id, username',
    [username, hashed]
  );
  return result.rows[0];
}

async function login(username, password) {
  const result = await pool.query(
    'SELECT * FROM users WHERE username = $1',
    [username]
  );
  const user = result.rows[0];
  if (!user) throw new Error('User not found');
  
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new Error('Wrong password');
  
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET);
  return { token, user: { id: user.id, username: user.username } };
}

function verifyToken(token) {
  return jwt.verify(token, SECRET);
}

module.exports = { register, login, verifyToken };
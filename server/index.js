const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// CORS setup for Socket.IO
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Middleware
app.use(cors({
  origin: '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:RNTC143@localhost:5432/skillswap',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const MIN_SESSION_DURATION = 900;

// Auth Middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// Format duration
function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// Format time for messages
function formatMessageTime(date) {
  const d = new Date(date);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Routes
app.get("/", (req, res) => {
  res.send("🚀 SkillSwap API Running");
});

// REGISTER
app.post("/register", async (req, res) => {
  const { name, email, password, bio, location, skills_have, skills_want } = req.body;
  
  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }
  
  try {
    const existingUser = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      `INSERT INTO users (name, email, password, bio, location) 
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, hashedPassword, bio || '', location || '']
    );
    
    const userId = userResult.rows[0].id;
    
    if (skills_have && Array.isArray(skills_have)) {
      for (const skill of skills_have) {
        await pool.query(
          `INSERT INTO skills (user_id, skill_name, skill_type, proficiency, category) 
           VALUES ($1, $2, 'have', $3, $4)`,
          [userId, skill.name, skill.proficiency || 'Intermediate', skill.category || 'Other']
        );
      }
    }
    
    if (skills_want && Array.isArray(skills_want)) {
      for (const skill of skills_want) {
        await pool.query(
          `INSERT INTO skills (user_id, skill_name, skill_type, proficiency, category) 
           VALUES ($1, $2, 'want', 'Beginner', $3)`,
          [userId, skill.name, skill.category || 'Other']
        );
      }
    }
    
    await pool.query("INSERT INTO user_stats (user_id) VALUES ($1)", [userId]);
    res.status(201).json({ success: true, userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// LOGIN
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  
  try {
    const result = await pool.query(
      `SELECT u.*, COALESCE(us.total_sessions, 0) as total_sessions,
              COALESCE(us.average_rating_received, 0) as avg_rating
       FROM users u 
       LEFT JOIN user_stats us ON u.id = us.user_id 
       WHERE u.email = $1`,
      [email]
    );
    
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "User not found" });
    }
    
    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    
    if (!validPassword) {
      return res.status(400).json({ error: "Invalid password" });
    }
    
    await pool.query("UPDATE users SET is_online = TRUE, last_seen = CURRENT_TIMESTAMP WHERE id = $1", [user.id]);
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "24h" }
    );
    
    const skillsResult = await pool.query("SELECT * FROM skills WHERE user_id = $1", [user.id]);
    
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        bio: user.bio,
        location: user.location,
        avatar_url: user.avatar_url,
        points: user.points,
        level: user.level,
        badges: user.badges,
        is_online: true,
        skills_have: skillsResult.rows.filter(s => s.skill_type === 'have'),
        skills_want: skillsResult.rows.filter(s => s.skill_type === 'want'),
        stats: { total_sessions: user.total_sessions, avg_rating: user.avg_rating }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// GET PROFILE
app.get("/profile", authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT u.*, us.* FROM users u 
       LEFT JOIN user_stats us ON u.id = us.user_id 
       WHERE u.id = $1`,
      [req.user.userId]
    );
    
    if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
    
    const user = userResult.rows[0];
    const skillsResult = await pool.query("SELECT * FROM skills WHERE user_id = $1", [req.user.userId]);
    const reviewsResult = await pool.query(
      `SELECT r.*, u.name as reviewer_name 
       FROM reviews r JOIN users u ON r.reviewer_id = u.id
       WHERE r.reviewee_id = $1 ORDER BY r.created_at DESC`,
      [req.user.userId]
    );
    
    res.json({
      ...user,
      skills_have: skillsResult.rows.filter(s => s.skill_type === 'have'),
      skills_want: skillsResult.rows.filter(s => s.skill_type === 'want'),
      reviews: reviewsResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// GET USER BY ID
app.get("/user/:userId", authenticateToken, async (req, res) => {
  try {
    const userResult = await pool.query(
      `SELECT u.*, us.* FROM users u 
       LEFT JOIN user_stats us ON u.id = us.user_id 
       WHERE u.id = $1`,
      [req.params.userId]
    );
    
    if (userResult.rows.length === 0) return res.status(404).json({ error: "User not found" });
    
    const user = userResult.rows[0];
    const skillsResult = await pool.query("SELECT * FROM skills WHERE user_id = $1", [req.params.userId]);
    const reviewsResult = await pool.query(
      `SELECT r.*, u.name as reviewer_name FROM reviews r 
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.reviewee_id = $1 ORDER BY r.created_at DESC`,
      [req.params.userId]
    );
    
    res.json({
      ...user,
      skills_have: skillsResult.rows.filter(s => s.skill_type === 'have'),
      skills_want: skillsResult.rows.filter(s => s.skill_type === 'want'),
      reviews: reviewsResult.rows
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// SMART MATCHING
app.get("/smart-matches", authenticateToken, async (req, res) => {
  try {
    const mySkills = await pool.query("SELECT * FROM skills WHERE user_id = $1", [req.user.userId]);
    const myHave = mySkills.rows.filter(s => s.skill_type === 'have').map(s => s.skill_name.toLowerCase());
    const myWant = mySkills.rows.filter(s => s.skill_type === 'want').map(s => s.skill_name.toLowerCase());
    
    const usersResult = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.bio, u.location, u.points, u.level, u.is_online, u.avatar_url,
       COALESCE(us.average_rating_received, 0) as avg_rating,
       array_agg(DISTINCT CASE WHEN s.skill_type = 'have' THEN s.skill_name END) FILTER (WHERE s.skill_type = 'have') as skills_have,
       array_agg(DISTINCT CASE WHEN s.skill_type = 'want' THEN s.skill_name END) FILTER (WHERE s.skill_type = 'want') as skills_want
       FROM users u
       LEFT JOIN skills s ON u.id = s.user_id
       LEFT JOIN user_stats us ON u.id = us.user_id
       WHERE u.id != $1
       GROUP BY u.id, us.average_rating_received`,
      [req.user.userId]
    );
    
    const matches = usersResult.rows.map(user => {
      const theyHave = (user.skills_have || []).map(s => s.toLowerCase());
      const theyWant = (user.skills_want || []).map(s => s.toLowerCase());
      
      const iTeachTheyWant = myHave.filter(skill => theyWant.includes(skill));
      const theyTeachIWant = theyHave.filter(skill => myWant.includes(skill));
      
      let score = 0;
      if (iTeachTheyWant.length > 0) score += 40;
      if (theyTeachIWant.length > 0) score += 40;
      if (iTeachTheyWant.length > 0 && theyTeachIWant.length > 0) score += 20;
      
      return {
        ...user,
        match_score: Math.min(score, 100),
        i_teach_they_want: iTeachTheyWant,
        they_teach_i_want: theyTeachIWant,
        is_perfect_match: iTeachTheyWant.length > 0 && theyTeachIWant.length > 0
      };
    })
    .filter(m => m.match_score > 0)
    .sort((a, b) => b.match_score - a.match_score);
    
    res.json(matches);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Matching failed" });
  }
});

// SKILL SUGGESTIONS
app.get("/skill-suggestions/:input", async (req, res) => {
  try {
    const input = `%${req.params.input}%`;
    const result = await pool.query(
      `SELECT suggested_skill, category FROM skill_suggestions 
       WHERE input_skill ILIKE $1 ORDER BY relevance_score DESC LIMIT 5`,
      [input]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to get suggestions" });
  }
});

// SESSIONS ROUTES
app.post("/sessions", authenticateToken, async (req, res) => {
  const { partner_id, skill_taught, session_date, session_time, duration, notes, meeting_link } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO sessions (requester_id, partner_id, skill_taught, session_date, session_time, duration_minutes, notes, meeting_link, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
      [req.user.userId, partner_id, skill_taught, session_date, session_time, duration || 60, notes, meeting_link || null]
    );
    
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_id) 
       VALUES ($1, 'session_request', 'New Session Request', $2, $3)`,
      [partner_id, `${req.user.name} wants to learn ${skill_taught}`, result.rows[0].id]
    );
    
    io.to(`user_${partner_id}`).emit("notification", { type: "session_request" });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create session" });
  }
});

app.get("/sessions", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u1.name as requester_name, u2.name as partner_name
       FROM sessions s
       JOIN users u1 ON s.requester_id = u1.id
       JOIN users u2 ON s.partner_id = u2.id
       WHERE s.requester_id = $1 OR s.partner_id = $1
       ORDER BY s.created_at DESC`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

app.put("/sessions/:id/accept", authenticateToken, async (req, res) => {
  try {
    const session = await pool.query(
      "SELECT * FROM sessions WHERE id = $1 AND partner_id = $2 AND status = 'pending'",
      [req.params.id, req.user.userId]
    );
    
    if (session.rows.length === 0) return res.status(403).json({ error: "Unauthorized" });
    
    let meetLink = session.rows[0].meeting_link;
    if (!meetLink) {
      meetLink = `https://meet.google.com/lookup/${Math.random().toString(36).substring(2, 10)}`;
    }
    
    await pool.query("UPDATE sessions SET status = 'accepted', meeting_link = $1 WHERE id = $2", [meetLink, req.params.id]);
    
    const requesterId = session.rows[0].requester_id;
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message) 
       VALUES ($1, 'session_accepted', 'Session Accepted', $2)`,
      [requesterId, `Your session was accepted! Meeting: ${meetLink}`]
    );
    
    io.to(`user_${requesterId}`).emit("notification", { type: "session_accepted", meeting_link: meetLink });
    res.json({ success: true, meeting_link: meetLink });
  } catch (err) {
    res.status(500).json({ error: "Failed to accept" });
  }
});

app.put("/sessions/:id/reject", authenticateToken, async (req, res) => {
  try {
    const session = await pool.query(
      "SELECT * FROM sessions WHERE id = $1 AND partner_id = $2 AND status = 'pending'",
      [req.params.id, req.user.userId]
    );
    
    if (session.rows.length === 0) return res.status(403).json({ error: "Unauthorized" });
    
    await pool.query("UPDATE sessions SET status = 'cancelled' WHERE id = $1", [req.params.id]);
    
    const requesterId = session.rows[0].requester_id;
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message) 
       VALUES ($1, 'session_rejected', 'Session Rejected', $2)`,
      [requesterId, `Your session request was declined`]
    );
    
    io.to(`user_${requesterId}`).emit("notification", { type: "session_rejected" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reject" });
  }
});

app.post("/sessions/:id/start", authenticateToken, async (req, res) => {
  try {
    const session = await pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND (requester_id = $2 OR partner_id = $2) AND status = 'accepted'`,
      [req.params.id, req.user.userId]
    );
    
    if (session.rows.length === 0) return res.status(400).json({ error: "Session not ready" });
    if (session.rows[0].actual_start_time) return res.status(400).json({ error: "Already started" });
    
    const startTime = new Date();
    await pool.query("UPDATE sessions SET status = 'ongoing', actual_start_time = $1 WHERE id = $2", [startTime, req.params.id]);
    
    const otherUserId = session.rows[0].requester_id === req.user.userId ? session.rows[0].partner_id : session.rows[0].requester_id;
    io.to(`user_${otherUserId}`).emit("session_started", { session_id: req.params.id, start_time: startTime });
    
    res.json({ success: true, start_time: startTime });
  } catch (err) {
    res.status(500).json({ error: "Failed to start" });
  }
});

app.get("/sessions/:id/status", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT s.*, u1.name as requester_name, u2.name as partner_name
       FROM sessions s
       JOIN users u1 ON s.requester_id = u1.id
       JOIN users u2 ON s.partner_id = u2.id
       WHERE s.id = $1 AND (s.requester_id = $2 OR s.partner_id = $2)`,
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) return res.status(404).json({ error: "Not found" });
    
    const sess = result.rows[0];
    const isRequester = sess.requester_id === req.user.userId;
    let durationSeconds = 0;
    
    if (sess.actual_start_time && sess.status === 'ongoing') {
      const now = new Date();
      const start = new Date(sess.actual_start_time);
      durationSeconds = Math.floor((now - start) / 1000);
    }
    
    res.json({
      id: sess.id,
      status: sess.status,
      skill_taught: sess.skill_taught,
      meeting_link: sess.meeting_link,
      start_time: sess.actual_start_time,
      duration_seconds: durationSeconds,
      duration_formatted: formatDuration(durationSeconds),
      my_confirmation: isRequester ? sess.requester_confirmed : sess.partner_confirmed,
      partner_confirmation: isRequester ? sess.partner_confirmed : sess.requester_confirmed,
      both_confirmed: sess.requester_confirmed && sess.partner_confirmed,
      is_valid: sess.is_valid,
      can_complete: sess.status === 'ongoing' && durationSeconds >= MIN_SESSION_DURATION,
      time_remaining: Math.max(0, MIN_SESSION_DURATION - durationSeconds)
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get status" });
  }
});

app.post("/sessions/:id/complete", authenticateToken, async (req, res) => {
  try {
    const session = await pool.query(
      `SELECT * FROM sessions WHERE id = $1 AND (requester_id = $2 OR partner_id = $2) AND status = 'ongoing'`,
      [req.params.id, req.user.userId]
    );
    
    if (session.rows.length === 0) return res.status(400).json({ error: "Session not ongoing" });
    
    const sess = session.rows[0];
    const isRequester = sess.requester_id === req.user.userId;
    const otherUserId = isRequester ? sess.partner_id : sess.requester_id;
    const confirmationField = isRequester ? 'requester_confirmed' : 'partner_confirmed';
    
    const now = new Date();
    const start = new Date(sess.actual_start_time);
    const durationSeconds = Math.floor((now - start) / 1000);
    
    if (durationSeconds < MIN_SESSION_DURATION) {
      await pool.query(`UPDATE sessions SET status = 'invalid' WHERE id = $1`, [req.params.id]);
      return res.status(400).json({ 
        error: "Session too short", 
        message: `Minimum 15 minutes required. You only did ${Math.floor(durationSeconds/60)} minutes.`
      });
    }
    
    await pool.query(
      `UPDATE sessions SET ${confirmationField} = TRUE, actual_end_time = $1, actual_duration_seconds = $2 WHERE id = $3`,
      [now, durationSeconds, req.params.id]
    );
    
    const updated = await pool.query("SELECT requester_confirmed, partner_confirmed FROM sessions WHERE id = $1", [req.params.id]);
    
    if (updated.rows[0].requester_confirmed && updated.rows[0].partner_confirmed) {
      await pool.query("UPDATE sessions SET status = 'completed', is_valid = TRUE WHERE id = $1", [req.params.id]);
      await pool.query("UPDATE users SET points = points + 150 WHERE id IN ($1, $2)", [sess.requester_id, sess.partner_id]);
      await pool.query(
        `UPDATE user_stats SET total_sessions = total_sessions + 1 WHERE user_id IN ($1, $2)`,
        [sess.requester_id, sess.partner_id]
      );
      
      io.to(`user_${sess.requester_id}`).emit("session_completed", { valid: true, points: 150 });
      io.to(`user_${sess.partner_id}`).emit("session_completed", { valid: true, points: 150 });
      
      res.json({ success: true, validated: true, points_earned: 150, both_confirmed: true });
    } else {
      io.to(`user_${otherUserId}`).emit("confirmation_needed", { session_id: req.params.id });
      res.json({ success: true, validated: false, message: "Waiting for partner..." });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to complete" });
  }
});

// REVIEWS
app.post("/reviews", authenticateToken, async (req, res) => {
  const { session_id, reviewee_id, rating, feedback } = req.body;
  
  try {
    const session = await pool.query(
      "SELECT * FROM sessions WHERE id = $1 AND status = 'completed' AND is_valid = TRUE",
      [session_id]
    );
    
    if (session.rows.length === 0) return res.status(400).json({ error: "Can only review valid completed sessions" });
    
    const result = await pool.query(
      `INSERT INTO reviews (session_id, reviewer_id, reviewee_id, rating, feedback) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [session_id, req.user.userId, reviewee_id, rating, feedback]
    );
    
    await pool.query(
      `UPDATE user_stats SET average_rating_received = (SELECT AVG(rating) FROM reviews WHERE reviewee_id = $1) WHERE user_id = $1`,
      [reviewee_id]
    );
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to submit review" });
  }
});

// NOTIFICATIONS
app.get("/notifications", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [req.user.userId]
    );
    const unread = await pool.query("SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE", [req.user.userId]);
    res.json({ notifications: result.rows, unread_count: parseInt(unread.rows[0].count) });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.put("/notifications/:id/read", authenticateToken, async (req, res) => {
  try {
    await pool.query("UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2", [req.params.id, req.user.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to mark as read" });
  }
});

// ============================================
// MESSAGES - WHATSAPP STYLE API
// ============================================

// Get messages with user info
app.get("/messages/:userId", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, 
        u1.name as sender_name, 
        u1.avatar_url as sender_avatar,
        u2.name as receiver_name,
        u2.avatar_url as receiver_avatar
       FROM messages m
       JOIN users u1 ON m.sender_id = u1.id
       JOIN users u2 ON m.receiver_id = u2.id
       WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
       AND m.is_deleted = FALSE
       ORDER BY m.created_at ASC`,
      [req.user.userId, req.params.userId]
    );
    
    // Mark messages as read
    await pool.query(
      "UPDATE messages SET is_read = TRUE, read_at = CURRENT_TIMESTAMP WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE",
      [req.params.userId, req.user.userId]
    );
    
    // Notify sender that messages were read
    io.to(`user_${req.params.userId}`).emit("messages_read", { 
      reader_id: req.user.userId,
      reader_name: req.user.name 
    });
    
    res.json(result.rows);
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Send message
app.post("/messages", authenticateToken, async (req, res) => {
  const { receiver_id, message, message_type = 'text', reply_to } = req.body;
  const trimmedMessage = typeof message === 'string' ? message.trim() : '';

  if (!receiver_id || !trimmedMessage) {
    return res.status(400).json({ error: "Receiver and message are required" });
  }
  
  try {
    const receiver = await pool.query("SELECT id, name FROM users WHERE id = $1", [receiver_id]);
    if (receiver.rows.length === 0) {
      return res.status(404).json({ error: "Receiver not found" });
    }
    
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, message, message_type, reply_to) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.userId, receiver_id, trimmedMessage, message_type, reply_to || null]
    );
    
    const messageWithSender = {
      ...result.rows[0],
      sender_name: req.user.name,
      sender_avatar: req.user.avatar_url || ''
    };
    
    // Create notification
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_id) 
       VALUES ($1, 'message', 'New Message', $2, $3)`,
      [receiver_id, `${req.user.name}: ${trimmedMessage.substring(0, 50)}${trimmedMessage.length > 50 ? '...' : ''}`, result.rows[0].id]
    );
    
    // Real-time emit
    io.to(`user_${receiver_id}`).emit("new_message", messageWithSender);
    io.to(`user_${receiver_id}`).emit("notification", { type: "new_message", sender_name: req.user.name });
    
    res.json(messageWithSender);
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Delete message
app.delete("/messages/:id", authenticateToken, async (req, res) => {
  try {
    const check = await pool.query(
      "SELECT * FROM messages WHERE id = $1 AND sender_id = $2",
      [req.params.id, req.user.userId]
    );
    
    if (check.rows.length === 0) {
      return res.status(403).json({ error: "Can only delete your own messages" });
    }
    
    const message = check.rows[0];
    
    // Soft delete
    await pool.query(
      "UPDATE messages SET is_deleted = TRUE, deleted_at = CURRENT_TIMESTAMP WHERE id = $1",
      [req.params.id]
    );
    
    io.to(`user_${message.receiver_id}`).emit("message_deleted", { 
      message_id: req.params.id,
      sender_id: req.user.userId
    });
    
    res.json({ success: true });
  } catch (err) {
    console.error("Delete message error:", err);
    res.status(500).json({ error: "Failed to delete message" });
  }
});

// Get chat list with last message preview
app.get("/chat-list", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.is_online, u.avatar_url, u.last_seen,
        (SELECT m.message FROM messages m
         WHERE ((m.sender_id = u.id AND m.receiver_id = $1) OR (m.sender_id = $1 AND m.receiver_id = u.id))
         AND m.is_deleted = FALSE
         ORDER BY m.created_at DESC LIMIT 1) as last_message,
        (SELECT m.created_at FROM messages m
         WHERE ((m.sender_id = u.id AND m.receiver_id = $1) OR (m.sender_id = $1 AND m.receiver_id = u.id))
         AND m.is_deleted = FALSE
         ORDER BY m.created_at DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = $1 AND is_read = FALSE AND is_deleted = FALSE) as unread_count
       FROM users u 
       JOIN messages m ON (m.sender_id = u.id AND m.receiver_id = $1) OR (m.sender_id = $1 AND m.receiver_id = u.id)
       WHERE u.id != $1
       ORDER BY last_message_time DESC NULLS LAST`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Chat list error:", err);
    res.status(500).json({ error: "Failed to fetch chat list" });
  }
});

// ============================================
// SOCKET.IO - REAL-TIME EVENTS
// ============================================

io.on("connection", (socket) => {
  console.log("🔌 Client connected:", socket.id);
  
  socket.on("join", async (userId) => {
    try {
      socket.userId = userId;
      socket.join(`user_${userId}`);
      console.log(`👤 User ${userId} joined`);
      
      await pool.query("UPDATE users SET is_online = TRUE WHERE id = $1", [userId]);
      socket.broadcast.emit("user_status", { user_id: userId, is_online: true });
    } catch (err) {
      console.error("Socket join error:", err);
    }
  });
  
  // Typing indicators
  socket.on("typing", (data) => {
    io.to(`user_${data.receiver_id}`).emit("typing", {
      sender_id: data.sender_id,
      sender_name: data.sender_name,
      is_typing: true
    });
  });
  
  socket.on("stop_typing", (data) => {
    io.to(`user_${data.receiver_id}`).emit("typing", {
      sender_id: data.sender_id,
      is_typing: false
    });
  });
  
  // Message read receipts
  socket.on("mark_read", async (data) => {
    await pool.query(
      "UPDATE messages SET is_read = TRUE, read_at = CURRENT_TIMESTAMP WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE",
      [data.sender_id, data.reader_id]
    );
    
    io.to(`user_${data.sender_id}`).emit("messages_read", {
      reader_id: data.reader_id,
      reader_name: data.reader_name
    });
  });
  
  // Disconnect handling
  socket.on("disconnect", async () => {
    console.log("❌ Client disconnected:", socket.id);
    if (socket.userId) {
      try {
        await pool.query("UPDATE users SET is_online = FALSE WHERE id = $1", [socket.userId]);
        socket.broadcast.emit("user_status", { user_id: socket.userId, is_online: false });
      } catch (err) {
        console.error("Socket disconnect error:", err);
      }
    }
  });
});

// ============================================
// SERVER START
// ============================================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 SkillSwap Server running on port ${PORT}`);
});
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:RNTC143@localhost:5432/skillswap',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";
const MIN_SESSION_DURATION = 900;

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

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// ============================================
// AUTH ROUTES
// ============================================

app.post("/register", async (req, res) => {
  const { name, email, password, bio, location, skills_have, skills_want } = req.body;
  
  try {
    // Check if email exists
    const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    
    const userResult = await pool.query(
      `INSERT INTO users (name, email, password, bio, location) 
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, hashedPassword, bio || '', location || '']
    );
    
    const userId = userResult.rows[0].id;
    
    // Add skills in transaction
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
    
    res.status(201).json({ success: true, userId, message: "Account created successfully" });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

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
    
    await pool.query("UPDATE users SET is_online = TRUE WHERE id = $1", [user.id]);
    
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
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

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
    
    res.json({
      ...user,
      skills_have: skillsResult.rows.filter(s => s.skill_type === 'have'),
      skills_want: skillsResult.rows.filter(s => s.skill_type === 'want')
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ============================================
// MATCHES
// ============================================

app.get("/smart-matches", authenticateToken, async (req, res) => {
  try {
    const mySkills = await pool.query("SELECT * FROM skills WHERE user_id = $1", [req.user.userId]);
    const myHave = mySkills.rows.filter(s => s.skill_type === 'have').map(s => s.skill_name.toLowerCase());
    const myWant = mySkills.rows.filter(s => s.skill_type === 'want').map(s => s.skill_name.toLowerCase());
    
    const usersResult = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.bio, u.location, u.points, u.level, u.is_online,
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
    res.status(500).json({ error: "Matching failed" });
  }
});

// ============================================
// SESSIONS
// ============================================

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
    io.to(`user_${requesterId}`).emit("notification", { type: "session_accepted", meeting_link: meetLink });
    res.json({ success: true, meeting_link: meetLink });
  } catch (err) {
    res.status(500).json({ error: "Failed to accept" });
  }
});

app.put("/sessions/:id/reject", authenticateToken, async (req, res) => {
  try {
    await pool.query("UPDATE sessions SET status = 'cancelled' WHERE id = $1 AND partner_id = $2", [req.params.id, req.user.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reject" });
  }
});

app.post("/sessions/:id/start", authenticateToken, async (req, res) => {
  try {
    const startTime = new Date();
    await pool.query(
      "UPDATE sessions SET status = 'ongoing', actual_start_time = $1 WHERE id = $2",
      [startTime, req.params.id]
    );
    res.json({ success: true, start_time: startTime });
  } catch (err) {
    res.status(500).json({ error: "Failed to start" });
  }
});

app.get("/sessions/:id/status", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sessions WHERE id = $1", [req.params.id]);
    const sess = result.rows[0];
    
    let durationSeconds = 0;
    if (sess.actual_start_time && sess.status === 'ongoing') {
      durationSeconds = Math.floor((new Date() - new Date(sess.actual_start_time)) / 1000);
    }
    
    res.json({
      ...sess,
      duration_seconds: durationSeconds,
      duration_formatted: formatDuration(durationSeconds),
      can_complete: sess.status === 'ongoing' && durationSeconds >= MIN_SESSION_DURATION
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to get status" });
  }
});

app.post("/sessions/:id/complete", authenticateToken, async (req, res) => {
  try {
    const session = await pool.query("SELECT * FROM sessions WHERE id = $1", [req.params.id]);
    const sess = session.rows[0];
    
    const durationSeconds = Math.floor((new Date() - new Date(sess.actual_start_time)) / 1000);
    
    if (durationSeconds < MIN_SESSION_DURATION) {
      return res.status(400).json({ error: "Session too short" });
    }
    
    await pool.query("UPDATE sessions SET status = 'completed', is_valid = TRUE WHERE id = $1", [req.params.id]);
    await pool.query("UPDATE users SET points = points + 150 WHERE id IN ($1, $2)", [sess.requester_id, sess.partner_id]);
    
    res.json({ success: true, points_earned: 150 });
  } catch (err) {
    res.status(500).json({ error: "Failed to complete" });
  }
});

// ============================================
// MESSAGES - FIXED
// ============================================

app.get("/messages/:userId", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.name as sender_name 
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE ((m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1))
       AND m.is_deleted = FALSE
       ORDER BY m.created_at ASC`,
      [req.user.userId, req.params.userId]
    );
    
    // Mark as read
    await pool.query(
      "UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2",
      [req.params.userId, req.user.userId]
    );
    
    res.json(result.rows);
  } catch (err) {
    console.error("Get messages error:", err);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

app.post("/messages", authenticateToken, async (req, res) => {
  const { receiver_id, message } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO messages (sender_id, receiver_id, message) 
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.userId, receiver_id, message]
    );
    
    const msgWithSender = { ...result.rows[0], sender_name: req.user.name };
    
    // Emit to receiver
    io.to(`user_${receiver_id}`).emit("new_message", msgWithSender);
    
    res.json(msgWithSender);
  } catch (err) {
    console.error("Send message error:", err);
    res.status(500).json({ error: "Failed to send message" });
  }
});

app.delete("/messages/:id", authenticateToken, async (req, res) => {
  try {
    const found = await pool.query(
      "SELECT id, sender_id, receiver_id FROM messages WHERE id = $1 AND sender_id = $2 AND is_deleted = FALSE",
      [req.params.id, req.user.userId]
    );
    if (found.rows.length === 0) {
      return res.status(404).json({ error: "Message not found" });
    }
    const { id, sender_id, receiver_id } = found.rows[0];
    await pool.query("UPDATE messages SET is_deleted = TRUE WHERE id = $1", [id]);
    const payload = { id, sender_id, receiver_id };
    io.to(`user_${receiver_id}`).emit("message_deleted", payload);
    io.to(`user_${sender_id}`).emit("message_deleted", payload);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete" });
  }
});

app.get("/chat-list", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.is_online,
        (SELECT message FROM messages 
         WHERE ((sender_id = u.id AND receiver_id = $1) OR (sender_id = $1 AND receiver_id = u.id))
         AND is_deleted = FALSE
         ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages 
         WHERE ((sender_id = u.id AND receiver_id = $1) OR (sender_id = $1 AND receiver_id = u.id))
         AND is_deleted = FALSE
         ORDER BY created_at DESC LIMIT 1) as last_message_time,
        (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = $1 AND is_read = FALSE) as unread_count
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
// SOCKET.IO - CLEAN
// ============================================

io.on("connection", (socket) => {
  socket.on("join", (userId) => {
    socket.join(`user_${userId}`);
    pool.query("UPDATE users SET is_online = TRUE WHERE id = $1", [userId]);
  });
  
  socket.on("typing", (data) => {
    socket.to(`user_${data.receiver_id}`).emit("typing", data);
  });

  socket.on("stop_typing", (data) => {
    if (data?.receiver_id != null) {
      socket.to(`user_${data.receiver_id}`).emit("stop_typing", data);
    }
  });

  socket.on("mark_read", (data) => {
    if (data?.sender_id != null) {
      socket.to(`user_${data.sender_id}`).emit("messages_read", {
        reader_id: data.reader_id
      });
    }
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected");
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
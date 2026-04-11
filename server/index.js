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
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

// Configuration
const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "skillswap",
  password: "RNTC143",
  port: 5432,
});

const JWT_SECRET = "your-secret-key-change-this-in-production";
const MIN_SESSION_DURATION = 900; // 15 minutes in seconds

// Middleware
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

// Test route
app.get("/", (req, res) => {
  res.send("Skill Swap Anti-Cheat Server Running 🚀");
});

// Database setup check
app.get("/setup", async (req, res) => {
  try {
    await pool.query("SELECT 1 FROM users LIMIT 1");
    res.send("✅ Database connected!");
  } catch (err) {
    res.status(500).send("❌ Database error: " + err.message);
  }
});

// Format duration helper
function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "00:00:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

// REGISTER
app.post("/register", async (req, res) => {
  const { name, email, password, bio, location, skills_have, skills_want } = req.body;
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    const userResult = await pool.query(
      `INSERT INTO users (name, email, password, bio, location) 
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, hashedPassword, bio || '', location || '']
    );
    
    const userId = userResult.rows[0].id;
    
    // Insert skills
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
    
    // Initialize user stats
    await pool.query("INSERT INTO user_stats (user_id) VALUES ($1)", [userId]);
    
    res.status(201).json({ success: true, userId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed: " + err.message });
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
    
    await pool.query("UPDATE users SET is_online = TRUE WHERE id = $1", [user.id]);
    
    const token = jwt.sign(
      { userId: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "24h" }
    );
    
    const skillsResult = await pool.query(
      "SELECT * FROM skills WHERE user_id = $1",
      [user.id]
    );
    
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
        stats: {
          total_sessions: user.total_sessions,
          avg_rating: user.avg_rating
        }
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed" });
  }
});

// GET CURRENT USER PROFILE
app.get("/profile", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    const userResult = await pool.query(
      `SELECT u.*, us.* 
       FROM users u 
       LEFT JOIN user_stats us ON u.id = us.user_id 
       WHERE u.id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const user = userResult.rows[0];
    
    const skillsResult = await pool.query(
      "SELECT * FROM skills WHERE user_id = $1",
      [userId]
    );
    
    const reviewsResult = await pool.query(
      `SELECT r.*, u.name as reviewer_name 
       FROM reviews r 
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.reviewee_id = $1 
       ORDER BY r.created_at DESC`,
      [userId]
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

// GET OTHER USER PROFILE BY ID
app.get("/user/:userId", authenticateToken, async (req, res) => {
  try {
    const userId = req.params.userId;
    
    const userResult = await pool.query(
      `SELECT u.*, us.* 
       FROM users u 
       LEFT JOIN user_stats us ON u.id = us.user_id 
       WHERE u.id = $1`,
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    
    const user = userResult.rows[0];
    
    const skillsResult = await pool.query(
      "SELECT * FROM skills WHERE user_id = $1",
      [userId]
    );
    
    const reviewsResult = await pool.query(
      `SELECT r.*, u.name as reviewer_name 
       FROM reviews r 
       JOIN users u ON r.reviewer_id = u.id
       WHERE r.reviewee_id = $1 
       ORDER BY r.created_at DESC`,
      [userId]
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
    const { location, min_rating } = req.query;
    
    const mySkills = await pool.query(
      "SELECT * FROM skills WHERE user_id = $1",
      [req.user.userId]
    );
    
    const myHave = mySkills.rows.filter(s => s.skill_type === 'have').map(s => s.skill_name.toLowerCase());
    const myWant = mySkills.rows.filter(s => s.skill_type === 'want').map(s => s.skill_name.toLowerCase());
    
    let query = `
      SELECT DISTINCT u.id, u.name, u.bio, u.location, u.points, u.level, u.is_online,
             COALESCE(us.average_rating_received, 0) as avg_rating,
             array_agg(DISTINCT CASE WHEN s.skill_type = 'have' THEN s.skill_name END) FILTER (WHERE s.skill_type = 'have') as skills_have,
             array_agg(DISTINCT CASE WHEN s.skill_type = 'want' THEN s.skill_name END) FILTER (WHERE s.skill_type = 'want') as skills_want
      FROM users u
      LEFT JOIN skills s ON u.id = s.user_id
      LEFT JOIN user_stats us ON u.id = us.user_id
      WHERE u.id != $1
    `;
    
    const params = [req.user.userId];
    
    if (location) {
      params.push(`%${location}%`);
      query += ` AND u.location ILIKE $${params.length}`;
    }
    
    if (min_rating) {
      params.push(min_rating);
      query += ` AND COALESCE(us.average_rating_received, 0) >= $${params.length}`;
    }
    
    query += ` GROUP BY u.id, us.average_rating_received`;
    
    const usersResult = await pool.query(query, params);
    
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

// AI SKILL SUGGESTIONS
app.get("/skill-suggestions/:input", async (req, res) => {
  const { input } = req.params;
  
  try {
    const result = await pool.query(
      `SELECT suggested_skill, category, relevance_score 
       FROM skill_suggestions 
       WHERE input_skill ILIKE $1 
       ORDER BY relevance_score DESC 
       LIMIT 5`,
      [input]
    );
    
    if (result.rows.length === 0) {
      const similar = await pool.query(
        `SELECT DISTINCT suggested_skill, category 
         FROM skill_suggestions 
         WHERE category IN (
           SELECT category FROM skill_suggestions 
           WHERE input_skill ILIKE $1 LIMIT 1
         ) LIMIT 5`,
        [input]
      );
      return res.json(similar.rows);
    }
    
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to get suggestions" });
  }
});

// CREATE SESSION WITH MEETING LINK
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
      [partner_id, `${req.user.name} wants to learn ${skill_taught} from you`, result.rows[0].id]
    );
    
    io.to(`user_${partner_id}`).emit("notification", {
      type: "session_request",
      message: `${req.user.name} requested a session`
    });
    
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to create session" });
  }
});

// GET USER SESSIONS
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

// ACCEPT SESSION
app.put("/sessions/:id/accept", authenticateToken, async (req, res) => {
  try {
    const session = await pool.query(
      "SELECT * FROM sessions WHERE id = $1 AND partner_id = $2 AND status = 'pending'",
      [req.params.id, req.user.userId]
    );
    
    if (session.rows.length === 0) {
      return res.status(403).json({ error: "Unauthorized or session not pending" });
    }
    
    let meetLink = session.rows[0].meeting_link;
    if (!meetLink) {
      meetLink = `https://meet.google.com/lookup/${Math.random().toString(36).substring(2, 10)}`;
    }
    
    await pool.query(
      "UPDATE sessions SET status = 'accepted', meeting_link = $1 WHERE id = $2",
      [meetLink, req.params.id]
    );
    
    const requesterId = session.rows[0].requester_id;
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_id) 
       VALUES ($1, 'session_accepted', 'Session Accepted', $2, $3)`,
      [requesterId, `${req.user.name} accepted your session. Meeting: ${meetLink}`, req.params.id]
    );
    
    io.to(`user_${requesterId}`).emit("notification", {
      type: "session_accepted",
      meeting_link: meetLink
    });
    
    res.json({ success: true, meeting_link: meetLink });
  } catch (err) {
    res.status(500).json({ error: "Failed to accept session" });
  }
});

// REJECT SESSION
app.put("/sessions/:id/reject", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "UPDATE sessions SET status = 'rejected' WHERE id = $1 AND partner_id = $2 AND status = 'pending' RETURNING *",
      [req.params.id, req.user.userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(403).json({ error: "Unauthorized" });
    }
    
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_id) 
       VALUES ($1, 'session_rejected', 'Session Rejected', $2, $3)`,
      [result.rows[0].requester_id, `${req.user.name} rejected your session`, req.params.id]
    );
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to reject session" });
  }
});

// START SESSION - TIMER BEGINS
app.post("/sessions/:id/start", authenticateToken, async (req, res) => {
  try {
    const session = await pool.query(
      `SELECT * FROM sessions 
       WHERE id = $1 
       AND (requester_id = $2 OR partner_id = $2) 
       AND status = 'accepted'`,
      [req.params.id, req.user.userId]
    );
    
    if (session.rows.length === 0) {
      return res.status(400).json({ error: "Session not found or not ready" });
    }
    
    const sess = session.rows[0];
    if (sess.actual_start_time) {
      return res.status(400).json({ error: "Session already started" });
    }
    
    const startTime = new Date();
    await pool.query(
      "UPDATE sessions SET status = 'ongoing', actual_start_time = $1 WHERE id = $2",
      [startTime, req.params.id]
    );
    
    await pool.query(
      `INSERT INTO verification_logs (session_id, user_id, action) 
       VALUES ($1, $2, 'session_started')`,
      [req.params.id, req.user.userId]
    );
    
    const otherUserId = sess.requester_id === req.user.userId ? sess.partner_id : sess.requester_id;
    io.to(`user_${otherUserId}`).emit("session_started", {
      session_id: req.params.id,
      start_time: startTime
    });
    
    res.json({ 
      success: true, 
      start_time: startTime,
      message: "Session started. Timer running."
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to start session" });
  }
});

// GET SESSION STATUS WITH LIVE TIMER
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
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    const sess = result.rows[0];
    const isRequester = sess.requester_id === req.user.userId;
    let durationSeconds = 0;
    
    if (sess.actual_start_time && sess.status === 'ongoing') {
      const now = new Date();
      const start = new Date(sess.actual_start_time);
      durationSeconds = Math.floor((now - start) / 1000);
    } else if (sess.actual_duration_seconds) {
      durationSeconds = sess.actual_duration_seconds;
    }
    
    res.json({
      id: sess.id,
      status: sess.status,
      skill_taught: sess.skill_taught,
      meeting_link: sess.meeting_link,
      start_time: sess.actual_start_time,
      end_time: sess.actual_end_time,
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

// COMPLETE SESSION - DUAL CONFIRMATION ANTI-CHEAT
app.post("/sessions/:id/complete", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    const { proof_image } = req.body;
    
    const session = await client.query(
      `SELECT * FROM sessions 
       WHERE id = $1 
       AND (requester_id = $2 OR partner_id = $2) 
       AND status = 'ongoing'`,
      [req.params.id, req.user.userId]
    );
    
    if (session.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Session not ongoing or unauthorized" });
    }
    
    const sess = session.rows[0];
    const isRequester = sess.requester_id === req.user.userId;
    const otherUserId = isRequester ? sess.partner_id : sess.requester_id;
    const confirmationField = isRequester ? 'requester_confirmed' : 'partner_confirmed';
    
    // Calculate duration
    const now = new Date();
    const start = new Date(sess.actual_start_time);
    const durationSeconds = Math.floor((now - start) / 1000);
    
    // ANTI-CHEAT: Check minimum time (15 minutes)
    if (durationSeconds < MIN_SESSION_DURATION) {
      await client.query(
        `UPDATE sessions 
         SET cheating_flags = cheating_flags || $1::jsonb,
             status = 'invalid'
         WHERE id = $2`,
        [JSON.stringify([`insufficient_time: ${durationSeconds}s < ${MIN_SESSION_DURATION}s required`]), req.params.id]
      );
      
      await client.query('COMMIT');
      return res.status(400).json({ 
        error: "Session too short", 
        message: `Minimum ${MIN_SESSION_DURATION/60} minutes required. You only completed ${Math.floor(durationSeconds/60)} minutes.`,
        duration: durationSeconds
      });
    }
    
    // Update confirmation
    await client.query(
      `UPDATE sessions 
       SET ${confirmationField} = TRUE,
           actual_end_time = $1,
           actual_duration_seconds = $2,
           proof_image_url = COALESCE($3, proof_image_url)
       WHERE id = $4`,
      [now, durationSeconds, proof_image, req.params.id]
    );
    
    await client.query(
      `INSERT INTO verification_logs (session_id, user_id, action) 
       VALUES ($1, $2, 'completion_initiated')`,
      [req.params.id, req.user.userId]
    );
    
    // Check if both confirmed
    const updated = await client.query(
      "SELECT requester_confirmed, partner_confirmed FROM sessions WHERE id = $1",
      [req.params.id]
    );
    
    const bothConfirmed = updated.rows[0].requester_confirmed && updated.rows[0].partner_confirmed;
    
    if (bothConfirmed) {
      // VALID COMPLETION
      await client.query(
        `UPDATE sessions 
         SET status = 'completed', is_valid = TRUE 
         WHERE id = $1`,
        [req.params.id]
      );
      
      // Award points
      await client.query(
        "UPDATE users SET points = points + 150 WHERE id IN ($1, $2)",
        [sess.requester_id, sess.partner_id]
      );
      
      // Update stats
      await client.query(
        `UPDATE user_stats 
         SET total_sessions = total_sessions + 1,
             total_hours_spent = total_hours_spent + $3
         WHERE user_id IN ($1, $2)`,
        [sess.requester_id, sess.partner_id, Math.ceil(durationSeconds/3600)]
      );
      
      // Notifications
      await client.query(
        `INSERT INTO notifications (user_id, type, title, message) 
         VALUES ($1, 'session_completed', 'Session Validated!', $2),
                ($3, 'session_completed', 'Session Validated!', $4)`,
        [
          sess.requester_id, 
          `Session completed! +150 points earned.`,
          sess.partner_id,
          `Session completed! +150 points earned.`
        ]
      );
      
      io.to(`user_${sess.requester_id}`).emit("session_completed", {
        valid: true,
        points: 150
      });
      
      io.to(`user_${sess.partner_id}`).emit("session_completed", {
        valid: true,
        points: 150
      });
      
      await client.query('COMMIT');
      
      res.json({
        success: true,
        validated: true,
        message: "Session validated! Both users confirmed.",
        points_earned: 150,
        both_confirmed: true
      });
    } else {
      await client.query('COMMIT');
      
      io.to(`user_${otherUserId}`).emit("confirmation_needed", {
        session_id: req.params.id
      });
      
      res.json({
        success: true,
        validated: false,
        message: "Waiting for partner confirmation...",
        both_confirmed: false
      });
    }
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: "Failed to complete session" });
  } finally {
    client.release();
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
    
    if (session.rows.length === 0) {
      return res.status(400).json({ error: "Can only review completed valid sessions" });
    }
    
    const result = await pool.query(
      `INSERT INTO reviews (session_id, reviewer_id, reviewee_id, rating, feedback) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [session_id, req.user.userId, reviewee_id, rating, feedback]
    );
    
    // Update average rating
    await pool.query(
      `UPDATE user_stats 
       SET average_rating_received = (SELECT AVG(rating) FROM reviews WHERE reviewee_id = $1)
       WHERE user_id = $1`,
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
      `SELECT * FROM notifications 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 20`,
      [req.user.userId]
    );
    
    const unread = await pool.query(
      "SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND is_read = FALSE",
      [req.user.userId]
    );
    
    res.json({
      notifications: result.rows,
      unread_count: parseInt(unread.rows[0].count)
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.put("/notifications/:id/read", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      "UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2",
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to update" });
  }
});

// MESSAGES
app.get("/messages/:userId", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, u.name as sender_name
       FROM messages m
       JOIN users u ON m.sender_id = u.id
       WHERE (m.sender_id = $1 AND m.receiver_id = $2) OR (m.sender_id = $2 AND m.receiver_id = $1)
       ORDER BY m.created_at ASC`,
      [req.user.userId, req.params.userId]
    );
    
    await pool.query(
      "UPDATE messages SET is_read = TRUE WHERE sender_id = $1 AND receiver_id = $2 AND is_read = FALSE",
      [req.params.userId, req.user.userId]
    );
    
    res.json(result.rows);
  } catch (err) {
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
    
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message) 
       VALUES ($1, 'message', 'New Message', $2)`,
      [receiver_id, `New message from ${req.user.name}`]
    );
    
    io.to(`user_${receiver_id}`).emit("new_message", {
      ...result.rows[0],
      sender_name: req.user.name
    });
    
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to send message" });
  }
});

app.get("/chat-list", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT u.id, u.name, u.is_online,
        (SELECT message FROM messages 
         WHERE ((sender_id = u.id AND receiver_id = $1) OR (sender_id = $1 AND receiver_id = u.id))
         ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = $1 AND is_read = FALSE) as unread_count
       FROM users u
       JOIN messages m ON (m.sender_id = u.id AND m.receiver_id = $1) OR (m.sender_id = $1 AND m.receiver_id = u.id)
       WHERE u.id != $1`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch chat list" });
  }
});

// ANALYTICS
app.get("/analytics", authenticateToken, async (req, res) => {
  try {
    const stats = await pool.query(
      `SELECT us.*, u.points, u.level
       FROM user_stats us
       JOIN users u ON us.user_id = u.id
       WHERE u.id = $1`,
      [req.user.userId]
    );
    
    const recentActivity = await pool.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM sessions
       WHERE (requester_id = $1 OR partner_id = $1) 
       AND created_at > CURRENT_DATE - INTERVAL '7 days'
       GROUP BY DATE(created_at)`,
      [req.user.userId]
    );
    
    const leaderboard = await pool.query(
      `SELECT name, points, level FROM users ORDER BY points DESC LIMIT 10`
    );
    
    res.json({
      stats: stats.rows[0],
      recent_activity: recentActivity.rows,
      leaderboard: leaderboard.rows
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch analytics" });
  }
});

// Socket.io
io.on("connection", (socket) => {
  console.log("Connected:", socket.id);
  
  socket.on("join", (userId) => {
    socket.join(`user_${userId}`);
  });
  
  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

server.listen(5000, () => {
  console.log("🚀 Anti-Cheat Skill Swap Server on port 5000");
});
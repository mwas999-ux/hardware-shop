require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Resend } = require('resend');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));
app.use(passport.initialize());

// ── DATABASE ──
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) { console.log('DB connection failed:', err); return; }
    console.log('Connected to PostgreSQL!');
    release();
});

// ── CREATE TABLES ──
pool.query(`
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    stock INT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255),
    google_id VARCHAR(100),
    is_verified BOOLEAN DEFAULT FALSE,
    verify_token VARCHAR(255),
    reset_token VARCHAR(255),
    reset_expires TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('Tables ready!'))
    .catch(err => console.log('Table error:', err));

// ── EMAIL SETUP (Resend) ──
const resend = new Resend(process.env.RESEND_API_KEY);

// ── JWT MIDDLEWARE ──
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token' });
    }
}

// ── GOOGLE OAUTH STRATEGY ──
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: 'https://hardware-shop-ksvk.onrender.com/auth/google/callback'
}, async (accessToken, refreshToken, profile, done) => {
    try {
        const email = profile.emails[0].value;
        const name = profile.displayName;
        const googleId = profile.id;

        let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        if (result.rows.length > 0) {
            if (!result.rows[0].google_id) {
                await pool.query('UPDATE users SET google_id = $1, is_verified = TRUE WHERE email = $2', [googleId, email]);
            }
            return done(null, result.rows[0]);
        }

        const newUser = await pool.query(
            'INSERT INTO users (name, email, google_id, is_verified) VALUES ($1, $2, $3, TRUE) RETURNING *',
            [name, email, googleId]
        );

        return done(null, newUser.rows[0]);
    } catch (err) {
        return done(err, null);
    }
}));

// ── PRODUCTS ──
app.get('/products', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM products');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── AUTH ROUTES ──

// REGISTER
app.post('/auth/register', async (req, res) => {
    const { name, phone, email, password } = req.body;
    if (!name || !phone || !email || !password) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    try {
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR phone = $2', [email, phone]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Account with this email or phone already exists' });
        }
        const hashedPassword = await bcrypt.hash(password, 12);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
        const result = await pool.query(
            'INSERT INTO users (name, phone, email, password, verify_token, reset_expires) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, name, email',
            [name, phone, email, hashedPassword, otp, otpExpires]
        );
        await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: email,
            subject: '✅ Your Mwangi Hardware verification code',
            html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
          <h2 style="color:#ff6a00">Welcome to Mwangi Hardware, ${name}! 🔨</h2>
          <p>Your verification code is:</p>
          <div style="font-size:2.5rem;font-weight:bold;color:#ff6a00;letter-spacing:12px;margin:20px 0;text-align:center">${otp}</div>
          <p style="color:#666">This code expires in <strong>10 minutes</strong>. Do not share it with anyone.</p>
        </div>
    `
        });
        res.status(201).json({ message: 'Account created! Enter the OTP sent to your email.', email });
    } catch (err) {
        console.log('Register error:', err);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

// VERIFY OTP
app.post('/auth/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ error: 'Email and OTP are required' });
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 AND verify_token = $2 AND reset_expires > NOW()',
            [email, otp]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.' });
        }
        await pool.query(
            'UPDATE users SET is_verified = TRUE, verify_token = NULL, reset_expires = NULL WHERE email = $1',
            [email]
        );
        res.json({ message: 'Email verified successfully! You can now login.' });
    } catch (err) {
        console.log('OTP verify error:', err);
        res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});


// LOGIN
app.post('/auth/login', async (req, res) => {
    const { identifier, password } = req.body;
    if (!identifier || !password) {
        return res.status(400).json({ error: 'Please provide email/phone and password' });
    }
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1 OR phone = $1', [identifier]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'No account found with this email or phone' });
        }
        const user = result.rows[0];
        if (!user.password) {
            return res.status(401).json({ error: 'This account uses Google login. Please sign in with Google.' });
        }
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Incorrect password' });
        }
        if (!user.is_verified) {
            return res.status(403).json({ error: 'Please verify your email before logging in' });
        }
        const token = jwt.sign(
            { id: user.id, name: user.name, email: user.email, phone: user.phone },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({
            message: 'Login successful!',
            token,
            user: { id: user.id, name: user.name, email: user.email, phone: user.phone }
        });
    } catch (err) {
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// FORGOT PASSWORD
app.post('/auth/forgot-password', async (req, res) => {
    console.log('Forgot password request received for:', req.body.email);
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'No account found with this email' });
        }
        const resetToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        const resetExpires = new Date(Date.now() + 3600000);
        await pool.query(
            'UPDATE users SET reset_token = $1, reset_expires = $2 WHERE email = $3',
            [resetToken, resetExpires, email]
        );
        const resetUrl = `${process.env.FRONTEND_URL}/hardware-shop/reset-password.html?token=${resetToken}`;
        console.log('Attempting to send email via Resend...');
        await resend.emails.send({
            from: 'onboarding@resend.dev',
            to: email,
            subject: '🔐 Reset your Mwangi Hardware password',
            html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
          <h2 style="color:#ff6a00">Password Reset Request 🔐</h2>
          <p>Click the button below to reset your password. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#ff6a00;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
            Reset My Password
          </a>
        </div>
      `
        });
        console.log('Email sent successfully to:', email);
        res.json({ message: 'Password reset link sent to your email!' });
    } catch (err) {
        console.log('Forgot password error:', err);
        res.status(500).json({ error: 'Failed to send reset email. Please try again.' });
    }
});

// RESET PASSWORD
app.post('/auth/reset-password', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });
    try {
        const result = await pool.query(
            'SELECT * FROM users WHERE reset_token = $1 AND reset_expires > NOW()', [token]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid or expired reset link' });
        }
        const hashedPassword = await bcrypt.hash(password, 12);
        await pool.query(
            'UPDATE users SET password = $1, reset_token = NULL, reset_expires = NULL WHERE reset_token = $2',
            [hashedPassword, token]
        );
        res.json({ message: 'Password reset successfully! You can now login.' });
    } catch (err) {
        res.status(500).json({ error: 'Password reset failed. Please try again.' });
    }
});

// GOOGLE AUTH ROUTES
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

app.get('/auth/google/callback',
    passport.authenticate('google', { session: false, failureRedirect: `${process.env.FRONTEND_URL}?error=google_failed` }),
    (req, res) => {
        const user = req.user;
        const token = jwt.sign(
            { id: user.id, name: user.name, email: user.email, phone: user.phone || '' },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.redirect(`${process.env.FRONTEND_URL}?token=${token}&name=${encodeURIComponent(user.name)}&email=${encodeURIComponent(user.email)}`);
    }
);

// ── START SERVER ──
app.listen(3000, () => {
    console.log('Server running on port 3000');
});
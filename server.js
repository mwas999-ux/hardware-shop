require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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
    phone VARCHAR(20) UNIQUE NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    is_verified BOOLEAN DEFAULT FALSE,
    verify_token VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW()
  );
`).then(() => console.log('Tables ready!'))
    .catch(err => console.log('Table error:', err));

// ── EMAIL SETUP ──
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ── MIDDLEWARE: Verify JWT ──
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

// ── PRODUCTS ROUTES ──
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
        // Check if user exists
        const existing = await pool.query(
            'SELECT id FROM users WHERE email = $1 OR phone = $2',
            [email, phone]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Account with this email or phone already exists' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 12);

        // Generate verification token
        const verifyToken = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);

        // Save user
        const result = await pool.query(
            'INSERT INTO users (name, phone, email, password, verify_token) VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email',
            [name, phone, email, hashedPassword, verifyToken]
        );

        const user = result.rows[0];

        // Send verification email
        const verifyUrl = `https://hardware-shop-ksvk.onrender.com/auth/verify/${verifyToken}`;

        await transporter.sendMail({
            from: `"Mwangi Hardware" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: '✅ Verify your Mwangi Hardware account',
            html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:20px">
          <h2 style="color:#ff6a00">Welcome to Mwangi Hardware, ${name}! 🔨</h2>
          <p>Thank you for creating an account. Please verify your email to get started.</p>
          <a href="${verifyUrl}" style="display:inline-block;background:#ff6a00;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;margin:16px 0">
            ✅ Verify My Email
          </a>
          <p style="color:#888;font-size:13px">If you didn't create this account, ignore this email.</p>
        </div>
      `
        });

        res.status(201).json({
            message: 'Account created! Please check your email to verify your account.',
            user: { id: user.id, name: user.name, email: user.email }
        });

    } catch (err) {
        console.log('Register error:', err);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

// VERIFY EMAIL
app.get('/auth/verify/:token', async (req, res) => {
    const { token } = req.params;
    try {
        const result = await pool.query(
            'UPDATE users SET is_verified = TRUE, verify_token = NULL WHERE verify_token = $1 RETURNING name',
            [token]
        );

        if (result.rows.length === 0) {
            return res.send('<h2>Invalid or expired verification link.</h2>');
        }

        res.send(`
      <div style="font-family:Arial,sans-serif;text-align:center;padding:60px 20px">
        <h2 style="color:#16a34a">✅ Email Verified Successfully!</h2>
        <p>Welcome to Mwangi Hardware, ${result.rows[0].name}!</p>
        <p>You can now <a href="https://freddymwas.netlify.app" style="color:#ff6a00;font-weight:bold">login to your account</a>.</p>
      </div>
    `);
    } catch (err) {
        res.status(500).send('<h2>Verification failed. Please try again.</h2>');
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
            'SELECT * FROM users WHERE email = $1 OR phone = $1',
            [identifier]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'No account found with this email or phone' });
        }

        const user = result.rows[0];

        // Check password
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Incorrect password' });
        }

        // Check if verified
        if (!user.is_verified) {
            return res.status(403).json({ error: 'Please verify your email before logging in' });
        }

        // Generate JWT token
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
        console.log('Login error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

// GET PROFILE (protected route)
app.get('/auth/profile', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, phone, created_at FROM users WHERE id = $1',
            [req.user.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── START SERVER ──
app.listen(3000, () => {
    console.log('Server running on port 3000');
});
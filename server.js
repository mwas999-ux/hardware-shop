const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Connect to PostgreSQL database
const pool = new Pool({
    connectionString: 'postgresql://hardware_shop_db_user:ccGK1r5jMATFmkFVm2bpjbVMC69f0Doy@dpg-d7d5sad7vvec73em4vr0-a.oregon-postgres.render.com/hardware_shop_db',
    ssl: {
        rejectUnauthorized: false
    }
});

// Test connection
pool.connect((err, client, release) => {
    if (err) {
        console.log('Database connection failed:', err);
        return;
    }
    console.log('Connected to PostgreSQL database successfully!');
    release();
});

// Create products table if it doesn't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    category VARCHAR(50) NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    stock INT NOT NULL
  )
`).then(() => {
    console.log('Products table ready!');
}).catch(err => console.log('Table error:', err));

// Route to get all products
app.get('/products', async (req, res) => {
    try {
        const results = await pool.query('SELECT * FROM products');
        res.json(results.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server
app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
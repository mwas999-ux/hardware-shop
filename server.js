const express = require('express');
const mysql2 = require('mysql2');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const db = mysql2.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'hardware_shop'
});

db.connect((err) => {
    if (err) {
        console.log('Database connection failed:', err);
        return;
    }
    console.log('Connected to MySQL database!');
});

app.get('/products', (req, res) => {
    db.query('SELECT * FROM products', (err, results) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        res.json(results);
    });
});

app.listen(3000, () => {
    console.log('Server running on http://localhost:3000');
});
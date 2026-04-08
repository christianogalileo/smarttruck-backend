// smart-truck-backend/db.js
const mysql = require('mysql2');

// Buat koneksi database
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '', // isi jika pakai password
  database: 'smart_truck_db'
});

// Tes koneksi
connection.connect((err) => {
  if (err) {
    console.error('❌ Error connecting to MySQL:', err.message);
    process.exit(1); // hentikan proses jika koneksi gagal
  } else {
    console.log('✅ MySQL Connected to smart_truck_db');
  }
});

module.exports = connection;

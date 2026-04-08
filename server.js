  const express = require('express');
  const mysql = require('mysql2');
  const cors = require('cors');
  const multer = require('multer');
  const path = require('path');
  const fs = require('fs');
  const { Parser } = require('json2csv');
  const db = require('./db');
  const trackingRouter = require('./routes/tracking');
  const ExcelJS = require('exceljs');
  const bcrypt = require('bcrypt'); // letakkan setelah require lainnya

 

  const app = express();
  const PORT = 5000;

  app.use(cors());
  app.use(express.json());

  // Static uploads folder
  const uploadPath = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath);
  app.use('/uploads', express.static(uploadPath));

  app.use((req, res, next) => {
    console.log(`Incoming request: ${req.method} ${req.url}`);
    next();
  });

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadPath),
      filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
    }),
  });

  // ================= REGISTER ====================
  app.post('/api/register', async (req, res) => { // ubah function jadi async
  const { email, password, role } = req.body;
  if (!email || !password || !role) {
    return res.status(400).json({ message: 'Email, password, dan role wajib diisi' });
  }

  const checkEmail = 'SELECT * FROM users WHERE email = ?';
  db.query(checkEmail, [email], async (err, results) => {
    if (err) return res.status(500).json({ message: 'Gagal memeriksa email' });
    if (results.length > 0) return res.status(400).json({ message: 'Email sudah terdaftar' });

    try {
      const hashedPassword = await bcrypt.hash(password, 10); // hash password
      const insertUser = 'INSERT INTO users (email, password, role) VALUES (?, ?, ?)';
      db.query(insertUser, [email, hashedPassword, role], (err) => {
        if (err) return res.status(500).json({ message: 'Gagal registrasi user' });
        res.status(201).json({ message: 'Registrasi berhasil' });
      });
    } catch (hashErr) {
      res.status(500).json({ message: 'Gagal hash password', error: hashErr.message });
    }
  });
});


app.post('/api/login', async (req, res) => {
  try {
    const email = (req.body.email || "").trim();
    const password = (req.body.password || "").trim();

    if (!email || !password) {
      return res.status(400).json({ message: 'Email dan password wajib diisi' });
    }

    const [users] = await db.promise().query(
      'SELECT id, email, password, IFNULL(role,"") AS role FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({ message: 'Email atau password salah' });
    }

    const user = users[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ message: 'Email atau password salah' });
    }

    // Login berhasil, kirim hanya email & id, role optional
    res.status(200).json({
      message: 'Login berhasil',
      user: {
        id: user.id,
        email: user.email,
        role: user.role || null
      }
    });

  } catch (error) {
    console.error('❌ Error login:', error);
    res.status(500).json({ message: 'Terjadi kesalahan server' });
  }
});



  // ================= GET TRUCKS WITH TRACKING STATUS ====================
  app.get('/api/trucks', (req, res) => {
    let baseSql = `
      SELECT t.*, td_latest.status AS current_status
      FROM trucks t
      LEFT JOIN (
        SELECT td1.truck_id, td1.status
        FROM tracking_data td1
        INNER JOIN (
          SELECT truck_id, MAX(id) as max_id
          FROM tracking_data
          GROUP BY truck_id
        ) td2 
        ON td1.truck_id = td2.truck_id AND td1.id = td2.max_id
      ) td_latest
      ON t.truckId = td_latest.truck_id
    `;

    const { status, date } = req.query;
    const values = [];

    if (date) {
      baseSql += " WHERE t.date = ?";
      values.push(date);
    }

    if (status) {
      baseSql += " HAVING LOWER(current_status) = LOWER(?)";
      values.push(status);
    }

    db.query(baseSql, values, (err, results) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ message: 'Server error', error: err });
      }

      const data = results.map(truck => ({
        truckId: truck.truckId,
        truckType: truck.truckType,
        driver: truck.driver,
        plateNumber: truck.plateNumber,   // ✅ Tambahin ini
        status: truck.current_status || 'Unknown',
        date: truck.date,
        image_url: truck.image_path ? `http://localhost:${PORT}/uploads/${truck.image_path}` : null
      }));


      res.json(data);
    });
  });

  // Handler export Excel
const exportExcelHandler = async (req, res) => {
  try {
    // Express biasanya sudah decode params, tapi untuk aman:
    const truckId = decodeURIComponent(req.params.truckId);
    console.log('Export Excel requested for truckId:', truckId);

    // Ambil data checkpoints (urut sesuai urutan checkpoint)
    const checkpointsQuery = `
      SELECT * FROM checkpoints
      WHERE truckId = ?
      ORDER BY FIELD(checkpoint, 'Checkpoint 1','Checkpoint 2','Checkpoint 3','Checkpoint 4'), timestamp ASC
    `;
    const [checkpoints] = await db.promise().query(checkpointsQuery, [truckId]);

    // Ambil data timbang muat
    const loadingsQuery = `
      SELECT * FROM timbang_muat
      WHERE truckId = ?
      ORDER BY id ASC
    `;
    const [loadings] = await db.promise().query(loadingsQuery, [truckId]);

    // Buat workbook
    const workbook = new ExcelJS.Workbook();

    // --- Sheet 1: Checkpoints
    const cpSheet = workbook.addWorksheet('Checkpoints');
    cpSheet.addRow(['No', 'Truck ID', 'Checkpoint', 'Timestamp']);
    cpSheet.getRow(1).font = { bold: true };

    if (Array.isArray(checkpoints) && checkpoints.length > 0) {
      checkpoints.forEach((cp, idx) => {
        const ts = cp.timestamp ? new Date(cp.timestamp).toLocaleString() : '';
        cpSheet.addRow([idx + 1, cp.truckId || '', cp.checkpoint || '', ts]);
      });
    }

    cpSheet.columns = [
      { key: 'no', width: 6 },
      { key: 'truckId', width: 20 },
      { key: 'checkpoint', width: 30 },
      { key: 'timestamp', width: 30 }
    ];

    // --- Sheet 2: Timbang Muat
    const tmSheet = workbook.addWorksheet('Timbang Muat');
    tmSheet.addRow(['No', 'Truck ID', 'Item', 'Qty', 'Bruto', 'Tara', 'Netto', 'Unit']);
    tmSheet.getRow(1).font = { bold: true };

    if (Array.isArray(loadings) && loadings.length > 0) {
      loadings.forEach((l, idx) => {
        tmSheet.addRow([
          idx + 1,
          l.truckId || '',
          l.itemType || '',
          l.quantity != null ? l.quantity : '',
          l.bruto != null ? l.bruto : '',
          l.tara != null ? l.tara : '',
          l.netto != null ? l.netto : '',
          l.unit || ''
        ]);
      });
    }

    tmSheet.columns = [
      { key: 'no', width: 6 },
      { key: 'truckId', width: 18 },
      { key: 'item', width: 24 },
      { key: 'qty', width: 8 },
      { key: 'bruto', width: 12 },
      { key: 'tara', width: 12 },
      { key: 'netto', width: 12 },
      { key: 'unit', width: 10 }
    ];

    // Set response headers (Excel)
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    const safeFilename = `truck-${encodeURIComponent(truckId)}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);

    // Tulis workbook ke response
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('Error exporting Excel:', err);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Gagal export Excel', error: err.message });
    } else {
      try { res.end(); } catch (e) {}
    }
  }
};

// ================= REGISTER ROUTES ====================
// ⚠️ Penting: letakkan route export di atas route umum seperti `/api/trucks/:truckId`
app.get('/api/export/truck/:truckId/excel', exportExcelHandler);
app.get('/api/export/truck/:truckId', exportExcelHandler);

  // ================= GET SINGLE TRUCK ====================
  app.get('/api/trucks/:truckId', (req, res) => {
    const { truckId } = req.params;
    const sql = 'SELECT * FROM trucks WHERE truckId = ?';
    db.query(sql, [truckId], (err, results) => {
      if (err) return res.status(500).json({ message: 'Server error' });
      if (results.length === 0) return res.status(404).json({ message: 'Truck tidak ditemukan' });

      const truck = results[0];
      res.json({
        truckId: truck.truckId,
        truckType: truck.truckType,
        driver: truck.driver,
        plateNumber: truck.plateNumber,   // ✅ tambahin
        status: truck.status,
        date: truck.date,
        image_url: truck.image_path ? `http://localhost:${PORT}/uploads/${truck.image_path}` : null
      });
    });
  });


  // ================= INSERT OR UPDATE TRUCK ====================
  // ================= INSERT OR UPDATE TRUCK ====================
  app.post('/api/trucks', upload.single('image'), (req, res) => {
    const { truckId, truckType, driver, plateNumber, status, date } = req.body; // ✅ tambah plateNumber
    const image = req.file ? req.file.filename : null;

    if (!truckId || !truckType || !driver || !plateNumber || !status || !date) {
      return res.status(400).json({ message: 'Semua field wajib diisi (termasuk plat nomor)' });
    }

    const checkTruck = 'SELECT * FROM trucks WHERE truckId = ?';
    db.query(checkTruck, [truckId], (err, results) => {
      if (err) return res.status(500).json({ message: 'Gagal cek data truck' });

      if (results.length > 0) {
        // === Update truck lama ===
        const oldImage = results[0].image_path;
        if (image && oldImage) {
          const oldImagePath = path.join(uploadPath, oldImage);
          if (fs.existsSync(oldImagePath)) {
            fs.unlink(oldImagePath, () => {});
          }
        }

        const updateTruck = `
          UPDATE trucks 
          SET truckType = ?, driver = ?, plateNumber = ?, status = ?, date = ?, image_path = ?
          WHERE truckId = ?
        `;
        const updateValues = [truckType, driver, plateNumber, status, date, image || oldImage, truckId];

        db.query(updateTruck, updateValues, (err) => {
          if (err) return res.status(500).json({ message: 'Gagal update truck' });

          const insertTracking = 'INSERT INTO tracking_data (truck_id, status, location) VALUES (?, ?, ?)';
          db.query(insertTracking, [truckId, status, 'Warehouse'], (err) => {
            if (err) return res.status(500).json({ message: 'Gagal simpan tracking data' });
            res.status(200).json({ message: 'Truck berhasil diupdate & tracking ditambahkan' });
          });
        });

      } else {
        // === Insert truck baru ===
        const insertTruck = `
          INSERT INTO trucks (truckId, truckType, driver, plateNumber, status, date, image_path)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        const insertValues = [truckId, truckType, driver, plateNumber, status, date, image];

        db.query(insertTruck, insertValues, (err) => {
          if (err) return res.status(500).json({ message: 'Gagal insert truck' });

          const insertTracking = 'INSERT INTO tracking_data (truck_id, status, location) VALUES (?, ?, ?)';
          db.query(insertTracking, [truckId, status, 'Warehouse'], (err) => {
            if (err) return res.status(500).json({ message: 'Gagal simpan tracking data' });
            res.status(201).json({ message: 'Truck & Tracking berhasil disimpan' });
          });
        });
      }
    });
  });


  // ================= UPDATE TRUCK (PUT) ====================
  app.put('/api/trucks/:truckId', upload.single('image'), (req, res) => {
    const { truckId } = req.params;
    const { truckType, driver, plateNumber, status, date } = req.body; // ✅ tambah plateNumber
    const image = req.file ? req.file.filename : null;

    let sql = `
      UPDATE trucks 
      SET truckType = ?, driver = ?, plateNumber = ?, status = ?, date = ?
    `;
    const values = [truckType, driver, plateNumber, status, date];

    if (image) {
      sql += ', image_path = ?';
      values.push(image);
    }

    sql += ' WHERE truckId = ?';
    values.push(truckId);

    db.query(sql, values, (err, result) => {
      if (err) {
        console.error('Error updating truck data:', err);
        return res.status(500).json({ message: 'Failed to update truck' });
      }

      res.json({ message: 'Truck updated successfully' });
    });
  });


  // ================= DELETE TRUCK ====================
  app.delete('/api/trucks/:truckId', (req, res) => {
    const { truckId } = req.params;

    // Ambil image_path terlebih dahulu
    const sqlSelect = 'SELECT image_path FROM trucks WHERE truckId = ?';
    db.query(sqlSelect, [truckId], (err, results) => {
      if (err) return res.status(500).json({ message: 'Gagal cek data truck' });

      if (results.length === 0) {
        return res.status(404).json({ message: 'Truck tidak ditemukan' });
      }

      const imagePath = results[0].image_path;

      // Hapus data tracking_data yang terkait
      const sqlDeleteTracking = 'DELETE FROM tracking_data WHERE truck_id = ?';
      db.query(sqlDeleteTracking, [truckId], (err) => {
        if (err) return res.status(500).json({ message: 'Gagal hapus tracking_data' });

        // Hapus data checkpoints yang terkait
        const sqlDeleteCheckpoints = 'DELETE FROM checkpoints WHERE truckId = ?';
        db.query(sqlDeleteCheckpoints, [truckId], (err) => {
          if (err) return res.status(500).json({ message: 'Gagal hapus checkpoints' });

          // Setelah semua relasi dihapus, baru hapus data trucks
          const sqlDeleteTruck = 'DELETE FROM trucks WHERE truckId = ?';
          db.query(sqlDeleteTruck, [truckId], (err) => {
            if (err) return res.status(500).json({ message: 'Gagal hapus truck' });

            // Terakhir, hapus file gambar (jika ada)
            if (imagePath) {
              const fullImagePath = path.join(uploadPath, imagePath);
              fs.unlink(fullImagePath, (unlinkErr) => {
                if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                  console.error('Gagal hapus file gambar:', unlinkErr);
                }
              });
            }

            res.json({ message: 'Truck berhasil dihapus beserta data terkait' });
          });
        });
      });
    });
  });


  // ================= RFID GET ====================
  // ================= RFID GET ====================
  app.get('/api/rfid/latest', (req, res) => {
    const getFirstRFID = 'SELECT * FROM rfid_logs ORDER BY id ASC LIMIT 1';
    db.query(getFirstRFID, (err, results) => {
      if (err) return res.status(500).json({ message: 'Gagal mengambil data RFID' });

      if (results.length === 0) {
        return res.status(404).json({ message: 'Belum ada data RFID' });
      }

      const firstRow = results[0];
      const rfidCode = firstRow.rfid_code;

      const checkTruck = 'SELECT * FROM trucks WHERE truckId = ?';
      db.query(checkTruck, [rfidCode], (err, truckResults) => {
        if (err) return res.status(500).json({ message: 'Gagal cek data truck' });

        db.query('DELETE FROM rfid_logs WHERE id = ?', [firstRow.id], (err) => {
          if (err) return res.status(500).json({ message: 'Gagal hapus data RFID' });

          if (truckResults.length === 0) {
            return res.json({ id: firstRow.id, rfid: rfidCode });
          } else {
            const truck = truckResults[0];
            return res.json({
              truck: {
                truckId: truck.truckId,
                truckType: truck.truckType,
                driver: truck.driver,
                plateNumber: truck.plateNumber, // ✅ plat nomor
                status: truck.status,
                date: truck.date,
                image_url: truck.image_path ? `http://localhost:${PORT}/uploads/${truck.image_path}` : null
              }
            });
          }
        });
      });
    });
  });


  // ================= RFID POST ====================
  app.post('/api/rfid/latest', (req, res) => {
    const { rfid } = req.body;
    if (!rfid) return res.status(400).json({ message: 'RFID tidak valid' });

    db.query('DELETE FROM rfid_logs', (err) => {
      if (err) return res.status(500).json({ message: 'Gagal hapus data lama' });

      db.query('INSERT INTO rfid_logs (rfid_code) VALUES (?)', [rfid], (err) => {
        if (err) return res.status(500).json({ message: 'Gagal simpan RFID' });
        res.status(201).json({ message: 'RFID berhasil disimpan' });
      });
    });
  });


  // ================= CHECKPOINT POST ====================
  app.post('/api/checkpoint', (req, res) => {
    const { rfid, checkpoint } = req.body;
    if (!rfid || !checkpoint) {
      return res.status(400).json({ message: 'RFID dan checkpoint wajib diisi' });
    }

    const checkTruck = 'SELECT * FROM trucks WHERE truckId = ?';
    db.query(checkTruck, [rfid], (err, truckResults) => {
      if (err) return res.status(500).json({ message: 'Gagal cek data truck' });

      if (truckResults.length === 0) {
        return res.status(404).json({ message: 'Data truck tidak ditemukan untuk RFID ini' });
      }

      const truck = truckResults[0];

  // Ambil checkpoint terakhir untuk truck ini
  const lastCheckpointQuery = 'SELECT checkpoint FROM checkpoints WHERE truckId = ? ORDER BY timestamp DESC LIMIT 1';
  db.query(lastCheckpointQuery, [truck.truckId], (err, checkpointResults) => {
    if (err) return res.status(500).json({ message: 'Gagal mengambil data checkpoint terakhir' });

    let lastCheckpoint = checkpointResults.length > 0 ? checkpointResults[0].checkpoint : null;

    // Daftar urutan checkpoint
    const checkpointOrder = ["Checkpoint 1", "Checkpoint 2", "Checkpoint 3", "Checkpoint 4"];
    
    // Cari index dari checkpoint sebelumnya dan checkpoint yang dikirim
    const lastIndex = lastCheckpoint ? checkpointOrder.indexOf(lastCheckpoint) : -1;
    const currentIndex = checkpointOrder.indexOf(checkpoint);

    // Kalau current checkpoint bukan urutan setelahnya, tolak
    if (currentIndex === -1 || currentIndex !== lastIndex + 1) {
      return res.status(400).json({ message: `Tidak bisa ke ${checkpoint} sebelum melewati checkpoint sebelumnya` });
    }

    // Kalau urutan sudah sesuai, baru simpan
      const insertCheckpoint = `
      INSERT INTO checkpoints (truckId, truckType, driver, plateNumber, checkpoint)
      VALUES (?, ?, ?, ?, ?)
    `;

    db.query(insertCheckpoint, [truck.truckId, truck.truckType, truck.driver, truck.plateNumber, checkpoint], (err) => {
      if (err) return res.status(500).json({ message: 'Gagal simpan data checkpoint' });

      res.status(201).json({ message: 'Checkpoint berhasil disimpan', truck });
    });

  });

    });
  });

// ================= CHECKPOINT GET ====================
app.get('/api/checkpoints', (req, res) => {
  const sql = `
    SELECT c.id, c.truckId, c.truckType, c.driver, t.plateNumber, c.checkpoint, c.timestamp
    FROM checkpoints c
    LEFT JOIN trucks t ON c.truckId = t.truckId
    ORDER BY c.timestamp DESC
  `;

  db.query(sql, (err, results) => {
    if (err) {
      console.error("Error fetching checkpoints:", err);
      return res.status(500).json({ message: "Gagal mengambil data checkpoints" });
    }

    const data = results.map(row => ({
      id: row.id,
      truckId: row.truckId,
      truckType: row.truckType,
      driver: row.driver,
      plateNumber: row.plateNumber || "-", // ✅ plat nomor
      checkpoint: row.checkpoint,
      timestamp: row.timestamp
    }));

    res.json(data);
  });
});


  // Tambahkan ini setelah app.post('/api/checkpoint'...)
// ================= GET TRUCK DETAIL WITH CHECKPOINTS ====================
app.get('/api/trucks/:truckId/details', (req, res) => {
  const { truckId } = req.params;

  const sqlTruck = 'SELECT * FROM trucks WHERE truckId = ?';
  db.query(sqlTruck, [truckId], (err, truckResults) => {
    if (err) return res.status(500).json({ message: 'Gagal mengambil data truck' });
    if (truckResults.length === 0) return res.status(404).json({ message: 'Truck tidak ditemukan' });

    const truck = truckResults[0];

    // ✅ Urutkan sesuai urutan checkpoint, bukan timestamp
    const sqlCheckpoints = `
      SELECT * FROM checkpoints 
      WHERE truckId = ? 
      ORDER BY FIELD(checkpoint, 'Checkpoint 1','Checkpoint 2','Checkpoint 3','Checkpoint 4'), timestamp ASC
    `;
    db.query(sqlCheckpoints, [truckId], (err, checkpointResults) => {
      if (err) return res.status(500).json({ message: 'Gagal mengambil data checkpoint' });

      res.json({
        truck,
        checkpoints: checkpointResults
      });
    });
  });
});


  app.get('/api/trucks/:truckId', (req, res) => {
    const { truckId } = req.params;
    const sql = 'SELECT * FROM trucks WHERE truckId = ?';
    db.query(sql, [truckId], (err, results) => {
      if (err) return res.status(500).json({ message: 'Server error' });
      if (results.length === 0) return res.status(404).json({ message: 'Truck tidak ditemukan' });

      const truck = results[0];
      res.json({
        truckId: truck.truckId,
        truckType: truck.truckType,
        driver: truck.driver,
        plateNumber: truck.plateNumber,   // ✅ tambahin
        status: truck.status,
        date: truck.date,
        image_url: truck.image_path ? `http://localhost:${PORT}/uploads/${truck.image_path}` : null
      });
    });
  });



  // ================= TIMBANG MUAT (LOADINGS) ====================

app.post("/api/loadings", (req, res) => {
  const { truckId, itemType, quantity, tara, unit } = req.body;

  if (!truckId || !itemType || !quantity || tara == null) {
    return res.status(400).json({ message: "truckId, itemType, quantity, dan tara wajib diisi" });
  }

  // Karena brutto & netto akan diisi di timbang isi, set default 0
  const brutoVal = 0;
  const nettoVal = 0;

  const query = `
    INSERT INTO timbang_muat (truckId, itemType, quantity, bruto, tara, netto, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  db.query(
    query,
    [truckId, itemType, quantity, brutoVal, tara, nettoVal, unit || "kg"],
    (err, result) => {
      if (err) {
        console.error("❌ Error saat simpan timbang muat:", err);
        return res.status(500).json({ message: "Gagal menyimpan data timbang muat" });
      }
      res.status(201).json({ message: "✅ Data timbang muat berhasil disimpan", id: result.insertId });
    }
  );
});

// ================= TIMBANG MUAT (LOADINGS) ====================

// GET timbang muat berdasarkan truckId
app.get("/api/loadings/:truckId", (req, res) => {
  const { truckId } = req.params;
  const sql = `SELECT * FROM timbang_muat WHERE truckId = ? ORDER BY id DESC`;
  db.query(sql, [truckId], (err, results) => {
    if (err) {
      console.error("❌ Error fetch timbang muat:", err);
      return res.status(500).json({ message: "Gagal mengambil data timbang muat" });
    }
    res.json(results);
  });
});

// ================= TIMBANG GUDANG (HITUNG BRUTTO & NETTO) ====================

// Update timbang muat saat sudah ditimbang isi di gudang
// ================= TIMBANG GUDANG (HITUNG BRUTTO & NETTO) ====================

app.put("/api/loadings/:id/brutto", (req, res) => {
  const { id } = req.params;
  const { bruto } = req.body;

  // Pastikan bruto ada dan berupa angka
  if (bruto == null || bruto === "") {
    return res.status(400).json({ message: "Brutto wajib diisi" });
  }

  const brutoVal = parseFloat(bruto);
  if (isNaN(brutoVal)) {
    return res.status(400).json({ message: "Brutto harus berupa angka" });
  }

  // Ambil dulu data tara dari DB
  const getSql = "SELECT tara FROM timbang_muat WHERE id = ?";
  db.query(getSql, [id], (err, results) => {
    if (err) {
      console.error("❌ Error ambil data timbang muat:", err);
      return res.status(500).json({ message: "Gagal mengambil data" });
    }
    if (results.length === 0) {
      return res.status(404).json({ message: "Data timbang muat tidak ditemukan" });
    }

    const tara = results[0].tara;
    const netto = brutoVal - tara;

    const updateSql = `
      UPDATE timbang_muat 
      SET bruto = ?, netto = ? 
      WHERE id = ?
    `;

    db.query(updateSql, [brutoVal, netto, id], (err2) => {
      if (err2) {
        console.error("❌ Error update timbang gudang:", err2);
        return res.status(500).json({ message: "Gagal update timbang gudang" });
      }

      res.json({ 
        message: "✅ Data timbang gudang berhasil diupdate", 
        bruto: brutoVal, 
        netto 
      });
    });
  });
});

  // Route Export (PASTIKAN DITAMBAH DI SINI sebelum listen)
app.get('/api/export/:driver', async (req, res) => {
  const { driver } = req.params;

  try {
    // ✅ Urutkan checkpoint sesuai urutan Checkpoint 1,2,3,4
    const checkpointsQuery = `
      SELECT * FROM checkpoints 
      WHERE driver = ? 
      ORDER BY FIELD(checkpoint, 'Checkpoint 1','Checkpoint 2','Checkpoint 3','Checkpoint 4'), timestamp ASC
    `;
    const loadingsQuery = `
      SELECT * FROM timbang_muat 
      WHERE truckId IN (SELECT truckId FROM trucks WHERE driver = ?) 
      ORDER BY id
    `;

    const [checkpoints] = await db.promise().query(checkpointsQuery, [driver]);
    const [loadings] = await db.promise().query(loadingsQuery, [driver]);

    const cpParser = new Parser({ fields: ['truckId', 'checkpoint', 'timestamp'] });
    const loadingParser = new Parser({ fields: ['truckId', 'itemType', 'quantity', 'bruto', 'tara', 'netto'] });

    const cpCsv = cpParser.parse(checkpoints);
    const loadingCsv = loadingParser.parse(loadings);

    const combined = `CHECKPOINT LOGS\n${cpCsv}\n\nTIMBANG MUAT\n${loadingCsv}`;

    res.setHeader('Content-Disposition', `attachment; filename="export-${driver}.csv"`);
    res.setHeader('Content-Type', 'text/csv');
    res.send(combined);
  } catch (error) {
    console.error('Error exporting data:', error);
    res.status(500).json({ message: 'Gagal export data' });
  }
});


// ================= EXPORT PDF (pakai pdfkit-table) ====================
const PDFDocument = require('pdfkit-table');

app.get('/api/export/truck/:truckId/pdf', async (req, res) => {
  const { truckId } = req.params;

  try {
    const checkpointsQuery = `
      SELECT * FROM checkpoints 
      WHERE truckId = ? 
      ORDER BY FIELD(checkpoint, 'Checkpoint 1','Checkpoint 2','Checkpoint 3','Checkpoint 4'), timestamp ASC
    `;
    const loadingsQuery = `
      SELECT * FROM timbang_muat 
      WHERE truckId = ? 
      ORDER BY id
    `;

    const [checkpoints] = await db.promise().query(checkpointsQuery, [truckId]);
    const [loadings] = await db.promise().query(loadingsQuery, [truckId]);

    const doc = new PDFDocument({ margin: 30, size: 'A4' });

    res.setHeader('Content-Disposition', `attachment; filename=export-${truckId}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);

    // Judul
    doc.fontSize(18).text(`Export Data Truck - ${truckId}`, { align: 'center' });
    doc.moveDown(2);

    // ===================== CHECKPOINTS =====================
    const checkpointTable = {
      title: "Checkpoint Logs",
      headers: ["Truck ID", "Checkpoint", "Timestamp"],
      rows: checkpoints.map(cp => [
        cp.truckId,
        cp.checkpoint,
        new Date(cp.timestamp).toLocaleString()
      ])
    };
    await doc.table(checkpointTable, {
      prepareHeader: () => doc.font("Helvetica-Bold").fontSize(12),
      prepareRow: (row, i) => doc.font("Helvetica").fontSize(11)
    });

    doc.addPage();

    // ===================== TIMBANG MUAT =====================
    const loadingTable = {
      title: "Data Timbang Muat",
      headers: ["Truck ID", "Item", "Qty", "Bruto", "Tara", "Netto", "Unit"],
      rows: loadings.map(l => [
        l.truckId,
        l.itemType,
        l.quantity,
        l.bruto,
        l.tara,
        l.netto,
        l.unit
      ])
    };
    await doc.table(loadingTable, {
      prepareHeader: () => doc.font("Helvetica-Bold").fontSize(12),
      prepareRow: (row, i) => doc.font("Helvetica").fontSize(11)
    });

    doc.end();
  } catch (err) {
    console.error('Error exporting PDF:', err);
    res.status(500).json({ message: 'Gagal export PDF' });
  }
});

// ================= SEARCH TRUCK BY PLATE NUMBER ====================
app.get("/api/trucks/search/:plateNumber", (req, res) => {
  const plateNumber = decodeURIComponent(req.params.plateNumber || "").trim();
  console.log("🔍 Searching truck with plate:", plateNumber);

  const sql = `
    SELECT t.*
    FROM trucks t
    WHERE LOWER(t.plateNumber) LIKE LOWER(?)
  `;

  db.query(sql, [`%${plateNumber}%`], (err, results) => {
    if (err) {
      console.error("❌ Error searching truck by plate number:", err);
      return res.status(500).json({ message: "Gagal mencari truck" });
    }

    if (!results || results.length === 0) {
      return res
        .status(404)
        .json({ message: "Truck dengan plat nomor tersebut tidak ditemukan" });
    }

    const data = results.map((truck) => ({
      truckId: truck.truckId,
      truckType: truck.truckType,
      driver: truck.driver,
      plateNumber: truck.plateNumber,
      status: truck.status || "Unknown",
      date: truck.date,
      image_url: truck.image_path
        ? `http://localhost:${PORT}/uploads/${truck.image_path}`
        : null,
    }));

    res.json(data);
  });
});


  app.use('/api/tracking', trackingRouter);

  app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server running on http://0.0.0.0:${PORT}`));



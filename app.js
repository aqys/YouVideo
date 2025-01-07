const express = require('express');
const multer = require('multer');
const mssql = require('mssql');
const path = require('path');
const dotenv = require('dotenv');
const videoController = require('./videoController');
const ffmpeg = require('fluent-ffmpeg');
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const session = require('express-session');
const { request } = require('http');

dotenv.config();

// Set the path to the ffmpeg executable
ffmpeg.setFfmpegPath('C:/ffmpeg/bin/ffmpeg.exe');

const app = express();
const port = process.env.PORT || 3000;

// Parse server and port from DB_SERVER
const [dbServer, dbPort] = process.env.DB_SERVER.split(',');

// Setup database connection
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: dbServer,
  port: parseInt(dbPort, 10),
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    connectionTimeout:  60000, // Increase timeout to 60 seconds
    requestTimeout: 1800000 // Increase request timeout to 30 minutes
  }
};

console.log('Database configuration:', dbConfig);

const poolPromise = mssql.connect(dbConfig)
  .then(pool => {
    console.log('Connected to the database');
    return pool;
  })
  .catch(err => {
    console.error('Database connection failed:', err);
    return null; // Return null if connection fails
  });

// Export poolPromise
module.exports = {
  poolPromise
};

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: 'skibidiHawkTuahSecret',
  resave: false,
  saveUninitialized: true
}));

app.get('/videos', async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }
    const result = await pool.request().query('SELECT id, video_name, author FROM videos');
    res.json(result.recordset);
  } catch (err) {
    console.error('Error fetching video list:', err);
    res.status(500).send('Error fetching video list');
  }
});

app.get('/video/blob/:id', videoController.getVideoBlob);

// Set EJS as the view engine (you can use other templating engines)
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public'))); // Serve static files like CSS, JS, images

// Body parser
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Set up multer for file uploads
const storage = multer.memoryStorage(); // Store file in memory temporarily
const upload = multer({ storage: storage });

// Routes
app.get('/thumbnail/:id', videoController.getThumbnail);
app.get('/', videoController.homePage);
app.post('/upload', upload.single('videoFile'), videoController.uploadVideo);
app.get('/video/blob/:id', videoController.getVideoBlob);
app.get('/videos', videoController.getAllVideoBlobs);
app.get('/video/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'video.html'));
});

app.get('/video/name/:id', async (req, res) => {
  const videoId = req.params.id;
  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }
    const result = await pool.request()
      .input('videoId', mssql.Int, videoId)
      .query('SELECT video_name FROM videos WHERE id = @videoId');

    const videoName = result.recordset[0]?.video_name;
    if (!videoName) {
      return res.status(404).send('Video not found');
    }

    res.json({ videoName });
  } catch (err) {
    console.error('Error fetching video name:', err);
    res.status(500).send('Error fetching video name');
  }
});

app.post('/login', async (req, res) => {
  const { userName, userPassword } = req.body;
  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }
    const result = await pool.request()
      .input('userName', mssql.NVarChar, userName)
      .query('SELECT * FROM users WHERE userName = @userName');

    if (result.recordset.length > 0) {
      const user = result.recordset[0];
      const passwordMatch = await bcrypt.compare(userPassword, user.userPassword);
      if (passwordMatch) {
        req.session.user = { userName: user.userName }; // Save user info in session
        res.json({ userName: user.userName }); // Return user data as JSON
      } else {
        res.status(401).json({ error: 'Invalid username or password' });
      }
    } else {
      res.status(401).json({ error: 'Invalid username or password' });
    }
  } catch (err) {
    console.error('Error during login:', err);
    res.status(500).json({ error: 'Error during login' });
  }
});

// Register route
app.post('/register', async (req, res) => {
  const { userName, userPassword, confirmPassword } = req.body;
  if (userPassword !== confirmPassword) {
    return res.status(400).send('Passwords do not match');
  }

  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }

    const result = await pool.request()
      .input('userName', mssql.NVarChar, userName)
      .query('SELECT * FROM users WHERE userName = @userName');

    if (result.recordset.length > 0) {
      return res.status(400).send('Username already exists');
    }

    const hashedPassword = await bcrypt.hash(userPassword, 10);
    await pool.request()
      .input('userName', mssql.NVarChar, userName)
      .input('userPassword', mssql.NVarChar, hashedPassword)
      .query('INSERT INTO users (userName, userPassword) VALUES (@userName, @userPassword)');

    res.redirect('/');
  } catch (err) {
    console.error('Error during registration:', err);
    res.status(500).send('Error during registration');
  }
});

app.get('/check-connection', async (req, res) => {
  try {
    const pool = await poolPromise;
    res.send('Database connection successful');
  } catch (err) {
    console.error(err);
    res.status(500).send('Database connection failed');
  }
});

// Route to check login status
app.get('/check-login', (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

ffmpeg.getAvailableFormats((err, formats) => {
  if (err) {
      console.error('FFmpeg error:', err);
  } else {
      console.log('FFmpeg is properly installed');
  }
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      return res.status(500).send('Error logging out');
    }
    res.send('Logged out');
  });
});

// Start the server
const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

server.timeout = 30 * 60 * 1000; // Increase server timeout to 30 minutes
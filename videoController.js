const mssql = require('mssql');
const path = require('path');
const dotenv = require('dotenv');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const NodeCache = require('node-cache');
const videoCache = new NodeCache({ stdTTL: 600 }); // Cache for 10 minutes

dotenv.config();

// Set the path to the ffmpeg executable
ffmpeg.setFfmpegPath('C:/ffmpeg/bin/ffmpeg.exe');

// Parse server and port from DB_SERVER
const [dbServer, dbPort] = process.env.DB_SERVER.split(',');

// Setup database connection
const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: dbServer,
  port: parseInt(dbPort, 10), // Convert port to integer
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true, // Use encryption
    trustServerCertificate: true, // For local dev certs
    connectionTimeout: 60000 // Increase timeout to 60 seconds
  }
};

const poolPromise = mssql.connect(dbConfig)
  .then(pool => {
    return pool;
  })
  .catch(err => {
    return null; // Return null if connection fails
  });

// Fetch video blob data
exports.getVideoBlob = async (req, res) => {
  const videoId = req.params.id;
  const range = req.headers.range;

  if (!range) {
    console.error('Range header is missing');
    return res.status(416).send('Range header required');
  }

  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }
    const result = await pool.request()
      .input('videoId', mssql.Int, videoId)
      .query('SELECT video_blob FROM videos WHERE id = @videoId');

    const videoBlob = result.recordset[0]?.video_blob;

    if (!videoBlob) {
      console.error('Video not found');
      return res.status(404).send('Video not found');
    }

    const videoSize = videoBlob.length;
    const CHUNK_SIZE = 1000 ** 6; // 1MB
    const start = Number(range.replace(/\D/g, ""));
    const end = Math.min(start + CHUNK_SIZE, videoSize - 1);

    console.log(`Requested range: ${range}`);
    console.log(`Video size: ${videoSize}`);
    console.log(`Start: ${start}, End: ${end}`);

    if (start >= videoSize) {
      console.error('Range not satisfiable');
      return res.status(416).send('Range not satisfiable');
    }

    const contentLength = end - start + 1;
    const headers = {
      "Content-Range": `bytes ${start}-${end}/${videoSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": contentLength,
      "Content-Type": "video/mp4",
    };

    res.writeHead(206, headers);
    res.end(videoBlob.slice(start, end + 1));
  } catch (err) {
    console.error('Error fetching video blob:', err);
    res.status(500).send('Error fetching video blob');
  }
};

// Home page to display list of videos
exports.homePage = async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }
    const result = await pool.request().query('SELECT id, video_name FROM videos');
    res.render('index', { videos: result.recordset });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
};

exports.uploadVideo = async (req, res) => {
  if (!req.session.user) {
    return res.status(401).send('You must be logged in to upload videos');
  }

  const videoFile = req.file;
  const videoName = req.body.videoName || videoFile.originalname;
  let author = req.session.user.userName;

  if (author.length > 50) {
    author = author.substring(0, 50);
  }

  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }

    const tempVideoPath = path.join(os.tmpdir(), `${uuidv4()}.mp4`);
    const thumbnailPath = path.join(os.tmpdir(), `${uuidv4()}.png`);
    
    await fs.writeFile(tempVideoPath, videoFile.buffer);
    
    await new Promise((resolve, reject) => {
      ffmpeg(tempVideoPath)
        .screenshots({
          count: 1,
          timestamps: ['00:00:01'],
          folder: path.dirname(thumbnailPath),
          filename: path.basename(thumbnailPath),
          size: '1280x720'
        })
        .on('end', () => {
          resolve();
        })
        .on('error', (err) => {
          reject(err);
        });
    });

    const thumbnailBuffer = await fs.readFile(thumbnailPath);

    await pool.request()
      .input('videoName', mssql.NVarChar, videoName)
      .input('videoBlob', mssql.VarBinary(mssql.MAX), videoFile.buffer)
      .input('thumbnailBlob', mssql.VarBinary(mssql.MAX), thumbnailBuffer)
      .input('author', mssql.NVarChar, author)
      .query(`
        INSERT INTO videos (video_name, video_blob, thumbnail_blob, author) 
        VALUES (@videoName, @videoBlob, @thumbnailBlob, @author)
      `);

    await fs.unlink(tempVideoPath).catch(console.error);
    await fs.unlink(thumbnailPath).catch(console.error);

    res.redirect('/');
  } catch (err) {
    console.error('Error in upload:', err);
    res.status(500).send('Upload failed: ' + err.message);
  }
};
  
exports.getAllVideoBlobs = async (req, res) => {
  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }
    
    const result = await pool.request()
      .query('SELECT id, video_name, author FROM videos ORDER BY id DESC');

    const videos = result.recordset;
    res.json(videos);
  } catch (err) {
    console.error('Error fetching videos:', err);
    res.status(500).send('Error fetching videos');
  }
};

exports.getThumbnail = async (req, res) => {
  const cacheKey = `thumbnail_${req.params.id}`;
  
  try {
    // Check cache first
    const cachedThumbnail = videoCache.get(cacheKey);
    if (cachedThumbnail) {
      res.setHeader('Content-Type', 'image/png');
      return res.send(cachedThumbnail);
    }

    const pool = await poolPromise;
    const result = await pool.request()
      .input('id', mssql.Int, req.params.id)
      .query('SELECT thumbnail_blob FROM videos WHERE id = @id');

    if (result.recordset[0]?.thumbnail_blob) {
      // Cache the thumbnail
      videoCache.set(cacheKey, result.recordset[0].thumbnail_blob);
      
      res.setHeader('Content-Type', 'image/png');
      res.send(result.recordset[0].thumbnail_blob);
    } else {
      res.status(404).send('Thumbnail not found');
    }
  } catch (err) {
    console.error('Error fetching thumbnail:', err);
    res.status(500).send('Error fetching thumbnail');
  }
};

// Watch video (streaming)
exports.watchVideo = async (req, res) => {
  const videoId = req.params.id;

  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }
    const result = await pool.request()
      .input('videoId', mssql.Int, videoId)
      .query('SELECT video_blob FROM videos WHERE id = @videoId');

    const videoBlob = result.recordset[0]?.video_blob;

    if (videoBlob) {
      res.setHeader('Content-Type', 'video/mp4');
      res.send(videoBlob);
    } else {
      res.status(404).send('Video not found');
    }
  } catch (err) {
    console.error('Error fetching video:', err);
    res.status(500).send('Error fetching video');
  }
};
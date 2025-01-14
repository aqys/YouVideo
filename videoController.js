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


  function formatVideoLength(seconds) {
    const totalSeconds = Math.floor(Number(seconds) || 0);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const secs = totalSeconds % 60;

    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
        return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
}

exports.getAllVideoBlobs = async (req, res) => {
    try {
        const pool = await poolPromise;
        if (!pool) {
            throw new Error('Database connection failed');
        }

        const result = await pool.request()
            .query('SELECT id, video_name, author, video_length FROM videos ORDER BY id DESC');
    
        const videos = result.recordset.map(video => {
            // **Insert the following line to format video_length**
            video.video_length = formatVideoLength(video.video_length);
            return video;
        });

        res.json(videos);
    } catch (err) {
        console.error('Error fetching videos:', err);
        res.status(500).send('Error fetching videos');
    }
};

  const   tVideoBlob = async (req, res) => {
    try {
        const pool = await poolPromise;
        const result = await pool.request()
            .input('id', mssql.Int, req.params.id)
            .query('SELECT video_data FROM videos WHERE id = @id');

        if (result.recordset.length > 0 && result.recordset[0].video_data) {
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': result.recordset[0].video_data.length
            });
            res.end(result.recordset[0].video_data);
        } else {
            res.status(404).send('Video not found');
        }
    } catch (err) {
        console.error('Error fetching video:', err);
        res.status(500).send('Error fetching video');
    }
};



exports.recordView = async (req, res) => {
  const videoId = req.params.id;
  const userId = req.session.user ? req.session.user.userName : req.ip;

  try {
      const pool = await poolPromise;
      
      // Check if user viewed this video in the last 24 hours
      const recentView = await pool.request()
          .input('videoId', mssql.Int, videoId)
          .input('userId', mssql.VarChar, userId)
          .query(`
              SELECT TOP 1 view_date 
              FROM video_views 
              WHERE video_id = @videoId 
              AND user_id = @userId 
              AND view_date > DATEADD(hour, -24, GETDATE())
          `);

      if (recentView.recordset.length === 0) {
          // Record new view
          await pool.request()
              .input('videoId', mssql.Int, videoId)
              .input('userId', mssql.VarChar, userId)
              .query('INSERT INTO video_views (video_id, user_id) VALUES (@videoId, @userId)');
      }

      // Get total views
      const viewCount = await pool.request()
          .input('videoId', mssql.Int, videoId)
          .query(`
              SELECT COUNT(DISTINCT user_id) as views 
              FROM video_views 
              WHERE video_id = @videoId
          `);

      res.json({ views: viewCount.recordset[0].views });
  } catch (err) {
      console.error('Error recording view:', err);
      res.status(500).json({ error: 'Server error' });
  }
};

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

exports.getVideoDetails = async (req, res) => {
  const videoId = req.params.id;
  try {
      const pool = await poolPromise;
      if (!pool) {
          throw new Error('Database connection failed');
      }
      const result = await pool.request()
          .input('videoId', mssql.Int, videoId)
          .query(`
              SELECT v.video_name, v.author, v.video_date
              FROM videos v
              WHERE v.id = @videoId
          `);

      const videoDetails = result.recordset[0];
      if (!videoDetails) {
          return res.status(404).json({ error: 'Video not found' });
      }

      console.log('Sending video details:', videoDetails); // Debug log
      res.json(videoDetails);
  } catch (err) {
      console.error('Error in getVideoDetails:', err);
      res.status(500).json({ error: 'Error fetching video details' });
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
    try {
        const videoFile = req.file;
        if (!videoFile) {
            return res.status(400).send('No video file uploaded.');
        }

        const pool = await poolPromise;
        if (!pool) {
            throw new Error('Database connection failed');
        }

        const tempVideoPath = path.join(os.tmpdir(), `${uuidv4()}.mp4`);
        const thumbnailPath = path.join(os.tmpdir(), `${uuidv4()}.png`);
        await fs.writeFile(tempVideoPath, videoFile.buffer);
        
        // Get video duration
        const durationInSeconds = await new Promise((resolve, reject) => {
            console.log('Formatted duration:', formattedDuration);
            ffmpeg.ffprobe(tempVideoPath, (err, metadata) => {
                if (err) reject(err);
                else {
                    const duration = Math.floor(metadata.format.duration);
                    console.log('Original duration:', metadata.format.duration);
                    console.log('Stored duration (seconds):', duration);
                    resolve(duration);
                }
            });
        });

        // **Insert the following code to format the duration**
        const formattedDuration = formatVideoLength(durationInSeconds);
        console.log('Formatted duration:', formattedDuration);
        // **End of inserted code**

        // Save video details to the database
        await pool.request()
            .input('videoName', mssql.VarChar, req.body.videoName)
            .input('author', mssql.VarChar, req.body.author)
            .input('videoLength', mssql.VarChar, formattedDuration) // Use formattedDuration here
            .input('videoData', mssql.VarBinary, videoFile.buffer)
            .query('INSERT INTO videos (video_name, author, video_length, video_data) VALUES (@videoName, @author, @videoLength, @videoData)');

        // Generate thumbnail (existing code continues...)
        await new Promise((resolve, reject) => {
            ffmpeg(tempVideoPath)
                .screenshots({
                    count: 1,
                    timestamps: ['00:00:01'],
                    folder: path.dirname(thumbnailPath),
                    filename: path.basename(thumbnailPath),
                    size: '1280x720'
                })
                .on('end', resolve)
                .on('error', reject);
        });

        // Clean up temporary files
        await fs.unlink(tempVideoPath);
        await fs.unlink(thumbnailPath);

        res.status(200).send('Video uploaded successfully.');
    } catch (err) {
        console.error('Error uploading video:', err);
        res.status(500).send('Error uploading video.');
    }
};

// Fetch comments for a video
exports.getComments = async (req, res) => {
  const videoId = req.params.id;
  try {
      const pool = await poolPromise;
      if (!pool) {
          throw new Error('Database connection failed');
      }
      const result = await pool.request()
          .input('videoId', mssql.Int, videoId)
          .query('SELECT * FROM comments WHERE video_id = @videoId ORDER BY comment_date DESC');
      res.json(result.recordset);
  } catch (err) {
      console.error('Error fetching comments:', err);
      res.status(500).send('Error fetching comments');
  }
};

// Post a new comment
exports.postComment = async (req, res) => {
  const { videoId, commentText } = req.body;
  const userName = req.session.user.userName;
  try {
      const pool = await poolPromise;
      if (!pool) {
          throw new Error('Database connection failed');
      }
      await pool.request()
          .input('videoId', mssql.Int, videoId)
          .input('userName', mssql.NVarChar, userName)
          .input('commentText', mssql.NVarChar, commentText)
          .query('INSERT INTO comments (video_id, user_name, comment_text) VALUES (@videoId, @userName, @commentText)');
      res.status(201).send('Comment added');
  } catch (err) {
      console.error('Error posting comment:', err);
      res.status(500).send('Error posting comment');
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

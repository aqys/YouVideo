const mssql = require('mssql');
const path = require('path');
const dotenv = require('dotenv');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const NodeCache = require('node-cache');

const caches = {
  videoCache: new NodeCache({ stdTTL: 600 }),
  thumbnailCache: new NodeCache({ stdTTL: 3600 }),
  chunkCache: new NodeCache({ stdTTL: 300 })
};

dotenv.config();

ffmpeg.setFfmpegPath('C:/ffmpeg/bin/ffmpeg.exe');

const [dbServer, dbPort] = process.env.DB_SERVER.split(',');

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: dbServer,
  port: parseInt(dbPort, 10),
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    connectionTimeout: 60000
  }
};

const poolPromise = mssql.connect(dbConfig)
  .then(pool => {
    return pool;
  })
  .catch(err => {
    return null;
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

const formatDate = (date) => {
    const now = new Date();
    const commentDate = new Date(date);
    commentDate.setHours(commentDate.getHours() - 1); // Subtract one hour
    const diffInSeconds = Math.floor((now - commentDate) / 1000);

    if (diffInSeconds < 60) {
        return "Just now";
    } else if (diffInSeconds < 3600) {
        const diffInMinutes = Math.floor(diffInSeconds / 60);
        return `${diffInMinutes} minute${diffInMinutes !== 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 86400) {
        const diffInHours = Math.floor(diffInSeconds / 3600);
        return `${diffInHours} hour${diffInHours !== 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 2592000) {
        const diffInDays = Math.floor(diffInSeconds / 86400);
        return `${diffInDays} day${diffInDays !== 1 ? 's' : ''} ago`;
    } else if (diffInSeconds < 31536000) {
        const diffInMonths = Math.floor(diffInSeconds / 2592000);
        return `${diffInMonths} month${diffInMonths !== 1 ? 's' : ''} ago`;
    } else {
        const diffInYears = Math.floor(diffInSeconds / 31536000);
        return `${diffInYears} year${diffInYears !== 1 ? 's' : ''} ago`;
    }
};

exports.getAllVideoBlobs = async (req, res) => {
    try {
        const pool = await poolPromise;
        if (!pool) {
            throw new Error('Database connection failed');
        }

        const result = await pool.request()
            .query(`
                SELECT v.id, v.video_name, v.author, v.video_length, v.video_date,
                       (SELECT COUNT(DISTINCT user_id) FROM video_views WHERE video_id = v.id) AS views
                FROM videos v
                ORDER BY v.id DESC
            `);

        const videos = result.recordset.map(video => {
            video.video_length = formatVideoLength(video.video_length);
            video.video_date = formatDate(video.video_date);
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
    if (!req.session.user) {
        return res.status(401).json({ error: 'User not logged in' });
    }

    const videoId = req.params.id;
    const userId = req.session.user.userName;

    try {
        const pool = await poolPromise;

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
            await pool.request()
                .input('videoId', mssql.Int, videoId)
                .input('userId', mssql.VarChar, userId)
                .query('INSERT INTO video_views (video_id, user_id, view_date) VALUES (@videoId, @userId, GETDATE())');
        }

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

exports.interactWithVideo = async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'User not logged in' });
    }

    const { videoId, interactionType } = req.body;
    const userId = req.session.user.userName;

    try {
        const pool = await poolPromise;

        if (interactionType === 'REMOVE') {
            await pool.request()
                .input('videoId', mssql.Int, videoId)
                .input('userId', mssql.VarChar, userId)
                .query(`
                    DELETE FROM video_interactions 
                    WHERE video_id = @videoId AND user_id = @userId
                `);
        } else {
            const existingInteraction = await pool.request()
                .input('videoId', mssql.Int, videoId)
                .input('userId', mssql.VarChar, userId)
                .query(`
                    SELECT * FROM video_interactions 
                    WHERE video_id = @videoId AND user_id = @userId
                `);

            if (existingInteraction.recordset.length > 0) {
                await pool.request()
                    .input('videoId', mssql.Int, videoId)
                    .input('userId', mssql.VarChar, userId)
                    .input('interactionType', mssql.VarChar, interactionType)
                    .query(`
                        UPDATE video_interactions 
                        SET interaction_type = @interactionType, interaction_date = GETDATE() 
                        WHERE video_id = @videoId AND user_id = @userId
                    `);
            } else {
                await pool.request()
                    .input('videoId', mssql.Int, videoId)
                    .input('userId', mssql.VarChar, userId)
                    .input('interactionType', mssql.VarChar, interactionType)
                    .query(`
                        INSERT INTO video_interactions (video_id, user_id, interaction_type, interaction_date) 
                        VALUES (@videoId, @userId, @interactionType, GETDATE())
                    `);
            }
        }

        const interactionCounts = await pool.request()
            .input('videoId', mssql.Int, videoId)
            .query(`
                SELECT 
                    SUM(CASE WHEN interaction_type = 'LIKE' THEN 1 ELSE 0 END) AS likes,
                    SUM(CASE WHEN interaction_type = 'DISLIKE' THEN 1 ELSE 0 END) AS dislikes
                FROM video_interactions
                WHERE video_id = @videoId
            `);

        res.json(interactionCounts.recordset[0]);
    } catch (err) {
        console.error('Error interacting with video:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.getSubscriptionStatus = async (req, res) => {
  const userName = req.params.userName;
  const currentUser = req.session.user ? req.session.user.userName : null;

  try {
      const pool = await poolPromise;
      if (!pool) {
          throw new Error('Database connection failed');
      }

      const subscriptionResult = await pool.request()
          .input('subscriber_id', mssql.NVarChar, currentUser)
          .input('channel_id', mssql.NVarChar, userName)
          .query('SELECT * FROM subscriptions WHERE subscriber_id = @subscriber_id AND channel_id = @channel_id');

      const isSubscribed = subscriptionResult.recordset.length > 0;

      const countResult = await pool.request()
          .input('channel_id', mssql.NVarChar, userName)
          .query('SELECT COUNT(*) AS subscriberCount FROM subscriptions WHERE channel_id = @channel_id');

      const subscriberCount = countResult.recordset[0].subscriberCount;

      res.json({ isSubscribed, subscriberCount, currentUser });
  } catch (err) {
      console.error('Error fetching subscription status:', err);
      res.status(500).json({ error: 'Error fetching subscription status' });
  }
};

exports.subscribeToChannel = async (req, res) => {
  const { channelId } = req.body;
  const currentUser = req.session.user ? req.session.user.userName : null;

  if (!currentUser) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error('Database connection failed');
    }

    const subscriptionResult = await pool.request()
      .input('subscriber_id', mssql.NVarChar, currentUser)
      .input('channel_id', mssql.NVarChar, channelId)
      .query('SELECT * FROM subscriptions WHERE subscriber_id = @subscriber_id AND channel_id = @channel_id');

    if (subscriptionResult.recordset.length > 0) {
      await pool.request()
        .input('subscriber_id', mssql.NVarChar, currentUser)
        .input('channel_id', mssql.NVarChar, channelId)
        .query('DELETE FROM subscriptions WHERE subscriber_id = @subscriber_id AND channel_id = @channel_id');

      return res.json({ subscribed: false });
    } else {
      await pool.request()
        .input('subscriber_id', mssql.NVarChar, currentUser)
        .input('channel_id', mssql.NVarChar, channelId)
        .query('INSERT INTO subscriptions (subscriber_id, channel_id, subscription_date) VALUES (@subscriber_id, @channel_id, GETDATE())');

      return res.json({ subscribed: true });
    }
  } catch (err) {
    console.error('Error subscribing to channel:', err);
    res.status(500).json({ error: 'Error subscribing to channel' });
  }
};

exports.getVideoInteractions = async (req, res) => {
    const videoId = req.params.id;
    const userId = req.session.user ? req.session.user.userName : null;

    try {
        const pool = await poolPromise;

        // Get like and dislike counts
        const interactionCounts = await pool.request()
            .input('videoId', mssql.Int, videoId)
            .query(`
                SELECT 
                    SUM(CASE WHEN interaction_type = 'LIKE' THEN 1 ELSE 0 END) AS likes,
                    SUM(CASE WHEN interaction_type = 'DISLIKE' THEN 1 ELSE 0 END) AS dislikes
                FROM video_interactions
                WHERE video_id = @videoId
            `);

        let userInteraction = null;
        if (userId) {
            // Get user's interaction with the video
            const userInteractionResult = await pool.request()
                .input('videoId', mssql.Int, videoId)
                .input('userId', mssql.VarChar, userId)
                .query(`
                    SELECT interaction_type 
                    FROM video_interactions 
                    WHERE video_id = @videoId AND user_id = @userId
                `);

            if (userInteractionResult.recordset.length > 0) {
                userInteraction = userInteractionResult.recordset[0].interaction_type;
            }
        }

        res.json({
            likes: interactionCounts.recordset[0].likes || 0,
            dislikes: interactionCounts.recordset[0].dislikes || 0,
            userInteraction: userInteraction
        });
    } catch (err) {
        console.error('Error fetching video interactions:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

exports.getVideoBlob = async (req, res) => {
    const videoId = parseInt(req.params.id, 10);
    
    try {
        const pool = await poolPromise;
        
        const videoInfo = await pool.request()
            .input('id', mssql.Int, videoId)
            .query(`
                SELECT 
                    DATALENGTH(video_blob) as size,
                    video_name
                FROM videos WITH (NOLOCK)
                WHERE id = @id
            `);

        if (!videoInfo.recordset[0]) {
            return res.status(404).send('Video not found');
        }

        const videoSize = videoInfo.recordset[0].size;
        const range = req.headers.range;

        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : Math.min(start + 1024 * 1024, videoSize - 1);
            const contentLength = end - start + 1;

            const result = await pool.request()
                .input('id', mssql.Int, videoId)
                .input('start', mssql.Int, start + 1)
                .input('length', mssql.Int, contentLength)
                .query(`
                    SELECT CAST(SUBSTRING(video_blob, @start, @length) AS VARBINARY(MAX)) as chunk 
                    FROM videos WITH (NOLOCK)
                    WHERE id = @id
                `);

            if (!result.recordset[0]?.chunk) {
                return res.status(404).send('Video chunk not found');
            }

            const headers = {
                'Content-Range': `bytes ${start}-${end}/${videoSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': contentLength,
                'Content-Type': 'video/mp4',
                'Content-Disposition': `inline; filename="${videoInfo.recordset[0].video_name}.mp4"`,
                'Cache-Control': 'public, max-age=3600'
            };

            res.writeHead(206, headers);
            res.end(result.recordset[0].chunk);
        } else {
            const headers = {
                'Content-Length': videoSize,
                'Content-Type': 'video/mp4',
                'Content-Disposition': `inline; filename="${videoInfo.recordset[0].video_name}.mp4"`,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=3600'
            };

            res.writeHead(200, headers);
            
            const result = await pool.request()
                .input('id', mssql.Int, videoId)
                .query('SELECT video_blob FROM videos WHERE id = @id');

            res.end(result.recordset[0].video_blob);
        }
    } catch (err) {
        console.error('Error streaming video:', err);
        res.status(500).send('Error streaming video');
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

        console.log('Sending video details:', videoDetails);
        res.json(videoDetails);
    } catch (err) {
        console.error('Error in getVideoDetails:', err);
        res.status(500).json({ error: 'Error fetching video details' });
    }
};

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

    try {
        const videoFile = req.file;
        const videoName = req.body.videoName;
        const author = req.session.user.userName;

        if (!videoFile || !videoName) {
            return res.status(400).send('Missing file or video name');
        }

        const pool = await poolPromise;
        if (!pool) {
            throw new Error('Database connection failed');
        }

        const tempVideoPath = path.join(os.tmpdir(), `${uuidv4()}.mp4`);
        const thumbnailPath = path.join(os.tmpdir(), `${uuidv4()}.png`);

        await fs.writeFile(tempVideoPath, videoFile.buffer);

        const duration = await new Promise((resolve, reject) => {
            ffmpeg.ffprobe(tempVideoPath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata.format.duration);
            });
        });

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

        const thumbnailBuffer = await fs.readFile(thumbnailPath);

        await pool.request()
            .input('videoName', mssql.NVarChar, videoName)
            .input('videoBlob', mssql.VarBinary(mssql.MAX), videoFile.buffer)
            .input('thumbnailBlob', mssql.VarBinary(mssql.MAX), thumbnailBuffer)
            .input('author', mssql.NVarChar, author)
            .input('videoLength', mssql.Float, duration)
            .input('videoDate', mssql.DateTime2, new Date()) // Add this line
            .query(`
                INSERT INTO videos (video_name, video_blob, thumbnail_blob, author, video_length, video_date) 
                VALUES (@videoName, @videoBlob, @thumbnailBlob, @author, @videoLength, @videoDate)
            `);

        await Promise.all([
            fs.unlink(tempVideoPath).catch(console.error),
            fs.unlink(thumbnailPath).catch(console.error)
        ]);

        res.status(200).json({ message: 'Upload successful' });
    } catch (err) {
        console.error('Error in upload:', err);
        res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
};

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
        
        const comments = result.recordset.map(comment => {
            comment.comment_date = formatDate(comment.comment_date);
            return comment;
        });

        res.json(comments);
    } catch (err) {
        console.error('Error fetching comments:', err);
        res.status(500).send('Error fetching comments');
    }
};

exports.postComment = async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ error: 'User not logged in' });
    }

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
            .query('INSERT INTO comments (video_id, user_name, comment_text, comment_date) VALUES (@videoId, @userName, @commentText, SYSDATETIME())');
        res.status(201).send('Comment added');
    } catch (err) {
        console.error('Error posting comment:', err);
        res.status(500).send('Error posting comment');
    }
};

exports.getThumbnail = async (req, res) => {
  const cacheKey = `thumbnail_${req.params.id}`;
  
  try {
      const cachedThumbnail = caches.thumbnailCache.get(cacheKey);
      if (cachedThumbnail) {
          res.setHeader('Content-Type', 'image/png');
          return res.send(cachedThumbnail);
      }

      const pool = await poolPromise;
      const result = await pool.request()
          .input('id', mssql.Int, req.params.id)
          .query('SELECT thumbnail_blob FROM videos WHERE id = @id');

      if (result.recordset[0]?.thumbnail_blob) {
          caches.thumbnailCache.set(cacheKey, result.recordset[0].thumbnail_blob);
          
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
const express = require("express");
const multer = require("multer");
const mssql = require("mssql");
const path = require("path");
const dotenv = require("dotenv");
const videoController = require("./videoController");
const ffmpeg = require("fluent-ffmpeg");
const bcrypt = require("bcrypt");
const session = require("express-session");

dotenv.config();

ffmpeg.setFfmpegPath("C:/ffmpeg/bin/ffmpeg.exe");

const app = express();
const port = process.env.PORT || 3000;

const [dbServer, dbPort] = process.env.DB_SERVER.split(",");

const dbConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: dbServer,
  port: parseInt(dbPort, 10),
  database: process.env.DB_DATABASE,
  options: {
    encrypt: true,
    trustServerCertificate: true,
    connectionTimeout: 60000,
    requestTimeout: 1800000,
  },
};

console.log("Database configuration:", dbConfig);

const poolPromise = mssql
  .connect(dbConfig)
  .then((pool) => {
    console.log("Connected to the database");
    return pool;
  })
  .catch((err) => {
    console.error("Database connection failed:", err);
    return null;
  });

  
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));
app.use(
  session({
    secret: "skibidiHawkTuahSecret",
    resave: false,
    saveUninitialized: true,
    cookie: {
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
    },
  }),
);

app.set("view engine", "ejs");
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.memoryStorage();

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
    fieldSize: 500 * 1024 * 1024,
  },
});

app.get("/thumbnail/:id", videoController.getThumbnail);
app.get("/", videoController.homePage);
app.get("/videos", videoController.getAllVideoBlobs.bind(videoController));
app.get("/video/blob/:id", videoController.getVideoBlob.bind(videoController));
app.get(
  "/api/subscription-status/:userName",
  videoController.getSubscriptionStatus,
);
app.post("/api/subscribe", videoController.subscribeToChannel);
app.post("/api/video/record-view/:id", videoController.recordView);
app.post("/api/video/interact", videoController.interactWithVideo);
app.get("/api/video/interactions/:id", videoController.getVideoInteractions);
app.get("/api/comments/:id", videoController.getComments);
app.post("/api/comments", videoController.postComment);
app.get("/video/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "video.html"));
});

app.post("/upload", upload.single("videoFile"), async (req, res) => {
  try {
    await videoController.uploadVideo(req, res);
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).send(error.message);
  }
});

app.post(
  "/api/update-profile-picture",
  upload.single("profilePicture"),
  async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const fileBuffer = await fs.promises.readFile(req.file.path);
      const pool = await poolPromise;

      await pool
        .request()
        .input("userName", mssql.NVarChar, req.session.user.userName)
        .input("profilePicture", mssql.VarBinary(mssql.MAX), fileBuffer)
        .query(
          "UPDATE users SET profile_picture = @profilePicture WHERE userName = @userName",
        );

      await fs.promises.unlink(req.file.path);

      res.json({ message: "Profile picture updated" });
    } catch (err) {
      console.error("Error updating profile picture:", err);
      if (req.file?.path) {
        try {
          await fs.promises.unlink(req.file.path);
        } catch (unlinkErr) {
          console.error("Error cleaning up file:", unlinkErr);
        }
      }
      res.status(500).json({ error: "Server error" });
    }
  },
);

app.get("/video/name/:id", async (req, res) => {
  const videoId = req.params.id;
  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error("Database connection failed");
    }
    const result = await pool
      .request()
      .input("videoId", mssql.Int, videoId)
      .query("SELECT video_name FROM videos WHERE id = @videoId");

    const videoName = result.recordset[0]?.video_name;
    if (!videoName) {
      return res.status(404).send("Video not found");
    }

    res.json({ videoName });
  } catch (err) {
    console.error("Error fetching video name:", err);
    res.status(500).send("Error fetching video name");
  }
});

app.post("/login", async (req, res) => {
  const { userName, userPassword } = req.body;
  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error("Database connection failed");
    }
    const result = await pool
      .request()
      .input("userName", mssql.NVarChar, userName)
      .query("SELECT * FROM users WHERE userName = @userName");

    if (result.recordset.length > 0) {
      const user = result.recordset[0];
      const passwordMatch = await bcrypt.compare(
        userPassword,
        user.userPassword,
      );
      if (passwordMatch) {
        req.session.user = {
          userName: user.userName,
        };
        req.session.save((err) => {
          if (err) {
            console.error("Session save error:", err);
            return res.status(500).json({ error: "Session error" });
          }
          console.log("Session after login:", req.session);
          res.json({ userName: user.userName });
        });
      } else {
        res.status(401).json({ error: "Invalid username or password" });
      }
    } else {
      res.status(401).json({ error: "Invalid username or password" });
    }
  } catch (err) {
    console.error("Error during login:", err);
    res.status(500).json({ error: "Error during login" });
  }
});

app.post("/register", async (req, res) => {
  const { userName, userPassword, confirmPassword } = req.body;
  if (userPassword !== confirmPassword) {
    return res.status(400).send("Passwords do not match");
  }

  try {
    const pool = await poolPromise;
    if (!pool) {
      throw new Error("Database connection failed");
    }

    const result = await pool
      .request()
      .input("userName", mssql.NVarChar, userName)
      .query("SELECT * FROM users WHERE userName = @userName");

    if (result.recordset.length > 0) {
      return res.status(400).send("Username already exists");
    }

    const hashedPassword = await bcrypt.hash(userPassword, 10);
    await pool
      .request()
      .input("userName", mssql.NVarChar, userName)
      .input("userPassword", mssql.NVarChar, hashedPassword)
      .query(
        "INSERT INTO users (userName, userPassword) VALUES (@userName, @userPassword)",
      );

    res.redirect("/");
  } catch (err) {
    console.error("Error during registration:", err);
    res.status(500).send("Error during registration");
  }
});

app.get("/debug-session", (req, res) => {
  console.log("Full session:", req.session);
  console.log("Session ID:", req.sessionID);
  console.log("Session user:", req.session.user);
  res.json({
    sessionId: req.sessionID,
    session: req.session,
    user: req.session.user,
  });
});

app.get("/check-connection", async (req, res) => {
  try {
    const pool = await poolPromise;
    res.send("Database connection successful");
  } catch (err) {
    console.error(err);
    res.status(500).send("Database connection failed");
  }
});

app.get("/profile.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile.html"));
});

app.get("/api/profile/:userName?", async (req, res) => {
  try {
    const requestedUserName = req.params.userName;
    if (!requestedUserName) {
      return res.status(400).json({ error: "Username is required" });
    }

    const pool = await poolPromise;
    const result = await pool
      .request()
      .input("userName", mssql.NVarChar, requestedUserName)
      .query("SELECT userName FROM users WHERE userName = @userName");

    if (result.recordset.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const isOwnProfile = req.session.user?.userName === requestedUserName;

    const profileData = {
      userName: result.recordset[0].userName,
      isOwnProfile: isOwnProfile
    };

    res.json(profileData);
  } catch (err) {
    console.error("Error fetching profile:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get('/video/details/:id', async (req, res) => {
  const videoId = req.params.id;
  try {
      const pool = await poolPromise;
      const result = await pool
          .request()
          .input('videoId', mssql.Int, videoId)
          .query(`
              SELECT v.id, v.video_name, v.author, v.video_date,
                  (SELECT COUNT(DISTINCT user_id) FROM video_views WHERE video_id = v.id) AS views
              FROM videos v
              WHERE v.id = @videoId
          `);

      const video = result.recordset[0];
      if (!video) {
          return res.status(404).json({ error: 'Video not found' });
      }

      // Format the date in a more detailed way
      const date = new Date(video.video_date);
      const formattedDate = date.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric'
      });

      res.json({
          ...video,
          formattedDate: formattedDate
      });
  } catch (err) {
      console.error('Error fetching video details:', err);
      res.status(500).json({ error: 'Error fetching video details' });
  }
});

app.get("/api/user-videos/:userName", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input("userName", mssql.NVarChar, req.params.userName)
      .query(
        "SELECT id, video_name FROM videos WHERE author = @userName ORDER BY id DESC",
      );

    res.json(result.recordset);
  } catch (err) {
    console.error("Error fetching user videos:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/check-session", (req, res) => {
  console.log("Current session:", req.session);
  res.json({
    loggedIn: !!req.session.user,
    user: req.session.user || null,
  });
});

app.get("/profile-picture/:userName", async (req, res) => {
  try {
    const pool = await poolPromise;
    const result = await pool
      .request()
      .input("userName", mssql.NVarChar, req.params.userName)
      .query("SELECT profile_picture FROM users WHERE userName = @userName");

    if (result.recordset[0]?.profile_picture) {
      res.setHeader("Content-Type", "image/jpeg");
      res.send(result.recordset[0].profile_picture);
    } else {
      res.sendFile(path.join(__dirname, "public", "default-profile.png"));
    }
  } catch (err) {
    console.error("Error fetching profile picture:", err);
    res.status(500).send("Server error");
  }
});

app.post(
  "/api/update-profile-picture",
  upload.single("profilePicture"),
  async (req, res) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const fileBuffer = await fs.promises.readFile(req.file.path);
      const pool = await poolPromise;

      await pool
        .request()
        .input("userName", mssql.NVarChar, req.session.user.userName)
        .input("profilePicture", mssql.VarBinary(mssql.MAX), fileBuffer)
        .query(
          "UPDATE users SET profile_picture = @profilePicture WHERE userName = @userName",
        );

      await fs.promises.unlink(req.file.path);

      res.json({ message: "Profile picture updated" });
    } catch (err) {
      console.error("Error updating profile picture:", err);
      if (req.file?.path) {
        try {
          await fs.promises.unlink(req.file.path);
        } catch (unlinkErr) {
          console.error("Error cleaning up file:", unlinkErr);
        }
      }
      res.status(500).json({ error: "Server error" });
    }
  },
);

app.post("/api/update-username", async (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }

  const { newUserName } = req.body;

  try {
    const pool = await poolPromise;

    const checkResult = await pool
      .request()
      .input("newUserName", mssql.NVarChar, newUserName)
      .query("SELECT userName FROM users WHERE userName = @newUserName");

    if (checkResult.recordset.length > 0) {
      return res.status(400).json({ error: "Username already taken" });
    }

    await pool
      .request()
      .input("oldUserName", mssql.NVarChar, req.session.user.userName)
      .input("newUserName", mssql.NVarChar, newUserName).query(`
        BEGIN TRANSACTION;
        UPDATE users SET userName = @newUserName WHERE userName = @oldUserName;
        UPDATE videos SET author = @newUserName WHERE author = @oldUserName;
        COMMIT;
      `);

    req.session.user.userName = newUserName;
    res.json({ message: "Username updated" });
  } catch (err) {
    console.error("Error updating username:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/check-login", (req, res) => {
  if (req.session.user) {
    res.json({ loggedIn: true, user: req.session.user });
  } else {
    res.json({ loggedIn: false });
  }
});

ffmpeg.getAvailableFormats((err, formats) => {
  if (err) {
    console.error("FFmpeg error:", err);
  } else {
    console.log("FFmpeg is properly installed");
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).send("Error logging out");
    }
    res.send("Logged out");
  });
});

const server = app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

server.timeout = 30 * 60 * 1000;
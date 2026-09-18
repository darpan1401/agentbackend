// ============================================================
// Alexa <-> Device Bridge Server
// ============================================================
// Handles:
// 1) Device connections (phone/laptop) via Socket.io
// 2) Commands coming from Alexa Skill via REST
// 3) Forwards commands to connected devices
// 4) Relays device responses back to Alexa
//
// GoDaddy Node.js Hosting compatible
// ============================================================

"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

// ============================================================
// APP SETUP
// ============================================================

const app = express();

// GoDaddy / reverse proxy friendly
app.disable("x-powered-by");

// ------------------------------------------------------------
// CORS
// ------------------------------------------------------------

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ------------------------------------------------------------
// JSON BODY PARSER
// ------------------------------------------------------------

app.use(
  express.json({
    limit: "1mb",
  })
);

// ------------------------------------------------------------
// REQUEST LOGGER
// ------------------------------------------------------------

app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );

  next();
});

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(app);

// ============================================================
// SOCKET.IO
// ============================================================

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },

  // Helps when hosted behind a reverse proxy
  transports: ["websocket", "polling"],
});

// ============================================================
// CONFIGURATION
// ============================================================

// IMPORTANT:
// Set BRIDGE_SECRET in GoDaddy Environment Variables.
//
// Example:
// BRIDGE_SECRET=your-super-secret-key
//
// The fallback is only useful for local development.

const SHARED_SECRET =
  process.env.BRIDGE_SECRET || "change-this-secret-123";

// ============================================================
// IN-MEMORY STATE
// ============================================================

const connectedDevices = new Map();
const pendingCommands = new Map();

// ============================================================
// BASIC / HEALTH ROUTES
// ============================================================

// ------------------------------------------------------------
// Root route
// ------------------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).json({
    name: "Alexa Device Bridge",
    status: "online",
    message: "Alexa Device Bridge is running.",
    timestamp: new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// Health check
// ------------------------------------------------------------

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    online: true,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// Status
// ------------------------------------------------------------

app.get("/status", (req, res) => {
  const devices = Array.from(connectedDevices.values()).map((device) => ({
    deviceName: device.deviceName,
    platform: device.platform,
  }));

  res.status(200).json({
    online: true,
    connectedDevices: devices,
    deviceCount: devices.length,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// SOCKET.IO - DEVICE CONNECTION
// ============================================================

io.on("connection", (socket) => {
  console.log("==========================================");
  console.log("New socket connected:", socket.id);
  console.log("==========================================");

  // ----------------------------------------------------------
  // DEVICE REGISTER
  // ----------------------------------------------------------

  socket.on("register", (data = {}) => {
    try {
      console.log("Register request from:", socket.id);

      // Validate secret
      if (data.secret !== SHARED_SECRET) {
        console.log(
          "Registration rejected: Invalid secret from",
          socket.id
        );

        socket.emit("register_failed", {
          reason: "Invalid secret",
        });

        socket.disconnect(true);
        return;
      }

      const deviceName =
        typeof data.deviceName === "string" && data.deviceName.trim()
          ? data.deviceName.trim()
          : "Unknown Device";

      const platform =
        typeof data.platform === "string" && data.platform.trim()
          ? data.platform.trim()
          : "unknown";

      connectedDevices.set(socket.id, {
        deviceName,
        platform,
        socket,
        connectedAt: new Date().toISOString(),
      });

      console.log(
        `Device registered: ${deviceName} (${platform})`
      );

      socket.emit("registered", {
        ok: true,
        deviceName,
        platform,
      });

      broadcastDeviceList();
    } catch (error) {
      console.error("Registration error:", error);

      socket.emit("register_failed", {
        reason: "Registration failed",
      });
    }
  });

  // ----------------------------------------------------------
  // COMMAND RESULT
  // ----------------------------------------------------------

  socket.on("command_result", (data = {}) => {
    try {
      const commandId = data.commandId;

      if (!commandId) {
        console.log("command_result received without commandId");
        return;
      }

      const pending = pendingCommands.get(commandId);

      if (!pending) {
        console.log(
          "No pending command found for:",
          commandId
        );
        return;
      }

      clearTimeout(pending.timeout);

      pending.resolve(data.result || {});

      pendingCommands.delete(commandId);

      console.log(
        `Command completed: ${commandId}`
      );
    } catch (error) {
      console.error("command_result error:", error);
    }
  });

  // ----------------------------------------------------------
  // DEVICE PING
  // ----------------------------------------------------------

  socket.on("ping", () => {
    socket.emit("pong", {
      timestamp: Date.now(),
    });
  });

  // ----------------------------------------------------------
  // DISCONNECT
  // ----------------------------------------------------------

  socket.on("disconnect", (reason) => {
    const device = connectedDevices.get(socket.id);

    if (device) {
      console.log(
        `Device disconnected: ${device.deviceName}`
      );
    } else {
      console.log(
        `Socket disconnected: ${socket.id}`
      );
    }

    console.log("Disconnect reason:", reason);

    connectedDevices.delete(socket.id);

    broadcastDeviceList();
  });

  // ----------------------------------------------------------
  // SOCKET ERROR
  // ----------------------------------------------------------

  socket.on("error", (error) => {
    console.error(
      `Socket error (${socket.id}):`,
      error
    );
  });
});

// ============================================================
// BROADCAST DEVICE LIST
// ============================================================

function broadcastDeviceList() {
  const list = Array.from(connectedDevices.values()).map(
    (device) => ({
      deviceName: device.deviceName,
      platform: device.platform,
    })
  );

  io.emit("device_list", list);

  console.log(
    `Connected devices: ${list.length}`
  );
}

// ============================================================
// SEND COMMAND TO DEVICE
// ============================================================

function sendCommandToDevice(
  commandType,
  payload = {},
  targetDeviceName = null,
  timeoutMs = 8000
) {
  return new Promise((resolve, reject) => {
    let target = null;

    // --------------------------------------------------------
    // Find target device
    // --------------------------------------------------------

    for (const device of connectedDevices.values()) {
      if (
        !targetDeviceName ||
        device.deviceName === targetDeviceName
      ) {
        target = device;
        break;
      }
    }

    // --------------------------------------------------------
    // No device
    // --------------------------------------------------------

    if (!target) {
      reject(
        new Error("No connected device found")
      );

      return;
    }

    // --------------------------------------------------------
    // Generate command ID
    // --------------------------------------------------------

    const commandId = crypto.randomUUID();

    console.log("Sending command:");
    console.log({
      commandId,
      commandType,
      targetDevice:
        target.deviceName,
    });

    // --------------------------------------------------------
    // Timeout
    // --------------------------------------------------------

    const timeout = setTimeout(() => {
      pendingCommands.delete(commandId);

      console.log(
        `Command timed out: ${commandId}`
      );

      reject(
        new Error(
          "Device did not respond in time"
        )
      );
    }, timeoutMs);

    // --------------------------------------------------------
    // Save pending command
    // --------------------------------------------------------

    pendingCommands.set(commandId, {
      resolve,
      reject,
      timeout,
    });

    // --------------------------------------------------------
    // Send to device
    // --------------------------------------------------------

    target.socket.emit("command", {
      commandId,
      type: commandType,
      payload,
    });
  });
}

// ============================================================
// ALEXA COMMAND ENDPOINT
// ============================================================

app.post("/alexa-command", async (req, res) => {
  try {
    console.log("=== /alexa-command ===");

    const {
      secret,
      command,
      deviceName,
      payload,
    } = req.body || {};

    // --------------------------------------------------------
    // Validate secret
    // --------------------------------------------------------

    if (secret !== SHARED_SECRET) {
      console.log(
        "Alexa command rejected: Unauthorized"
      );

      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    // --------------------------------------------------------
    // Validate command
    // --------------------------------------------------------

    if (!command) {
      return res.status(400).json({
        error: "Command is required",
      });
    }

    // --------------------------------------------------------
    // Check connected device
    // --------------------------------------------------------

    if (connectedDevices.size === 0) {
      return res.status(200).json({
        speech:
          "Your device is not connected to the bridge right now.",
      });
    }

    // --------------------------------------------------------
    // Send command
    // --------------------------------------------------------

    const result = await sendCommandToDevice(
      command,
      payload || {},
      deviceName || null
    );

    return res.status(200).json({
      speech: result?.speech || "Done.",
      raw: result,
    });
  } catch (error) {
    console.error(
      "/alexa-command error:",
      error
    );

    return res.status(200).json({
      speech:
        "Sorry, I could not reach your device.",
      error: error.message,
    });
  }
});

// ============================================================
// ALEXA WEBHOOK
// ============================================================

app.post("/alexa-webhook", async (req, res) => {
  console.log("");
  console.log("==========================================");
  console.log("=== ALEXA WEBHOOK HIT ===");
  console.log("==========================================");

  console.log(
    "Full incoming body:"
  );

  console.log(
    JSON.stringify(req.body, null, 2)
  );

  // ----------------------------------------------------------
  // Alexa response helper
  // ----------------------------------------------------------

  function speak(
    text,
    endSession = true
  ) {
    console.log(
      "Replying to Alexa:",
      text
    );

    return res.status(200).json({
      version: "1.0",

      response: {
        outputSpeech: {
          type: "PlainText",
          text: String(text),
        },

        shouldEndSession: endSession,
      },
    });
  }

  try {
    const request = req.body?.request;

    // --------------------------------------------------------
    // Invalid request
    // --------------------------------------------------------

    if (!request) {
      console.log(
        "No request field found"
      );

      return speak(
        "Sorry, something went wrong."
      );
    }

    console.log(
      "Alexa Request Type:",
      request.type
    );

    // ========================================================
    // LAUNCH REQUEST
    // ========================================================

    if (
      request.type === "LaunchRequest"
    ) {
      console.log(
        "Handling LaunchRequest"
      );

      return speak(
        "Bridge skill is ready. What would you like to check?",
        false
      );
    }

    // ========================================================
    // INTENT REQUEST
    // ========================================================

    if (
      request.type === "IntentRequest"
    ) {
      const intentName =
        request.intent?.name;

      console.log(
        "Alexa Intent:",
        intentName
      );

      // ------------------------------------------------------
      // CHECK NOTIFICATIONS
      // ------------------------------------------------------

      if (
        intentName ===
        "CheckNotificationsIntent"
      ) {
        console.log(
          "CheckNotificationsIntent"
        );

        console.log(
          "Connected devices:",
          connectedDevices.size
        );

        if (
          connectedDevices.size === 0
        ) {
          return speak(
            "Your device is not connected to the bridge right now."
          );
        }

        try {
          const result =
            await sendCommandToDevice(
              "check_notifications"
            );

          return speak(
            result?.speech ||
              "You have no new notifications."
          );
        } catch (error) {
          console.error(
            "Notification command error:",
            error.message
          );

          return speak(
            "Sorry, I could not reach your device."
          );
        }
      }

      // ------------------------------------------------------
      // PING DEVICE
      // ------------------------------------------------------

      if (
        intentName ===
        "PingDeviceIntent"
      ) {
        console.log(
          "PingDeviceIntent"
        );

        console.log(
          "Connected devices:",
          connectedDevices.size
        );

        if (
          connectedDevices.size === 0
        ) {
          return speak(
            "Your device is not connected to the bridge right now."
          );
        }

        try {
          const result =
            await sendCommandToDevice(
              "ping"
            );

          return speak(
            result?.speech ||
              "Your device is connected and responding."
          );
        } catch (error) {
          console.error(
            "Ping command error:",
            error.message
          );

          return speak(
            "Sorry, I could not reach your device."
          );
        }
      }

      // ------------------------------------------------------
      // STOP
      // ------------------------------------------------------

      if (
        intentName ===
          "AMAZON.StopIntent" ||
        intentName ===
          "AMAZON.CancelIntent"
      ) {
        return speak(
          "Okay, bye."
        );
      }

      // ------------------------------------------------------
      // HELP
      // ------------------------------------------------------

      if (
        intentName ===
        "AMAZON.HelpIntent"
      ) {
        return speak(
          "You can say check my notifications, or ping my device.",
          false
        );
      }

      // ------------------------------------------------------
      // FALLBACK
      // ------------------------------------------------------

      console.log(
        "Unhandled intent:",
        intentName
      );

      return speak(
        "Sorry, I did not understand that."
      );
    }

    // ========================================================
    // SESSION ENDED
    // ========================================================

    if (
      request.type ===
      "SessionEndedRequest"
    ) {
      console.log(
        "Alexa session ended."
      );

      return res.status(200).json({});
    }

    // ========================================================
    // UNKNOWN REQUEST
    // ========================================================

    console.log(
      "Unknown Alexa request type:",
      request.type
    );

    return speak(
      "Sorry, I did not understand that."
    );
  } catch (error) {
    console.error(
      "Alexa webhook error:",
      error
    );

    return speak(
      "Sorry, there was a problem processing your request."
    );
  }
});

// ============================================================
// 404 HANDLER
// ============================================================

app.use((req, res) => {
  res.status(404).json({
    error: "Not Found",
    path: req.originalUrl,
  });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (err, req, res, next) => {
    console.error(
      "Global server error:",
      err
    );

    if (res.headersSent) {
      return next(err);
    }

    res.status(500).json({
      error: "Internal Server Error",
    });
  }
);

// ============================================================
// GO DADDY / PRODUCTION PORT
// ============================================================

// IMPORTANT:
// NEVER hard-code a production port.
//
// GoDaddy provides PORT through:
// process.env.PORT
//
// 3000 is only a local development fallback.

// ============================================================
// GO DADDY / PRODUCTION PORT
// ============================================================

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log("==========================================");
  console.log(" Alexa Device Bridge Server");
  console.log("==========================================");
  console.log(`Server listening on ${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`Connected devices: ${connectedDevices.size}`);
  console.log("==========================================");
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(signal) {
  console.log(
    `Received ${signal}. Shutting down...`
  );

  // Clear pending command timers
  for (const [
    commandId,
    pending,
  ] of pendingCommands.entries()) {
    clearTimeout(pending.timeout);

    pending.reject(
      new Error(
        "Bridge server is shutting down"
      )
    );

    pendingCommands.delete(
      commandId
    );
  }

  // Close Socket.IO
  io.close(() => {
    console.log(
      "Socket.IO closed."
    );

    // Close HTTP server
    server.close(() => {
      console.log(
        "HTTP server closed."
      );

      process.exit(0);
    });
  });

  // Safety timeout
  setTimeout(() => {
    console.log(
      "Forced shutdown."
    );

    process.exit(1);
  }, 10000).unref();
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

// ============================================================
// PROCESS ERROR HANDLING
// ============================================================

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "UNCAUGHT EXCEPTION:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "UNHANDLED REJECTION:",
      reason
    );
  }
);
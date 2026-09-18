// Alexa <-> Device Bridge Server
// Handles: 1) Device connections (phone/laptop) via Socket.io
//          2) Commands coming from Alexa Skill (via REST /alexa endpoint)
//          3) Forwards commands to devices and relays responses back

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
app.use(cors());
app.use(express.json());

// Log every single incoming request, no matter the route.
// This helps confirm whether requests (e.g. from Alexa) are even reaching this server.
app.use((req, res, next) => {
  console.log(`>>> Incoming request: ${req.method} ${req.originalUrl}`);
  next();
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- Config ----
const SHARED_SECRET = process.env.BRIDGE_SECRET || "change-this-secret-123";

// ---- In-memory state ----
const connectedDevices = new Map();
const pendingCommands = new Map();

// ---------------- Socket.io: device connections ----------------
io.on("connection", (socket) => {
  console.log("New socket connected:", socket.id);

  socket.on("register", (data) => {
    if (data.secret !== SHARED_SECRET) {
      socket.emit("register_failed", { reason: "Invalid secret" });
      socket.disconnect(true);
      return;
    }
    connectedDevices.set(socket.id, {
      deviceName: data.deviceName || "Unknown Device",
      platform: data.platform || "unknown",
      socket,
    });
    console.log(`Device registered: ${data.deviceName} (${data.platform})`);
    socket.emit("registered", { ok: true });
    broadcastDeviceList();
  });

  socket.on("command_result", (data) => {
    const pending = pendingCommands.get(data.commandId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(data.result);
      pendingCommands.delete(data.commandId);
    }
  });

  socket.on("disconnect", () => {
    connectedDevices.delete(socket.id);
    console.log("Device disconnected:", socket.id);
    broadcastDeviceList();
  });
});

function broadcastDeviceList() {
  const list = Array.from(connectedDevices.values()).map((d) => ({
    deviceName: d.deviceName,
    platform: d.platform,
  }));
  io.emit("device_list", list);
}

function sendCommandToDevice(commandType, payload = {}, targetDeviceName = null, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let target = null;
    for (const dev of connectedDevices.values()) {
      if (!targetDeviceName || dev.deviceName === targetDeviceName) {
        target = dev;
        break;
      }
    }
    if (!target) {
      reject(new Error("No connected device found"));
      return;
    }

    const commandId = crypto.randomUUID();
    const timeout = setTimeout(() => {
      pendingCommands.delete(commandId);
      reject(new Error("Device did not respond in time"));
    }, timeoutMs);

    pendingCommands.set(commandId, { resolve, reject, timeout });
    target.socket.emit("command", { commandId, type: commandType, payload });
  });
}

// ---------------- REST: status check ----------------
app.get("/status", (req, res) => {
  res.json({
    online: true,
    connectedDevices: Array.from(connectedDevices.values()).map((d) => ({
      deviceName: d.deviceName,
      platform: d.platform,
    })),
  });
});

// ---------------- REST: endpoint for external calls (optional / legacy) ----------------
app.post("/alexa-command", async (req, res) => {
  const { secret, command, deviceName, payload } = req.body;

  if (secret !== SHARED_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  if (connectedDevices.size === 0) {
    return res.json({ speech: "Your device is not connected to the bridge right now." });
  }

  try {
    const result = await sendCommandToDevice(command, payload || {}, deviceName);
    return res.json({ speech: result.speech || "Done.", raw: result });
  } catch (err) {
    return res.json({ speech: "Sorry, I could not reach your device. " + err.message });
  }
});

// ---------------- Alexa direct HTTPS endpoint (no AWS Lambda needed) ----------------
app.post("/alexa-webhook", async (req, res) => {
  console.log("=== /alexa-webhook HIT ===");
  console.log("Full incoming body:", JSON.stringify(req.body, null, 2));

  const request = req.body.request;

  function speak(text, endSession = true) {
    console.log("Replying to Alexa with:", text);
    res.json({
      version: "1.0",
      response: {
        outputSpeech: { type: "PlainText", text },
        shouldEndSession: endSession,
      },
    });
  }

  if (!request) {
    console.log("No 'request' field found in body!");
    return speak("Sorry, something went wrong.");
  }

  console.log("Request type:", request.type);

  if (request.type === "LaunchRequest") {
    console.log("Handling LaunchRequest");
    return speak("Bridge skill is ready. What would you like to check?", false);
  }

  if (request.type === "IntentRequest") {
    const intentName = request.intent.name;
    console.log("Handling IntentRequest:", intentName);

    if (intentName === "CheckNotificationsIntent") {
      console.log("Connected devices count:", connectedDevices.size);
      if (connectedDevices.size === 0) return speak("Your device is not connected to the bridge right now.");
      try {
        const result = await sendCommandToDevice("check_notifications");
        return speak(result.speech || "Done.");
      } catch (err) {
        console.log("Error sending command:", err.message);
        return speak("Sorry, I could not reach your device.");
      }
    }

    if (intentName === "PingDeviceIntent") {
      console.log("Connected devices count:", connectedDevices.size);
      if (connectedDevices.size === 0) return speak("Your device is not connected to the bridge right now.");
      try {
        const result = await sendCommandToDevice("ping");
        return speak(result.speech || "Done.");
      } catch (err) {
        console.log("Error sending command:", err.message);
        return speak("Sorry, I could not reach your device.");
      }
    }

    if (intentName === "AMAZON.StopIntent" || intentName === "AMAZON.CancelIntent") {
      return speak("Okay, bye.");
    }

    if (intentName === "AMAZON.HelpIntent") {
      return speak("You can say, check my notifications, or, ping my device.", false);
    }

    console.log("Unhandled intent:", intentName);
  }

  console.log("Falling through to default response");
  return speak("Sorry, I did not understand that.");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bridge server running on port ${PORT}`));
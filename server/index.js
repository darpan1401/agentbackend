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

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// ---- Config ----
// Set this to a secret string. Your Flutter app AND your Alexa skill
// must both send this same key so random people can't control your devices.
const SHARED_SECRET = process.env.BRIDGE_SECRET || "change-this-secret-123";

// ---- In-memory state ----
// connectedDevices: socket.id -> { deviceName, platform, socket }
const connectedDevices = new Map();

// pendingCommands: commandId -> { resolve, reject, timeout }
const pendingCommands = new Map();

// ---------------- Socket.io: device connections ----------------
io.on("connection", (socket) => {
  console.log("New socket connected:", socket.id);

  // Device must "register" itself right after connecting
  socket.on("register", (data) => {
    // data = { secret, deviceName, platform }  platform: "android"|"windows"|"linux"
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

  // Device sends back the result of a command we forwarded to it
  socket.on("command_result", (data) => {
    // data = { commandId, result }
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

// Send a command to a specific device (or the first available one) and wait for its result
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

// ---------------- REST: endpoint Alexa Skill's Lambda calls ----------------
// Body: { secret, command, deviceName? }
// command examples: "check_notifications", "battery_status", "lock_pc", "open_app"
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
// In Alexa Developer Console, set Endpoint type to "HTTPS" and paste this server's
// URL + "/alexa-webhook" here. Alexa calls this directly whenever the skill is invoked.
app.post("/alexa-webhook", async (req, res) => {
  const request = req.body.request;

  function speak(text, endSession = true) {
    res.json({
      version: "1.0",
      response: {
        outputSpeech: { type: "PlainText", text },
        shouldEndSession: endSession,
      },
    });
  }

  if (!request) return speak("Sorry, something went wrong.");

  if (request.type === "LaunchRequest") {
    return speak("Bridge skill is ready. What would you like to check?", false);
  }

  if (request.type === "IntentRequest") {
    const intentName = request.intent.name;

    if (intentName === "CheckNotificationsIntent") {
      if (connectedDevices.size === 0) return speak("Your device is not connected to the bridge right now.");
      try {
        const result = await sendCommandToDevice("check_notifications");
        return speak(result.speech || "Done.");
      } catch (err) {
        return speak("Sorry, I could not reach your device.");
      }
    }

    if (intentName === "PingDeviceIntent") {
      if (connectedDevices.size === 0) return speak("Your device is not connected to the bridge right now.");
      try {
        const result = await sendCommandToDevice("ping");
        return speak(result.speech || "Done.");
      } catch (err) {
        return speak("Sorry, I could not reach your device.");
      }
    }

    if (intentName === "AMAZON.StopIntent" || intentName === "AMAZON.CancelIntent") {
      return speak("Okay, bye.");
    }

    if (intentName === "AMAZON.HelpIntent") {
      return speak("You can say, check my notifications, or, ping my device.", false);
    }
  }

  return speak("Sorry, I did not understand that.");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Bridge server running on port ${PORT}`));

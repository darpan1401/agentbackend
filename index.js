"use strict";

/*
============================================================
 ALEXA DEVICE BRIDGE - UNIVERSAL SERVER
============================================================

Works with:
  - Render
  - Railway
  - Any Node.js server
  - Local Node.js
  - ngrok
  - Cloudflare Tunnel
  - Other HTTPS reverse proxies

Main endpoints:
  GET  /
  GET  /health
  GET  /status
  GET  /alexa-webhook
  POST /alexa-webhook
  POST /alexa-command

Socket.IO:
  connection
  register
  command_result
  ping

============================================================
*/

const express = require("express");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const cors = require("cors");
const { Server } = require("socket.io");

// ============================================================
// CONFIG
// ============================================================

const app = express();

// When running behind Render/nginx/other proxies, trust proxy headers
app.set('trust proxy', true);

app.disable("x-powered-by");

const server = http.createServer(app);

// Log raw incoming HTTP requests to /socket.io so hosting logs capture handshake
server.on('request', (req, res) => {
  try {
    if (req.url && req.url.indexOf('/socket.io') === 0) {
      console.log('');
      console.log('--- RAW SOCKET.IO REQUEST ---');
      console.log('[HTTP] Method:', req.method);
      console.log('[HTTP] URL:', req.url);
      console.log('[HTTP] Headers:', req.headers);
      console.log('-----------------------------');
      console.log('');
    }
  } catch (err) {
    console.warn('Failed to log raw socket.io request', err);
  }
});

// Configure Socket.IO to be proxy-friendly and prefer polling first for
// environments where websocket upgrades may be restricted. Tweak timeouts
// to be reasonable for free-tier hosts.
const io = new Server(server, {
  path: '/socket.io',
  cors: {
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"]
  },
  // Use polling first so clients behind restrictive proxies can connect.
  transports: ["polling", "websocket"],
  allowEIO3: false,
  // Ping/pong intervals (ms)
  pingInterval: 25000,
  pingTimeout: 60000,
  // Small buffer size to limit memory usage of large messages
  maxHttpBufferSize: 1e6
});

// If REDIS_URL is provided we will connect a Redis adapter so Socket.IO
// can share session state across multiple instances (necessary on Render
// when scaling to more than one instance). If not set, the server runs
// without an adapter (single-instance mode).
if (process.env.REDIS_URL) {
  try {
    const { createAdapter } = require('@socket.io/redis-adapter');
    const { createClient } = require('redis');

    const pubClient = createClient({ url: process.env.REDIS_URL });
    const subClient = pubClient.duplicate();

    (async () => {
      await pubClient.connect();
      await subClient.connect();
      io.adapter(createAdapter(pubClient, subClient));
      console.log('[BOOT] Redis adapter connected for Socket.IO');
    })().catch((err) => {
      console.error('[BOOT] Redis adapter connection failed:', err);
    });
  } catch (err) {
    console.warn('[BOOT] Redis adapter not available:', err.message);
  }
}

// Render/Railway/etc. provide PORT automatically.
const PORT = Number(process.env.PORT) || 3000;

// MUST be 0.0.0.0 for Render/cloud hosting.
const HOST = "0.0.0.0";

// Secret used by your device/app.
const SHARED_SECRET =
  process.env.BRIDGE_SECRET || "change-this-secret-123";

// Alexa allows maximum timestamp tolerance.
const ALEXA_TIMESTAMP_TOLERANCE_MS = 150 * 1000;

// ============================================================
// MEMORY
// ============================================================

const connectedDevices = new Map();
const pendingCommands = new Map();

// ============================================================
// DEBUG HELPERS
// ============================================================

function now() {
  return new Date().toISOString();
}

function separator() {
  console.log(
    "============================================================"
  );
}

function debug(title, data = null) {
  console.log(`[${now()}] [DEBUG] ${title}`);

  if (data !== null) {
    console.dir(data, {
      depth: 10,
      colors: false
    });
  }
}

function info(title, data = null) {
  console.log(`[${now()}] [INFO] ${title}`);

  if (data !== null) {
    console.dir(data, {
      depth: 10,
      colors: false
    });
  }
}

function warn(title, data = null) {
  console.warn(`[${now()}] [WARN] ${title}`);

  if (data !== null) {
    console.dir(data, {
      depth: 10,
      colors: false
    });
  }
}

function errorLog(title, error = null) {
  console.error(`[${now()}] [ERROR] ${title}`);

  if (error) {
    console.error(error);
  }
}

// ============================================================
// CORS
// ============================================================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "SignatureCertChainUrl",
      "Signature-256",
      "Signature"
    ]
  })
);

// ============================================================
// JSON BODY
// ============================================================

// IMPORTANT:
// Alexa signature verification needs the original raw body.
app.use(
  express.json({
    limit: "1mb",

    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    }
  })
);

// ============================================================
// REQUEST LOGGER
// ============================================================

app.use((req, res, next) => {
  const requestId = crypto.randomUUID();
  const start = Date.now();

  req.requestId = requestId;

  console.log("");
  separator();

  console.log(
    `[HTTP] ${req.method} ${req.originalUrl}`
  );

  console.log(
    `[HTTP] Request ID: ${requestId}`
  );

  console.log(
    `[HTTP] User-Agent: ${req.get("user-agent") || "N/A"}`
  );

  console.log(
    `[HTTP] Content-Type: ${req.get("content-type") || "N/A"}`
  );

  console.log(
    `[HTTP] Content-Length: ${req.get("content-length") || "N/A"}`
  );

  if (req.headers["signaturecertchainurl"]) {
    console.log(
      "[HTTP] Alexa SignatureCertChainUrl: PRESENT"
    );
  }

  if (req.headers["signature-256"]) {
    console.log(
      "[HTTP] Alexa Signature-256: PRESENT"
    );
  }

  res.on("finish", () => {
    console.log(
      `[HTTP] Response ${res.statusCode} (${Date.now() - start}ms)`
    );

    separator();
    console.log("");
  });

  next();
});

// ============================================================
// ROOT
// ============================================================

app.get("/", (req, res) => {
  info("Root endpoint requested");

  res.status(200).json({
    service: "Alexa Device Bridge",
    status: "online",

    server: {
      node: process.version,
      environment: process.env.NODE_ENV || "development",
      port: PORT,
      host: HOST
    },

    endpoints: {
      health: "/health",
      status: "/status",
      alexaWebhook: "/alexa-webhook",
      alexaCommand: "/alexa-command"
    },

    socketIO: true,

    timestamp: now()
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  info("Health check requested");

  res.status(200).json({
    status: "ok",
    online: true,

    service: "Alexa Device Bridge",

    nodeVersion: process.version,

    environment:
      process.env.NODE_ENV || "development",

    pid: process.pid,

    port: PORT,

    uptime: process.uptime(),

    connectedDevices:
      connectedDevices.size,

    pendingCommands:
      pendingCommands.size,

    bridgeSecret:
      Boolean(process.env.BRIDGE_SECRET),

    alexaSignatureVerification:
      true,

    timestamp: now()
  });
});

// ============================================================
// STATUS
// ============================================================

app.get("/status", (req, res) => {
  info("Status endpoint requested");

  const devices = Array.from(
    connectedDevices.values()
  ).map((device) => ({
    deviceName: device.deviceName,
    platform: device.platform,
    connectedAt: device.connectedAt,
    socketId: device.socket.id
  }));

  res.status(200).json({
    online: true,

    deviceCount: devices.length,

    connectedDevices: devices,

    pendingCommands:
      pendingCommands.size,

    uptime: process.uptime(),

    timestamp: now()
  });
});

// ============================================================
// HEADER HELPER
// ============================================================

function getHeader(req, name) {
  const target = name.toLowerCase();

  for (const key of Object.keys(req.headers)) {
    if (key.toLowerCase() === target) {
      return req.headers[key];
    }
  }

  return undefined;
}

// ============================================================
// ALEXA CERTIFICATE URL VALIDATION
// ============================================================

function validateCertificateUrl(certificateUrl) {
  try {
    const url = new URL(certificateUrl);

    debug("Alexa certificate URL", {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      pathname: url.pathname
    });

    if (url.protocol !== "https:") {
      return false;
    }

    if (
      url.hostname.toLowerCase() !==
      "s3.amazonaws.com"
    ) {
      return false;
    }

    if (
      !url.pathname.startsWith("/echo.api/")
    ) {
      return false;
    }

    if (
      url.port &&
      url.port !== "443"
    ) {
      return false;
    }

    return true;

  } catch (err) {
    errorLog(
      "Certificate URL parsing failed",
      err
    );

    return false;
  }
}

// ============================================================
// DOWNLOAD ALEXA CERTIFICATE
// ============================================================

function downloadCertificate(certificateUrl) {
  return new Promise((resolve, reject) => {

    debug(
      "Downloading Alexa signing certificate..."
    );

    const request = https.get(
      certificateUrl,
      {
        timeout: 10000
      },

      (response) => {

        debug(
          "Alexa certificate HTTP status",
          response.statusCode
        );

        if (
          response.statusCode !== 200
        ) {

          response.resume();

          reject(
            new Error(
              `Certificate download failed with HTTP ${response.statusCode}`
            )
          );

          return;
        }

        const chunks = [];

        response.on(
          "data",
          (chunk) => {
            chunks.push(chunk);
          }
        );

        response.on(
          "end",
          () => {

            const certificate =
              Buffer.concat(chunks)
                .toString("utf8");

            debug(
              "Alexa certificate downloaded",
              {
                bytes: certificate.length
              }
            );

            resolve(certificate);
          }
        );
      }
    );

    request.on(
      "timeout",
      () => {

        request.destroy();

        reject(
          new Error(
            "Certificate download timed out"
          )
        );
      }
    );

    request.on(
      "error",
      (err) => {
        reject(err);
      }
    );
  });
}

// ============================================================
// VALIDATE SIGNING CERTIFICATE
// ============================================================

function validateSigningCertificate(
  certificatePem
) {

  try {

    const certificate =
      new crypto.X509Certificate(
        certificatePem
      );

    const currentTime =
      Date.now();

    const validFrom =
      new Date(
        certificate.validFrom
      ).getTime();

    const validTo =
      new Date(
        certificate.validTo
      ).getTime();

    debug(
      "Alexa certificate dates",
      {
        validFrom:
          certificate.validFrom,

        validTo:
          certificate.validTo
      }
    );

    if (
      Number.isNaN(validFrom) ||
      Number.isNaN(validTo)
    ) {

      return {
        valid: false,

        reason:
          "Certificate validity dates could not be read"
      };
    }

    if (
      currentTime < validFrom ||
      currentTime > validTo
    ) {

      return {
        valid: false,

        reason:
          "Alexa signing certificate is expired or not yet valid"
      };
    }

    const san =
      certificate.subjectAltName || "";

    debug(
      "Alexa certificate SAN",
      san
    );

    const sanEntries =
      san
        .split(",")
        .map((entry) =>
          entry.trim()
        )
        .map((entry) =>
          entry.replace(
            /^DNS:/i,
            ""
          )
        );

    const hasAlexaSAN =
      sanEntries.some(
        (entry) =>
          entry.toLowerCase() ===
          "echo-api.amazon.com"
      );

    if (!hasAlexaSAN) {

      return {
        valid: false,

        reason:
          "Certificate SAN does not contain echo-api.amazon.com"
      };
    }

    return {
      valid: true,
      certificate
    };

  } catch (err) {

    return {
      valid: false,

      reason:
        "Invalid X.509 certificate: " +
        err.message
    };
  }
}

// ============================================================
// VERIFY ALEXA REQUEST
// ============================================================

async function verifyAlexaRequest(req) {

  console.log("");
  console.log(
    "[ALEXA SECURITY] Starting signature verification..."
  );

  const certificateUrl =
    getHeader(
      req,
      "SignatureCertChainUrl"
    );

  const signature =
    getHeader(
      req,
      "Signature-256"
    );

  console.log(
    "[ALEXA SECURITY] Certificate URL:",
    certificateUrl
      ? "PRESENT"
      : "MISSING"
  );

  console.log(
    "[ALEXA SECURITY] Signature:",
    signature
      ? "PRESENT"
      : "MISSING"
  );

  if (!certificateUrl) {

    return {
      valid: false,

      reason:
        "Missing SignatureCertChainUrl header"
    };
  }

  if (!signature) {

    return {
      valid: false,

      reason:
        "Missing Signature-256 header"
    };
  }

  // ----------------------------------------------------------
  // Validate URL
  // ----------------------------------------------------------

  if (
    !validateCertificateUrl(
      certificateUrl
    )
  ) {

    return {
      valid: false,

      reason:
        "Invalid SignatureCertChainUrl"
    };
  }

  // ----------------------------------------------------------
  // Download certificate
  // ----------------------------------------------------------

  let certificatePem;

  try {

    certificatePem =
      await downloadCertificate(
        certificateUrl
      );

  } catch (err) {

    return {
      valid: false,

      reason:
        "Could not download Alexa signing certificate: " +
        err.message
    };
  }

  // ----------------------------------------------------------
  // Validate certificate
  // ----------------------------------------------------------

  const certificateResult =
    validateSigningCertificate(
      certificatePem
    );

  if (
    !certificateResult.valid
  ) {

    return certificateResult;
  }

  // ----------------------------------------------------------
  // Raw body
  // ----------------------------------------------------------

  if (!req.rawBody) {

    return {
      valid: false,

      reason:
        "Raw request body is unavailable"
    };
  }

  // ----------------------------------------------------------
  // Signature
  // ----------------------------------------------------------

  let signatureBuffer;

  try {

    signatureBuffer =
      Buffer.from(
        signature,
        "base64"
      );

  } catch (err) {

    return {
      valid: false,

      reason:
        "Invalid Signature-256 encoding"
    };
  }

  // ----------------------------------------------------------
  // RSA SHA256
  // ----------------------------------------------------------

  try {

    const verifier =
      crypto.createVerify(
        "RSA-SHA256"
      );

    verifier.update(
      req.rawBody
    );

    verifier.end();

    const verified =
      verifier.verify(
        certificateResult
          .certificate
          .publicKey,

        signatureBuffer
      );

    console.log(
      "[ALEXA SECURITY] Signature:",
      verified
        ? "VALID"
        : "INVALID"
    );

    if (!verified) {

      return {
        valid: false,

        reason:
          "Alexa request signature verification failed"
      };
    }

    return {
      valid: true
    };

  } catch (err) {

    return {
      valid: false,

      reason:
        "Signature verification error: " +
        err.message
    };
  }
}

// ============================================================
// VERIFY ALEXA TIMESTAMP
// ============================================================

function verifyAlexaTimestamp(req) {

  const timestamp =
    req.body?.request?.timestamp;

  console.log(
    "[ALEXA SECURITY] Alexa timestamp:",
    timestamp || "MISSING"
  );

  if (!timestamp) {

    return {
      valid: false,

      reason:
        "Alexa request timestamp is missing"
    };
  }

  const requestTime =
    new Date(
      timestamp
    ).getTime();

  if (
    Number.isNaN(requestTime)
  ) {

    return {
      valid: false,

      reason:
        "Alexa request timestamp is invalid"
    };
  }

  const difference =
    Math.abs(
      Date.now() -
      requestTime
    );

  console.log(
    "[ALEXA SECURITY] Timestamp difference:",
    `${difference}ms`
  );

  if (
    difference >
    ALEXA_TIMESTAMP_TOLERANCE_MS
  ) {

    return {
      valid: false,

      reason:
        "Alexa request timestamp is outside the allowed tolerance"
    };
  }

  return {
    valid: true
  };
}

// ============================================================
// SOCKET.IO CONNECTION
// ============================================================

io.on(
  "connection",
  (socket) => {

    console.log("");
    separator();

    console.log(
      "[SOCKET] NEW CONNECTION"
    );

    console.log(
      "[SOCKET] Socket ID:",
      socket.id
    );

    console.log(
      "[SOCKET] IP:",
      socket.handshake.address
    );

    console.log(
      "[SOCKET] Transport:",
      socket.conn.transport.name
    );

    separator();

    // ========================================================
    // REGISTER DEVICE
    // ========================================================

    socket.on(
      "register",
      (data = {}) => {

        console.log("");
        console.log(
          "[DEVICE] REGISTER REQUEST"
        );

        console.dir(
          {
            socketId:
              socket.id,

            deviceName:
              data.deviceName,

            platform:
              data.platform,

            hasSecret:
              Boolean(data.secret)
          },
          {
            depth: 10
          }
        );

        // ------------------------------------------------------
        // SECRET
        // ------------------------------------------------------

        if (
          data.secret !==
          SHARED_SECRET
        ) {

          warn(
            "Device registration rejected: invalid secret"
          );

          socket.emit(
            "register_failed",
            {
              reason:
                "Invalid secret"
            }
          );

          socket.disconnect(
            true
          );

          return;
        }

        // ------------------------------------------------------
        // DEVICE NAME
        // ------------------------------------------------------

        const deviceName =
          typeof data.deviceName ===
          "string" &&
          data.deviceName.trim()
            ? data.deviceName.trim()
            : "Unknown Device";

        // ------------------------------------------------------
        // PLATFORM
        // ------------------------------------------------------

        const platform =
          typeof data.platform ===
          "string" &&
          data.platform.trim()
            ? data.platform.trim()
            : "unknown";

        // ------------------------------------------------------
        // STORE
        // ------------------------------------------------------

        connectedDevices.set(
          socket.id,
          {
            deviceName,
            platform,
            socket,
            connectedAt:
              now()
          }
        );

        console.log("");
        console.log(
          "****************************************************"
        );

        console.log(
          "[DEVICE] DEVICE REGISTERED"
        );

        console.log(
          "[DEVICE] Name:",
          deviceName
        );

        console.log(
          "[DEVICE] Platform:",
          platform
        );

        console.log(
          "[DEVICE] Socket:",
          socket.id
        );

        console.log(
          "[DEVICE] Total connected:",
          connectedDevices.size
        );

        console.log(
          "****************************************************"
        );

        socket.emit(
          "registered",
          {
            ok: true,

            deviceName,

            platform
          }
        );

        broadcastDeviceList();
      }
    );

    // ========================================================
    // COMMAND RESULT
    // ========================================================

    socket.on(
      "command_result",
      (data = {}) => {

        console.log("");
        console.log(
          "[DEVICE] COMMAND RESULT RECEIVED"
        );

        console.dir(
          data,
          {
            depth: 10
          }
        );

        const commandId =
          data.commandId;

        if (!commandId) {

          warn(
            "command_result has no commandId"
          );

          return;
        }

        const pending =
          pendingCommands.get(
            commandId
          );

        if (!pending) {

          warn(
            "No pending command found",
            commandId
          );

          return;
        }

        clearTimeout(
          pending.timeout
        );

        pending.resolve(
          data.result || {}
        );

        pendingCommands.delete(
          commandId
        );

        console.log(
          "[COMMAND] Completed:",
          commandId
        );
      }
    );

    // ========================================================
    // DEVICE PING
    // ========================================================

    socket.on(
      "ping",
      () => {

        console.log(
          "[DEVICE] Ping received:",
          socket.id
        );

        socket.emit(
          "pong",
          {
            timestamp:
              Date.now()
          }
        );
      }
    );

    // ========================================================
    // SOCKET ERROR
    // ========================================================

    socket.on(
      "error",
      (err) => {

        errorLog(
          `[SOCKET ${socket.id}] Socket error`,
          err
        );
      }
    );

    // ========================================================
    // DISCONNECT
    // ========================================================

    socket.on(
      "disconnect",
      (reason) => {

        console.log("");
        console.log(
          "[SOCKET] DISCONNECTED"
        );

        console.log(
          "[SOCKET] ID:",
          socket.id
        );

        console.log(
          "[SOCKET] Reason:",
          reason
        );

        const device =
          connectedDevices.get(
            socket.id
          );

        if (device) {

          console.log(
            "[DEVICE] Disconnected:",
            device.deviceName
          );
        }

        connectedDevices.delete(
          socket.id
        );

        console.log(
          "[DEVICE] Connected devices:",
          connectedDevices.size
        );

        broadcastDeviceList();
      }
    );
  }
);

// ============================================================
// BROADCAST DEVICE LIST
// ============================================================

function broadcastDeviceList() {

  const list =
    Array.from(
      connectedDevices.values()
    ).map(
      (device) => ({
        deviceName:
          device.deviceName,

        platform:
          device.platform,

        connectedAt:
          device.connectedAt
      })
    );

  io.emit(
    "device_list",
    list
  );

  console.log(
    "[DEVICE LIST] Broadcasting:",
    list
  );
}

// ============================================================
// FIND DEVICE
// ============================================================

function findDevice(
  targetDeviceName = null
) {

  console.log(
    "[DEVICE] Looking for device:",
    targetDeviceName || "ANY DEVICE"
  );

  console.log(
    "[DEVICE] Available devices:",
    connectedDevices.size
  );

  let target = null;

  for (
    const device of
    connectedDevices.values()
  ) {

    console.log(
      "[DEVICE] Checking:",
      device.deviceName
    );

    if (
      !targetDeviceName ||
      device.deviceName ===
      targetDeviceName
    ) {

      target = device;

      break;
    }
  }

  return target;
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

  return new Promise(
    (resolve, reject) => {

      console.log("");
      separator();

      console.log(
        "[COMMAND] Preparing command"
      );

      console.log(
        "[COMMAND] Type:",
        commandType
      );

      console.log(
        "[COMMAND] Target:",
        targetDeviceName || "ANY"
      );

      console.log(
        "[COMMAND] Payload:"
      );

      console.dir(
        payload,
        {
          depth: 10
        }
      );

      // ------------------------------------------------------
      // DEVICE
      // ------------------------------------------------------

      const target =
        findDevice(
          targetDeviceName
        );

      if (!target) {

        console.error(
          "[COMMAND] NO CONNECTED DEVICE"
        );

        reject(
          new Error(
            "No connected device found"
          )
        );

        return;
      }

      // ------------------------------------------------------
      // COMMAND ID
      // ------------------------------------------------------

      const commandId =
        crypto.randomUUID();

      console.log(
        "[COMMAND] Command ID:",
        commandId
      );

      console.log(
        "[COMMAND] Sending to:",
        target.deviceName
      );

      // ------------------------------------------------------
      // TIMEOUT
      // ------------------------------------------------------

      const timeout =
        setTimeout(
          () => {

            console.error(
              "[COMMAND] TIMEOUT:",
              commandId
            );

            pendingCommands.delete(
              commandId
            );

            reject(
              new Error(
                "Device did not respond in time"
              )
            );

          },
          timeoutMs
        );

      // ------------------------------------------------------
      // SAVE PENDING
      // ------------------------------------------------------

      pendingCommands.set(
        commandId,
        {
          resolve,
          reject,
          timeout,

          commandType,

          deviceName:
            target.deviceName,

          createdAt:
            now()
        }
      );

      // ------------------------------------------------------
      // SEND SOCKET COMMAND
      // ------------------------------------------------------

      target.socket.emit(
        "command",
        {
          commandId,

          type:
            commandType,

          payload
        }
      );

      console.log(
        "[COMMAND] Socket command emitted successfully"
      );

      separator();
    }
  );
}

// ============================================================
// ALEXA COMMAND API
// ============================================================

app.post(
  "/alexa-command",
  async (req, res) => {

    console.log("");
    console.log(
      "####################################################"
    );

    console.log(
      "[ALEXA COMMAND API] REQUEST"
    );

    console.dir(
      req.body,
      {
        depth: 10
      }
    );

    console.log(
      "####################################################"
    );

    try {

      const {
        secret,
        command,
        deviceName,
        payload
      } =
        req.body || {};

      // ------------------------------------------------------
      // SECRET
      // ------------------------------------------------------

      if (
        secret !==
        SHARED_SECRET
      ) {

        warn(
          "[ALEXA COMMAND API] Unauthorized"
        );

        return res
          .status(401)
          .json({
            error:
              "Unauthorized"
          });
      }

      // ------------------------------------------------------
      // COMMAND
      // ------------------------------------------------------

      if (!command) {

        return res
          .status(400)
          .json({
            error:
              "Command is required"
          });
      }

      // ------------------------------------------------------
      // DEVICES
      // ------------------------------------------------------

      if (
        connectedDevices.size ===
        0
      ) {

        return res
          .status(200)
          .json({
            speech:
              "Your device is not connected to the bridge right now."
          });
      }

      // ------------------------------------------------------
      // SEND
      // ------------------------------------------------------

      const result =
        await sendCommandToDevice(
          command,
          payload || {},
          deviceName || null
        );

      console.log(
        "[ALEXA COMMAND API] RESULT:"
      );

      console.dir(
        result,
        {
          depth: 10
        }
      );

      return res
        .status(200)
        .json({
          speech:
            result?.speech ||
            "Done.",

          raw:
            result
        });

    } catch (err) {

      errorLog(
        "[ALEXA COMMAND API] Error",
        err
      );

      return res
        .status(200)
        .json({
          speech:
            "Sorry, I could not reach your device.",

          error:
            err.message
        });
    }
  }
);

// ============================================================
// ALEXA WEBHOOK - GET TEST
// ============================================================

app.get(
  "/alexa-webhook",
  (req, res) => {

    console.log("");
    separator();

    console.log(
      "[ALEXA WEBHOOK] GET TEST"
    );

    console.log(
      "[ALEXA WEBHOOK] This means public URL is reachable."
    );

    separator();

    res
      .status(200)
      .json({
        online: true,

        service:
          "Alexa Device Bridge",

        endpoint:
          "/alexa-webhook",

        method:
          "POST",

        message:
          "Alexa webhook is reachable. Alexa itself will use POST.",

        alexaReady:
          true,

        timestamp:
          now()
      });
  }
);

// ============================================================
// ALEXA WEBHOOK - POST
// ============================================================

app.post(
  "/alexa-webhook",
  async (req, res) => {

    console.log("");
    console.log("");
    console.log(
      "############################################################"
    );

    console.log(
      "###                 ALEXA WEBHOOK HIT                   ###"
    );

    console.log(
      "############################################################"
    );

    console.log(
      "[ALEXA] Request ID:",
      req.requestId
    );

    console.log(
      "[ALEXA] Time:",
      now()
    );

    console.log(
      "[ALEXA] Request Type:",
      req.body?.request?.type
    );

    console.log(
      "[ALEXA] Intent:",
      req.body?.request?.intent?.name
    );

    console.log(
      "[ALEXA] Timestamp:",
      req.body?.request?.timestamp
    );

    console.log(
      "[ALEXA] Raw body bytes:",
      req.rawBody
        ? req.rawBody.length
        : 0
    );

    console.log(
      "[ALEXA] Connected devices:",
      connectedDevices.size
    );

    // ========================================================
    // RESPONSE HELPER
    // ========================================================

    function speak(
      text,
      endSession = true
    ) {

      console.log("");
      console.log(
        "[ALEXA RESPONSE]"
      );

      console.log(
        "Speech:",
        text
      );

      console.log(
        "End session:",
        endSession
      );

      console.log("");

      return res
        .status(200)
        .json({
          version: "1.0",

          response: {

            outputSpeech: {

              type:
                "PlainText",

              text:
                String(text)
            },

            shouldEndSession:
              endSession
          }
        });
    }

    try {

      // ======================================================
      // SIGNATURE
      // ======================================================

      console.log("");
      console.log(
        "[ALEXA SECURITY] Verifying request..."
      );

      const signatureResult =
        await verifyAlexaRequest(
          req
        );

      if (
        !signatureResult.valid
      ) {

        console.error(
          "[ALEXA SECURITY] FAILED:",
          signatureResult.reason
        );

        return res
          .status(400)
          .json({
            error:
              "Invalid Alexa request",

            reason:
              signatureResult.reason
          });
      }

      console.log(
        "[ALEXA SECURITY] Signature VALID"
      );

      // ======================================================
      // TIMESTAMP
      // ======================================================

      const timestampResult =
        verifyAlexaTimestamp(
          req
        );

      if (
        !timestampResult.valid
      ) {

        console.error(
          "[ALEXA SECURITY] Timestamp FAILED:",
          timestampResult.reason
        );

        return res
          .status(400)
          .json({
            error:
              "Invalid Alexa request",

            reason:
              timestampResult.reason
          });
      }

      console.log(
        "[ALEXA SECURITY] Timestamp VALID"
      );

      // ======================================================
      // REQUEST
      // ======================================================

      const request =
        req.body?.request;

      if (!request) {

        console.error(
          "[ALEXA] Missing request object"
        );

        return speak(
          "Sorry, something went wrong."
        );
      }

      console.log("");
      console.log(
        "[ALEXA] Processing:",
        request.type
      );

      // ======================================================
      // LAUNCH
      // ======================================================

      if (
        request.type ===
        "LaunchRequest"
      ) {

        console.log(
          "[ALEXA] LaunchRequest"
        );

        return speak(
          "Bridge skill is ready. What would you like to check?",
          false
        );
      }

      // ======================================================
      // INTENT
      // ======================================================

      if (
        request.type ===
        "IntentRequest"
      ) {

        const intentName =
          request.intent?.name;

        console.log("");
        console.log(
          "****************************************************"
        );

        console.log(
          "[ALEXA] INTENT:",
          intentName
        );

        console.log(
          "****************************************************"
        );

        // ====================================================
        // CHECK NOTIFICATIONS
        // ====================================================

        if (
          intentName ===
          "CheckNotificationsIntent"
        ) {

          console.log(
            "[ALEXA] CheckNotificationsIntent"
          );

          if (
            connectedDevices.size ===
            0
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

          } catch (err) {

            errorLog(
              "Notification command failed",
              err
            );

            return speak(
              "Sorry, I could not reach your device."
            );
          }
        }

        // ====================================================
        // PING DEVICE
        // ====================================================

        if (
          intentName ===
          "PingDeviceIntent"
        ) {

          console.log(
            "[ALEXA] PingDeviceIntent"
          );

          if (
            connectedDevices.size ===
            0
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

          } catch (err) {

            errorLog(
              "Ping command failed",
              err
            );

            return speak(
              "Sorry, I could not reach your device."
            );
          }
        }

        // ====================================================
        // STOP
        // ====================================================

        if (
          intentName ===
          "AMAZON.StopIntent" ||
          intentName ===
          "AMAZON.CancelIntent"
        ) {

          console.log(
            "[ALEXA] Stop/Cancel"
          );

          return speak(
            "Okay, bye."
          );
        }

        // ====================================================
        // HELP
        // ====================================================

        if (
          intentName ===
          "AMAZON.HelpIntent"
        ) {

          return speak(
            "You can say check my notifications, or ping my device.",
            false
          );
        }

        // ====================================================
        // FALLBACK
        // ====================================================

        console.log(
          "[ALEXA] Unhandled intent:",
          intentName
        );

        return speak(
          "Sorry, I did not understand that."
        );
      }

      // ======================================================
      // SESSION END
      // ======================================================

      if (
        request.type ===
        "SessionEndedRequest"
      ) {

        console.log(
          "[ALEXA] SessionEndedRequest"
        );

        return res
          .status(200)
          .json({});
      }

      // ======================================================
      // UNKNOWN
      // ======================================================

      console.log(
        "[ALEXA] Unknown request type:",
        request.type
      );

      return speak(
        "Sorry, I did not understand that."
      );

    } catch (err) {

      errorLog(
        "[ALEXA WEBHOOK] INTERNAL ERROR",
        err
      );

      return res
        .status(500)
        .json({
          error:
            "Internal Alexa webhook error",

          message:
            err.message
        });
    }
  }
);

// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    console.log("");
    console.log(
      "[404] Route not found:",
      req.method,
      req.originalUrl
    );

    res
      .status(404)
      .json({
        error:
          "Not Found",

        path:
          req.originalUrl,

        method:
          req.method,

        availableEndpoints: [
          "GET /",
          "GET /health",
          "GET /status",
          "GET /alexa-webhook",
          "POST /alexa-webhook",
          "POST /alexa-command"
        ]
      });
  }
);

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use(
  (
    err,
    req,
    res,
    next
  ) => {

    errorLog(
      "[GLOBAL SERVER ERROR]",
      err
    );

    if (
      res.headersSent
    ) {

      return next(err);
    }

    res
      .status(500)
      .json({
        error:
          "Internal Server Error",

        message:
          err.message
      });
  }
);

// ============================================================
// STARTUP
// ============================================================

console.log("");
console.log("");
console.log(
  "############################################################"
);

console.log(
  "###          ALEXA DEVICE BRIDGE STARTING              ###"
);

console.log(
  "############################################################"
);

console.log(
  "[BOOT] Node:",
  process.version
);

console.log(
  "[BOOT] PID:",
  process.pid
);

console.log(
  "[BOOT] Environment:",
  process.env.NODE_ENV ||
  "development"
);

console.log(
  "[BOOT] PORT:",
  PORT
);

console.log(
  "[BOOT] HOST:",
  HOST
);

console.log(
  "[BOOT] BRIDGE_SECRET:",
  process.env.BRIDGE_SECRET
    ? "SET"
    : "NOT SET - USING FALLBACK"
);

console.log(
  "[BOOT] Alexa signature verification: ENABLED"
);

console.log(
  "[BOOT] Socket.IO: ENABLED"
);

console.log(
  "[BOOT] CORS: ENABLED"
);

console.log(
  "[BOOT] Raw Alexa request body: ENABLED"
);

console.log(
  "[BOOT] Server can run behind Render/ngrok/Cloudflare/etc."
);

console.log(
  "############################################################"
);

server.listen(
  PORT,
  HOST,
  () => {

    console.log("");
    console.log(
      "============================================================"
    );

    console.log(
      "🚀 ALEXA DEVICE BRIDGE IS ONLINE"
    );

    console.log(
      "============================================================"
    );

    console.log(
      `Local server: http://127.0.0.1:${PORT}`
    );

    console.log(
      `Health: http://127.0.0.1:${PORT}/health`
    );

    console.log(
      `Status: http://127.0.0.1:${PORT}/status`
    );

    console.log(
      `Alexa webhook: http://127.0.0.1:${PORT}/alexa-webhook`
    );

    console.log(
      ""
    );

    console.log(
      "For Render:"
    );

    console.log(
      "https://YOUR-SERVICE.onrender.com/alexa-webhook"
    );

    console.log(
      ""
    );

    console.log(
      "For ngrok:"
    );

    console.log(
      "https://YOUR-NGROK-DOMAIN/alexa-webhook"
    );

    console.log(
      ""
    );

    console.log(
      "Waiting for Alexa/device connections..."
    );

    console.log(
      "============================================================"
    );

    console.log("");
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

function shutdown(signal) {

  console.log("");
  console.log(
    "============================================================"
  );

  console.log(
    `[SHUTDOWN] Received ${signal}`
  );

  console.log(
    "[SHUTDOWN] Pending commands:",
    pendingCommands.size
  );

  console.log(
    "[SHUTDOWN] Connected devices:",
    connectedDevices.size
  );

  console.log(
    "============================================================"
  );

  // ----------------------------------------------------------
  // Pending commands
  // ----------------------------------------------------------

  for (
    const [
      commandId,
      pending
    ]
    of pendingCommands.entries()
  ) {

    clearTimeout(
      pending.timeout
    );

    pending.reject(
      new Error(
        "Bridge server is shutting down"
      )
    );

    pendingCommands.delete(
      commandId
    );
  }

  // ----------------------------------------------------------
  // Socket.IO
  // ----------------------------------------------------------

  io.close(
    () => {

      console.log(
        "[SHUTDOWN] Socket.IO closed."
      );

      // --------------------------------------------------------
      // HTTP
      // --------------------------------------------------------

      server.close(
        () => {

          console.log(
            "[SHUTDOWN] HTTP server closed."
          );

          process.exit(0);
        }
      );
    }
  );

  // ----------------------------------------------------------
  // Force exit
  // ----------------------------------------------------------

  setTimeout(
    () => {

      console.error(
        "[SHUTDOWN] Forced shutdown."
      );

      process.exit(1);

    },
    10000
  ).unref();
}

// ============================================================
// PROCESS SIGNALS
// ============================================================

process.on(
  "SIGTERM",
  () => {
    shutdown("SIGTERM");
  }
);

process.on(
  "SIGINT",
  () => {
    shutdown("SIGINT");
  }
);

// ============================================================
// CRASH HANDLERS
// ============================================================

process.on(
  "uncaughtException",
  (err) => {

    console.error("");
    console.error(
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    );

    console.error(
      "UNCAUGHT EXCEPTION"
    );

    console.error(
      err
    );

    console.error(
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    );

    // Don't immediately exit so Render logs remain visible.
  }
);

process.on(
  "unhandledRejection",
  (reason) => {

    console.error("");
    console.error(
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    );

    console.error(
      "UNHANDLED PROMISE REJECTION"
    );

    console.error(
      reason
    );

    console.error(
      "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    );
  }
);

// ============================================================
// PERIODIC DEBUG STATUS
// ============================================================

// Every 60 seconds print bridge status.
// Useful on Render because you can see whether the process
// is still alive and whether a device is connected.

setInterval(
  () => {

    console.log("");
    console.log(
      "[HEARTBEAT]"
    );

    console.log(
      "Time:",
      now()
    );

    console.log(
      "Uptime:",
      `${Math.round(process.uptime())} seconds`
    );

    console.log(
      "Connected devices:",
      connectedDevices.size
    );

    console.log(
      "Pending commands:",
      pendingCommands.size
    );

    console.log(
      "Memory:",
      process.memoryUsage()
    );

    console.log(
      ""
    );

  },
  60 * 1000
);
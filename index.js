// ============================================================
// Alexa <-> Device Bridge Server
// ============================================================
// Handles:
// 1) Device connections via Socket.io
// 2) Commands coming from Alexa Skill
// 3) Forwards commands to connected devices
// 4) Relays device responses back to Alexa
//
// HOSTING:
// - Local Node.js server
// - Cloudflare Tunnel
//
// NO GoDaddy dependency
// ============================================================

"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const crypto = require("crypto");
const https = require("https");

// ============================================================
// APP SETUP
// ============================================================

const app = express();

app.disable("x-powered-by");

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
      "Signature",
    ],
  })
);

// ============================================================
// JSON BODY PARSER
// ============================================================
//
// Keep the exact raw request body because Alexa signs the
// original request body.
//
// ============================================================

app.use(
  express.json({
    limit: "1mb",

    verify: (req, res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  })
);

// ============================================================
// REQUEST LOGGER
// ============================================================

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

  transports: ["websocket", "polling"],
});

// ============================================================
// CONFIGURATION
// ============================================================

const PORT =
  Number(process.env.PORT) || 3000;

const HOST = "0.0.0.0";

// ------------------------------------------------------------
// Device authentication secret
// ------------------------------------------------------------

const SHARED_SECRET =
  process.env.BRIDGE_SECRET ||
  "change-this-secret-123";

// ------------------------------------------------------------
// Alexa timestamp tolerance
// ------------------------------------------------------------
//
// Amazon recommends a maximum tolerance of 150 seconds.
// ------------------------------------------------------------

const ALEXA_TIMESTAMP_TOLERANCE_MS =
  150 * 1000;

// ============================================================
// IN-MEMORY STATE
// ============================================================

const connectedDevices = new Map();

const pendingCommands = new Map();

// ============================================================
// BASIC ROUTES
// ============================================================

// ------------------------------------------------------------
// Root
// ------------------------------------------------------------

app.get("/", (req, res) => {
  res.status(200).json({
    name: "Alexa Device Bridge",
    status: "online",
    environment: "local",
    cloudflareReady: true,
    message:
      "Alexa Device Bridge is running.",
    timestamp:
      new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// Health
// ------------------------------------------------------------

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    online: true,
    uptime: process.uptime(),
    connectedDevices:
      connectedDevices.size,
    timestamp:
      new Date().toISOString(),
  });
});

// ------------------------------------------------------------
// Status
// ------------------------------------------------------------

app.get("/status", (req, res) => {
  const devices = Array.from(
    connectedDevices.values()
  ).map((device) => ({
    deviceName: device.deviceName,
    platform: device.platform,
    connectedAt: device.connectedAt,
  }));

  res.status(200).json({
    online: true,
    connectedDevices: devices,
    deviceCount: devices.length,
    uptime: process.uptime(),
    timestamp:
      new Date().toISOString(),
  });
});

// ============================================================
// ALEXA SIGNATURE VERIFICATION HELPERS
// ============================================================

// ------------------------------------------------------------
// Get request header case-insensitively
// ------------------------------------------------------------

function getHeader(req, name) {
  const target =
    name.toLowerCase();

  for (const key of Object.keys(
    req.headers
  )) {
    if (
      key.toLowerCase() === target
    ) {
      return req.headers[key];
    }
  }

  return undefined;
}

// ------------------------------------------------------------
// Validate SignatureCertChainUrl
// ------------------------------------------------------------
//
// Alexa documentation requires the certificate URL to use:
//
// https://s3.amazonaws.com/echo.api/...
//
// ------------------------------------------------------------

function validateCertificateUrl(
  certificateUrl
) {
  try {
    const url =
      new URL(certificateUrl);

    if (
      url.protocol !== "https:"
    ) {
      return false;
    }

    if (
      url.hostname.toLowerCase() !==
      "s3.amazonaws.com"
    ) {
      return false;
    }

    if (
      !url.pathname.startsWith(
        "/echo.api/"
      )
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
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Download Alexa signing certificate
// ------------------------------------------------------------

function downloadCertificate(
  certificateUrl
) {
  return new Promise(
    (resolve, reject) => {
      const request =
        https.get(
          certificateUrl,
          {
            timeout: 5000,
          },
          (response) => {
            if (
              response.statusCode !==
              200
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
                resolve(
                  Buffer.concat(
                    chunks
                  ).toString("utf8")
                );
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
        (error) => {
          reject(error);
        }
      );
    }
  );
}

// ------------------------------------------------------------
// Validate signing certificate
// ------------------------------------------------------------

function validateSigningCertificate(
  certificatePem
) {
  try {
    const certificate =
      new crypto.X509Certificate(
        certificatePem
      );

    const now =
      Date.now();

    const validFrom =
      new Date(
        certificate.validFrom
      ).getTime();

    const validTo =
      new Date(
        certificate.validTo
      ).getTime();

    if (
      Number.isNaN(validFrom) ||
      Number.isNaN(validTo)
    ) {
      return {
        valid: false,
        reason:
          "Certificate validity dates could not be read",
      };
    }

    if (
      now < validFrom ||
      now > validTo
    ) {
      return {
        valid: false,
        reason:
          "Alexa signing certificate is expired or not yet valid",
      };
    }

    // Alexa requires echo-api.amazon.com
    // in the certificate SAN.

    const san =
      certificate.subjectAltName ||
      "";

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

    const hasAlexaSan =
      sanEntries.some(
        (entry) =>
          entry.toLowerCase() ===
          "echo-api.amazon.com"
      );

    if (!hasAlexaSan) {
      return {
        valid: false,
        reason:
          "Certificate SAN does not contain echo-api.amazon.com",
      };
    }

    return {
      valid: true,
      certificate,
    };
  } catch (error) {
    return {
      valid: false,
      reason:
        "Invalid X.509 certificate: " +
        error.message,
    };
  }
}

// ------------------------------------------------------------
// Verify Alexa request signature
// ------------------------------------------------------------

async function verifyAlexaRequest(
  req
) {
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

  if (!certificateUrl) {
    return {
      valid: false,
      reason:
        "Missing SignatureCertChainUrl header",
    };
  }

  if (!signature) {
    return {
      valid: false,
      reason:
        "Missing Signature-256 header",
    };
  }

  // Validate certificate URL.

  if (
    !validateCertificateUrl(
      certificateUrl
    )
  ) {
    return {
      valid: false,
      reason:
        "Invalid SignatureCertChainUrl",
    };
  }

  // Download signing certificate.

  let certificatePem;

  try {
    certificatePem =
      await downloadCertificate(
        certificateUrl
      );
  } catch (error) {
    return {
      valid: false,
      reason:
        "Could not download Alexa signing certificate: " +
        error.message,
    };
  }

  // Validate certificate.

  const certificateResult =
    validateSigningCertificate(
      certificatePem
    );

  if (
    !certificateResult.valid
  ) {
    return certificateResult;
  }

  // Raw body is required.

  if (!req.rawBody) {
    return {
      valid: false,
      reason:
        "Raw request body is unavailable",
    };
  }

  // Decode Base64 signature.

  let signatureBuffer;

  try {
    signatureBuffer =
      Buffer.from(
        signature,
        "base64"
      );
  } catch {
    return {
      valid: false,
      reason:
        "Invalid Signature-256 encoding",
    };
  }

  // Verify RSA SHA-256 signature.

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
        certificateResult.certificate.publicKey,
        signatureBuffer
      );

    if (!verified) {
      return {
        valid: false,
        reason:
          "Alexa request signature verification failed",
      };
    }

    return {
      valid: true,
    };
  } catch (error) {
    return {
      valid: false,
      reason:
        "Signature verification error: " +
        error.message,
    };
  }
}

// ------------------------------------------------------------
// Verify Alexa timestamp
// ------------------------------------------------------------

function verifyAlexaTimestamp(
  req
) {
  const timestamp =
    req.body?.request?.timestamp;

  if (!timestamp) {
    return {
      valid: false,
      reason:
        "Alexa request timestamp is missing",
    };
  }

  const requestTime =
    new Date(timestamp).getTime();

  if (
    Number.isNaN(requestTime)
  ) {
    return {
      valid: false,
      reason:
        "Alexa request timestamp is invalid",
    };
  }

  const difference =
    Math.abs(
      Date.now() -
        requestTime
    );

  if (
    difference >
    ALEXA_TIMESTAMP_TOLERANCE_MS
  ) {
    return {
      valid: false,
      reason:
        "Alexa request timestamp is outside the allowed tolerance",
    };
  }

  return {
    valid: true,
  };
}

// ============================================================
// SOCKET.IO - DEVICE CONNECTION
// ============================================================

io.on(
  "connection",
  (socket) => {
    console.log(
      "=========================================="
    );

    console.log(
      "New socket connected:",
      socket.id
    );

    console.log(
      "=========================================="
    );

    // --------------------------------------------------------
    // DEVICE REGISTER
    // --------------------------------------------------------

    socket.on(
      "register",
      (data = {}) => {
        try {
          console.log(
            "Register request from:",
            socket.id
          );

          // Validate secret.

          if (
            data.secret !==
            SHARED_SECRET
          ) {
            console.log(
              "Registration rejected: Invalid secret from",
              socket.id
            );

            socket.emit(
              "register_failed",
              {
                reason:
                  "Invalid secret",
              }
            );

            socket.disconnect(
              true
            );

            return;
          }

          // Device name.

          const deviceName =
            typeof data.deviceName ===
              "string" &&
            data.deviceName.trim()
              ? data.deviceName.trim()
              : "Unknown Device";

          // Platform.

          const platform =
            typeof data.platform ===
              "string" &&
            data.platform.trim()
              ? data.platform.trim()
              : "unknown";

          // Store device.

          connectedDevices.set(
            socket.id,
            {
              deviceName,
              platform,
              socket,
              connectedAt:
                new Date().toISOString(),
            }
          );

          console.log(
            `Device registered: ${deviceName} (${platform})`
          );

          // Registration success.

          socket.emit(
            "registered",
            {
              ok: true,
              deviceName,
              platform,
            }
          );

          broadcastDeviceList();
        } catch (error) {
          console.error(
            "Registration error:",
            error
          );

          socket.emit(
            "register_failed",
            {
              reason:
                "Registration failed",
            }
          );
        }
      }
    );

    // --------------------------------------------------------
    // COMMAND RESULT
    // --------------------------------------------------------

    socket.on(
      "command_result",
      (data = {}) => {
        try {
          const commandId =
            data.commandId;

          if (!commandId) {
            console.log(
              "command_result received without commandId"
            );

            return;
          }

          const pending =
            pendingCommands.get(
              commandId
            );

          if (!pending) {
            console.log(
              "No pending command found for:",
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
            `Command completed: ${commandId}`
          );
        } catch (error) {
          console.error(
            "command_result error:",
            error
          );
        }
      }
    );

    // --------------------------------------------------------
    // DEVICE PING
    // --------------------------------------------------------

    socket.on(
      "ping",
      () => {
        socket.emit(
          "pong",
          {
            timestamp:
              Date.now(),
          }
        );
      }
    );

    // --------------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------------

    socket.on(
      "disconnect",
      (reason) => {
        const device =
          connectedDevices.get(
            socket.id
          );

        if (device) {
          console.log(
            `Device disconnected: ${device.deviceName}`
          );
        } else {
          console.log(
            `Socket disconnected: ${socket.id}`
          );
        }

        console.log(
          "Disconnect reason:",
          reason
        );

        connectedDevices.delete(
          socket.id
        );

        broadcastDeviceList();
      }
    );

    // --------------------------------------------------------
    // SOCKET ERROR
    // --------------------------------------------------------

    socket.on(
      "error",
      (error) => {
        console.error(
          `Socket error (${socket.id}):`,
          error
        );
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
      })
    );

  io.emit(
    "device_list",
    list
  );

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
  return new Promise(
    (resolve, reject) => {
      let target = null;

      // ------------------------------------------------------
      // Find target device
      // ------------------------------------------------------

      for (
        const device of
          connectedDevices.values()
      ) {
        if (
          !targetDeviceName ||
          device.deviceName ===
            targetDeviceName
        ) {
          target = device;
          break;
        }
      }

      // ------------------------------------------------------
      // No device
      // ------------------------------------------------------

      if (!target) {
        reject(
          new Error(
            "No connected device found"
          )
        );

        return;
      }

      // ------------------------------------------------------
      // Generate command ID
      // ------------------------------------------------------

      const commandId =
        crypto.randomUUID();

      console.log(
        "Sending command:"
      );

      console.log({
        commandId,
        commandType,
        targetDevice:
          target.deviceName,
      });

      // ------------------------------------------------------
      // Timeout
      // ------------------------------------------------------

      const timeout =
        setTimeout(
          () => {
            pendingCommands.delete(
              commandId
            );

            console.log(
              `Command timed out: ${commandId}`
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
      // Save pending command
      // ------------------------------------------------------

      pendingCommands.set(
        commandId,
        {
          resolve,
          reject,
          timeout,
        }
      );

      // ------------------------------------------------------
      // Send command
      // ------------------------------------------------------

      target.socket.emit(
        "command",
        {
          commandId,
          type: commandType,
          payload,
        }
      );
    }
  );
}

// ============================================================
// ALEXA COMMAND ENDPOINT
// ============================================================

app.post(
  "/alexa-command",
  async (req, res) => {
    try {
      console.log(
        "=== /alexa-command ==="
      );

      const {
        secret,
        command,
        deviceName,
        payload,
      } = req.body || {};

      // ------------------------------------------------------
      // Validate secret
      // ------------------------------------------------------

      if (
        secret !==
        SHARED_SECRET
      ) {
        console.log(
          "Alexa command rejected: Unauthorized"
        );

        return res
          .status(401)
          .json({
            error:
              "Unauthorized",
          });
      }

      // ------------------------------------------------------
      // Validate command
      // ------------------------------------------------------

      if (!command) {
        return res
          .status(400)
          .json({
            error:
              "Command is required",
          });
      }

      // ------------------------------------------------------
      // Check connected device
      // ------------------------------------------------------

      if (
        connectedDevices.size ===
        0
      ) {
        return res
          .status(200)
          .json({
            speech:
              "Your device is not connected to the bridge right now.",
          });
      }

      // ------------------------------------------------------
      // Send command
      // ------------------------------------------------------

      const result =
        await sendCommandToDevice(
          command,
          payload || {},
          deviceName || null
        );

      return res
        .status(200)
        .json({
          speech:
            result?.speech ||
            "Done.",
          raw: result,
        });
    } catch (error) {
      console.error(
        "/alexa-command error:",
        error
      );

      return res
        .status(200)
        .json({
          speech:
            "Sorry, I could not reach your device.",
          error:
            error.message,
        });
    }
  }
);

// ============================================================
// ALEXA WEBHOOK
// ============================================================

// ------------------------------------------------------------
// GET /alexa-webhook
//
// Browser / Cloudflare connectivity test only.
//
// Alexa itself sends POST.
// ------------------------------------------------------------

app.get(
  "/alexa-webhook",
  (req, res) => {
    console.log(
      "GET /alexa-webhook - browser test"
    );

    res
      .status(200)
      .json({
        online: true,
        endpoint:
          "/alexa-webhook",
        method: "POST",
        message:
          "Alexa webhook is reachable. Alexa requests must use POST.",
        timestamp:
          new Date().toISOString(),
      });
  }
);

// ------------------------------------------------------------
// POST /alexa-webhook
//
// Actual Alexa endpoint.
// ------------------------------------------------------------

app.post(
  "/alexa-webhook",
  async (req, res) => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      "=== ALEXA WEBHOOK HIT ==="
    );
    console.log(
      "=========================================="
    );

    console.log(
      "Alexa request received."
    );

    // --------------------------------------------------------
    // Show headers needed for verification
    // --------------------------------------------------------

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
      "SignatureCertChainUrl:",
      certificateUrl
        ? "PRESENT"
        : "MISSING"
    );

    console.log(
      "Signature-256:",
      signature
        ? "PRESENT"
        : "MISSING"
    );

    // --------------------------------------------------------
    // Alexa response helper
    // --------------------------------------------------------

    function speak(
      text,
      endSession = true
    ) {
      console.log(
        "Replying to Alexa:",
        text
      );

      return res
        .status(200)
        .json({
          version: "1.0",

          response: {
            outputSpeech: {
              type: "PlainText",
              text: String(
                text
              ),
            },

            shouldEndSession:
              endSession,
          },
        });
    }

    try {
      // ======================================================
      // ALEXA SECURITY VALIDATION
      // ======================================================

      console.log(
        "Verifying Alexa request..."
      );

      const signatureResult =
        await verifyAlexaRequest(
          req
        );

      if (
        !signatureResult.valid
      ) {
        console.error(
          "Alexa signature verification failed:",
          signatureResult.reason
        );

        // During local browser testing,
        // GET is handled separately.
        //
        // For POST requests, reject invalid
        // or unsigned requests.

        return res
          .status(400)
          .json({
            error:
              "Invalid Alexa request",
            reason:
              signatureResult.reason,
          });
      }

      console.log(
        "Alexa signature: VALID"
      );

      // ------------------------------------------------------
      // Timestamp validation
      // ------------------------------------------------------

      const timestampResult =
        verifyAlexaTimestamp(
          req
        );

      if (
        !timestampResult.valid
      ) {
        console.error(
          "Alexa timestamp validation failed:",
          timestampResult.reason
        );

        return res
          .status(400)
          .json({
            error:
              "Invalid Alexa request",
            reason:
              timestampResult.reason,
          });
      }

      console.log(
        "Alexa timestamp: VALID"
      );

      // ======================================================
      // REQUEST BODY
      // ======================================================

      const request =
        req.body?.request;

      console.log(
        "Alexa Request Type:",
        request?.type
      );

      // ------------------------------------------------------
      // Invalid request
      // ------------------------------------------------------

      if (!request) {
        console.log(
          "No request field found"
        );

        return speak(
          "Sorry, something went wrong."
        );
      }

      // ======================================================
      // LAUNCH REQUEST
      // ======================================================

      if (
        request.type ===
        "LaunchRequest"
      ) {
        console.log(
          "Handling LaunchRequest"
        );

        return speak(
          "Bridge skill is ready. What would you like to check?",
          false
        );
      }

      // ======================================================
      // INTENT REQUEST
      // ======================================================

      if (
        request.type ===
        "IntentRequest"
      ) {
        const intentName =
          request.intent?.name;

        console.log(
          "Alexa Intent:",
          intentName
        );

        // ----------------------------------------------------
        // CHECK NOTIFICATIONS
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // PING DEVICE
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // STOP
        // ----------------------------------------------------

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

        // ----------------------------------------------------
        // HELP
        // ----------------------------------------------------

        if (
          intentName ===
          "AMAZON.HelpIntent"
        ) {
          return speak(
            "You can say check my notifications, or ping my device.",
            false
          );
        }

        // ----------------------------------------------------
        // FALLBACK
        // ----------------------------------------------------

        console.log(
          "Unhandled intent:",
          intentName
        );

        return speak(
          "Sorry, I did not understand that."
        );
      }

      // ======================================================
      // SESSION ENDED
      // ======================================================

      if (
        request.type ===
        "SessionEndedRequest"
      ) {
        console.log(
          "Alexa session ended."
        );

        return res
          .status(200)
          .json({});
      }

      // ======================================================
      // UNKNOWN REQUEST
      // ======================================================

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

      return res
        .status(500)
        .json({
          error:
            "Internal Alexa webhook error",
        });
    }
  }
);

// ============================================================
// 404 HANDLER
// ============================================================

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        error:
          "Not Found",
        path:
          req.originalUrl,
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
    console.error(
      "Global server error:",
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
      });
  }
);

// ============================================================
// SERVER START
// ============================================================

server.listen(
  PORT,
  HOST,
  () => {
    console.log("");
    console.log(
      "=========================================="
    );
    console.log(
      " Alexa Device Bridge - LOCAL"
    );
    console.log(
      "=========================================="
    );

    console.log(
      `Server listening on http://${HOST}:${PORT}`
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
      `Cloudflare target: http://127.0.0.1:${PORT}`
    );

    console.log(
      "Alexa signature verification: ENABLED"
    );

    console.log(
      "=========================================="
    );

    console.log("");
  }
);

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================

function shutdown(
  signal
) {
  console.log(
    `Received ${signal}. Shutting down...`
  );

  // ----------------------------------------------------------
  // Clear pending command timers
  // ----------------------------------------------------------

  for (
    const [
      commandId,
      pending,
    ] of pendingCommands.entries()
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
  // Close Socket.IO
  // ----------------------------------------------------------

  io.close(
    () => {
      console.log(
        "Socket.IO closed."
      );

      // ------------------------------------------------------
      // Close HTTP server
      // ------------------------------------------------------

      server.close(
        () => {
          console.log(
            "HTTP server closed."
          );

          process.exit(0);
        }
      );
    }
  );

  // ----------------------------------------------------------
  // Safety timeout
  // ----------------------------------------------------------

  setTimeout(
    () => {
      console.log(
        "Forced shutdown."
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
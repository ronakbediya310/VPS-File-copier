// server.js
import fs from "fs";
import path from "path";
import http from "http";
import { WebSocketServer } from "ws";
import { spawn, exec } from "child_process";
import { fileURLToPath } from "url";
import os from "os";
import dotenv from "dotenv";
import { handleTerminalConnection } from "./terminal.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 6060;
const wss = new WebSocketServer({ noServer: true });

const DEST_USER = process.env.DEST_USER;
const DEST_IP = process.env.DEST_IP;
const DEST_PASSWORD = process.env.DEST_PASSWORD;

if (!DEST_USER || !DEST_IP || !DEST_PASSWORD) {
  console.error("❌ Missing DEST_USER, DEST_IP, or DEST_PASSWORD in .env");
  process.exit(1);
}

function sanitizeArg(arg) {
  if (typeof arg !== "string") return "";
  return arg.replace(/(["\s'$`\\])/g, "\\$1");
}

function startHeartbeat(ws) {
  ws._lastPong = Date.now();

  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 30000);

  const checkTimeout = setInterval(() => {
    if (Date.now() - ws._lastPong > 60000) ws.terminate();
  }, 10000);

  ws.on("pong", () => {
    ws._lastPong = Date.now();
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    clearInterval(checkTimeout);
  });
}

// Copy function with sshpass password usage
function copyFromSourceVPSToLocal(
  { username, password, ipAddress, sourcePath },
  ws
) {
  const cleanUsername = sanitizeArg(username);
  const cleanPassword = sanitizeArg(password);
  const cleanIp = sanitizeArg(ipAddress);
  const cleanSourcePath = sanitizeArg(sourcePath);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = `backup_${timestamp}`;
  const remoteFolder = `/home/${DEST_USER}/${backupDir}`;

  const mkdirCommand = `sshpass -p '${DEST_PASSWORD}' ssh -o StrictHostKeyChecking=no ${DEST_USER}@${DEST_IP} "mkdir -p ${remoteFolder}"`;

  ws.send(
    JSON.stringify({ action: "terminal", output: `\n$ ${mkdirCommand}\n` })
  );

  exec(mkdirCommand, (err) => {
    if (err) {
      ws.send(
        JSON.stringify({
          action: "error",
          message: "Failed to create backup folder on destination VPS.",
        })
      );
      return;
    }
    ws.send(JSON.stringify({ action: "progress", progress: 10 }));

    // rsync command with nested sshpass for source and destination passwords
    const rsyncCommand =
      `sshpass -p '${cleanPassword}' ssh -o StrictHostKeyChecking=no ${cleanUsername}@${cleanIp} ` +
      `"sshpass -p '${DEST_PASSWORD}' rsync -avz -e 'ssh -o StrictHostKeyChecking=no' ${cleanSourcePath}/ ${DEST_USER}@${DEST_IP}:${remoteFolder}/"`;

    ws.send(
      JSON.stringify({ action: "terminal", output: `$ ${rsyncCommand}\n` })
    );

    const proc = exec(rsyncCommand);

    proc.stdout.on("data", (data) => {
      ws.send(JSON.stringify({ action: "terminal", output: data }));
    });

    proc.stderr.on("data", (data) => {
      ws.send(JSON.stringify({ action: "terminal", output: data }));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        ws.send(JSON.stringify({ action: "progress", progress: 100 }));
        ws.send(JSON.stringify({ action: "done", folder: backupDir }));
      } else {
        ws.send(
          JSON.stringify({
            action: "error",
            message: `Rsync failed with exit code ${code}`,
          })
        );
      }
    });
  });
}
function retryLatestBackup({ username, password, ipAddress, sourcePath }, ws) {
  const cleanUsername = sanitizeArg(username);
  const cleanPassword = sanitizeArg(password);
  const cleanIp = sanitizeArg(ipAddress);
  const cleanSourcePath = sanitizeArg(sourcePath);

  // Only get directories named backup_* in /home/DEST_USER, sorted by name descending
  const listCommand = `sshpass -p '${DEST_PASSWORD}' ssh -o StrictHostKeyChecking=no ${DEST_USER}@${DEST_IP} "find /home/${DEST_USER} -maxdepth 1 -type d -name 'backup_*' | sort -r"`;

  ws.send(JSON.stringify({ action: "terminal", output: `$ ${listCommand}\n` }));

  exec(listCommand, (err, stdout) => {
    if (err) {
      ws.send(
        JSON.stringify({
          action: "error",
          message: "Failed to list backups for retry.",
        })
      );
      return;
    }

    const latestBackup = stdout.trim().split("\n")[0];
    if (
      !latestBackup ||
      !latestBackup.startsWith(`/home/${DEST_USER}/backup_`)
    ) {
      ws.send(
        JSON.stringify({
          action: "error",
          message: "No valid backup folders found for retry.",
        })
      );
      return;
    }

    ws.send(JSON.stringify({ action: "progress", progress: 10 }));
    ws.send(
      JSON.stringify({
        action: "terminal",
        output: `Retrying backup into existing folder: ${latestBackup}\n`,
      })
    );

    const rsyncCommand =
      `sshpass -p '${cleanPassword}' ssh -o StrictHostKeyChecking=no ${cleanUsername}@${cleanIp} ` +
      `"sshpass -p '${DEST_PASSWORD}' rsync -avz -e 'ssh -o StrictHostKeyChecking=no' ${cleanSourcePath}/ ${DEST_USER}@${DEST_IP}:${latestBackup}/"`;

    ws.send(
      JSON.stringify({ action: "terminal", output: `$ ${rsyncCommand}\n` })
    );

    const proc = exec(rsyncCommand);

    proc.stdout.on("data", (data) => {
      ws.send(JSON.stringify({ action: "terminal", output: data }));
    });

    proc.stderr.on("data", (data) => {
      ws.send(JSON.stringify({ action: "terminal", output: data }));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        ws.send(JSON.stringify({ action: "progress", progress: 100 }));
        ws.send(
          JSON.stringify({
            action: "done",
            message: "Retry backup completed successfully.",
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            action: "error",
            message: `Retry backup failed with exit code ${code}`,
          })
        );
      }
    });
  });
}

// Restore all backups sequentially
function restoreFromBackup({ ipAddress, username, password, targetPath }, ws) {
  const cleanUsername = sanitizeArg(username);
  const cleanPassword = sanitizeArg(password);
  const cleanIp = sanitizeArg(ipAddress);
  const cleanTargetPath = sanitizeArg(targetPath);

  const listBackupsCommand = `sshpass -p '${DEST_PASSWORD}' ssh -o StrictHostKeyChecking=no ${DEST_USER}@${DEST_IP} "ls -d /home/${DEST_USER}/backup_*"`;

  ws.send(
    JSON.stringify({
      action: "terminal",
      output: `\n$ ${listBackupsCommand}\n`,
    })
  );

  exec(listBackupsCommand, (err, stdout) => {
    if (err) {
      ws.send(
        JSON.stringify({
          action: "error",
          message: "Failed to list backup folders on backup VPS.",
        })
      );
      return;
    }

    const backupFolders = stdout.trim().split("\n").filter(Boolean);
    if (backupFolders.length === 0) {
      ws.send(
        JSON.stringify({ action: "error", message: "No backup folders found." })
      );
      return;
    }

    let currentIndex = 0;

    function restoreNext() {
      if (currentIndex >= backupFolders.length) {
        ws.send(JSON.stringify({ action: "progress", progress: 100 }));
        ws.send(
          JSON.stringify({
            action: "done",
            message: "Restoration completed successfully!",
          })
        );
        return;
      }

      const folder = backupFolders[currentIndex];
      const folderName = folder.split("/").pop();
      const progressPercent = Math.floor(
        (currentIndex / backupFolders.length) * 100
      );

      ws.send(
        JSON.stringify({ action: "progress", progress: progressPercent })
      );
      ws.send(
        JSON.stringify({
          action: "terminal",
          output: `\nRestoring folder: ${folderName}\n`,
        })
      );

      const rsyncCommand =
        `rsync -avz -e "sshpass -p '\\''${cleanPassword}'\\'' ssh -o StrictHostKeyChecking=no" ` +
        `${folder}/ ${cleanUsername}@${cleanIp}:${cleanTargetPath}/`;

      const remoteExecCommand = `sshpass -p '${DEST_PASSWORD}' ssh -o StrictHostKeyChecking=no ${DEST_USER}@${DEST_IP} '${rsyncCommand}'`;

      ws.send(
        JSON.stringify({
          action: "terminal",
          output: `$ ${remoteExecCommand}\n`,
        })
      );

      const proc = exec(remoteExecCommand);

      proc.stdout.on("data", (data) => {
        ws.send(JSON.stringify({ action: "terminal", output: data }));
      });

      proc.stderr.on("data", (data) => {
        ws.send(JSON.stringify({ action: "terminal", output: data }));
      });

      proc.on("close", (code) => {
        if (code === 0) {
          ws.send(
            JSON.stringify({
              action: "terminal",
              output: `Folder ${folderName} restored successfully.\n`,
            })
          );
          currentIndex++;
          restoreNext();
        } else {
          ws.send(
            JSON.stringify({
              action: "error",
              message: `Restore failed for folder ${folderName} with exit code ${code}`,
            })
          );
        }
      });
    }

    restoreNext();
  });
}

// Retry latest restore (single folder)
function retryLatestRestore({ ipAddress, username, password, targetPath }, ws) {
  const cleanUsername = sanitizeArg(username);
  const cleanPassword = sanitizeArg(password);
  const cleanIp = sanitizeArg(ipAddress);
  const cleanTargetPath = sanitizeArg(targetPath);

  const listCommand = `sshpass -p '${DEST_PASSWORD}' ssh -o StrictHostKeyChecking=no ${DEST_USER}@${DEST_IP} "ls -dt /home/${DEST_USER}/backup_*"`;

  ws.send(JSON.stringify({ action: "terminal", output: `$ ${listCommand}\n` }));

  exec(listCommand, (err, stdout) => {
    if (err) {
      ws.send(
        JSON.stringify({
          action: "error",
          message: "Failed to list backups on retry.",
        })
      );
      return;
    }

    const latestBackup = stdout.trim().split("\n")[0];
    if (!latestBackup) {
      ws.send(
        JSON.stringify({
          action: "error",
          message: "No backups available for restore.",
        })
      );
      return;
    }

    ws.send(JSON.stringify({ action: "progress", progress: 10 }));
    ws.send(
      JSON.stringify({
        action: "terminal",
        output: `Retrying restore from: ${latestBackup}\n`,
      })
    );

    const rsyncCommand =
      `rsync -avz -e "sshpass -p '\\''${cleanPassword}'\\'' ssh -o StrictHostKeyChecking=no" ` +
      `${latestBackup}/ ${cleanUsername}@${cleanIp}:${cleanTargetPath}/`;

    const remoteExecCommand = `sshpass -p '${DEST_PASSWORD}' ssh -o StrictHostKeyChecking=no ${DEST_USER}@${DEST_IP} '${rsyncCommand}'`;

    ws.send(
      JSON.stringify({ action: "terminal", output: `$ ${remoteExecCommand}\n` })
    );

    const proc = exec(remoteExecCommand);

    proc.stdout.on("data", (data) => {
      ws.send(JSON.stringify({ action: "terminal", output: data }));
    });

    proc.stderr.on("data", (data) => {
      ws.send(JSON.stringify({ action: "terminal", output: data }));
    });

    proc.on("close", (code) => {
      if (code === 0) {
        ws.send(JSON.stringify({ action: "progress", progress: 100 }));
        ws.send(
          JSON.stringify({
            action: "done",
            message: "Retry restore completed successfully.",
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            action: "error",
            message: `Retry restore failed with exit code ${code}`,
          })
        );
      }
    });
  });
}

// HTTP server, websocket setup, heartbeat, handlers — same as before
const server = http.createServer((req, res) => {
  if (req.method !== "GET") {
    res.writeHead(405);
    return res.end("Method Not Allowed");
  }

  const route = req.url === "/" ? "index.html" : req.url.slice(1);
  const filePath = path.join(__dirname, route);
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const extMap = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };
  const ext = path.extname(route);
  const contentType = extMap[ext] || "application/octet-stream";

  fs.readFile(normalizedPath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500);
      return res.end(err.message);
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

wss.on("connection", (ws) => {
  startHeartbeat(ws);
  handleTerminalConnection(ws);

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      switch (data.action) {
        case "startCopy":
          copyFromSourceVPSToLocal(data, ws);
          break;
        case "startRestore":
          restoreFromBackup(data, ws);
          break;
        case "retry_backup":
          retryLatestBackup(data, ws);
          break;
        case "retry_restore":
          retryLatestRestore(data, ws);
          break;
        default:
          ws.send(
            JSON.stringify({ action: "error", message: "Unknown action." })
          );
      }
    } catch {
      ws.send(
        JSON.stringify({ action: "error", message: "Invalid JSON format." })
      );
    }
  });
});

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

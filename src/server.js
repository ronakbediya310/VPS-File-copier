// server.js
import fs from 'fs';
import path from 'path';
import http from 'http';
import { WebSocketServer } from 'ws';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import os from 'os';
import dotenv from 'dotenv';
import { handleTerminalConnection, setSharedTerminalMode } from './terminal.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = 6060;
const wss = new WebSocketServer({ noServer: true });

//constants
const DEST_USER = process.env.DEST_USER;
const DEST_IP = process.env.DEST_IP;
const DEST_PASSWORD = process.env.DEST_PASSWORD;

if (!DEST_USER || !DEST_IP || !DEST_PASSWORD) {
  console.error('❌ Missing DEST_USER, DEST_IP, or DEST_PASSWORD in .env');
  process.exit(1);
}

// Helper function
function sanitizePath(p) {
  return os.platform() === 'win32' ? p : p.replace(/(["\s'$`\\])/g, '\\$1');
}

function copyFromSourceVPSToLocal({ username, password, ipAddress, sourcePath }, ws) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = `backup_${timestamp}`;
  const remoteFolder = `/home/${DEST_USER}/${backupDir}`;

  const mkdirCommand = `sshpass -p '${DEST_PASSWORD}' ssh -o StrictHostKeyChecking=no ${DEST_USER}@${DEST_IP} "mkdir -p ${remoteFolder}"`;

  const rsyncCommand = `sshpass -p '${password}' ssh -o StrictHostKeyChecking=no ${username}@${ipAddress} "sshpass -p '${DEST_PASSWORD}' rsync -avz -e 'ssh -o StrictHostKeyChecking=no' ${sourcePath}/ ${DEST_USER}@${DEST_IP}:${remoteFolder}/"`;

  // Step 1: Create destination backup folder
  ws.send(JSON.stringify({ action: 'terminal', output: `\n$ ${mkdirCommand}\n` }));

  exec(mkdirCommand, (mkdirErr) => {
    if (mkdirErr) {
      console.error('[DEST MKDIR ERROR]', mkdirErr);
      ws.send(JSON.stringify({ action: 'error', message: 'Failed to create backup folder on destination VPS.' }));
      return;
    }

    ws.send(JSON.stringify({ action: 'progress', progress: 10 }));

    // Step 2: Show rsync command before executing
    ws.send(JSON.stringify({ action: 'terminal', output: `\n$ ${rsyncCommand}\n` }));

    const proc = exec(rsyncCommand);

    proc.stdout.on('data', (data) => {
      console.log('[Rsync STDOUT]', data);
      ws.send(JSON.stringify({ action: 'terminal', output: data }));
    });

    proc.stderr.on('data', (data) => {
      console.error('[Rsync STDERR]', data);
      ws.send(JSON.stringify({ action: 'terminal', output: data }));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        ws.send(JSON.stringify({ action: 'progress', progress: 100 }));
        ws.send(JSON.stringify({ action: 'done', folder: backupDir }));
      } else {
        ws.send(JSON.stringify({ action: 'error', message: `Rsync failed with exit code ${code}` }));
      }
    });
  });
}


// Heartbeat to keep socket alive
function startHeartbeat(ws) {
  const interval = setInterval(() => ws.ping(), 30000);
  const timeout = setInterval(() => {
    if (Date.now() - ws._lastPong > 60000) {
      console.log('No pong received, closing connection.');
      ws.close();
    }
  }, 5000);

  ws._lastPong = Date.now();
  ws.on('pong', () => ws._lastPong = Date.now());
  ws.on('close', () => {
    clearInterval(interval);
    clearInterval(timeout);
  });
}

// Static file server
const server = http.createServer((req, res) => {
  if (req.method !== 'GET') {
    res.writeHead(405);
    return res.end('Method Not Allowed');
  }

  const route = req.url === '/' ? 'index.html' : req.url.slice(1);
  const filePath = path.join(__dirname, route);
  const normalizedPath = path.normalize(filePath);

  if (!normalizedPath.startsWith(__dirname)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  const extMap = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
  };
  const ext = path.extname(route);
  const contentType = extMap[ext] || 'application/octet-stream';

  fs.readFile(normalizedPath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      return res.end(err.message);
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  startHeartbeat(ws);
  handleTerminalConnection(ws);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.action === 'startCopy') {
        copyFromSourceVPSToLocal(data, ws);
      }
    } catch (err) {
      console.error('[JSON Parse Error]', err);
      ws.send(JSON.stringify({ action: 'error', message: 'Invalid JSON message.' }));
    }
  });
});

// Upgrade HTTP to WebSocket
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// Start HTTP server
server.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
});

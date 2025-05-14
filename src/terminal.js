//  terminal.js
import http from 'http';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import pty from 'node-pty';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let sharedPty = null;
let isSharedMode = false;

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

// Function to spawn the shell process
const spawnShell = () => pty.spawn(shell, [], {
  name: 'xterm-color',
  cols: 80,
  rows: 24,
  cwd: process.env.HOME,
  env: process.env,
});

// Set whether the terminal should be shared across multiple clients
export const setSharedTerminalMode = (enable) => {
  isSharedMode = enable;
  if (isSharedMode && !sharedPty) {
    sharedPty = spawnShell();  // Only spawn a shared terminal once
  }
};

// Handle terminal WebSocket connections
export const handleTerminalConnection = (ws) => {
  // Use a shared terminal if in shared mode; otherwise, spawn a new terminal for the connection
  const ptyProcess = isSharedMode ? sharedPty : spawnShell();

  // Buffer to store the current command
  let currentCommand = '';
  let isCommandRunning = false; // Track whether a command is currently running

  // Stream terminal output back to the client
  ptyProcess.onData((data) => {
    console.log('[Terminal Output]:', data); // Debugging: Log terminal output
    ws.send(JSON.stringify({ action: 'terminal', output: data }));

    // If we receive a new line and the user has entered a full command
    if (data.includes('\n')) {
      // If there was a running command, send "Command Executed" message
      if (isCommandRunning) {
        ws.send(JSON.stringify({
          action: 'debug',
          message: `Command Executed: ${currentCommand}`, // Send the executed command back to the client
        }));

        // Reset the buffer after the command is executed
        currentCommand = '';
        isCommandRunning = false; // Reset the command running status
      }
    }
  });

  // Handle incoming WebSocket messages
  ws.on('message', (message) => {
    try {
      // Try to parse the incoming message as JSON
      const data = JSON.parse(message);

      // Handle special commands if needed
      // Example: If the client sends a special action like 'exit' or 'reset'
      if (data.action === 'exit') {
        ws.send(JSON.stringify({ action: 'debug', message: 'Exiting terminal' }));
        ptyProcess.kill();  // Terminate the terminal process gracefully
      }

    } catch (error) {
      // If the message is not valid JSON, treat it as raw terminal input and write to the pty process
      console.log('[Command Executing]:', message);
      
      // Append the raw command to the buffer
      currentCommand += message;

      // Write the command to the terminal
      ptyProcess.write(message);

      // If the user is typing a new command, set the flag that a command is running
      if (!isCommandRunning) {
        isCommandRunning = true;
      }
    }
  });

  // Clean up the terminal process when the WebSocket connection is closed
  ws.on('close', () => {
    if (!isSharedMode && ptyProcess) {
      ptyProcess.kill();
    }
  });

  // Handle WebSocket errors
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    ws.send(JSON.stringify({ action: 'error', message: 'An error occurred with the WebSocket connection.' }));
  });

  // Log WebSocket connection closing events for debugging
  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
};

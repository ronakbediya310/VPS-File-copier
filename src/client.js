// Create a WebSocket connection to the server
const socket = new WebSocket(
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`
);

const term = new Terminal({ cursorBlink: true });
let hasStartedCopyProgress = false;

// Utility function to validate IP address format (IPv4)
const isValidIP = (ip) => {
  const regex =
    /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
  return regex.test(ip);
};

// Utility function to validate non-empty string with some minimal length (for username, password, paths)
const isNonEmpty = (str, minLen = 1) =>
  typeof str === "string" && str.trim().length >= minLen;

// Utility function for password strength (at least 6 characters, include numbers and letters)
const isValidPassword = (password) => {
  return /^(?=.*[A-Za-z])(?=.*\d).{6,}$/.test(password);
};

// Validate path (basic check for non-empty and no illegal characters)
const isValidPath = (path) => {
  // You can customize this regex based on your path requirements
  return /^[\w\-\\/.: ]+$/.test(path.trim());
};
/* Theme Toggle */
const toggle = document.getElementById("themeToggle");
const root = document.documentElement;
toggle.addEventListener("change", () => {
  root.classList.toggle("dark", toggle.checked);
});
// Show messages (success or error)
const showMessage = (text, type = "info") => {
  const container = document.getElementById("progress-wrapper");
  if (!container) return;

  const existingMessage = document.getElementById("status-message");
  if (existingMessage) existingMessage.remove();

  const msg = document.createElement("div");
  msg.id = "status-message";
  msg.textContent = text;
  msg.style.cssText = `
    position: relative;
    top: 10px;
    padding: 10px;
    border-radius: 6px;
    margin-top: 10px;
    font-weight: bold;
    max-width: 1000px;
    text-align: center;
    transition: opacity 0.5s ease-in-out;
    opacity: 1;
    background-color: ${type === "error" ? "#ff4c4c" : "#4caf50"};
    color: #fff;
  `;

  container.appendChild(msg);

  setTimeout(() => {
    msg.style.opacity = "0";
    setTimeout(() => msg.remove(), 1000);
  }, 3000);
};

// Terminal initialization
const initTerminal = () => {
  if (term._initialized) return;
  term._initialized = true;
  term.open(document.getElementById("terminal"));

  // Show typed keys in bold green, then send to server
  term.onKey(({ key }) => {
    socket.send(key);
  });
  // Handle clipboard paste
  term.attachCustomKeyEventHandler((e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "v") {
      navigator.clipboard
        .readText()
        .then((text) => socket.send(text))
        .catch(() => showMessage("Clipboard access denied.", "error"));
      return false;
    }
    return true;
  });
};
/** Clear the terminal scrollback & viewport safely */
function clearTerminal() {
  if (term) {
    term.clear(); // clear viewport
    term.reset(); // flush scrollback & cursor state
    term.focus();
  }
}


// Trigger file copy process
const startCopy = () => {
  const username = document.getElementById("username")?.value;
  const password = document.getElementById("password")?.value;
  const ipAddress = document.getElementById("ipAddress")?.value;
  const sourcePath = document.getElementById("sourcePath")?.value;

  const zipBeforeBackup = document.getElementById("zipOption")?.checked;
  const incrementalBackup = document.getElementById("incrementalOption")?.checked;

  if (
    !isNonEmpty(username) ||
    !isNonEmpty(password) ||
    !isNonEmpty(ipAddress) ||
    !isNonEmpty(sourcePath)
  ) {
    showMessage("All fields are required.", "error");
    return;
  }

  if (!isValidIP(ipAddress)) {
    showMessage("Invalid IP address format.", "error");
    return;
  }

  if (!isValidPassword(password)) {
    showMessage(
      "Password must be at least 6 characters and include letters and numbers.",
      "error"
    );
    return;
  }

  if (!isValidPath(sourcePath)) {
    showMessage("Invalid source path.", "error");
    return;
  }

  hasStartedCopyProgress = false;
  updateProgressBar(0);

  socket.send(
    JSON.stringify({
      action: "startCopy",
      username,
      password,
      ipAddress,
      sourcePath,
      zipBeforeBackup,
      incrementalBackup,
    })
  );
};

// Trigger restoration process
const startRestore = () => {
  const restoreIP = document.getElementById("restoreIp")?.value;
  const restoreUser = document.getElementById("restoreUser")?.value;
  const restorePass = document.getElementById("restorePassword")?.value;
  const restorePath = document.getElementById("restorePath")?.value;

  if (
    !isNonEmpty(restoreIP) ||
    !isNonEmpty(restoreUser) ||
    !isNonEmpty(restorePass) ||
    !isNonEmpty(restorePath)
  ) {
    showMessage("All restoration fields are required.", "error");
    return;
  }

  if (!isValidIP(restoreIP)) {
    showMessage("Invalid restore IP address format.", "error");
    return;
  }

  if (!isValidPassword(restorePass)) {
    showMessage(
      "Restore password must be at least 6 characters and include letters and numbers.",
      "error"
    );
    return;
  }

  if (!isValidPath(restorePath)) {
    showMessage("Invalid restore path.", "error");
    return;
  }

  hasStartedCopyProgress = false;
  updateProgressBar(0);

  socket.send(
    JSON.stringify({
      action: "startRestore",
      ipAddress: restoreIP,
      username: restoreUser,
      password: restorePass,
      targetPath: restorePath,
    })
  );
};

// Update visual progress bar
const updateProgressBar = (progress) => {
  const percent = Math.max(0, Math.min(progress, 100));
  const bar = document.getElementById("progress");
  if (bar) bar.style.width = `${percent}%`;

  if (!hasStartedCopyProgress && percent > 0) {
    hasStartedCopyProgress = true;
    showMessage("Operation started...", "info");
  }
};

// Retry Backup using latest backup_* folder
const retryBackup = () => {
  const username = document.getElementById("username")?.value;
  const password = document.getElementById("password")?.value;
  const ipAddress = document.getElementById("ipAddress")?.value;
  const sourcePath = document.getElementById("sourcePath")?.value;
  const zipBeforeBackup = document.getElementById("zipOption")?.checked;
  const incrementalBackup = document.getElementById("incrementalOption")?.checked;

  if (
    !isNonEmpty(username) ||
    !isNonEmpty(password) ||
    !isNonEmpty(ipAddress) ||
    !isNonEmpty(sourcePath)
  ) {
    showMessage("All backup retry fields are required.", "error");
    return;
  }

  if (!isValidIP(ipAddress)) {
    showMessage("Invalid IP address format.", "error");
    return;
  }

  if (!isValidPassword(password)) {
    showMessage(
      "Password must be at least 6 characters and include letters and numbers.",
      "error"
    );
    return;
  }

  if (!isValidPath(sourcePath)) {
    showMessage("Invalid source path.", "error");
    return;
  }

  hasStartedCopyProgress = false;
  updateProgressBar(0);

  socket.send(
    JSON.stringify({
      action: "retry_backup",
      username,
      password,
      ipAddress,
      sourcePath,
      zipBeforeBackup,
      incrementalBackup,
    })
  );
};

// Retry Restore using latest backup_* folder
const retryRestore = () => {
  const restoreIP = document.getElementById("restoreIp")?.value;
  const restoreUser = document.getElementById("restoreUser")?.value;
  const restorePass = document.getElementById("restorePassword")?.value;
  const restorePath = document.getElementById("restorePath")?.value;

  if (
    !isNonEmpty(restoreIP) ||
    !isNonEmpty(restoreUser) ||
    !isNonEmpty(restorePass) ||
    !isNonEmpty(restorePath)
  ) {
    showMessage("All restoration fields are required for retry.", "error");
    return;
  }

  if (!isValidIP(restoreIP)) {
    showMessage("Invalid restore IP address format.", "error");
    return;
  }

  if (!isValidPassword(restorePass)) {
    showMessage(
      "Restore password must be at least 6 characters and include letters and numbers.",
      "error"
    );
    return;
  }

  if (!isValidPath(restorePath)) {
    showMessage("Invalid restore path.", "error");
    return;
  }

  hasStartedCopyProgress = false;
  updateProgressBar(0);

  socket.send(
    JSON.stringify({
      action: "retry_restore",
      ipAddress: restoreIP,
      username: restoreUser,
      password: restorePass,
      targetPath: restorePath,
    })
  );
};

// Handle WebSocket messages
const handleWebSocketMessage = ({ data }) => {
  try {
    const msg = JSON.parse(data);

    switch (msg.action) {
      case "progress":
        updateProgressBar(msg.progress);
        break;
      case "done":
        showMessage("Operation completed successfully!");
        break;
      case "debug": {
        const timestamp = new Date().toLocaleTimeString();
        const lines = msg.message.split("\n");
        term.writeln(`\r\n\x1b[33m[DEBUG ${timestamp}]\x1b[0m`);
        lines.forEach((line) => {
          // Dim the debug lines for subtlety
          term.writeln(`  \x1b[2m${line}\x1b[0m`);
        });
        break;
      }
      case "terminal":
        // Color terminal output in cyan for commands/output
        term.write(`\x1b[36m${msg.output}\x1b[0m`);
        break;
      case "error":
        showMessage(msg.message || "An error occurred.", "error");
        break;
      default:
        console.error(`Unknown action: ${msg.action}`);
    }
  } catch (error) {
    console.error("Failed to parse WebSocket message:", data);
    term.write(data); // Show raw if parsing fails
  }
};

// WebSocket events
socket.onopen = initTerminal;
socket.onmessage = handleWebSocketMessage;
socket.onerror = (err) => {
  console.error("WebSocket error:", err);
  showMessage("WebSocket connection error.", "error");
};
socket.onclose = () => {
  term.writeln("\r\nDisconnected from server.\r\n");
  showMessage("Disconnected from server.", "error");
};

#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const tasks = {
  "plugin:install": {
    darwin: ["sh", ["scripts/install-plugin-macos.sh"]],
    win32: ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "./scripts/install-plugin.ps1"]]
  },
  "plugin:uninstall": {
    darwin: ["sh", ["scripts/uninstall-plugin-macos.sh"]],
    win32: ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "./scripts/uninstall-plugin.ps1"]]
  },
  "service:install": {
    darwin: ["sh", ["scripts/install-service-macos.sh"]],
    win32: ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "./scripts/register-bridge-task.ps1"]]
  },
  "service:uninstall": {
    darwin: ["sh", ["scripts/uninstall-service-macos.sh"]],
    win32: ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "./scripts/unregister-bridge-task.ps1"]]
  },
  "service:start": {
    darwin: ["sh", ["scripts/install-service-macos.sh", "--start-only"]],
    win32: ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "./scripts/start-bridge-background.ps1"]]
  },
  "service:stop": {
    darwin: ["sh", ["scripts/uninstall-service-macos.sh", "--stop-only"]],
    win32: ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "./scripts/stop-bridge.ps1"]]
  },
  doctor: {
    darwin: ["sh", ["scripts/doctor-macos.sh"]],
    win32: ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "Write-Host 'Windows doctor ist nicht implementiert.'"]]
  }
};

const [taskName, ...extraArgs] = process.argv.slice(2);
const task = tasks[taskName];
if (!task) {
  console.error(`Unknown task: ${taskName || "(missing)"}`);
  process.exit(2);
}

const command = task[process.platform];
if (!command) {
  console.error(`Task ${taskName} is not supported on ${process.platform}.`);
  process.exit(2);
}

const [file, args] = command;
const child = spawn(file, [...args, ...extraArgs], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`${taskName} terminated by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});

child.on("error", error => {
  console.error(`${taskName} failed: ${error.message}`);
  process.exit(1);
});

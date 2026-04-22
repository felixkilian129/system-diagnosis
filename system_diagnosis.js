#!/usr/bin/env node
"use strict";

const cp = require("node:child_process");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

const VERSION = "0.1.0";
const DEFAULT_LOG_DIR = "logs";
const DEFAULT_TIMEOUT_MS = 15000;
const ANDROID_TIMEOUT_MS = 20000;
const WINDOWS_EXTENDED_LOOKBACK_DAYS = 14;

const WIN_DEVICE_ERRORS = {
  1: "Device is not configured correctly",
  3: "Driver may be corrupted or missing",
  10: "Device cannot start",
  12: "Not enough free resources",
  14: "Device needs restart",
  16: "Required resources missing",
  18: "Reinstall drivers",
  19: "Registry may be corrupted",
  21: "Device is not working properly",
  22: "Device is disabled",
  24: "Device is not present or not working",
  28: "No drivers installed",
  29: "Device disabled by firmware",
  31: "Device is not working properly",
  32: "Driver not loaded",
  33: "Driver may be wrong or missing",
  34: "Hardware configuration issue",
  35: "BIOS needs update",
  36: "IRQ conflict",
  37: "Driver failed to initialize",
  38: "Driver instance still in memory",
  39: "Driver may be corrupt",
  40: "Driver or registry entry corrupt",
  41: "Hardware not working",
  43: "Device reported problems",
  44: "Device is locked by an application or service",
  45: "Device not connected",
  47: "Device needs restart",
  48: "Driver blocked",
  49: "Driver information inconsistent",
  50: "Device waiting on another device",
  51: "Device currently busy",
};

function parseArgs(argv) {
  const args = {
    command: null,
    target: null,
    serial: null,
    output: DEFAULT_LOG_DIR,
    format: "all",
    profile: "full",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    nonInteractive: false,
    help: false,
    version: false,
  };
  const commands = new Set(["list", "scan", "help"]);
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (commands.has(token) && !args.command) {
      args.command = token;
      continue;
    }
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--version" || token === "-v") {
      args.version = true;
      continue;
    }
    if (token === "--non-interactive" || token === "--yes") {
      args.nonInteractive = true;
      continue;
    }
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${token}`);
      i += 1;
      return argv[i];
    };
    if (token === "--target" || token === "-t") {
      args.target = next();
    } else if (token === "--serial" || token === "-s") {
      args.serial = next();
    } else if (token === "--output" || token === "-o") {
      args.output = next();
    } else if (token === "--format" || token === "-f") {
      args.format = next();
    } else if (token === "--profile" || token === "-p") {
      args.profile = next();
    } else if (token === "--timeout-ms") {
      args.timeoutMs = Number(next());
      if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) {
        throw new Error("--timeout-ms must be a positive number");
      }
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  if (!args.command) args.command = args.help ? "help" : "scan";
  args.target = args.target ? args.target.toLowerCase() : null;
  args.format = args.format.toLowerCase();
  args.profile = args.profile.toLowerCase();
  if (args.target && !["local", "android"].includes(args.target)) {
    throw new Error("--target must be local or android");
  }
  if (!["text", "json", "all"].includes(args.format)) {
    throw new Error("--format must be text, json, or all");
  }
  if (!["quick", "full", "extended"].includes(args.profile)) {
    throw new Error("--profile must be quick, full, or extended");
  }
  return args;
}

function usage() {
  return [
    "System Diagnosis",
    "",
    "Usage:",
    "  node system_diagnosis.js",
    "  node system_diagnosis.js list",
    "  node system_diagnosis.js scan --target local",
    "  node system_diagnosis.js scan --target local --profile quick",
    "  node system_diagnosis.js scan --target local --profile full",
    "  node system_diagnosis.js scan --target local --profile extended",
    "  node system_diagnosis.js scan --target android --serial DEVICE_SERIAL",
    "",
    "Options:",
    "  -t, --target local|android   Device type to scan",
    "  -s, --serial SERIAL          Android serial from adb devices -l",
    "  -o, --output DIR             Report directory (default: logs)",
    "  -f, --format text|json|all   Report format (default: all)",
    "  -p, --profile quick|full|extended",
    "                               Check depth (default: full)",
    "      --timeout-ms NUMBER      Per-command timeout for local commands",
    "      --non-interactive        Fail instead of asking for a device",
    "  -h, --help                   Show help",
    "  -v, --version                Show version",
    "",
    "Notes:",
    "  Windows and Linux local scans run on the computer executing this script.",
    "  Android scans require Android platform-tools and USB debugging or wireless adb.",
    "  iOS is intentionally not supported.",
  ].join("\n");
}

function nowIso() {
  return new Date().toISOString();
}

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function bytes(bytesValue) {
  if (!Number.isFinite(bytesValue)) return "unknown";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = bytesValue;
  let idx = 0;
  while (Math.abs(value) >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function pct(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((part / total) * 1000) / 10;
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function json(text, fallback = null) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function arr(value) {
  if (value === null || value === undefined || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function num(value) {
  const n = Number(String(value || "").trim());
  return Number.isFinite(n) ? n : null;
}

function readIf(file) {
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  } catch (_) {
    return "";
  }
}

function run(command, args = [], options = {}) {
  try {
    const result = cp.spawnSync(command, args, {
      cwd: options.cwd || process.cwd(),
      encoding: "utf8",
      timeout: options.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || 1024 * 1024 * 8,
      windowsHide: true,
      input: options.input,
    });
    return {
      ok: !result.error && result.status === 0,
      status: result.status,
      stdout: result.stdout ? String(result.stdout).trim() : "",
      stderr: result.stderr ? String(result.stderr).trim() : "",
      error: result.error ? result.error.message : null,
      timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
      command: [command, ...args].join(" "),
    };
  } catch (error) {
    return { ok: false, status: null, stdout: "", stderr: "", error: error.message, timedOut: false, command: [command, ...args].join(" ") };
  }
}

function ps(script, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const utf8Script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [Console]::OutputEncoding; " + script;
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", utf8Script], {
    timeoutMs,
    maxBuffer: 1024 * 1024 * 16,
  });
}

function exists(command) {
  const result = process.platform === "win32"
    ? run("where", [command], { timeoutMs: 5000 })
    : run("sh", ["-c", `command -v ${shellQuote(command)}`], { timeoutMs: 5000 });
  return result.ok;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function kv(text, separator = ":") {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const idx = line.indexOf(separator);
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + separator.length).trim();
  }
  return out;
}

function commandError(result) {
  return { command: result.command, status: result.status, timedOut: result.timedOut, stderr: result.stderr, error: result.error };
}

function commandFailure(summary, result, status = "warn") {
  return {
    status,
    summary,
    details: { ...commandError(result), stdout: result.stdout },
    advice: result.timedOut ? ["The command timed out. Re-run with a higher --timeout-ms value."] : ["Run with elevated permissions or install the missing platform tool if this check is expected to work."],
  };
}

function redactAddress(address) {
  if (!address) return "";
  if (address.includes(":")) return `${address.split(":").slice(0, 3).join(":")}:...`;
  const parts = address.split(".");
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.${parts[2]}.x` : address;
}

function redactMac(mac) {
  if (!mac || mac === "00:00:00:00:00:00") return mac || "";
  const parts = mac.split(":");
  return parts.length >= 6 ? `${parts.slice(0, 3).join(":")}:xx:xx:xx` : "redacted";
}

class Report {
  constructor(target, options) {
    this.data = {
      schemaVersion: 1,
      tool: { name: "system_diagnosis", version: VERSION },
      startedAt: nowIso(),
      finishedAt: null,
      profile: options.profile,
      target,
      summary: { fail: 0, warn: 0, ok: 0, skip: 0, info: 0 },
      checks: [],
    };
  }
  add(check) {
    const status = check.status || "info";
    this.data.checks.push({
      id: check.id,
      title: check.title,
      status,
      severity: status === "fail" ? "high" : status === "warn" ? "medium" : "low",
      summary: check.summary || "",
      details: check.details || {},
      evidence: check.evidence || [],
      advice: check.advice || [],
      startedAt: check.startedAt || nowIso(),
      finishedAt: nowIso(),
    });
    this.data.summary[status] = (this.data.summary[status] || 0) + 1;
  }
  finish() {
    this.data.finishedAt = nowIso();
    return this.data;
  }
}

async function check(report, id, title, fn) {
  const startedAt = nowIso();
  try {
    report.add({ id, title, startedAt, ...(await fn()) });
  } catch (error) {
    report.add({
      id,
      title,
      startedAt,
      status: "fail",
      summary: error.message,
      details: { stack: error.stack },
      advice: ["The check crashed. Inspect the stack trace in the JSON report."],
    });
  }
}

function localTarget() {
  return {
    kind: "local",
    family: os.platform() === "win32" ? "windows" : os.platform() === "linux" ? "linux" : os.platform(),
    platform: os.platform(),
    hostname: os.hostname(),
    arch: os.arch(),
    node: process.version,
  };
}

function findAdb() {
  if (run("adb", ["version"], { timeoutMs: 5000 }).ok) return "adb";
  if (process.platform !== "win32") return null;
  const base = process.env.LOCALAPPDATA || "";
  const candidates = [
    path.join(base, "Android", "Sdk", "platform-tools", "adb.exe"),
    "C:\\Android\\platform-tools\\adb.exe",
    "C:\\platform-tools\\adb.exe",
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate) && run(candidate, ["version"], { timeoutMs: 5000 }).ok) return candidate;
  }
  return null;
}

function androidDevices(adb) {
  const result = run(adb, ["devices", "-l"], { timeoutMs: 10000 });
  if (!result.ok) return [];
  const devices = [];
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("List of devices")) continue;
    const parts = line.split(/\s+/);
    const device = { serial: parts[0], state: parts[1] || "unknown" };
    for (const part of parts.slice(2)) {
      const [key, ...rest] = part.split(":");
      if (key && rest.length) device[key === "transport_id" ? "transportId" : key] = rest.join(":");
    }
    devices.push(device);
  }
  return devices;
}

async function listDevices() {
  const devices = [{
    key: "local",
    kind: "local",
    label: `This computer (${os.hostname()}, ${os.platform()} ${os.arch()})`,
    target: localTarget(),
  }];
  const adb = findAdb();
  if (!adb) return { devices, adbAvailable: false, adbPath: null };
  for (const d of androidDevices(adb)) {
    const labelName = d.model || d.product || d.device || d.serial;
    devices.push({
      key: `android:${d.serial}`,
      kind: "android",
      label: `Android ${labelName} (${d.serial}) ${d.state}`,
      target: { kind: "android", adbPath: adb, serial: d.serial, state: d.state, model: d.model || null, product: d.product || null, device: d.device || null },
    });
  }
  return { devices, adbAvailable: true, adbPath: adb };
}

async function choose(devices) {
  if (devices.length === 1) return devices[0].target;
  process.stdout.write("Select a device to diagnose:\n");
  devices.forEach((d, i) => process.stdout.write(`  ${i + 1}. ${d.label}\n`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question("Device number: ", resolve));
  rl.close();
  const n = Number(answer);
  if (!Number.isInteger(n) || n < 1 || n > devices.length) throw new Error("Invalid device selection");
  return devices[n - 1].target;
}

async function resolveTarget(args) {
  const inventory = await listDevices();
  if (args.target === "local") return localTarget();
  if (args.target === "android") {
    if (!inventory.adbAvailable) throw new Error("adb was not found. Install Android platform-tools and add adb to PATH.");
    const phones = inventory.devices.filter((d) => d.kind === "android");
    if (!phones.length) throw new Error("No Android devices were found by adb.");
    if (args.serial) {
      const found = phones.find((d) => d.target.serial === args.serial);
      if (!found) throw new Error(`Android device ${args.serial} was not found by adb.`);
      return found.target;
    }
    if (args.nonInteractive && phones.length !== 1) throw new Error("Multiple Android devices found. Pass --serial.");
    return phones.length === 1 ? phones[0].target : choose(phones);
  }
  return args.nonInteractive ? localTarget() : choose(inventory.devices);
}

async function runDiagnosis(target, options) {
  return target.kind === "android" ? runAndroidDiagnosis(target, options) : runLocalDiagnosis(target, options);
}

async function runLocalDiagnosis(target, options) {
  const report = new Report(target, options);
  const fullOrExtended = options.profile === "full" || options.profile === "extended";
  const extended = options.profile === "extended";
  await check(report, "local.system", "System identity", localSystem);
  await check(report, "local.cpu", "CPU and load", localCpu);
  await check(report, "local.memory", "Memory pressure", localMemory);
  await check(report, "local.storage", "Storage capacity", () => localStorage(options));
  await check(report, "local.network", "Network basics", () => localNetwork(options));

  if (process.platform === "win32") {
    await check(report, "windows.device_manager", "Windows device manager", () => winDeviceManager(options));
    await check(report, "windows.storage_health", "Windows storage health", () => winStorageHealth(options));
    await check(report, "windows.battery", "Windows battery", () => winBattery(options));
    await check(report, "windows.defender", "Windows Defender", () => winDefender(options));
    if (fullOrExtended) {
      await check(report, "windows.events", "Windows critical events", () => winEvents(options));
      await check(report, "windows.thermal", "Windows thermal sensors", () => winThermal(options));
    }
    if (extended) {
      await check(report, "windows.event_history", "Windows Event Viewer history", () => winExtendedEventHistory(options));
      await check(report, "windows.reliability", "Windows reliability history", () => winReliabilityHistory(options));
      await check(report, "windows.application_crashes", "Windows application crashes", () => winApplicationCrashes(options));
      await check(report, "windows.update_health", "Windows update health", () => winUpdateHealth(options));
      await check(report, "windows.service_health", "Windows service health", () => winServiceHealth(options));
      await check(report, "windows.driver_health", "Windows driver health", () => winDriverHealth(options));
      await check(report, "windows.hardware_events", "Windows hardware event history", () => winHardwareEvents(options));
      await check(report, "windows.hardware_inventory", "Windows hardware inventory", () => winHardwareInventory(options));
    }
  } else if (process.platform === "linux") {
    await check(report, "linux.storage_health", "Linux storage health", () => linuxStorageHealth(options));
    await check(report, "linux.battery", "Linux battery", linuxBattery);
    await check(report, "linux.services", "Linux failed services", () => linuxFailedServices(options));
    await check(report, "linux.thermal", "Linux thermal sensors", linuxThermal);
    if (fullOrExtended) await check(report, "linux.kernel_logs", "Linux kernel warnings", () => linuxKernelLogs(options));
  } else {
    await check(report, "local.platform", "Platform support", async () => ({
      status: "warn",
      summary: `${os.platform()} is not a first-class local scan platform yet.`,
      advice: ["Use Windows, Linux, or Android for the full diagnostic set."],
    }));
  }
  return report.finish();
}

function localSystem() {
  const cpus = os.cpus() || [];
  const details = {
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    type: os.type(),
    arch: os.arch(),
    uptimeSeconds: os.uptime(),
    nodeVersion: process.version,
    cpuModel: cpus[0] ? cpus[0].model : "unknown",
    cpuThreads: cpus.length,
    totalMemoryBytes: os.totalmem(),
  };
  return { status: "info", summary: `${details.type} ${details.release}, ${details.cpuThreads} CPU threads, ${bytes(details.totalMemoryBytes)} RAM`, details };
}

function localCpu() {
  const load = os.loadavg();
  const cpus = os.cpus() || [];
  const perThread = cpus.length ? load[0] / cpus.length : 0;
  return {
    status: perThread > 1.5 ? "warn" : "ok",
    summary: `${cpus.length} CPU thread(s), 1-minute load ${load[0].toFixed(2)}`,
    details: { cpuModel: cpus[0] ? cpus[0].model : "unknown", cpuThreads: cpus.length, loadAverage: { oneMinute: load[0], fiveMinutes: load[1], fifteenMinutes: load[2] }, loadPerThread: perThread },
    advice: perThread > 1.5 ? ["High CPU load can hide intermittent hardware or driver problems. Re-run while the system is idle."] : [],
  };
}

function localMemory() {
  const total = os.totalmem();
  const free = os.freemem();
  const usedPercent = pct(total - free, total);
  return {
    status: usedPercent >= 92 ? "warn" : "ok",
    summary: `${bytes(free)} free of ${bytes(total)} (${usedPercent}% used)`,
    details: { totalBytes: total, freeBytes: free, usedPercent },
    advice: usedPercent >= 92 ? ["Memory is heavily used. Close applications or inspect processes before long stability checks."] : [],
  };
}

function localStorage(options) {
  if (process.platform === "win32") return winLogicalDisks(options);
  if (process.platform === "linux") return linuxDf(options);
  return { status: "skip", summary: `Storage capacity check is not implemented for ${process.platform}.` };
}

async function localNetwork(options) {
  const active = [];
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (!address.internal) active.push({ name, family: address.family, address: redactAddress(address.address), mac: redactMac(address.mac) });
    }
  }
  let dnsDetails = null;
  let dnsOk = true;
  try {
    const lookup = await Promise.race([
      dns.lookup("example.com"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("DNS lookup timed out")), options.timeoutMs)),
    ]);
    dnsDetails = { host: "example.com", family: lookup.family, addressHash: hash(lookup.address) };
  } catch (error) {
    dnsOk = false;
    dnsDetails = { error: error.message };
  }
  const status = active.length && dnsOk ? "ok" : "warn";
  return {
    status,
    summary: `${active.length} non-internal interface address(es), DNS ${dnsOk ? "ok" : "warn"}`,
    details: { activeInterfaces: active, dns: dnsDetails },
    advice: status === "warn" ? ["Check adapter state, gateway, DNS configuration, VPN, or captive portal status."] : [],
  };
}

function winLogicalDisks(options) {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_LogicalDisk -Filter \"DriveType=3\" | Select-Object DeviceID,VolumeName,FileSystem,Size,FreeSpace | ConvertTo-Json -Depth 3";
  const result = ps(script, options.timeoutMs);
  if (!result.ok) return commandFailure("Unable to read Windows logical disks", result);
  const disks = arr(json(result.stdout, [])).map((disk) => {
    const size = Number(disk.Size);
    const free = Number(disk.FreeSpace);
    return { device: disk.DeviceID, volumeName: disk.VolumeName || "", fileSystem: disk.FileSystem || "", sizeBytes: size, freeBytes: free, usedPercent: pct(size - free, size), freeHuman: bytes(free), sizeHuman: bytes(size) };
  });
  const low = disks.filter((disk) => disk.usedPercent >= 90);
  return {
    status: low.length ? "warn" : "ok",
    summary: low.length ? `${low.length} drive(s) above 90% used` : `${disks.length} fixed drive(s) checked`,
    details: { disks },
    advice: low.length ? ["Free disk space on heavily used volumes before updates, backups, or firmware tools."] : [],
  };
}

function winDeviceManager(options) {
  const script = "$ErrorActionPreference='Stop'; Get-CimInstance Win32_PnPEntity | Where-Object { $_.ConfigManagerErrorCode -ne 0 } | Select-Object Name,PNPClass,DeviceID,ConfigManagerErrorCode | ConvertTo-Json -Depth 4";
  const result = ps(script, options.timeoutMs);
  if (!result.ok) return commandFailure("Unable to read Windows device manager state", result);
  const problems = arr(json(result.stdout, [])).map((device) => {
    const code = Number(device.ConfigManagerErrorCode);
    return { name: device.Name || "Unknown device", class: device.PNPClass || "", deviceIdHash: hash(device.DeviceID || device.Name), code, description: WIN_DEVICE_ERRORS[code] || "Unknown device manager error" };
  });
  return {
    status: problems.length ? "fail" : "ok",
    summary: problems.length ? `${problems.length} device manager problem(s) found` : "No device manager errors reported",
    details: { problems },
    advice: problems.length ? ["Inspect the listed devices in Device Manager and update, reconnect, or reinstall the affected drivers."] : [],
  };
}

function winStorageHealth(options) {
  const physical = ps("$ErrorActionPreference='SilentlyContinue'; if (Get-Command Get-PhysicalDisk -ErrorAction SilentlyContinue) { Get-PhysicalDisk | Select-Object FriendlyName,MediaType,HealthStatus,OperationalStatus,Size | ConvertTo-Json -Depth 4 }", options.timeoutMs);
  const smart = ps("$ErrorActionPreference='SilentlyContinue'; Get-CimInstance -Namespace root/wmi -ClassName MSStorageDriver_FailurePredictStatus | Select-Object InstanceName,PredictFailure,Reason | ConvertTo-Json -Depth 4", options.timeoutMs);
  const disks = arr(json(physical.stdout, []));
  const smartRows = arr(json(smart.stdout, []));
  const unhealthy = disks.filter((disk) => {
    const health = String(disk.HealthStatus || "").toLowerCase();
    const operational = arr(disk.OperationalStatus).join(",").toLowerCase();
    return (health && health !== "healthy") || (operational && !operational.includes("ok"));
  });
  const predicted = smartRows.filter((row) => row.PredictFailure === true || String(row.PredictFailure).toLowerCase() === "true");
  const skipped = !physical.ok && !smart.ok;
  return {
    status: predicted.length || unhealthy.length ? "fail" : skipped ? "skip" : "ok",
    summary: predicted.length || unhealthy.length ? "Storage health problem detected" : skipped ? "Storage health APIs were not available" : `${disks.length} physical disk(s), ${smartRows.length} SMART prediction row(s) checked`,
    details: {
      physicalDisks: disks.map((disk) => ({ friendlyName: disk.FriendlyName, mediaType: disk.MediaType, healthStatus: disk.HealthStatus, operationalStatus: disk.OperationalStatus, sizeBytes: Number(disk.Size) })),
      smartPredictions: smartRows.map((row) => ({ instanceHash: hash(row.InstanceName), predictFailure: row.PredictFailure, reason: row.Reason })),
      commandErrors: [physical, smart].filter((r) => !r.ok && (r.stderr || r.error)).map(commandError),
    },
    advice: predicted.length || unhealthy.length ? ["Back up important data immediately and inspect the disk with vendor tooling or smartctl."] : [],
  };
}

function winBattery(options) {
  const result = ps("$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Battery | Select-Object Name,BatteryStatus,EstimatedChargeRemaining,EstimatedRunTime,Status | ConvertTo-Json -Depth 4", options.timeoutMs);
  if (!result.ok && !result.stdout) return commandFailure("Unable to read Windows battery state", result, "skip");
  const batteries = arr(json(result.stdout, []));
  if (!batteries.length) return { status: "skip", summary: "No battery reported by Windows", details: { batteries: [] } };
  const charges = batteries.map((b) => Number(b.EstimatedChargeRemaining)).filter(Number.isFinite);
  const low = batteries.filter((b) => Number(b.EstimatedChargeRemaining) <= 15);
  return {
    status: low.length ? "warn" : "ok",
    summary: `${batteries.length} battery record(s), lowest charge ${charges.length ? Math.min(...charges) : "unknown"}%`,
    details: { batteries },
    advice: low.length ? ["Plug in power before long diagnostics, updates, or storage checks."] : [],
  };
}

function winDefender(options) {
  const result = ps("$ErrorActionPreference='SilentlyContinue'; if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) { Get-MpComputerStatus | Select-Object AMServiceEnabled,AntivirusEnabled,RealTimeProtectionEnabled,AntispywareEnabled,IoavProtectionEnabled,IsTamperProtected,NISEnabled,QuickScanAge,FullScanAge,AntivirusSignatureAge | ConvertTo-Json -Depth 4 }", options.timeoutMs);
  if (!result.ok && !result.stdout) return { status: "skip", summary: "Windows Defender status is unavailable", details: { error: commandError(result) } };
  const status = json(result.stdout, null);
  if (!status) return { status: "skip", summary: "Windows Defender is unavailable or managed by another security product" };
  const disabled = ["AMServiceEnabled", "AntivirusEnabled", "RealTimeProtectionEnabled"].filter((key) => status[key] === false);
  return {
    status: disabled.length ? "warn" : "ok",
    summary: disabled.length ? `Disabled Defender component(s): ${disabled.join(", ")}` : "Defender core protections are enabled",
    details: status,
    advice: disabled.length ? ["Confirm whether another managed security product is active or re-enable Defender protections."] : [],
  };
}

function winEvents(options) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$start=(Get-Date).AddHours(-24)",
    "$rows=foreach($log in @('System','Application')){Get-WinEvent -FilterHashtable @{LogName=$log;StartTime=$start;Level=@(1,2)} -MaxEvents 50 | Select-Object @{n='LogName';e={$log}},TimeCreated,ProviderName,Id,LevelDisplayName,Message}",
    "$rows | Select-Object LogName,TimeCreated,ProviderName,Id,LevelDisplayName,@{n='Message';e={if($_.Message){$_.Message.Substring(0,[Math]::Min(300,$_.Message.Length))}else{''}}} | ConvertTo-Json -Depth 4",
  ].join("; ");
  const result = ps(script, Math.max(options.timeoutMs, 25000));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows event logs", result, "skip");
  const events = arr(json(result.stdout, []));
  return {
    status: events.length ? "warn" : "ok",
    summary: events.length ? `${events.length} critical/error event(s) in the last 24 hours` : "No recent critical/error events found",
    details: { lookbackHours: 24, events },
    advice: events.length ? ["Review recurring providers and event IDs before assuming a hardware fault."] : [],
  };
}

function winThermal(options) {
  const result = ps("$ErrorActionPreference='SilentlyContinue'; Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object InstanceName,CurrentTemperature,CriticalTripPoint | ConvertTo-Json -Depth 4", options.timeoutMs);
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows thermal sensors", result, "skip");
  const zones = arr(json(result.stdout, [])).map((row) => ({ instanceHash: hash(row.InstanceName), currentCelsius: kelvinTenths(row.CurrentTemperature), criticalCelsius: kelvinTenths(row.CriticalTripPoint) }));
  const hot = zones.filter((z) => z.currentCelsius !== null && z.currentCelsius >= 85);
  return {
    status: !zones.length ? "skip" : hot.length ? "warn" : "ok",
    summary: !zones.length ? "No ACPI thermal zones exposed by Windows" : `${zones.length} thermal zone(s) checked`,
    details: { zones },
    advice: hot.length ? ["High temperature readings can indicate blocked airflow, bad fan behavior, or bad sensor data."] : [],
  };
}

function extendedTimeout(options, minimum = 45000) {
  return Math.max(options.timeoutMs || DEFAULT_TIMEOUT_MS, minimum);
}

function levelCountsFromLogs(logs) {
  const counts = { critical: 0, error: 0, warning: 0 };
  for (const log of arr(logs)) {
    const byLevel = log && log.byLevel ? log.byLevel : {};
    counts.critical += Number(byLevel["1"] || 0);
    counts.error += Number(byLevel["2"] || 0);
    counts.warning += Number(byLevel["3"] || 0);
  }
  return counts;
}

function levelCountsFromEvents(events) {
  const counts = { critical: 0, error: 0, warning: 0 };
  for (const event of arr(events)) {
    const level = Number(event.levelValue ?? event.Level);
    if (level === 1) counts.critical += 1;
    else if (level === 2) counts.error += 1;
    else if (level === 3) counts.warning += 1;
  }
  return counts;
}

function countIssueText(rows, fields, pattern) {
  let count = 0;
  for (const row of arr(rows)) {
    const text = fields.map((field) => row && row[field] ? String(row[field]) : "").join(" ");
    if (pattern.test(text)) count += 1;
  }
  return count;
}

function isNoEventsError(message) {
  const text = String(message || "");
  return /NoMatchingEventsFound|no events|no matching events|keine ereignisse|keine .*ereignisse|keine .*gefunden|es wurden keine/i.test(text);
}

function isMissingEventLogError(message) {
  const text = String(message || "");
  return /no event log|event log .*not found|cannot find .*event log|kein ereignisprotokoll|kein .*ereignisprotokoll.*gefunden|wurde kein ereignisprotokoll gefunden/i.test(text);
}

function winExtendedEventHistory(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Short-Message {
  param([string]$Message, [int]$Max = 600)
  if (-not $Message) { return '' }
  $text = $Message.Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) }
  return $text
}
function Add-Count {
  param([hashtable]$Map, [string]$Key)
  if (-not $Map.ContainsKey($Key)) { $Map[$Key] = 0 }
  $Map[$Key] = [int]$Map[$Key] + 1
}
function Event-Object {
  param($Event, [string]$LogName, [int]$MaxMessage = 600)
  [pscustomobject]@{
    logName = $LogName
    timeCreated = if ($Event.TimeCreated) { $Event.TimeCreated.ToString('o') } else { $null }
    providerName = $Event.ProviderName
    id = $Event.Id
    level = $Event.LevelDisplayName
    levelValue = $Event.Level
    recordId = $Event.RecordId
    message = Short-Message $Event.Message $MaxMessage
  }
}
$start = (Get-Date).AddDays(-${WINDOWS_EXTENDED_LOOKBACK_DAYS})
$logs = @(
  'System',
  'Application',
  'Setup',
  'Microsoft-Windows-WER-SystemErrorReporting/Operational',
  'Microsoft-Windows-WindowsUpdateClient/Operational',
  'Microsoft-Windows-Diagnostics-Performance/Operational',
  'Microsoft-Windows-DeviceSetupManager/Admin',
  'Microsoft-Windows-DriverFrameworks-UserMode/Operational'
)
$logResults = @()
foreach ($log in $logs) {
  try {
    $events = @(Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $start; Level = @(1,2,3) } -MaxEvents 500 -ErrorAction Stop)
    $byLevel = @{}
    $topMap = @{}
    foreach ($event in $events) {
      Add-Count $byLevel ([string]$event.Level)
      $provider = if ($event.ProviderName) { $event.ProviderName } else { 'Unknown' }
      $levelName = if ($event.LevelDisplayName) { $event.LevelDisplayName } else { [string]$event.Level }
      $key = "{0}|{1}|{2}|{3}" -f $provider, $event.Id, $event.Level, $levelName
      Add-Count $topMap $key
    }
    $topEvents = @($topMap.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 12 | ForEach-Object {
      $parts = $_.Key.Split('|')
      [pscustomobject]@{
        count = $_.Value
        providerName = $parts[0]
        id = [int]$parts[1]
        levelValue = [int]$parts[2]
        level = $parts[3]
      }
    })
    $recentEvents = @($events | Sort-Object TimeCreated -Descending | Select-Object -First 35 | ForEach-Object { Event-Object $_ $log 500 })
    $logResults += [pscustomobject]@{
      logName = $log
      total = $events.Count
      byLevel = $byLevel
      topEvents = $topEvents
      recentEvents = $recentEvents
      queryError = $null
    }
  } catch {
    $logResults += [pscustomobject]@{
      logName = $log
      total = 0
      byLevel = @{}
      topEvents = @()
      recentEvents = @()
      queryError = $_.Exception.Message
    }
  }
}
[pscustomobject]@{
  lookbackDays = ${WINDOWS_EXTENDED_LOOKBACK_DAYS}
  startTime = $start.ToString('o')
  logs = $logResults
} | ConvertTo-Json -Depth 8
`;
  const result = ps(script, extendedTimeout(options, 60000));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query extended Windows Event Viewer history", result, "skip");
  const details = json(result.stdout, null) || { lookbackDays: WINDOWS_EXTENDED_LOOKBACK_DAYS, logs: [] };
  const logs = arr(details.logs);
  const counts = levelCountsFromLogs(logs);
  const missingLogs = logs.filter((log) => log.queryError && isMissingEventLogError(log.queryError));
  const inaccessible = logs.filter((log) => log.queryError && !isNoEventsError(log.queryError) && !isMissingEventLogError(log.queryError));
  const totalEvents = logs.reduce((sum, log) => sum + Number(log.total || 0), 0);
  const advice = [];
  if (totalEvents) advice.push("Use the top repeating provider and event ID pairs to separate persistent faults from one-time noise.");
  if (inaccessible.length) advice.push("Some Event Viewer logs could not be read. Run the app as Administrator for the most complete history.");
  return {
    status: counts.critical || counts.error || counts.warning ? "warn" : inaccessible.length ? "skip" : "ok",
    summary: totalEvents ? `${totalEvents} sampled critical/error/warning event(s) in ${WINDOWS_EXTENDED_LOOKBACK_DAYS} days across ${logs.length} log(s)` : "No extended Event Viewer issue events found",
    details: {
      ...details,
      maxEventsPerLog: 500,
      totalsByLevel: counts,
      missingLogs: missingLogs.map((log) => ({ logName: log.logName, queryError: log.queryError })),
      inaccessibleLogs: inaccessible.map((log) => ({ logName: log.logName, queryError: log.queryError })),
    },
    advice,
  };
}

function winReliabilityHistory(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Short-Message {
  param([string]$Message, [int]$Max = 600)
  if (-not $Message) { return '' }
  $text = $Message.Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) }
  return $text
}
$start = (Get-Date).AddDays(-${WINDOWS_EXTENDED_LOOKBACK_DAYS})
$records = @()
$queryError = $null
try {
  $records = @(Get-CimInstance -Namespace root/cimv2 -ClassName Win32_ReliabilityRecords -ErrorAction Stop | Where-Object {
    $eventTime = $null
    try { $eventTime = [System.Management.ManagementDateTimeConverter]::ToDateTime($_.TimeGenerated) } catch { $eventTime = $null }
    $eventTime -and $eventTime -ge $start
  } | Sort-Object TimeGenerated -Descending | Select-Object -First 120 | ForEach-Object {
    $eventTime = $null
    try { $eventTime = [System.Management.ManagementDateTimeConverter]::ToDateTime($_.TimeGenerated) } catch { $eventTime = $null }
    [pscustomobject]@{
      timeGenerated = if ($eventTime) { $eventTime.ToString('o') } else { $null }
      sourceName = $_.SourceName
      productName = $_.ProductName
      eventIdentifier = $_.EventIdentifier
      message = Short-Message $_.Message 700
    }
  })
} catch {
  $queryError = $_.Exception.Message
}
$topMap = @{}
foreach ($record in $records) {
  $source = if ($record.sourceName) { $record.sourceName } else { 'Unknown' }
  $product = if ($record.productName) { $record.productName } else { 'Unknown' }
  $key = "{0}|{1}|{2}" -f $source, $product, $record.eventIdentifier
  if (-not $topMap.ContainsKey($key)) { $topMap[$key] = 0 }
  $topMap[$key] = [int]$topMap[$key] + 1
}
$top = @($topMap.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 12 | ForEach-Object {
  $parts = $_.Key.Split('|')
  [pscustomobject]@{ count = $_.Value; sourceName = $parts[0]; productName = $parts[1]; eventIdentifier = $parts[2] }
})
[pscustomobject]@{
  lookbackDays = ${WINDOWS_EXTENDED_LOOKBACK_DAYS}
  records = $records
  topRecords = $top
  queryError = $queryError
} | ConvertTo-Json -Depth 6
`;
  const result = ps(script, extendedTimeout(options));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows reliability history", result, "skip");
  const details = json(result.stdout, null) || { records: [], queryError: null };
  const records = arr(details.records);
  const issueCount = countIssueText(records, ["sourceName", "productName", "message"], /stopped working|not responding|failed|failure|crash|fault|blue.?screen|livekernel|shutdown unexpectedly|was not properly shut down/i);
  return {
    status: details.queryError && !records.length ? "skip" : issueCount ? "warn" : "ok",
    summary: details.queryError && !records.length ? "Reliability history is unavailable" : issueCount ? `${issueCount} likely reliability problem record(s) in ${WINDOWS_EXTENDED_LOOKBACK_DAYS} days` : `${records.length} reliability record(s), no obvious crash keywords`,
    details,
    advice: issueCount ? ["Review repeated Reliability Monitor sources to identify crashing applications, drivers, or improper shutdowns."] : details.queryError ? ["Reliability history may require elevated permissions or an enabled Reliability Monitor service."] : [],
  };
}

function winApplicationCrashes(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Short-Message {
  param([string]$Message, [int]$Max = 700)
  if (-not $Message) { return '' }
  $text = $Message.Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) }
  return $text
}
function Event-Object {
  param($Event, [string]$LogName)
  [pscustomobject]@{
    logName = $LogName
    timeCreated = if ($Event.TimeCreated) { $Event.TimeCreated.ToString('o') } else { $null }
    providerName = $Event.ProviderName
    id = $Event.Id
    level = $Event.LevelDisplayName
    levelValue = $Event.Level
    message = Short-Message $Event.Message
  }
}
$start = (Get-Date).AddDays(-${WINDOWS_EXTENDED_LOOKBACK_DAYS})
$events = @()
$errors = @()
try {
  $events += @(Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $start; Id = @(1000,1001,1002,1005,1023,1026); Level = @(1,2,3) } -MaxEvents 160 -ErrorAction Stop | ForEach-Object { Event-Object $_ 'Application' })
} catch {
  $errors += [pscustomobject]@{ source = 'Application'; error = $_.Exception.Message }
}
try {
  $events += @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-WER-SystemErrorReporting/Operational'; StartTime = $start; Level = @(1,2,3) } -MaxEvents 80 -ErrorAction Stop | ForEach-Object { Event-Object $_ 'Microsoft-Windows-WER-SystemErrorReporting/Operational' })
} catch {
  $errors += [pscustomobject]@{ source = 'WER-SystemErrorReporting'; error = $_.Exception.Message }
}
$topMap = @{}
foreach ($event in $events) {
  $provider = if ($event.providerName) { $event.providerName } else { 'Unknown' }
  $key = "{0}|{1}" -f $provider, $event.id
  if (-not $topMap.ContainsKey($key)) { $topMap[$key] = 0 }
  $topMap[$key] = [int]$topMap[$key] + 1
}
$top = @($topMap.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 12 | ForEach-Object {
  $parts = $_.Key.Split('|')
  [pscustomobject]@{ count = $_.Value; providerName = $parts[0]; id = [int]$parts[1] }
})
[pscustomobject]@{
  lookbackDays = ${WINDOWS_EXTENDED_LOOKBACK_DAYS}
  events = @($events | Sort-Object timeCreated -Descending | Select-Object -First 180)
  topEvents = $top
  queryErrors = $errors
} | ConvertTo-Json -Depth 6
`;
  const result = ps(script, extendedTimeout(options));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows application crash history", result, "skip");
  const details = json(result.stdout, null) || { events: [], queryErrors: [] };
  const events = arr(details.events);
  const queryErrors = arr(details.queryErrors).filter((entry) => !isNoEventsError(entry.error) && !isMissingEventLogError(entry.error));
  return {
    status: events.length ? "warn" : queryErrors.length ? "skip" : "ok",
    summary: events.length ? `${events.length} application crash/hang/WER event(s) in ${WINDOWS_EXTENDED_LOOKBACK_DAYS} days` : "No application crash or hang events found",
    details: { ...details, queryErrors },
    advice: events.length ? ["Group crashes by provider and event ID, then update or reinstall the repeatedly crashing application or related runtime."] : [],
  };
}

function winUpdateHealth(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Short-Message {
  param([string]$Message, [int]$Max = 600)
  if (-not $Message) { return '' }
  $text = $Message.Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) }
  return $text
}
function Event-Object {
  param($Event)
  [pscustomobject]@{
    timeCreated = if ($Event.TimeCreated) { $Event.TimeCreated.ToString('o') } else { $null }
    providerName = $Event.ProviderName
    id = $Event.Id
    level = $Event.LevelDisplayName
    levelValue = $Event.Level
    message = Short-Message $Event.Message
  }
}
$start = (Get-Date).AddDays(-${WINDOWS_EXTENDED_LOOKBACK_DAYS})
$pending = [ordered]@{
  cbsRebootPending = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'
  windowsUpdateRebootRequired = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
  pendingFileRenameOperations = $false
}
try {
  $sessionManager = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -ErrorAction Stop
  $pending.pendingFileRenameOperations = [bool]$sessionManager.PendingFileRenameOperations
} catch { }
$hotfixes = @()
try {
  $hotfixes = @(Get-CimInstance Win32_QuickFixEngineering -ErrorAction Stop | Sort-Object InstalledOn -Descending | Select-Object -First 20 | ForEach-Object {
    [pscustomobject]@{
      hotFixId = $_.HotFixID
      description = $_.Description
      installedOn = if ($_.InstalledOn) { [string]$_.InstalledOn } else { '' }
      installedBy = $_.InstalledBy
    }
  })
} catch { }
$events = @()
$queryError = $null
try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-WindowsUpdateClient/Operational'; StartTime = $start; Level = @(1,2,3) } -MaxEvents 140 -ErrorAction Stop | ForEach-Object { Event-Object $_ })
} catch {
  $queryError = $_.Exception.Message
}
[pscustomobject]@{
  lookbackDays = ${WINDOWS_EXTENDED_LOOKBACK_DAYS}
  pendingReboot = $pending
  recentHotfixes = $hotfixes
  updateEvents = $events
  queryError = $queryError
} | ConvertTo-Json -Depth 6
`;
  const result = ps(script, extendedTimeout(options));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows update health", result, "skip");
  const details = json(result.stdout, null) || { pendingReboot: {}, updateEvents: [] };
  const updateEvents = arr(details.updateEvents);
  const counts = levelCountsFromEvents(updateEvents);
  const pending = details.pendingReboot || {};
  const pendingReasons = Object.entries(pending).filter(([, value]) => value === true).map(([key]) => key);
  const queryError = isNoEventsError(details.queryError) ? null : details.queryError;
  return {
    status: pendingReasons.length || counts.critical || counts.error || counts.warning ? "warn" : "ok",
    summary: pendingReasons.length || updateEvents.length ? `${pendingReasons.length} pending reboot flag(s), ${updateEvents.length} update warning/error event(s)` : "No Windows Update warnings or pending reboot flags found",
    details: { ...details, queryError, totalsByLevel: counts, pendingRebootReasons: pendingReasons },
    advice: pendingReasons.length ? ["Restart Windows to finish pending servicing work, then rerun the extended scan."] : updateEvents.length ? ["Review Windows Update event IDs and install failures before troubleshooting applications."] : [],
  };
}

function winServiceHealth(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Short-Message {
  param([string]$Message, [int]$Max = 600)
  if (-not $Message) { return '' }
  $text = $Message.Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) }
  return $text
}
$start = (Get-Date).AddDays(-${WINDOWS_EXTENDED_LOOKBACK_DAYS})
$services = @()
$queryError = $null
try {
  $services = @(Get-CimInstance Win32_Service -ErrorAction Stop | Where-Object { $_.StartMode -eq 'Auto' -and $_.State -ne 'Running' } | Sort-Object DisplayName | Select-Object -First 160 | ForEach-Object {
    [pscustomobject]@{
      name = $_.Name
      displayName = $_.DisplayName
      state = $_.State
      status = $_.Status
      startMode = $_.StartMode
      exitCode = $_.ExitCode
      serviceSpecificExitCode = $_.ServiceSpecificExitCode
      processId = $_.ProcessId
      pathNameHash = if ($_.PathName) { [System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($_.PathName))).Replace('-', '').Substring(0, 12).ToLowerInvariant() } else { '' }
    }
  })
} catch {
  $queryError = $_.Exception.Message
}
$events = @()
$eventError = $null
try {
  $events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = 'Service Control Manager'; StartTime = $start; Level = @(1,2,3) } -MaxEvents 120 -ErrorAction Stop | ForEach-Object {
    [pscustomobject]@{
      timeCreated = if ($_.TimeCreated) { $_.TimeCreated.ToString('o') } else { $null }
      providerName = $_.ProviderName
      id = $_.Id
      level = $_.LevelDisplayName
      levelValue = $_.Level
      message = Short-Message $_.Message
    }
  })
} catch {
  $eventError = $_.Exception.Message
}
[pscustomobject]@{
  lookbackDays = ${WINDOWS_EXTENDED_LOOKBACK_DAYS}
  automaticServicesNotRunning = $services
  serviceControlManagerEvents = $events
  queryError = $queryError
  eventQueryError = $eventError
} | ConvertTo-Json -Depth 6
`;
  const result = ps(script, extendedTimeout(options));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows service health", result, "skip");
  const details = json(result.stdout, null) || { automaticServicesNotRunning: [], serviceControlManagerEvents: [] };
  const services = arr(details.automaticServicesNotRunning);
  const events = arr(details.serviceControlManagerEvents);
  const failedServices = services.filter((service) => Number(service.exitCode || 0) !== 0 || Number(service.serviceSpecificExitCode || 0) !== 0);
  const counts = levelCountsFromEvents(events);
  const eventQueryError = isNoEventsError(details.eventQueryError) ? null : details.eventQueryError;
  return {
    status: failedServices.length || counts.critical || counts.error ? "warn" : details.queryError && !services.length ? "skip" : "ok",
    summary: `${services.length} automatic service(s) not running, ${events.length} Service Control Manager warning/error event(s)`,
    details: { ...details, eventQueryError, failedServices, totalsByLevel: counts },
    advice: failedServices.length || events.length ? ["Investigate repeated Service Control Manager event IDs and services with non-zero exit codes."] : [],
  };
}

function winDriverHealth(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Short-Message {
  param([string]$Message, [int]$Max = 600)
  if (-not $Message) { return '' }
  $text = $Message.Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) }
  return $text
}
$start = (Get-Date).AddDays(-${WINDOWS_EXTENDED_LOOKBACK_DAYS})
$unsigned = @()
$driverError = $null
try {
  $unsigned = @(Get-CimInstance Win32_PnPSignedDriver -ErrorAction Stop | Where-Object { $_.IsSigned -eq $false } | Sort-Object DeviceName | Select-Object -First 160 | ForEach-Object {
    [pscustomobject]@{
      deviceName = $_.DeviceName
      deviceClass = $_.DeviceClass
      manufacturer = $_.Manufacturer
      driverProviderName = $_.DriverProviderName
      driverVersion = $_.DriverVersion
      driverDate = if ($_.DriverDate) { [string]$_.DriverDate } else { '' }
      isSigned = $_.IsSigned
      signer = $_.Signer
      infName = $_.InfName
    }
  })
} catch {
  $driverError = $_.Exception.Message
}
$events = @()
$eventErrors = @()
$providers = @('Microsoft-Windows-Kernel-PnP', 'Microsoft-Windows-UserPnp', 'Microsoft-Windows-DriverFrameworks-UserMode', 'Microsoft-Windows-DeviceSetupManager')
foreach ($provider in $providers) {
  try {
    $events += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = $provider; StartTime = $start; Level = @(1,2,3) } -MaxEvents 60 -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{
        timeCreated = if ($_.TimeCreated) { $_.TimeCreated.ToString('o') } else { $null }
        providerName = $_.ProviderName
        id = $_.Id
        level = $_.LevelDisplayName
        levelValue = $_.Level
        message = Short-Message $_.Message
      }
    })
  } catch {
    $eventErrors += [pscustomobject]@{ providerName = $provider; error = $_.Exception.Message }
  }
}
[pscustomobject]@{
  lookbackDays = ${WINDOWS_EXTENDED_LOOKBACK_DAYS}
  unsignedOrUnverifiedDrivers = $unsigned
  driverEvents = @($events | Sort-Object timeCreated -Descending | Select-Object -First 180)
  driverQueryError = $driverError
  eventQueryErrors = $eventErrors
} | ConvertTo-Json -Depth 6
`;
  const result = ps(script, extendedTimeout(options));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows driver health", result, "skip");
  const details = json(result.stdout, null) || { unsignedOrUnverifiedDrivers: [], driverEvents: [] };
  const unsigned = arr(details.unsignedOrUnverifiedDrivers);
  const events = arr(details.driverEvents);
  const counts = levelCountsFromEvents(events);
  const eventQueryErrors = arr(details.eventQueryErrors).filter((entry) => !isNoEventsError(entry.error));
  return {
    status: unsigned.length || counts.critical || counts.error || counts.warning ? "warn" : details.driverQueryError && !unsigned.length ? "skip" : "ok",
    summary: `${unsigned.length} unsigned driver record(s), ${events.length} driver setup/runtime warning/error event(s)`,
    details: { ...details, eventQueryErrors, totalsByLevel: counts },
    advice: unsigned.length || events.length ? ["Prioritize repeated Kernel-PnP, UserPnp, and DriverFrameworks events for devices that also appear in Device Manager."] : [],
  };
}

function winHardwareEvents(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Short-Message {
  param([string]$Message, [int]$Max = 700)
  if (-not $Message) { return '' }
  $text = $Message.Replace("\`r", ' ').Replace("\`n", ' ').Trim()
  if ($text.Length -gt $Max) { return $text.Substring(0, $Max) }
  return $text
}
$start = (Get-Date).AddDays(-${WINDOWS_EXTENDED_LOOKBACK_DAYS})
$providers = @(
  'Disk',
  'Ntfs',
  'atapi',
  'storahci',
  'stornvme',
  'iaStorV',
  'iaStorA',
  'Microsoft-Windows-WHEA-Logger',
  'WHEA-Logger',
  'Microsoft-Windows-Kernel-Power',
  'Microsoft-Windows-ACPI',
  'ACPI',
  'Microsoft-Windows-Thermal-UI',
  'Microsoft-Windows-ThermalState',
  'Display',
  'nvlddmkm',
  'amdkmdag',
  'igfx'
)
$events = @()
$queryErrors = @()
foreach ($provider in $providers) {
  try {
    $events += @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; ProviderName = $provider; StartTime = $start; Level = @(1,2,3) } -MaxEvents 80 -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{
        timeCreated = if ($_.TimeCreated) { $_.TimeCreated.ToString('o') } else { $null }
        providerName = $_.ProviderName
        id = $_.Id
        level = $_.LevelDisplayName
        levelValue = $_.Level
        recordId = $_.RecordId
        message = Short-Message $_.Message
      }
    })
  } catch {
    $queryErrors += [pscustomobject]@{ providerName = $provider; error = $_.Exception.Message }
  }
}
$topMap = @{}
foreach ($event in $events) {
  $provider = if ($event.providerName) { $event.providerName } else { 'Unknown' }
  $key = "{0}|{1}|{2}" -f $provider, $event.id, $event.levelValue
  if (-not $topMap.ContainsKey($key)) { $topMap[$key] = 0 }
  $topMap[$key] = [int]$topMap[$key] + 1
}
$top = @($topMap.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 16 | ForEach-Object {
  $parts = $_.Key.Split('|')
  [pscustomobject]@{ count = $_.Value; providerName = $parts[0]; id = [int]$parts[1]; levelValue = [int]$parts[2] }
})
[pscustomobject]@{
  lookbackDays = ${WINDOWS_EXTENDED_LOOKBACK_DAYS}
  events = @($events | Sort-Object timeCreated -Descending | Select-Object -First 240)
  topEvents = $top
  queryErrors = $queryErrors
} | ConvertTo-Json -Depth 6
`;
  const result = ps(script, extendedTimeout(options));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows hardware event history", result, "skip");
  const details = json(result.stdout, null) || { events: [], topEvents: [] };
  const events = arr(details.events);
  const counts = levelCountsFromEvents(events);
  const queryErrors = arr(details.queryErrors).filter((entry) => !isNoEventsError(entry.error));
  const severeHardware = events.filter((event) => /disk|ntfs|stor|whea|thermal|display|nvlddmkm|amdkmdag|igfx/i.test(event.providerName || "") && [1, 2].includes(Number(event.levelValue)));
  return {
    status: severeHardware.length ? "fail" : events.length ? "warn" : "ok",
    summary: events.length ? `${events.length} hardware-related warning/error event(s) in ${WINDOWS_EXTENDED_LOOKBACK_DAYS} days` : "No targeted hardware warning/error events found",
    details: { ...details, queryErrors, totalsByLevel: counts, severeHardwareEvents: severeHardware.slice(0, 40) },
    advice: severeHardware.length ? ["Back up important data and inspect repeated disk, WHEA, thermal, or display driver events with vendor diagnostics."] : events.length ? ["Correlate hardware events with Device Manager, storage health, and temperature results."] : [],
  };
}

function winHardwareInventory(options) {
  const script = `
$ErrorActionPreference='SilentlyContinue'
function Select-Props {
  param($Object, [string[]]$Names)
  if (-not $Object) { return $null }
  $out = [ordered]@{}
  foreach ($name in $Names) {
    if ($Object.PSObject.Properties[$name]) { $out[$name] = $Object.$name }
  }
  [pscustomobject]$out
}
$queryErrors = @()
function Query-Cim {
  param([string]$ClassName, [string]$Namespace = 'root/cimv2')
  try { @(Get-CimInstance -Namespace $Namespace -ClassName $ClassName -ErrorAction Stop) }
  catch {
    $script:queryErrors += [pscustomobject]@{ className = $ClassName; namespace = $Namespace; error = $_.Exception.Message }
    @()
  }
}
$computer = Query-Cim 'Win32_ComputerSystem' | Select-Object -First 1
$os = Query-Cim 'Win32_OperatingSystem' | Select-Object -First 1
$bios = Query-Cim 'Win32_BIOS' | Select-Object -First 1
$baseBoard = Query-Cim 'Win32_BaseBoard' | Select-Object -First 1
$processors = Query-Cim 'Win32_Processor'
$memory = Query-Cim 'Win32_PhysicalMemory'
$diskDrives = Query-Cim 'Win32_DiskDrive'
$video = Query-Cim 'Win32_VideoController'
$network = Query-Cim 'Win32_NetworkAdapter' | Where-Object { $_.PhysicalAdapter -eq $true }
$enclosure = Query-Cim 'Win32_SystemEnclosure' | Select-Object -First 1
$tpm = $null
try {
  if (Get-Command Get-Tpm -ErrorAction SilentlyContinue) { $tpm = Get-Tpm -ErrorAction Stop }
} catch {
  $queryErrors += [pscustomobject]@{ className = 'Get-Tpm'; namespace = 'PowerShell'; error = $_.Exception.Message }
}
[pscustomobject]@{
  computerSystem = Select-Props $computer @('Manufacturer','Model','SystemType','TotalPhysicalMemory','NumberOfProcessors','NumberOfLogicalProcessors','Domain','PartOfDomain','Status')
  operatingSystem = Select-Props $os @('Caption','Version','BuildNumber','InstallDate','LastBootUpTime','Status')
  bios = Select-Props $bios @('Manufacturer','Name','SMBIOSBIOSVersion','ReleaseDate','SerialNumber','Status')
  baseBoard = Select-Props $baseBoard @('Manufacturer','Product','Version','SerialNumber','Status')
  enclosure = Select-Props $enclosure @('Manufacturer','ChassisTypes','SerialNumber','SMBIOSAssetTag','SecurityStatus')
  processors = @($processors | ForEach-Object { Select-Props $_ @('Name','Manufacturer','DeviceID','NumberOfCores','NumberOfLogicalProcessors','MaxClockSpeed','CurrentClockSpeed','LoadPercentage','Status','LastErrorCode') })
  memoryModules = @($memory | ForEach-Object { Select-Props $_ @('BankLabel','DeviceLocator','Manufacturer','PartNumber','SerialNumber','Capacity','Speed','ConfiguredClockSpeed','MemoryType','SMBIOSMemoryType') })
  diskDrives = @($diskDrives | ForEach-Object { Select-Props $_ @('Model','InterfaceType','MediaType','Size','Partitions','Status','LastErrorCode','SerialNumber') })
  videoControllers = @($video | ForEach-Object { Select-Props $_ @('Name','AdapterRAM','DriverVersion','DriverDate','VideoProcessor','Status','ConfigManagerErrorCode') })
  networkAdapters = @($network | Select-Object -First 80 | ForEach-Object { Select-Props $_ @('Name','Manufacturer','AdapterType','NetConnectionStatus','Speed','MACAddress','Status','ConfigManagerErrorCode') })
  tpm = if ($tpm) { Select-Props $tpm @('TpmPresent','TpmReady','TpmEnabled','TpmActivated','ManufacturerIdTxt','ManufacturerVersion','ManagedAuthLevel') } else { $null }
  queryErrors = $queryErrors
} | ConvertTo-Json -Depth 7
`;
  const result = ps(script, extendedTimeout(options));
  if (!result.ok && !result.stdout) return commandFailure("Unable to query Windows hardware inventory", result, "skip");
  const details = json(result.stdout, null) || {};
  const issueStatuses = /error|degrad|pred fail|no contact|lost comm|nonrecover/i;
  const statusRows = [
    details.computerSystem,
    details.operatingSystem,
    details.bios,
    details.baseBoard,
    ...arr(details.processors),
    ...arr(details.diskDrives),
    ...arr(details.videoControllers),
    ...arr(details.networkAdapters),
  ].filter(Boolean);
  const statusProblems = statusRows.filter((row) => issueStatuses.test(String(row.Status || "")) || Number(row.LastErrorCode || 0) !== 0 || Number(row.ConfigManagerErrorCode || 0) !== 0);
  const tpm = details.tpm || {};
  const tpmProblem = tpm && tpm.TpmPresent === true && (tpm.TpmReady === false || tpm.TpmEnabled === false || tpm.TpmActivated === false);
  return {
    status: statusProblems.length || tpmProblem ? "warn" : "info",
    summary: `${arr(details.processors).length} CPU record(s), ${arr(details.memoryModules).length} memory module(s), ${arr(details.diskDrives).length} disk drive(s), ${arr(details.videoControllers).length} video controller(s) inventoried`,
    details: { ...details, statusProblems, tpmProblem },
    advice: statusProblems.length ? ["Inspect hardware inventory rows with non-OK status, LastErrorCode, or ConfigManagerErrorCode."] : tpmProblem ? ["Check TPM readiness in Windows Security or firmware settings if device encryption is expected."] : [],
  };
}

function kelvinTenths(value) {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? Math.round(((raw / 10) - 273.15) * 10) / 10 : null;
}

function linuxDf(options) {
  const result = run("df", ["-Pk", "-x", "tmpfs", "-x", "devtmpfs"], { timeoutMs: options.timeoutMs });
  if (!result.ok) return commandFailure("Unable to run df", result);
  const filesystems = parseDf(result.stdout);
  const low = filesystems.filter((row) => row.usedPercent >= 90);
  return {
    status: low.length ? "warn" : "ok",
    summary: low.length ? `${low.length} filesystem(s) above 90% used` : `${filesystems.length} filesystem(s) checked`,
    details: { filesystems },
    advice: low.length ? ["Free space on filesystems above 90% usage."] : [],
  };
}

function parseDf(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/).slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [filesystem, blocks, used, available, usedPercentText, ...mountParts] = parts;
    rows.push({ filesystem, sizeBytes: Number(blocks) * 1024, usedBytes: Number(used) * 1024, freeBytes: Number(available) * 1024, usedPercent: Number(String(usedPercentText).replace("%", "")), mount: mountParts.join(" ") });
  }
  return rows;
}

function linuxStorageHealth(options) {
  const lsblk = run("lsblk", ["-J", "-o", "NAME,TYPE,SIZE,MODEL,SERIAL,STATE,ROTA,MOUNTPOINTS"], { timeoutMs: options.timeoutMs });
  const smartctl = exists("smartctl");
  const details = { lsblk: json(lsblk.stdout, null), smartctlAvailable: smartctl, smartctl: [], commandErrors: [] };
  if (!lsblk.ok) details.commandErrors.push(commandError(lsblk));
  if (smartctl && details.lsblk && Array.isArray(details.lsblk.blockdevices)) {
    const disks = flattenBlockDevices(details.lsblk.blockdevices).filter((d) => d.type === "disk").slice(0, 12);
    for (const disk of disks) {
      const result = run("smartctl", ["-H", `/dev/${disk.name}`], { timeoutMs: Math.max(options.timeoutMs, 20000) });
      details.smartctl.push({ device: `/dev/${disk.name}`, ok: result.ok, output: `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(0, 20) });
    }
  }
  const failing = details.smartctl.filter((entry) => entry.output.join("\n").toLowerCase().match(/failed|prefail|failing/));
  if (!lsblk.ok && !smartctl) return { status: "skip", summary: "No Linux storage health source was available", details, advice: ["Install util-linux and smartmontools for deeper storage checks."] };
  return {
    status: failing.length ? "fail" : "ok",
    summary: smartctl ? `${details.smartctl.length} disk SMART health command(s) run` : "Block devices listed; smartctl is not installed",
    details,
    advice: failing.length ? ["Back up important data immediately and inspect failing disks with smartctl -a."] : smartctl ? [] : ["Install smartmontools to check SMART health directly."],
  };
}

function flattenBlockDevices(devices, out = []) {
  for (const device of devices || []) {
    out.push(device);
    if (Array.isArray(device.children)) flattenBlockDevices(device.children, out);
  }
  return out;
}

function linuxBattery() {
  const base = "/sys/class/power_supply";
  if (!fs.existsSync(base)) return { status: "skip", summary: "No Linux power_supply interface found" };
  const supplies = fs.readdirSync(base).map((name) => {
    const dir = path.join(base, name);
    return { name, type: readIf(path.join(dir, "type")), status: readIf(path.join(dir, "status")), capacityPercent: num(readIf(path.join(dir, "capacity"))), health: readIf(path.join(dir, "health")), manufacturer: readIf(path.join(dir, "manufacturer")), modelName: readIf(path.join(dir, "model_name")) };
  });
  const batteries = supplies.filter((s) => String(s.type).toLowerCase() === "battery");
  if (!batteries.length) return { status: "skip", summary: "No battery found", details: { supplies } };
  const low = batteries.filter((b) => Number(b.capacityPercent) <= 15);
  const bad = batteries.filter((b) => b.health && !/^good|unknown$/i.test(b.health));
  return {
    status: bad.length ? "fail" : low.length ? "warn" : "ok",
    summary: `${batteries.length} battery/batteries checked`,
    details: { batteries },
    advice: bad.length ? ["Battery health is not reported as good. Confirm with vendor diagnostics."] : low.length ? ["Plug in power before long diagnostics or updates."] : [],
  };
}

function linuxFailedServices(options) {
  if (!exists("systemctl")) return { status: "skip", summary: "systemctl is not available" };
  const result = run("systemctl", ["--failed", "--no-legend", "--plain"], { timeoutMs: options.timeoutMs });
  if (!result.ok && result.status !== 1) return commandFailure("Unable to query failed systemd services", result, "skip");
  const services = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s+/);
    return { unit: parts[0], load: parts[1], active: parts[2], sub: parts[3], description: parts.slice(4).join(" ") };
  });
  return {
    status: services.length ? "warn" : "ok",
    summary: services.length ? `${services.length} failed systemd unit(s)` : "No failed systemd services",
    details: { services },
    advice: services.length ? ["Inspect failed units with systemctl status UNIT and journalctl -u UNIT."] : [],
  };
}

function linuxThermal() {
  const base = "/sys/class/thermal";
  const zones = [];
  if (fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base)) {
      if (!entry.startsWith("thermal_zone")) continue;
      const dir = path.join(base, entry);
      const tempRaw = num(readIf(path.join(dir, "temp")));
      zones.push({ zone: entry, type: readIf(path.join(dir, "type")), tempCelsius: tempRaw === null ? null : Math.round((tempRaw / 1000) * 10) / 10 });
    }
  }
  let sensors = null;
  const sensorsAvailable = exists("sensors");
  if (sensorsAvailable) {
    const result = run("sensors", ["-j"], { timeoutMs: 10000 });
    sensors = result.ok ? json(result.stdout, null) : { error: commandError(result) };
  }
  const hot = zones.filter((z) => z.tempCelsius !== null && z.tempCelsius >= 85);
  return {
    status: !zones.length && !sensorsAvailable ? "skip" : hot.length ? "warn" : "ok",
    summary: zones.length ? `${zones.length} thermal zone(s) checked` : sensorsAvailable ? "lm-sensors data collected" : "No thermal zones or lm-sensors found",
    details: { thermalZones: zones, sensorsAvailable, sensors },
    advice: hot.length ? ["High thermal readings can indicate cooling or sensor problems."] : [],
  };
}

function linuxKernelLogs(options) {
  let result = run("journalctl", ["-k", "-p", "warning..alert", "--since", "24 hours ago", "--no-pager", "-n", "120"], { timeoutMs: Math.max(options.timeoutMs, 20000), maxBuffer: 1024 * 1024 * 4 });
  if (!result.ok) result = run("dmesg", ["--level=warn,err,crit,alert,emerg"], { timeoutMs: options.timeoutMs, maxBuffer: 1024 * 1024 * 4 });
  if (!result.ok) return commandFailure("Unable to read kernel warning logs", result, "skip");
  const lines = result.stdout.split(/\r?\n/).filter(Boolean).slice(-120);
  return {
    status: lines.length ? "warn" : "ok",
    summary: lines.length ? `${lines.length} kernel warning/error line(s)` : "No kernel warnings found",
    details: { lines },
    advice: lines.length ? ["Look for repeated I/O, GPU, ACPI, thermal, or driver messages."] : [],
  };
}

async function runAndroidDiagnosis(target, options) {
  const adbPath = target.adbPath || findAdb();
  if (!adbPath) throw new Error("adb was not found. Install Android platform-tools and add adb to PATH.");
  const safeTarget = { ...target, adbPath: adbPath === "adb" ? "PATH:adb" : adbPath };
  const report = new Report(safeTarget, options);
  const adb = (args, timeoutMs = ANDROID_TIMEOUT_MS) => run(adbPath, ["-s", target.serial, ...args], { timeoutMs, maxBuffer: 1024 * 1024 * 12 });

  await check(report, "android.connection", "Android ADB connection", () => androidConnection(target, adb));
  await check(report, "android.identity", "Android identity", () => androidIdentity(adb));
  await check(report, "android.battery", "Android battery", () => androidBattery(adb));
  await check(report, "android.storage", "Android storage", () => androidStorage(adb));
  await check(report, "android.memory", "Android memory", () => androidMemory(adb));
  await check(report, "android.cpu", "Android CPU and uptime", () => androidCpu(adb));
  await check(report, "android.network", "Android network", () => androidNetwork(adb));
  await check(report, "android.thermal", "Android thermal sensors", () => androidThermal(adb));
  await check(report, "android.packages", "Android package inventory", () => androidPackages(adb));
  if (options.profile === "full" || options.profile === "extended") {
    await check(report, "android.logs", "Android recent error logs", () => androidLogs(adb));
    await check(report, "android.sensors", "Android sensor service", () => androidSensors(adb));
  }
  return report.finish();
}

function adbShell(adb, command, timeoutMs = ANDROID_TIMEOUT_MS) {
  return adb(["shell", command], timeoutMs);
}

function androidConnection(target, adb) {
  const state = adb(["get-state"], 10000);
  if (!state.ok) return commandFailure("ADB device is not reachable", state, "fail");
  const value = state.stdout.trim();
  return {
    status: value === "device" ? "ok" : "warn",
    summary: `ADB state: ${value || target.state || "unknown"}`,
    details: { serial: target.serial, state: value, model: target.model || null },
    advice: value === "device" ? [] : ["Unlock the Android device and accept the USB debugging prompt."],
  };
}

function androidIdentity(adb) {
  const result = adbShell(adb, "getprop");
  if (!result.ok) return commandFailure("Unable to read Android properties", result);
  const props = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\[(.+?)\]: \[(.*?)\]$/.exec(line.trim());
    if (match) props[match[1]] = match[2];
  }
  const details = {
    manufacturer: props["ro.product.manufacturer"] || props["ro.product.vendor.manufacturer"] || "",
    model: props["ro.product.model"] || props["ro.product.vendor.model"] || "",
    device: props["ro.product.device"] || "",
    androidVersion: props["ro.build.version.release"] || "",
    sdk: props["ro.build.version.sdk"] || "",
    securityPatch: props["ro.build.version.security_patch"] || "",
    buildFingerprintHash: hash(props["ro.build.fingerprint"]),
    bootloader: props["ro.bootloader"] || "",
    abi: props["ro.product.cpu.abi"] || "",
  };
  return { status: "info", summary: `${details.manufacturer} ${details.model}, Android ${details.androidVersion} (SDK ${details.sdk})`, details };
}

function androidBattery(adb) {
  const result = adbShell(adb, "dumpsys battery");
  if (!result.ok) return commandFailure("Unable to read Android battery service", result);
  const data = kv(result.stdout);
  const level = num(data.level);
  const scale = num(data.scale) || 100;
  const levelPercent = level === null ? null : pct(level, scale);
  const tempRaw = num(data.temperature);
  const tempCelsius = tempRaw === null ? null : Math.round((tempRaw / 10) * 10) / 10;
  const health = androidBatteryHealth(data.health);
  const statusName = androidBatteryStatus(data.status);
  const badHealth = health && !["good", "unknown"].includes(health.toLowerCase());
  const warn = badHealth || (tempCelsius !== null && tempCelsius >= 45) || (levelPercent !== null && levelPercent <= 15);
  return {
    status: warn ? "warn" : "ok",
    summary: `Battery ${levelPercent === null ? "unknown" : `${levelPercent}%`}, ${statusName || "status unknown"}, ${tempCelsius === null ? "temp unknown" : `${tempCelsius} C`}`,
    details: { levelPercent, status: statusName, health, plugged: data["AC powered"] === "true" || data["USB powered"] === "true" || data["Wireless powered"] === "true", tempCelsius, voltageMv: num(data.voltage), raw: data },
    advice: warn ? ["Charge or cool the device before running long diagnostics, updates, or backups."] : [],
  };
}

function androidBatteryHealth(value) {
  return ({ 1: "unknown", 2: "good", 3: "overheat", 4: "dead", 5: "over voltage", 6: "unspecified failure", 7: "cold" })[Number(value)] || String(value || "");
}

function androidBatteryStatus(value) {
  return ({ 1: "unknown", 2: "charging", 3: "discharging", 4: "not charging", 5: "full" })[Number(value)] || String(value || "");
}

function androidStorage(adb) {
  const result = adbShell(adb, "df -k");
  if (!result.ok) return commandFailure("Unable to run Android df", result);
  const filesystems = parseDf(result.stdout);
  const important = filesystems.filter((row) => ["/data", "/sdcard", "/storage/emulated"].some((mount) => row.mount.startsWith(mount)));
  const low = filesystems.filter((row) => row.usedPercent >= 90);
  return {
    status: low.length ? "warn" : "ok",
    summary: low.length ? `${low.length} filesystem(s) above 90% used` : `${filesystems.length} filesystem(s) checked`,
    details: { important, filesystems },
    advice: low.length ? ["Free storage on Android before app updates, OS updates, or log-heavy testing."] : [],
  };
}

function androidMemory(adb) {
  const result = adbShell(adb, "cat /proc/meminfo");
  if (!result.ok) return commandFailure("Unable to read Android /proc/meminfo", result);
  const meminfo = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^(\w+):\s+(\d+)\s+kB/.exec(line.trim());
    if (match) meminfo[match[1]] = Number(match[2]) * 1024;
  }
  const total = meminfo.MemTotal || null;
  const available = meminfo.MemAvailable || meminfo.MemFree || null;
  const usedPercent = total && available ? pct(total - available, total) : null;
  return {
    status: usedPercent !== null && usedPercent >= 92 ? "warn" : "ok",
    summary: `${available ? bytes(available) : "unknown"} available of ${total ? bytes(total) : "unknown"} RAM`,
    details: { totalBytes: total, availableBytes: available, usedPercent, meminfo },
    advice: usedPercent !== null && usedPercent >= 92 ? ["Close foreground apps and re-run if memory pressure may affect results."] : [],
  };
}

function androidCpu(adb) {
  const uptime = adbShell(adb, "cat /proc/uptime");
  const cpuinfo = adbShell(adb, "cat /proc/cpuinfo | head -n 80");
  const loadavg = adbShell(adb, "cat /proc/loadavg");
  if (!uptime.ok && !cpuinfo.ok && !loadavg.ok) return commandFailure("Unable to read Android CPU information", uptime);
  const loads = loadavg.stdout.trim().split(/\s+/).slice(0, 3).map(Number);
  const cores = (cpuinfo.stdout.match(/^processor\s*:/gm) || []).length || null;
  const hardwareLine = cpuinfo.stdout.split(/\r?\n/).find((line) => /^Hardware\s*:/i.test(line) || /^model name\s*:/i.test(line));
  const uptimeSeconds = Number(uptime.stdout.trim().split(/\s+/)[0]);
  const perCore = cores && Number.isFinite(loads[0]) ? loads[0] / cores : null;
  return {
    status: perCore !== null && perCore > 1.5 ? "warn" : "ok",
    summary: `${cores || "unknown"} CPU core(s), load ${Number.isFinite(loads[0]) ? loads[0].toFixed(2) : "unknown"}`,
    details: { processorCount: cores, hardware: hardwareLine ? hardwareLine.split(":").slice(1).join(":").trim() : "", uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : null, loadAverage: { oneMinute: loads[0] || null, fiveMinutes: loads[1] || null, fifteenMinutes: loads[2] || null }, loadPerCore: perCore },
    advice: perCore !== null && perCore > 1.5 ? ["Re-run while the phone is idle if you need a clean baseline."] : [],
  };
}

function androidNetwork(adb) {
  const ip = adbShell(adb, "ip addr show");
  const airplane = adbShell(adb, "settings get global airplane_mode_on");
  if (!ip.ok) return commandFailure("Unable to read Android network interfaces", ip, "warn");
  const addresses = [];
  for (const line of ip.stdout.split(/\r?\n/)) {
    const match = /\s+inet6?\s+([^\s/]+).*?\s(\S+)$/.exec(line);
    if (match && !match[1].startsWith("127.") && match[1] !== "::1") addresses.push({ address: redactAddress(match[1]), interface: match[2] });
  }
  const airplaneOn = airplane.ok && airplane.stdout.trim() === "1";
  return {
    status: airplaneOn || !addresses.length ? "warn" : "ok",
    summary: airplaneOn ? "Airplane mode is on" : `${addresses.length} non-loopback address(es) found`,
    details: { airplaneMode: airplane.ok ? airplane.stdout.trim() : "unknown", addresses },
    advice: airplaneOn || !addresses.length ? ["Check Wi-Fi, mobile data, VPN, or airplane mode before network-related tests."] : [],
  };
}

function androidThermal(adb) {
  const shell = "for z in /sys/class/thermal/thermal_zone*; do [ -e \"$z/temp\" ] || continue; printf \"%s|\" \"$z\"; cat \"$z/type\" 2>/dev/null | tr -d '\\n'; printf \"|\"; cat \"$z/temp\" 2>/dev/null; done";
  const result = adbShell(adb, shell);
  if (!result.ok) return commandFailure("Unable to read Android thermal zones", result, "skip");
  const zones = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const [zone, type, tempText] = line.split("|");
    if (!zone) continue;
    const raw = num(tempText);
    const tempCelsius = raw === null ? null : Math.round((raw > 1000 ? raw / 1000 : raw / 10) * 10) / 10;
    zones.push({ zone: zone.replace("/sys/class/thermal/", ""), type: type || "", tempCelsius });
  }
  const hot = zones.filter((z) => z.tempCelsius !== null && z.tempCelsius >= 50);
  return {
    status: !zones.length ? "skip" : hot.length ? "warn" : "ok",
    summary: !zones.length ? "No readable thermal zones" : `${zones.length} thermal zone(s) checked`,
    details: { zones },
    advice: hot.length ? ["Let the phone cool and check for runaway apps before long diagnostics."] : [],
  };
}

function androidPackages(adb) {
  const thirdParty = adbShell(adb, "pm list packages -3");
  const disabled = adbShell(adb, "pm list packages -d");
  if (!thirdParty.ok && !disabled.ok) return commandFailure("Unable to query Android packages", thirdParty, "warn");
  const thirdPartyCount = thirdParty.ok ? thirdParty.stdout.split(/\r?\n/).filter(Boolean).length : null;
  const disabledPackages = disabled.ok ? disabled.stdout.split(/\r?\n/).filter(Boolean).slice(0, 200) : [];
  return { status: "info", summary: `${thirdPartyCount === null ? "unknown" : thirdPartyCount} third-party package(s), ${disabledPackages.length} disabled package(s) sampled`, details: { thirdPartyCount, disabledPackages } };
}

function androidLogs(adb) {
  const result = adb(["logcat", "-d", "-t", "300", "*:E"], 25000);
  if (!result.ok) return commandFailure("Unable to read Android logcat errors", result, "skip");
  const lines = result.stdout.split(/\r?\n/).filter((line) => line.trim() && !line.includes("--------- beginning of")).slice(-300);
  return {
    status: lines.length ? "warn" : "ok",
    summary: lines.length ? `${lines.length} recent error log line(s)` : "No recent Android error logs returned",
    details: { lines },
    advice: lines.length ? ["Look for repeated app, kernel, thermal, storage, or radio errors."] : [],
  };
}

function androidSensors(adb) {
  let result = adbShell(adb, "cmd sensorservice list", 20000);
  if (!result.ok) result = adbShell(adb, "dumpsys sensorservice", 20000);
  if (!result.ok) return commandFailure("Unable to query Android sensor service", result, "skip");
  const lines = result.stdout.split(/\r?\n/).filter(Boolean).slice(0, 250);
  const sensorCount = lines.filter((line) => /sensor|accelerometer|gyroscope|magnetometer|light|proximity/i.test(line)).length;
  return { status: "info", summary: `${sensorCount} sensor-related line(s) collected`, details: { output: lines } };
}

function targetLabel(target) {
  if (target.kind === "android") return `Android ${target.model || ""} ${target.serial || ""}`.trim();
  return `Local ${target.family || target.platform} ${target.hostname || os.hostname()}`;
}

function safeName(value) {
  return String(value || "device").replace(/[^a-zA-Z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "device";
}

function detailHighlights(details) {
  if (!details || typeof details !== "object") return [];
  const lines = [];
  if (Array.isArray(details.problems)) {
    for (const p of details.problems.slice(0, 5)) lines.push(`Problem: ${p.name} (${p.description}, code ${p.code})`);
  }
  if (Array.isArray(details.disks)) {
    for (const d of details.disks.slice(0, 5)) lines.push(`Disk: ${d.device} ${d.freeHuman} free of ${d.sizeHuman}, ${d.usedPercent}% used`);
  }
  if (Array.isArray(details.events)) {
    for (const e of details.events.slice(0, 3)) lines.push(`Event: ${e.ProviderName || e.providerName || e.LogName || e.logName} ${e.Id || e.id || ""} ${e.LevelDisplayName || e.level || ""}`.trim());
  }
  if (Array.isArray(details.topEvents)) {
    for (const e of details.topEvents.slice(0, 3)) lines.push(`Top event: ${e.count || ""}x ${e.providerName || e.ProviderName || ""} ${e.id || e.Id || ""}`.trim());
  }
  if (Array.isArray(details.logs)) {
    const topEvents = [];
    for (const log of details.logs) {
      for (const event of arr(log.topEvents).slice(0, 1)) topEvents.push({ ...event, logName: log.logName });
    }
    for (const e of topEvents.slice(0, 3)) lines.push(`Top event: ${e.count || ""}x ${e.logName || ""} ${e.providerName || ""} ${e.id || ""}`.trim());
  }
  if (Array.isArray(details.pendingRebootReasons) && details.pendingRebootReasons.length) {
    lines.push(`Pending reboot: ${details.pendingRebootReasons.join(", ")}`);
  }
  if (Array.isArray(details.lines)) {
    for (const line of details.lines.slice(0, 3)) lines.push(`Log: ${String(line).slice(0, 180)}`);
  }
  if (details.levelPercent !== undefined) {
    lines.push(`Battery: ${details.levelPercent}% ${details.status || ""} ${details.tempCelsius === null ? "" : `${details.tempCelsius} C`}`.trim());
  }
  if (Array.isArray(details.batteries)) {
    for (const b of details.batteries.slice(0, 3)) lines.push(`Battery: ${b.EstimatedChargeRemaining ?? b.capacityPercent ?? "unknown"}% ${b.Status || b.status || ""}`.trim());
  }
  return lines;
}

function render(report) {
  const lines = [];
  lines.push("System Diagnosis Report");
  lines.push("=======================");
  lines.push("");
  lines.push(`Started:  ${report.startedAt}`);
  lines.push(`Finished: ${report.finishedAt}`);
  lines.push(`Profile:  ${report.profile}`);
  lines.push(`Target:   ${targetLabel(report.target)}`);
  lines.push("");
  lines.push(`Summary:  ${report.summary.fail} fail, ${report.summary.warn} warn, ${report.summary.ok} ok, ${report.summary.skip} skip, ${report.summary.info} info`);
  lines.push("");

  const rank = { fail: 0, warn: 1, ok: 2, info: 3, skip: 4 };
  for (const check of [...report.checks].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))) {
    lines.push(`[${check.status.toUpperCase()}] ${check.title}`);
    lines.push(`  ${check.summary}`);
    for (const advice of check.advice || []) lines.push(`  Advice: ${advice}`);
    for (const highlight of detailHighlights(check.details)) lines.push(`  ${highlight}`);
    lines.push("");
  }
  lines.push("The JSON report contains full structured evidence for every check.");
  return lines.join("\n");
}

function writeReports(report, options) {
  const outputDir = path.resolve(options.output || DEFAULT_LOG_DIR);
  fs.mkdirSync(outputDir, { recursive: true });
  const base = path.join(outputDir, `diagnosis_${safeName(targetLabel(report.target))}_${stamp()}`);
  const files = {};
  if (options.format === "json" || options.format === "all") {
    files.json = `${base}.json`;
    fs.writeFileSync(files.json, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (options.format === "text" || options.format === "all") {
    files.text = `${base}.txt`;
    fs.writeFileSync(files.text, `${render(report)}\n`, "utf8");
  }
  return files;
}

function printDeviceList(inventory) {
  process.stdout.write("Available targets:\n");
  for (const device of inventory.devices) process.stdout.write(`  - ${device.label}\n`);
  if (!inventory.adbAvailable) process.stdout.write("\nAndroid: adb not found. Install Android platform-tools to scan phones.\n");
  else if (!inventory.devices.some((device) => device.kind === "android")) process.stdout.write("\nAndroid: adb found, but no authorized Android devices are connected.\n");
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.help || args.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (args.command === "list") {
    printDeviceList(await listDevices());
    return;
  }
  if (args.command !== "scan") throw new Error(`Unknown command: ${args.command}`);

  const target = await resolveTarget(args);
  process.stdout.write(`Running ${args.profile} diagnosis for ${targetLabel(target)}...\n`);
  const report = await runDiagnosis(target, args);
  const files = writeReports(report, args);
  process.stdout.write("\n");
  process.stdout.write(render(report));
  process.stdout.write("\n\nReports written:\n");
  for (const [format, filePath] of Object.entries(files)) process.stdout.write(`  ${format}: ${filePath}\n`);
  if (report.summary.fail > 0) process.exitCode = 2;
  else if (report.summary.warn > 0) process.exitCode = 1;
}

module.exports = {
  VERSION,
  DEFAULT_LOG_DIR,
  parseArgs,
  usage,
  listDevices,
  resolveTarget,
  runDiagnosis,
  render,
  writeReports,
  targetLabel,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n\n${usage()}\n`);
    process.exitCode = 2;
  });
}

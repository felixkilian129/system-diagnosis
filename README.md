# System Diagnosis

System Diagnosis is a small Electron desktop app and Node.js CLI for collecting local system health reports. It scans the Windows or Linux computer running the tool, and it can scan connected Android devices through `adb`.

iOS is intentionally not supported.

## Requirements

- Node.js 18 or newer
- Windows PowerShell for Windows local scans
- Standard Linux tools such as `df`, `lsblk`, `systemctl`, `journalctl`, and optional `smartctl`
- Android platform-tools for Android scans

Install dependencies:

```powershell
npm install
```

## Desktop App

Run the app during development:

```powershell
npm.cmd run gui
```

The scan profile selector includes:

- `Quick`: core identity, CPU, memory, storage, network, and baseline platform checks
- `Full`: quick checks plus normal platform health checks
- `Extended - Windows Events + Hardware`: full checks plus Windows Event Viewer history, Reliability Monitor records, application crash history, Windows Update health, Service Control Manager events, driver setup/runtime events, targeted hardware event providers, and a hardware inventory snapshot

After a scan, select any check in the results list to inspect readable details. Event-heavy checks show event cards, repeated event IDs, crash sources, extracted application/module names where available, advice, and the raw structured evidence.

Build the portable Windows app:

```powershell
npm.cmd run package:win
```

The build output is written to `dist\System Diagnosis-win32-x64\System Diagnosis.exe`.

## CLI

```powershell
node .\system_diagnosis.js --help
node .\system_diagnosis.js list
node .\system_diagnosis.js scan --target local
node .\system_diagnosis.js scan --target local --profile quick
node .\system_diagnosis.js scan --target local --profile full
node .\system_diagnosis.js scan --target local --profile extended
node .\system_diagnosis.js scan --target android --serial DEVICE_SERIAL
```

NPM aliases:

```powershell
npm.cmd run list
npm.cmd run scan:quick
npm.cmd run scan:full
npm.cmd run scan:extended
```

Running the CLI without arguments opens a small device-selection prompt.

## Reports

Reports are written to `logs` by default:

- `diagnosis_<target>_<timestamp>.txt`
- `diagnosis_<target>_<timestamp>.json`

The text report is for quick review. The JSON report keeps the full structured evidence for automation, follow-up analysis, or UI work.

## Checks

Local Windows/Linux checks include system identity, CPU load, memory pressure, storage capacity, network basics, and platform-specific health checks.

Windows adds Device Manager errors, physical disk health, SMART prediction data where available, battery state, Defender state, critical event logs, and ACPI thermal sensors. The extended Windows profile adds the deeper event and hardware history listed in the desktop app section.

Linux adds disk inventory, optional SMART health through `smartctl`, battery data, failed systemd services, thermal zones, optional `lm-sensors`, and kernel warning logs.

Android checks include ADB connectivity, build/device identity, battery, storage, memory, CPU load, network state, thermal zones, package inventory, recent error logs, and sensor-service output.

Some hardware checks depend on what the operating system exposes without administrator or root permissions. Vendor-only diagnostics, destructive write tests, battery calibration, deep memory testing, and firmware flashing are intentionally not run by this tool.

## Repository Notes

Generated directories and reports are ignored by Git:

- `node_modules`
- `dist`
- `logs`
- generated inventory CSV files

Use `npm.cmd run check` before committing code changes.

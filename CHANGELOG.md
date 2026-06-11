# Changelog

All notable changes to Velxio will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [3.0.0] - 2026-06-11

### Added
- **Digital Gate Engine**: Event-driven logic gate evaluation for board‑less digital circuits (AND, OR, NOT, XOR, NAND, NOR, XNOR, multi‑input gates). Supports sequential logic: D, T, JK flip‑flops, 4‑bit ripple counter, and mixed digital/analog boundary handoff.
- **Chip‑to‑Chip Bus**: Custom chips can now share address/data buses via a 4‑valued logic kernel with drive‑strength tri‑state nets. Ships a complete Galaksija Z80 home computer example (keyboard, display, ROM, RAM) that boots in the browser.
- **Retro CPU Custom Chips**: Programmable Z80 and Intel 8080 CPU emulator chips with external ROM loaded from project files (assembly or C via SDCC). Includes i8080 Kill‑the‑Bit demo and Z80 Larson scanner examples.
- **MicroSD Card Storage**: SD‑over‑SPI card emulation for AVR, RP2040, and ESP32 boards. FAT16 image built from workspace files with an upload panel for extra files (gated by pro overlay).
- **Signal Router**: First‑class GPIO Matrix routing for ESP32 – per‑signal routing via `SignalRouter` class, replacing the previous ad‑hoc `ledc_gpio_map`. Multi‑servo control now works correctly.
- **Library Manager**: Single unified tab with state‑aware row actions (Add to project, In project toggle, Uninstall/Remove). Per‑board library manifests (`velxio.json`) autocomplete and persistence.
- **Oscilloscope Trigger Modes**: Auto, Normal, and Single‑shot trigger with configurable source, edge, and position. ARMED/TRIGGERED/CAPTURED status badges.
- **Undo/Redo**: Command‑pattern undo/redo for canvas mutations (add/remove/move/rotate components, add/remove wires). Keyboard shortcuts (Ctrl+Z, Ctrl+Y) and toolbar buttons.
- **i18n – Multilingual Support**: Full internationalisation for the editor, landing page, examples gallery, and auth pages. 9 locales (en, es, pt‑br, it, fr, zh‑cn, de, ja, ru) with react‑i18next foundation.
- **ESP32‑CAM Emulation**: End‑to‑end emulation of the AI‑Thinker ESP32‑CAM with real webcam frame bridge. `esp_camera_fb_get()` returns JPEG frames from user’s camera. Gallery example with ILI9341 live preview.
- **ePaper Display Support**: SSD168x (mono/tri‑colour) and UC8159c (ACeP 7‑colour) decoder with SPI slave and canvas rendering. Works on AVR, RP2040, and ESP32.
- **STM32 Board Emulation**: Blue Pill, Black Pill, F4 Discovery, Olimex H405, Netduino 2/+2 – all via QEMU arm backend

## [2.0.1] - 2026-04-22

### Added
- Enhanced electrical simulation with ngspice-WASM engine for accurate analog circuit analysis
- Expanded component catalog with 44 SPICE-compatible parts including logic gates, transistors, op-amps, regulators, and electromechanical components
- Added 40 new circuit examples demonstrating analog, digital, and electromechanical concepts
- Introduced custom web components for electronic elements (relays, resistors, capacitors, inductors, transistors)
- Implemented ESP32 ADC waveform simulation with periodic 12-bit waveform look-up tables and interpolation
- Added voltmeter and ammeter instrument components for real-time circuit measurements
- Created comprehensive end-to-end tests for electrical simulation including capacitor charging, rectifier behavior, and waveform analysis
- Added GitHub Actions workflow for circuit simulation testing on every push and PR

### Changed
- Renamed all components to use 'velxio-' prefix for consistency
- Enabled electrical simulation by default (always-on SPICE mode) instead of requiring manual activation
- Enhanced LED brightness simulation to reflect actual current flow from SPICE calculations
- Updated backend to handle unhandled asyncio exceptions and prevent process crashes
- Improved component metadata generation to prevent CI drift and enforce up-to-date metadata
- Refactored property synchronization in simulation parts to use event-based system
- Expanded ADC pin mapping to support all 18 board types for full microcontroller integration

### Fixed
- Fixed sitemap generation to include all circuit examples for better SEO visibility
- Resolved floating input node issues in RC low-pass filter circuits that caused SPICE singular matrix errors
- Updated proxy configuration to use 127.0.0.1 for improved compatibility
- Fixed metadata regeneration to properly include custom components in the component picker
- Improved backend entrypoint script to ensure clean container restarts when processes die

## [2.0.1] - 2026-04-17

### Added
- Added ATtiny85 support with examples and simulation tests
- Added BMP280 sensor component with circuit preview and SVG representation
- Added example detail pages with improved SEO and sitemap generation
- Added MicroPython support for RP2040 (Pico), ESP32, ESP32-S3, and ESP32-C3 boards
- Added ability to upload precompiled firmware files (.hex, .bin, .elf) directly into the emulator
- Added ability to remove boards from workspace with confirmation dialog
- Added I2C sensor support with slave emulation for MPU6050, BMP280, DS1307, and DS3231 sensors
- Added ESP32 WiFi/BLE emulation with ESP-IDF compilation pipeline
- Added VS Code extension skeleton for local simulation
- Added comprehensive documentation for ESP32 GPIO sensor simulation, Docker infrastructure, and MicroPython implementation
- Added auto-compile feature that triggers compilation when pressing Play if code changed or no firmware loaded
- Added share functionality for projects and examples with visibility toggle
- Added component metadata overrides and enhanced property controls
- Added new CI/CD workflows for backend unit tests, end-to-end tests, and automated Discord release notifications
- Added Docker multi-architecture support (amd64 + arm64) and pre-built ESP-IDF toolchain image

### Changed
- Enhanced auto-compile to use board's file group for WiFi detection instead of legacy global files
- Updated CircuitPreview component and implemented ShareModal using createPortal
- Enhanced Arduino pin tracing in DynamicComponent and updated LittleFS WASM initialization
- Enhanced ESP-IDF compiler library resolution logic and added support for dynamic library detection
- Enhanced wire connection handling and GND checks for components
- Enhanced logging for library loading and WiFi progress
- Updated Docker build processes with optimized build contexts and multi-architecture support
- Changed WiFi SSID normalization to match QEMU access points for reliable ESP32 WiFi connection
- Refactored I2C slave tests for ESP32 with improved event handling and ACK/NACK responses

### Fixed
- Fixed container restart issue by monitoring both backend and nginx processes
- Fixed project saving to use active board files/kind and improved error messages
- Fixed ESP32 boot stability with deterministic instruction counting
- Fixed ESP32 Run button to auto-compile and recover firmware after page refresh
- Fixed LED ground check to require cathode wired to GND (or LOW GPIO) to light up
- Fixed MPU6050Slave I2C handling with improved WHO_AM_I read tracking
- Fixed ESP32 WiFi SSID/channel alignment with QEMU access_points array
- Fixed RISC-V toolchain paths for ESP32-C3 compilation
- Fixed ESP-IDF Python requirements installation in Docker
- Fixed SaveProjectModal to prevent saving to `/api/projects/none` when project ID is invalid
- Fixed ESP32 compilation by adding missing dependencies (cmake, ninja-build, git, packaging, libusb)

[2.0.1]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v2.0.1

[3.0.0]: https://github.com/davidmonterocrespo24/velxio/releases/tag/v3.0.0
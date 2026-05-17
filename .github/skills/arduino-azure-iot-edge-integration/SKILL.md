---
name: arduino-azure-iot-edge-integration
description: 'Design and implement Arduino integration with Azure IoT Hub and IoT Edge, including secure provisioning, resilient telemetry, command handling, and production guardrails.'
---

# Arduino Azure IoT Edge Integration

Use this skill when connecting Arduino-class devices to Azure IoT or implementing edge-heavy scenarios with gateways, intermittent networks, offline buffering, and local actuation.

## When to Use

- Connecting Arduino sensors to cloud platforms
- Sending MQTT/HTTP telemetry
- Implementing edge gateway for field devices
- Cloud-to-device commands and OTA configuration updates
- Handling unstable connectivity with store-and-forward patterns

## Integration Patterns

### Pattern A: Device Direct to Cloud
- Protocol: MQTT over TLS or HTTPS
- Identity: per-device credentials (SAS tokens or X.509 certificates)
- Telemetry payload: compact JSON with timestamp, device ID, metrics
- Use when: Connectivity is stable and cloud latency is acceptable

### Pattern B: Device to Local Gateway
- Arduino communicates with local gateway (serial, BLE, local MQTT, RS-485, Modbus)
- Gateway forwards data to cloud
- Use when: Links are constrained, local control required, or batching improves cost/reliability

## Design Checklist

### 1. Device Contract
- Define sensor catalog and units
- Set sampling frequency and throughput
- Design message schema with versioning
- Plan desired/reported properties for configuration

### 2. Security Baseline
- Unique identity per device
- No hardcoded secrets in firmware
- Credential rotation strategy
- Signed firmware and controlled updates

### 3. Reliability & Offline Behavior
- Implement backoff with jitter
- Local queue/buffer with bounded size
- Duplicate suppression or idempotent processing
- Fallback to last-known-good configuration

### 4. Observability
- Device heartbeat and firmware version
- Connectivity state transitions
- Message send success/error counters
- Gateway health and restart tracking

## Required Output

Always provide:
1. Chosen connectivity pattern and rationale
2. Message contract (fields, units, sample payload)
3. Security checklist
4. Reliability plan (retry, buffering, deduplication)
5. Implementation backlog

## Guidelines

- Do not use shared credentials across devices
- Do not assume always-on connectivity
- Include command authorization and auditing for actuators
- Plan for graceful degradation during outages

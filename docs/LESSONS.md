# Lessons Learned

What building SmartToolbox taught, in one place: for whoever picks this up next,
including someone building their own. Each lesson is short and links to where the full
story lives. Newest additions go at the top of their section, dated.

## Camera and vision

- **Pick the lens for the job before anything else.** (2026-11-04) The camera that ships
  with the Grove Vision AI V2 has a ~62 degree lens. To see one small drawer it had to be
  held about a foot above it, which would mean a two-foot mast over a bigger chest. A
  160 degree fisheye OV5647 (about $17, a generic Raspberry Pi camera board) works with
  the same module and covers the whole drawer from about 4 inches. The cost is fisheye
  distortion at the edges, which any model you train has to learn through the same lens.
  Photos: `docs/photos/fisheye-*-2026-11-04.jpg`. Detail: Phase 0 in
  `docs/PLAN-drawer-activity.md`.
- **The camera needs its own light.** (2026-11-04) In a normally lit room the inside of an
  open drawer is still dim and shadowed, and detection gets much worse in shadow. Plan for
  a white LED beside the camera, aimed the same way as the lens. Options for powering it
  are under Camera illumination LED in `docs/HARDWARE.md`.

## Sensors

- **A motion sensor (PIR) cannot tell you which drawer is open.** (2026-10-04) It reacts
  to warm moving things - your hand and arm - not to a drawer, and it goes quiet when a
  drawer is left open. It is useful as "someone is at the box", and nothing more. Detail:
  `docs/PLAN-drawer-activity.md`.
- **On the ESP32-S3, touch readings go up when touched.** On the original ESP32 they go
  down, so code and tutorials written for it silently never fire. Throw away the first
  ten or so readings after boot too; they are about eight times too high. Detail:
  `.claude/rules/firmware.md`.

## Wiring and the serial link

- **Put the Pi's serial port in raw mode, every time it connects.** Linux opens it with
  echo on, so the XIAO hears its own messages and the link fails in a way that looks fine
  from the Pi's side. Detail: `.claude/rules/serial-protocol.md`.
- **The XIAO ESP32S3 needs its external antenna for Wi-Fi.** Without it, Wi-Fi fails in a
  way that looks exactly like a wrong password. Check signal strength before suspecting
  the password.
- **A 5V LED strip runs mostly fine from a 3.3V Grove port, but not perfectly.** The
  WS2813 strip lit and worked from the expansion base's 3.3V port, which was enough to
  prove the wiring. Colours skew a little and the top of the brightness range is
  missing, and thirty LEDs at full white would draw more than that port should supply.
  Give it its own 5V supply before relying on it. Detail: `docs/HARDWARE.md`.

## Updates and recovery

- **Keep a way to flash the board that does not need working firmware.** Over-the-air
  updates need a running program to receive them, so one bad build can lock you out. Here
  the Pi can re-flash the XIAO over the USB cable already connecting them, which
  recovered a dead board in under a minute. Detail: the `firmware-release` skill and
  `docs/PLAN-usb-flashing.md`.
- **If the whole box powers on at once, the first update check always fails.** The Pi
  takes about 37 seconds to boot and the XIAO gives up after about 30. The device retries
  later on its own; to test an update, reset the XIAO alone with the Pi already running.

## Voice

- **Speech-to-text can run on a NAS you already own.** The Pi Zero 2 has too little memory
  to run Whisper itself, so the box sends audio to `whisper-asr-webservice` running on a
  NAS on the home network. Audio stays on the LAN and costs nothing per request, with
  OpenAI as a fallback setting. It is slow, though: about 9 seconds for one second of
  audio, and over 30 seconds on the first request after sitting idle, so the Pi waits
  90 seconds and the device 100. Telling Whisper the language (`language=en`) instead of
  letting it guess made it both faster and more accurate on quiet audio. Detail:
  `.claude/rules/serial-protocol.md`.

# Home dashboard

A custom Home Assistant dashboard in plain HTML, CSS and JavaScript. It is phone first and also lays out for a wall tablet (side rail, clock, bigger tiles) and a desktop browser. It talks to Home Assistant live over the WebSocket API, so changes show up instantly.

## Install

**Quickest (File editor, works from a phone):** upload the single-file build `dashboard-single/index.html` to `config/www/dashboard/index.html`. It holds all the CSS and JS in one file. Regenerate it after changing any source file with `python3 build.py`.

**Or copy the source folder:**

1. Copy this whole `dashboard` folder into Home Assistant's `config/www/` folder, so you end up with `config/www/dashboard/index.html`. The File editor, Studio Code Server or Samba add-ons all work for this. If `www` did not exist before, restart Home Assistant once.
2. Check it loads at `http://<your-home-assistant>:8123/local/dashboard/index.html`.

### In the Home Assistant app (phone) and the HA web UI

1. In Home Assistant go to **Settings → Dashboards → Add dashboard → Webpage**.
2. Enter `/local/dashboard/index.html` as the URL (use the full address from step 2 above if it asks for one), give it a title and an icon, and save.
3. It now appears in the sidebar of the app and the web UI. When opened this way it signs in with your existing Home Assistant login, so no token is needed.

### Directly in a browser or on a wall tablet

1. Open `http://<your-home-assistant>:8123/local/dashboard/index.html`.
2. In Home Assistant, open your profile, go to the **Security** tab and create a **Long-lived access token**.
3. In the dashboard, open **Settings**, paste the token and press **Save and connect**. The token is stored only on that device.
4. For a wall tablet, see **Wall mode** below.

### Install as an app

On an `https` address (for example Home Assistant Cloud), open the dashboard in Chrome or Edge, go to **Settings → Install as an app** and press **Install app** (or use the browser menu). On an iPhone or iPad, open it in Safari, tap **Share → Add to Home Screen**. It then opens full screen with its own icon. Browsers do not install apps from plain `http` addresses; there you can still add a home-screen shortcut from the browser menu.

## Using it

- **Tap** a light, switch, fan or toggle to turn it on or off. The tile changes straight away and settles once Home Assistant confirms; if the device does not respond, it flips back and a message says why.
- **Tap** a scene, script or button to run it. The tile shows a tick for a moment.
- **Long-press** any tile (or tap its ⋮ button, or right-click in a browser) for its full controls: brightness, warmth and colour for lights; speed for fans; the Run button for scenes and scripts.
- **Thermostats** get a wide card with − and + for the target temperature. Taps are gathered up and sent once you stop tapping. Tap the card itself for mode (heat, cool, …), preset and fan speed, and for heat/cool ranges.
- **Sensors** open to a graph of the last 24 hours; door, motion and other on/off sensors show a timeline of when they were on.
- Home shows your floor plan (or room tiles), with your cameras, thermostats and scenes underneath.

## Floor plan (Home)

Each home sets up its own floor plan in **Settings → Floor plan**. Nothing about any one house is built in, so the same file works for anyone.

1. **Upload a picture** of one floor (or pick "Draw rooms without a picture"). The picture has to be:
   - **PNG, JPG, WebP or SVG.** Not PDF or iPhone HEIC photos: take a screenshot of those and upload that.
   - **Up to 10 MB.** Bigger pictures are shrunk to 2000 pixels on the longest side so they fit in Home Assistant.
   - **At least 800 pixels on its longest side**, so walls stay sharp on a tablet.
   - **No more than 3 times as wide as it is tall** (or tall as it is wide).
   - **One floor per picture**, seen from above, cropped close to the house. Dark lines on a light background work best.
   Settings shows these rules and says exactly which one a picture breaks.
2. **Draw the rooms** over it: *Rectangle* (drag corner to corner) or *Any shape* (tap each corner, then the first again) for L-shaped rooms. Corners snap to nearby corners so shared walls line up. Select a room to drag its corners, drag the small dots to add a corner, drag inside to move it, or drag the little bar under its name to move the name. Undo goes back a step.
3. **Name each room and link it to a Home Assistant area.** Rooms are matched to areas by name until one is picked (common other names count, so "Lounge" finds "Living room"). Mark porches and decks as outdoors, and cupboards or stairs as "just part of the drawing".
4. Per floor: show **your picture** with the rooms over it, or **drawn 3D walls** made from the rooms; crop to the rooms; darken the picture in dark mode; show or hide room names (hide them if the picture already has names). **Add a floor** for each storey (up to 4); Home then shows floor buttons above the plan.

The plan saves as you go. With an administrator login on Home Assistant 2025.x or later it is saved for **everyone** (Home Assistant's shared frontend data), so every phone and wall tablet shows it. Other logins, and older Home Assistant versions, keep their own copy in their profile. **Export to a file** keeps a backup (pictures included) or copies the plan to another login or another Home Assistant; **Import a file** loads one.

Without a floor plan, Home shows your Home Assistant areas as room tiles instead.

- **Tap a room** to see its devices in a sheet: tap a tile to switch it, long-press (or ⋮) for full controls, and the back arrow returns to the room. Rooms with more than one light get **All off** and **All on**.
- Rooms with lights on glow in the colour of the light (warm or cool white for white bulbs) and show how many are on. The room's temperature shows when it has a temperature sensor or thermostat, a door icon means a door or window there is open, and a blue dot means motion.
- On a phone held upright, a wide plan is turned on its side so it fills the screen.

## Home: your day

- Across the top: good morning / afternoon / evening, the date, a big clock and the weather now (tap it for details) with today's high, low and chance of rain.
- **Your day ahead**: a short summary of the weather, what's on the calendar and where everyone is. It is written by the AI you have set up in Home Assistant: add the Anthropic, OpenAI or Google Gemini integration under Settings → Devices & services and give it an **AI Task** (the dashboard finds it by itself; pick another in **Settings → Home screen → Written by**). Without one, a plain summary is shown. A new one is written when the day's facts change (new event, the morning turns into afternoon, someone leaves home) and is shared with your other screens; ↻ writes a fresh one.
- On a desktop Home fills the screen in three parts: the greeting, your day ahead, the clock and weather across the top; under that the **floor plan** (three quarters, stays in place) beside the **family calendar** (every `calendar.*` entity: Google Calendar, Local Calendar…; Upcoming list or Month grid; tap a day for details), the **people map** and **notifications**. On a phone everything stacks.
- **Notifications** shows Home Assistant's own notification list (dismiss with ×) and notifications your automations sent to phones (`notify.*`) in the last week. Home Assistant does not keep the sent ones, so the dashboard records them while it is open (the wall tablet catches them all) and shares them through your profile; seeing them needs an administrator login. Turn the card off in **Settings → Home screen**.
- On a **tablet** (iPad size) or in **wall mode** the notifications move into a **bell** in the top bar instead: a red badge counts the new ones, tapping it opens them in a little popup, and a soft **ding** plays when a new one arrives. Safari and the Home Assistant app only allow sound once the screen has been touched after the dashboard opens, so the first ding works after your first tap (a wall panel is normally touched anyway). Choose Automatic, Bell or On Home, turn the ding off, or test it in **Settings → Home screen**.
- Devices are no longer on Home; they are in Devices. **Settings → Home screen** can bring solar, cameras, thermostats and scenes back underneath, and pick which calendars show.

## Unavailable devices and devices without a room

- Anything Home Assistant reports as unavailable (or unknown, with nothing to show) is left off the whole dashboard and comes back by itself when it is available again. Nothing is deleted in Home Assistant. **Settings → Display → Show unavailable devices** shows them again.
- **Settings → Devices without a room** lists every device Home Assistant has in no area. Pick a room for one and it shows up in that room on the floor plan, in its room sheet and under that room in Devices. Floor plan rooms are offered by their names once they are linked to an area. The choice only changes the dashboard and is saved to your Home Assistant profile, so the phone and the wall tablet agree.

## Cameras

Every `camera.*` entity shows on Home under **Cameras**, in its room's sheet on the floor plan (rooms with a camera show a camera icon), and in Devices. Tiles show the camera's latest picture, refreshed every 10 seconds while they are on screen.

- **Tap** a camera to watch it live. It starts muted; tap the speaker for sound (only shown when the camera sends audio) and the corner button for full screen. The other cameras sit underneath the video, so you can flick between them.
- It uses Home Assistant's own camera features over the same sign-in, so nothing extra needs installing. It tries the quickest route the camera offers: **WebRTC** (cameras set up through go2rtc, which Home Assistant includes, and Nest), then **HLS** (the stream integration, part of the default setup), then **MJPEG**, which every camera has. The video shows which one it got.
- HLS uses the hls.js player, downloaded from cdn.jsdelivr.net the first time it is needed (iPhones and iPads use their built-in player instead). Without internet access it falls back to MJPEG.
- The video hangs up when the app goes to the background or the sheet closes, and reconnects when you come back. On a wall panel the clock screen waits at least 10 minutes while a camera is open.

## People map

Home shows **People**: a map with everyone's phone and your zones (Home in blue, others lighter, passive zones dashed), with a chip per person underneath saying Home, Away or the zone they are in, and how far from home.

- Tap a face on the map or a chip for that person's sheet: where they are and since when, street address, distance from home, GPS accuracy, when the phone last sent its location, battery (and whether it is charging), plus **Show on map** and **Open in Maps**.
- The map follows everyone until you move it; the people button brings everyone back into view. On a phone one finger scrolls the page past the map and two fingers zoom; the full screen button lets one finger pan too. On a computer drag and use the zoom buttons.
- It reads Home Assistant's `person.*` entities and `zone.*` zones. GPS trackers no person uses (a car tracker) show too. Turn it off in Settings, Display.
- The map library (Leaflet) comes from cdn.jsdelivr.net and the map pictures from OpenStreetMap (tile.openstreetmap.org, no key needed), so it needs internet; the chips work without it. OpenStreetMap sees which map area is being looked at, not who is in it. In dark mode the same map is shown inverted.

**What each phone needs:** the Home Assistant Companion app signed in to your Home Assistant, location permission set to **Allow all the time** (Android: also Precise, and turn on the Background location sensor in the app's Settings, Companion app, Manage sensors; iPhone: Always and Precise Location on). Then in Home Assistant, Settings, People, open each person and pick their phone under **Track device**. The Battery level and Geocoded location sensors in the app add battery and address to the sheet.

## Solar and battery

Home shows **Solar and battery** at the top: a live diagram like the Sigen app, with solar above, the grid on the left, the house on the right and the battery below. Moving dots show which way power is going (faster for more power), and the grid says Buying or Selling, the battery Charging or Discharging with its level. Underneath are today's totals (solar, charged, discharged, and bought, sold and used when those sensors exist).

- Tap any circle or total for its 24-hour history.
- It finds the sensors by name, so it works with the Sigenergy Cloud integration (PV Power, Grid Power, Battery Power, Load Power, Battery State of Charge) and Sigenergy Local Modbus. If it picks the wrong one, choose it in Settings, Solar and battery.
- Integrations disagree on whether a positive grid number means buying or selling (and charging or discharging). The dashboard works this out from readings that add up and remembers it; if the arrows ever point the wrong way, set it by hand in the same Settings section.
- Sigenergy Cloud only updates every 5 minutes, so the numbers move in steps.

## Live sky background

The background is a sky that follows the real sun and weather:

- **Time of day** comes from Home Assistant's `sun.sun` entity (how high the sun is and whether it is rising or setting). Night is dark with stars and a moon, sunrise is a soft rose and gold glow that drifts upwards, sunset is a deeper orange that sinks, and clear days are blue. If there is no `sun.sun`, the clock is used instead.
- **Weather** comes from the first `weather.*` entity, or the one picked in **Settings → Background → Weather from**. Clouds drift (faster when windy), rain and snow fall, storms flash with lightning, fog rolls along the bottom, and overcast skies turn grey.
- Colours glide between states, so the sky changes gradually through the day.
- **Settings → Background → Preview a sky** shows each look (sunrise, sunset, rain, storm, snow and so on) without waiting for the weather. The preview resets when the page reloads.
- Text sitting straight on the sky switches between light and dark to stay readable, and the cards are frosted glass. The **Sky** theme also turns the cards dark after sunset.
- On an older tablet, turn off **Animate rain, snow and clouds** to save power; the sky still changes, just without movement. Turn off **Live sky** for the plain background.

## Wall mode

Turn on **Settings → Wall mode → Use this device as a wall panel** on the tablet (it is saved on that device only), or add `?wall` to the address. `?kiosk` does the same and also hides the menu.

- After a spell without touches (**Clock screen after**, 2 minutes by default) it goes back to Home and shows a large clock with the date, the weather and how many lights are on, over the sky. The clock shifts slightly every minute so nothing sits in one place.
- **Dim the clock screen** darkens it, and **Dim more after sunset** darkens it further at night. This is a dark layer on top of the page; the screen's own backlight is still set by the tablet (apps like Fully Kiosk Browser can control that).
- The first touch only wakes the screen; it does not press whatever is underneath.
- **Keep the screen on** stops the tablet going to sleep while the dashboard is open. Browsers allow this only on `https` addresses; Settings says whether it is working.
- A full-screen button appears at the top right in wall mode.

On a tablet in landscape and in a desktop browser, Home puts climate and scenes on the left with rooms down the right, and Devices shows rooms side by side in columns.

## Voice assistant (Assist)

The microphone button in the top bar talks to **Assist**, the voice assistant set up in Home Assistant. Tap it and speak; Home Assistant hears when you stop, does what you asked (or answers a question) and speaks the answer back. Tap the big button again to stop early. You can also type a question in the box underneath. If the assistant asks something back, it listens again by itself. The panel closes a minute after the last answer.

**What to set up in Home Assistant** (Settings → Voice assistants):

- **An assistant with speech-to-text.** Home Assistant Cloud gives one straight away. Without Cloud, add the **Whisper** add-on for speech-to-text and **Piper** for the spoken answer (Settings → Add-ons, then the Wyoming integration picks them up), and choose them in the assistant.
- **The conversation agent** decides how clever it is: Home Assistant's own handles commands like "turn off the kitchen lights"; pick the Anthropic (Claude), OpenAI or Google Gemini integration as the agent for free-form questions, with **Prefer handling commands locally** on so lights still switch quickly. Under the agent's options, **Control Home Assistant → Assist** lets the AI switch things too.
- Only the devices **exposed** to Assist can be controlled (Settings → Voice assistants → Expose).
- With more than one assistant, pick which one at the top of the panel; the choice is kept on that device. Without picking, Home Assistant's preferred assistant answers.

**The microphone normally needs `https`.** Browsers only let a page use the microphone on an `https` address (or on the device itself). **Chrome on a computer or Android can be told to trust your http address:** open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, type your dashboard's address without the path (for example `http://192.168.1.50:8123` or `http://homeassistant.local:8123`, exactly as it shows in the address bar), set it to **Enabled** and press **Relaunch**. The microphone then works on http, and the dashboard uses it whenever the browser allows. That flag does not exist on an iPad or iPhone (Chrome there is Safari underneath), so there it needs https. Without either, the button still opens the panel, explains this, and typing works. For https, use your Home Assistant Cloud address (`https://xxxx.ui.nabu.casa/local/dashboard/index.html`) or your own domain with a certificate (the Let's Encrypt or DuckDNS add-on, or a reverse proxy). Safari asks for the microphone the first time; tap Allow. If you said no, allow it again under **aA → Website Settings → Microphone** in Safari (or Settings → Safari → Microphone). Inside the Home Assistant app the microphone may be blocked by the app; use the app's own Assist button there.

There is no wake word ("Hey Jarvis"): a web page cannot listen all the time. For hands-free, a Home Assistant Voice speaker or an ESPHome satellite next to the wall tablet works with the same assistant.

## Good to know

- Files in `www` are served to anyone who can reach Home Assistant, without a login. That is why nothing secret lives in these files; the token only ever sits in the device's own storage.
- If Home Assistant is on `https`, use the `https` address. Browsers block an `https` page from talking to an `http` server.
- After updating the files, your browser or the app may show the old version for a while. Pull to refresh, or add `?v=2` (any new number) to the address.
- Rooms come from Home Assistant **areas**. Devices without an area are listed under "No room". Hidden and diagnostic entities are left out unless you turn them on in Settings.

## Files

| Path | What it does |
| --- | --- |
| `index.html` | Page shell |
| `css/styles.css` | Layout and theme (light, dark, auto) with phone, tablet and desktop breakpoints |
| `js/ha.js` | WebSocket client: auth, live state updates, keep-alive ping, auto reconnect, `callService`, `history` |
| `js/auth.js` | Picks the sign-in method: the Home Assistant session when embedded, otherwise the saved token |
| `js/entities.js` | Names, icons, friendly state text, and what a tap does for each kind of entity |
| `js/controls.js` | HTML for the tiles, thermostat card, detail-sheet controls and history graphs |
| `js/icons.js` | Material Design Icons used by the UI |
| `js/sky.js` | The live sky: colours for each sun height, clouds, rain, snow, fog, lightning, and previews |
| `js/wall.js` | Wall mode: clock screen, dimming, keeping the screen on, full screen |
| `js/plan.js` | The floor plan: matching rooms to areas, checking saved layouts, drawing a floor |
| `js/planedit.js` | Floor plan set-up: the picture rules and checks, and the room editor in Settings |
| `js/camera.js` | Camera pictures and the live player (WebRTC, HLS, MJPEG) |
| `js/people.js` | The people map: persons, zones, distances, and the Leaflet map |
| `js/energy.js` | Solar and battery: finding the sensors, which way power flows, and the flow diagram |
| `js/voice.js` | The voice assistant: microphone, streaming speech to Home Assistant's Assist, playing the answer, typed questions |
| `js/install.js` | Builds the app manifest and icons in the page so it can be installed as an app |
| `js/app.js` | Views (Home, Devices, Settings), routing, detail sheet, tap / long-press handling and service calls |
| `build.py` | Bundles everything into `../dashboard-single/index.html` |

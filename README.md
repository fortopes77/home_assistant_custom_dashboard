# Home dashboard

A custom Home Assistant dashboard in plain HTML, CSS and JavaScript, built around four questions:

- **Today:** what's my day? The time, the weather, a summary of the day, what needs attention right now, the calendar, the shopping list, notifications and the news.
- **Energy:** how's the solar going? Battery level, whether it's charging or running the house, how long it will last, and what you've made, used, **sold to the grid** and earned. It also shows the last 24 hours.
- **Places:** where is everyone? A map of the household, with each phone's place, distance from home and battery.
- **Home:** your floor plan and rooms, showing **only the devices exposed to your voice assistant**, plus climate, scenes and cameras.

It works on phones and on wall tablets, and also on desktops and a Google Nest Hub. It talks to Home Assistant live over the WebSocket API, so changes show up instantly. It is one HTML file, with no add-ons or HACS needed.

## Install

1. Download `index.html` from the top of this repository. GitHub builds it from `src/` on every change.
2. Use the **File editor** add-on (or Samba, or Studio Code Server) to put it in Home Assistant at `config/www/dashboard/index.html`. If `www` did not exist before, restart Home Assistant once.
3. Check that it loads at `http://<your-home-assistant>:8123/local/dashboard/index.html`.

### In the Home Assistant app and web UI

Go to **Settings → Dashboards → Add dashboard → Webpage** and enter `/local/dashboard/index.html`. The dashboard then appears in the sidebar and signs in with your existing login, so no token is needed.

### In a browser, on a wall tablet or on a Nest Hub

Open the address directly. In Home Assistant, go to your profile, then the **Security** tab, and create a **Long-lived access token**. Paste it in the dashboard under **Settings → Connection**. The token is stored only on that screen.

- `?wall` turns on wall mode for that address.
- `?kiosk` also hides the menu.
- `?token=<token>` signs in a screen without a keyboard, such as a Nest Hub cast with `catt`.

### Updating

After you upload a new file, open screens reload by themselves within 5 minutes. They watch `version.json` next to the page, so upload that file too. **Settings → Connection → Dashboard version** shows which build a screen is running. To have Home Assistant fetch every new build by itself, see [Automatic updates from GitHub](#automatic-updates-from-github).

## Using it

- **Tap** a light, switch or fan to turn it on or off. **Tap** a scene, script or button to run it.
- **Long-press** any tile, or tap its ⋮ button, for its full controls: brightness, warmth and colour for lights, blind position, thermostat modes and temperatures, and media volume.
- **Sensors** open to a graph of the last 24 hours.
- **Find a device** on Home searches everything shown.

## Only exposed devices

Rooms and Home show only the entities exposed in Home Assistant under **Settings → Voice assistants → Expose**, so the list stays short. To change what shows, expose or un-expose things there. In the dashboard, **Settings → Devices** can show everything instead. You can also show hidden and diagnostic entities, and unavailable ones.

An administrator login reads the exposed list and shares a copy, so screens signed in as other users (a Nest Hub token) use the same list. Solar, people, news, weather and the calendar are read whether they are exposed or not.

## Today

- **Hero:** a greeting, a big clock, the date and the weather now (tap it for the forecast). Below that is a short **summary of the day**: the weather, what's on and where everyone is. If Home Assistant has an AI integration (Anthropic, OpenAI or Google Gemini) with an **AI Task**, the AI writes the summary; otherwise a plain one is shown. To pick who writes it, or turn it off, use **Settings → Today**.
- **Right now** lists open doors, someone at a camera, appliances running and lights left on, with quick actions.
- **Calendar:** every `calendar.*` entity, as **Days** (today and tomorrow) or a **Month** grid. Tap a day to see its events. Choose which calendars show in Settings. It's also a **family calendar** you can add to, see [Family calendar](#family-calendar).
- **Shopping list:** your Home Assistant to-do list. Tap an item to tick it off, type to add one, and use **Clear ticked** to tidy up.
- **Notifications:** Home Assistant's own notices, which you can dismiss, and what your automations sent to phones (`notify.*`). The **bell** in the top bar counts new ones and plays a soft ding. Seeing what was sent to phones needs an administrator login.
- **News:** Feedreader feeds work, but Home Assistant only keeps the latest story from each, so the dashboard collects stories as they arrive and shares them between screens. For a full list straight away, add a sensor from the HACS **feedparser** integration:
  ```yaml
  sensor:
    - platform: feedparser
      name: News
      feed_url: "https://www.abc.net.au/news/feed/51120/rss.xml"
      date_format: "%a, %d %b %Y %H:%M:%S %z"
      scan_interval:
        minutes: 15
      inclusions: [title, link, published, summary, image]
  ```
- **Settings → Today** can also add cameras, climate and scenes to Today, and turn off any card.

## Energy

The Energy page shows a live power-flow diagram: solar, grid, house and battery, with a battery gauge and how long it will last. It also shows today's totals, money earned from selling to the grid, monthly and yearly exports, and 24-hour charts.

- Sensors are found by name. That works with the Sigenergy integrations and most others. If it picks the wrong ones, choose them under **Settings → Energy → Sensors and directions**.
- Integrations disagree on whether a positive grid number means buying or selling, and whether a positive battery number means charging or discharging. The dashboard works this out from readings that add up. If an arrow points the wrong way, set it there yourself.
- Enter your **feed-in rate** and what you pay per kWh to see dollars.
- `homeassistant/battery_full.yaml` is an example automation that notifies a phone when the battery reaches 100%. Give it the id `dashboard_battery_full` and the Energy page shows a switch for it.
- `homeassistant/solar_recap.yaml` sends an 8 pm summary of the day's solar. With the id `dashboard_solar_recap` the Energy page shows a switch for it too.
- `homeassistant/notify_family.yaml` is a script that sends one notification to every family device through the Home Assistant app, optionally reworded by an AI task. The other examples can call it instead of a single phone.
- To hide the Energy page, turn off **Show the Energy page**.

## Places

A map with everyone's phones and your zones, plus a card per person. Each card shows where they are and since when, their address, distance from home and phone battery. A person's sheet has **Show on the map** and **Directions**. Wall tablets that are set up as people are hidden from the map by default; choose who shows under **Settings → People and the map**.

The map library (Leaflet) comes from cdn.jsdelivr.net and the map pictures from OpenStreetMap, so the map needs internet.

**What each phone needs:**

- The Home Assistant Companion app, signed in.
- Location set to **Allow all the time**, with precise location on.
- In Home Assistant, under **Settings → People**, that phone picked under **Track device** for its person.

The Battery level and Geocoded location sensors in the app add the battery and address.

## Family calendar

Add, change and delete events right on Today, and say **who** each one is for: one of you, or both. Each person has a colour, every event shows a name tag, and **Everyone / Azelia / Andrew** at the top of the calendar shows just one person's things (plus shared ones) on that screen.

- **+** on the calendar, or **Add an event** on a day, makes a new one. Tap any event to change or delete it (delete asks for a second tap). For a repeating event, choose **Only this one** or **This one and later ones**.
- Events go in calendars Home Assistant can write to: **Local Calendar** or **Google Calendar**. A calendar named after someone (`Azelia`, `Andrew`) is theirs, and one called `Family` is for both. Change this under **Settings → Today**.
- With only one shared calendar, the event's notes get a line like `Who: Andrew` instead, and the dashboard reads it back.
- Calendars that can only be read (like an iCal feed) still show, and open read-only.
- Reminders: [`homeassistant/calendar_reminders.yaml`](homeassistant/calendar_reminders.yaml) sends one 30 minutes before (7:00 for all-day events) to whoever it's for, or to the whole family.

## Shopping reminders at the shops

`homeassistant/shopping_nearby.yaml` is an example automation. When someone arrives at a supermarket and the shopping list isn't empty, it sends them the list. A supermarket is any zone with the `mdi:cart` icon, so add your local shops as zones with that icon. They show as small carts on the map.

## Floor plan (Home)

Each home sets up its own floor plan in **Settings → Floor plan**. Nothing about any one house is built in.

1. **Upload a picture** of one floor, or pick "Draw rooms without a picture". The picture must be:
   - a PNG, JPG, WebP or SVG, up to 10 MB;
   - at least 800 pixels on its longest side;
   - no more than 3 times as wide as it is tall;
   - one floor per picture, cropped close to the house.

   Settings explains which rule a picture breaks.
2. **Draw the rooms** over it. Use **Rectangle** (drag corner to corner) or **Any shape** (tap each corner, then the first one again). Corners snap together so shared walls line up. Select a room to drag its corners, add corners, move it or move its name. **Undo** steps back.
3. **Name each room and link it to a Home Assistant area.** Until you pick an area, rooms are matched to areas by name. Mark porches and decks as outdoors.
4. **Per floor**, choose between your picture and drawn 3D walls, and set crop, dark-mode darkening and room names. **Add a floor** for each storey, up to 4.

The plan saves as you go. With an administrator login it is saved for **everyone**, so every screen shows it. **Export to a file** keeps a backup, pictures included; **Import a file** loads one.

On Home, rooms glow when their lights are on and show temperature, open doors and motion. **Tap a room** to see its devices. Without a floor plan, Home shows your areas as room cards.

**Devices without a room:** **Settings → Devices without a room** lists devices that Home Assistant has in no area. Pick a room for one and it shows up there. This only changes the dashboard, and it is saved to your Home Assistant profile.

## Cameras

Every `camera.*` entity shows on Home and in its room, with a picture that refreshes every 10 seconds. **Tap** a camera to watch it live. The dashboard tries WebRTC first (go2rtc, which Home Assistant includes), then HLS, then MJPEG, and the video says which one it got. HLS uses hls.js from cdn.jsdelivr.net, except on iPhones and iPads.

## Wall mode

Turn on **Settings → Wall mode** on the tablet, or add `?wall` to the address.

- After a spell without touches it goes back to Today and shows a large clock with the date, the weather and how many lights are on. The clock moves slightly every minute.
- You can dim the clock screen, and dim it more after sunset.
- **Keep the screen on** stops the tablet sleeping. Browsers allow this only on `https` addresses.
- The first touch only wakes the screen. A full screen button appears in the top bar.

## Time and weather tint

Today has a soft wash of colour behind it that follows the sun (`sun.sun`) and the weather: gold in the morning, blue at midday, rose at sunset, indigo at night, and greyer or bluer when it's cloudy or raining. The colours drift slowly as things change, and the other pages stay plain. Turn it off under **Settings → Look → Time and weather tint on Today**. It steps aside while the live sky is on.

## Live sky background

**Settings → Look → Live sky background** draws a sky that follows the real sun (`sun.sun`) and weather: sunrise and sunset glows, stars at night, drifting clouds, rain, snow, storms and fog. The cards turn to frosted glass over it. **Preview a sky** shows each look. On an older tablet, turn off the animation to save power.

## Voice assistant (Assist)

The microphone button talks to **Assist**. Tap it and speak, or type. Set up an assistant with speech-to-text in Home Assistant (Home Assistant Cloud, or the Whisper and Piper add-ons). Only exposed devices can be controlled.

Browsers only allow the microphone on `https`. In Chrome on a computer or Android, you can allow your http address instead: open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enter the address, enable it and relaunch.

## Install as an app

On an `https` address, open the dashboard in Chrome or Edge and use **Settings → Install as an app**. On an iPhone or iPad, use Safari's **Share → Add to Home Screen**.

## Automatic updates from GitHub

Every push to `main` runs `.github/workflows/build.yml`. It builds `src/` into `index.html` and `version.json` and commits them to the top of the repository. Then, if the repository has an `HA_WEBHOOK_URL` secret, it calls that Home Assistant webhook.

To have your own Home Assistant follow a copy (fork) of this repository:

1. Copy `homeassistant/update_dashboard.sh` to `/config/scripts/`.
2. Put `homeassistant/dashboard_update.yaml` in `/config/packages/`. To enable packages, add this to `configuration.yaml`:
   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```
3. In the YAML, replace `OWNER/REPO` with your fork and `WEBHOOK_ID` with a long random string. Then restart Home Assistant.
4. In GitHub, go to **Settings → Secrets and variables → Actions** and add the secret `HA_WEBHOOK_URL`, set to `https://<your external address>/api/webhook/<WEBHOOK_ID>`. The webhook id works like a password, so keep it out of the repository.

If a download fails, a notice appears in Home Assistant.

## Good to know

- Files in `www` are served to anyone who can reach Home Assistant, without a login, so nothing secret lives in these files. A token only ever sits in the screen's own storage.
- If Home Assistant is on `https`, use the `https` address. Browsers block an `https` page from talking to an `http` server.

## Files

| Path | What it does |
| --- | --- |
| `index.html`, `version.json` | The built dashboard to upload (made by GitHub; don't edit) |
| `build.py` | Bundles `src/` into `dist/index.html` and `dist/version.json` |
| `src/index.html` | Page shell |
| `src/css/app.css` | Layout and themes; the `_*.css` partials style the floor plan, map, cameras, settings and wall mode |
| `src/js/main.js` | The app: views, sheets, actions, Settings, the exposed list, notifications, news and the shopping list |
| `src/js/ha.js`, `auth.js` | WebSocket client and sign-in |
| `src/js/entities.js`, `controls.js`, `icons.js` | Entity names and states, tiles and controls, icons |
| `src/js/plan.js`, `planedit.js`, `planset.js` | Drawing the floor plan, the room editor, and saving the plan in Home Assistant |
| `src/js/home.js` | Grouping rooms and "Right now" |
| `src/js/energy.js` | Finding the solar sensors and the power flow |
| `src/js/people.js` | People, zones and the Leaflet map |
| `src/js/calendar.js`, `brief.js`, `notify.js`, `news.js` | Calendar, day summary, notifications and news |
| `src/js/camera.js`, `voice.js` | Camera player and Assist |
| `src/js/sky.js`, `tint.js`, `wall.js`, `install.js` | Live sky, the Today tint, wall mode, and installing as an app |
| `homeassistant/` | Example automations and the GitHub update package |

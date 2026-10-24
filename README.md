# Voice Assistant 

A voice app for your Android phone that talks to the AI model of your choice using your own API keys. Everything runs in Chrome on the phone. The files are static, so there is nothing to run or maintain; they just need to be reachable at a web address once.

## What it does

- Switch between **Anthropic, OpenAI, Google Gemini, OpenRouter** or any **OpenAI-compatible** endpoint. Tap the chip at the top to change provider and model. Each provider keeps its own key.
- Replies stream in and are spoken sentence by sentence, so speech starts before the full answer is written.
- Voices: your phone's built-in voices, or OpenAI voices (uses your OpenAI key).
- Hands-free loop: listen, answer, listen again. Tap the orb to cancel, stop or interrupt.
- Installs like an app and opens straight into listening.
- Turn off "Show the written conversation" in Settings for a minimal screen with just the orb and a caption.

## Put it online (one time, free)

Any static host works. GitHub Pages:

1. Create a new **public** repository on GitHub, for example `voice`.
2. Upload every file in this folder to the repository root (drag them into the web page).
3. Repository **Settings → Pages → Build and deployment**: Source "Deploy from a branch", branch `main`, folder `/ (root)`. Save.
4. After a minute your app is at `https://YOUR-NAME.github.io/voice/`.

Cloudflare Pages and Netlify also work if you prefer them. The page contains no keys, so a public repo is fine. Your keys are typed into the app on your phone and stay in that browser.

## Install on your phone

1. Open the address in **Chrome** on Android.
2. Menu (⋮) → **Install app** (or Add to Home screen).
3. Open it from its icon, allow the microphone when asked, then add an API key under Settings.
4. Tap the chip at the top to pick a provider and model. "Refresh model list" loads the models your key can use.

## Launch it from a button

The installed app opens listening straight away. Anything on your phone that can open an app can start it:

- **Hardware button** (side key, action key, Bixby or similar): in your phone's settings, look for the button or side key options and set it to open an app, then choose Voice. Exact wording depends on the phone.
- **Long-press the app icon** for a "Talk now" shortcut.
- **Home-screen shortcut or automation app** (Tasker, MacroDroid): have it open the app.

## Files

`index.html`, `style.css`, `lib.js` (provider requests and streaming), `app.js` (the app), `sw.js` (offline cache), `manifest.webmanifest` and the icons.

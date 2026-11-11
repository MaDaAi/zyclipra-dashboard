# Zyclipra website

The online companion to [Zyclipra](https://madaai.github.io/zyclipra-dashboard/), a free Windows clipping and audio app.

- **Clips:** sign in with Google to see, play and download the clips the Zyclipra app uploaded to your Google Drive.
  The site only asks for `drive.file`, so it can only see files Zyclipra made.
- **PC controls (same network only):** Clip it, recording, screenshots, instant replay and the soundboard.
  The app leaves a private link file in your Drive with your PC's home-network address and a random key;
  this page uses it to connect straight to your PC over WebRTC (the connection setup passes through that Drive
  file). No relay server of ours is involved and no ports are opened to the internet.

It is a static site: no server of ours, no database, no client secret, no cookies and no analytics. The Google
token and the PC session stay in memory and are gone when you close the tab. See privacy.html, terms.html,
cookies.html and refunds.html.

`config.js` holds the public Google OAuth client ID.

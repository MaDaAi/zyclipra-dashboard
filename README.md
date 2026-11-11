# Zyclipra website

The online companion to [Zyclipra](https://madaai.github.io/zyclipra-dashboard/), a free Windows clipping and audio app.

- **Clips:** sign in with Google to see, play and download the clips the Zyclipra app uploaded to your Google Drive.
  The site only asks for `drive.file`, so it can only see files Zyclipra made.
- **PC controls (same network only):** Clip it, recording, screenshots, instant replay and the soundboard.
  The app leaves a private link file in your Drive with your PC's home-network address and a random key;
  this page uses it to connect straight to your PC. Nothing goes through a server and no ports are opened
  to the internet. If the browser blocks the connection, the page links to the PC's own dashboard instead.

It is a static site: no server, no database, no client secret, and nothing is stored in your browser
after you close the tab (the Google token and the PC session stay in memory).

`config.js` holds the public Google OAuth client ID.

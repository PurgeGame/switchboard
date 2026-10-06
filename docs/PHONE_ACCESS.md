# Use Switchboard from your phone (Tailscale)

The daemon stays bound to `127.0.0.1`. `tailscale serve` gives this machine a private HTTPS name that only devices on your tailnet can reach, and forwards it to the daemon.

1. Install Tailscale on the phone and sign in to the same account.
2. On this machine, run `sb phone`. The first time, it sets up `tailscale serve` (Tailscale may ask you to enable Serve for your tailnet once, in the browser).
3. Scan the QR code with the phone's camera within 60 seconds. The phone is logged in for 12 hours.
4. Afterwards, open `https://<this machine>.<tailnet>.ts.net` on the phone (add it to the home screen). Run `sb phone` again when the login expires.

The daemon looks up its tailnet name at start and accepts that exact name over HTTPS, as well as `127.0.0.1`. To turn this off, set `"remoteHost": null` in `~/.config/switchboard/config.json`; to use another name, set it there. `sb signout` signs every browser out, phones included.

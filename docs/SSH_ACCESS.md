# Access Switchboard over SSH

Run Switchboard on the machine that owns the sessions, then forward its loopback port to your local browser. The daemon remains bound to `127.0.0.1`; do not expose it on a public interface.

On your local computer, open a tunnel (replace the host and account):

```sh
ssh -N -L 7777:127.0.0.1:7777 user@remote-host
```

Keep that SSH command running. In a second SSH shell on the remote machine, run:

```sh
sb login
```

Open the printed `http://127.0.0.1:7777/auth?...` link in a browser on your local computer while the tunnel is active. The login link expires after 60 seconds and can only be used once. The UI and its API traffic then travel through the SSH tunnel to the daemon; sessions, provider credentials, and the daemon stay on the remote machine.

The local and remote tunnel ports must match the daemon's configured port because Switchboard checks the browser's `Host` and `Origin`. For a different port, configure the remote daemon with `SB_PORT=<port>` and forward that same port on both sides:

```sh
ssh -N -L 7788:127.0.0.1:7788 user@remote-host
```

Then run `SB_PORT=7788 sb login` remotely. Closing the SSH tunnel disconnects the browser but does not stop Switchboard or its sessions.

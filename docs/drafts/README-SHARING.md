## Share this Harness with a guest

<!-- DRAFT for the root README. This comment is not part of the section.
Paste from the heading above. UI labels are the strings in
packages/plugin/src/client/index.ts; the contract is docs/SHARING.md. -->

Sharing lets another person remote-control your Harness from a browser without
installing anything and without giving them your owner password. It is **off by
default**, and it is scoped to one device.

1. Open the DSH RC panel in the Harness sidebar and turn on **Share this
   Harness**. The panel says: “On — anyone with an invite link can request
   access. You approve every guest.”
2. Choose **Invite expires** — **15 minutes**, **1 hour**, **24 hours**, or
   **Never** — and press **Create invite**. The link is shown **once**, with
   **Copy** and a QR code. Treat it as a secret until it is used or expires.
3. Send the link. The guest opens it in any browser, sees the device name and
   invite label, and clicks **Request access**. That creates a pending request,
   not a session.
4. The request appears under **Waiting for approval** with the guest's label,
   IP and user-agent. Press **Approve** or **Deny**. Nothing reaches the
   Harness before you approve.
5. The guest lands in the real Harness UI at `/d/<deviceId>/`. You can watch
   them under **Active guests** (label, IP, since) and press **Revoke**, or
   **Revoke all**.

### What a guest can and cannot do

A guest can use the Harness UI for that device: the same conversations,
workspace, terminal and tools you can. They cannot reach the dashboard,
`/v1/*`, `/setup`, `/pair`, `/login`, device approve/revoke, invites, approvals
or sharing settings — those return `403`.

There is **no read-only guest mode** and no per-guest file or terminal scoping.
Treat sharing as handing someone the desktop, not as showing them a document.

The guest client is a current desktop browser. There is no mobile app, and mobile
browsers are not a supported client.

### Two warnings, stated plainly

**A guest session never expires on its own.** It is a signed, device-scoped
cookie with no server-side expiry and a ten-year `Max-Age`. Closing the browser,
rebooting the guest's laptop, restarting the edge, or a tunnel reconnect does
not end it, and there is no idle timeout. It ends only when the guest presses
**Disconnect**, you **Revoke** that guest or **Revoke all**, you turn **Share
this Harness** off, you revoke the device, or the edge database is deleted. A
stolen guest cookie is therefore **permanent access until you revoke it**. If a
guest's machine may be compromised, use **Revoke all** and turn sharing off.

**Multiple guests can control the same Harness at once.** There is no
controller lock. They share one single-user desktop — the same workspace,
terminal and tools — so they can interfere with each other, overwrite work, or
read what another guest is doing. The panel shows a standing warning and lists
every guest separately. Share with people you would let sit at this computer.

### Networking prerequisite

The guest must be able to reach the edge. A loopback-only edge can share only
with browsers on the same machine. For anyone else, the edge needs a public
HTTPS URL:

- **Tailscale Funnel** — a free public HTTPS URL; the guest installs nothing.
- **A VPS edge** — the production shape; no Tailscale anywhere.
- **Tailscale Serve** — only for guests who have joined your tailnet.

The panel warns when the advertised `publicUrl` is loopback. Sharing is an
authorization feature; reachability is deployment. See
[`docs/SHARING.md`](docs/SHARING.md) and [`docs/DEPLOY.md`](docs/DEPLOY.md).
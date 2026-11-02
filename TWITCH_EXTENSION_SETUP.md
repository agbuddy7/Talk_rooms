# Twitch Extension setup

SideChat supports two front-end modes from the same files:

- In a normal browser it shows the Signal Lab dashboard and permits local preview identities when no Extension secret is configured.
- Inside a Twitch Extension iframe it becomes a transparent video overlay with a compact invitation floater and room drawer.

## Twitch console

1. Create a Twitch Extension and enable the **Video Overlay** type.
2. Enable **Request Identity Link** so chat participants can be matched to their numeric Twitch user IDs.
3. Set the Video Fullscreen viewer path to `index.html`.
4. Add `https://talk-rooms-6x2v.onrender.com` to **Allowlist for URL Fetching Domains**.
5. Upload a ZIP containing the contents of `public/` at the ZIP root, then move the version to Hosted Test.
6. Copy the current base64-encoded Extension shared secret into the backend environment as TWITCH_EXTENSION_SECRET.
7. Set `TWITCH_EXTENSION_ORIGINS` to the exact Twitch origin (`https://EXTENSION_ID.ext-twitch.tv`) in Render. When omitted, the backend accepts Twitch Extension origins and localhost but still requires a valid signed JWT.
8. Set `ALLOW_PREVIEW_IDENTITY=false` and `ENABLE_SIGNAL_LAB=false` for the hosted build.
9. Keep `TWITCH_BROADCASTER_ID` set to the channel numeric ID so viewer JWTs from other channels are rejected.

The Extension files use the API base declared in the `sidechat-api-base` meta tag in `public/index.html`. Local dashboard requests remain same-origin; requests from Twitch use the Render HTTPS backend.

The Extension Helper calls onAuthorized whenever its JWT refreshes. SideChat sends the newest JWT in the x-extension-jwt header. The backend verifies its HS256 signature, expiration, channel, and role before returning invitations or accepting room actions.

Unlinked viewers see a consent card. Selecting **Connect Twitch identity** calls Twitch.ext.actions.requestIdShare(). Until Twitch returns a linked JWT containing user_id, SideChat cannot correlate that viewer with their EventSub chat messages and will not reveal invitations.

## Viewer safety controls

- **Not now** dismisses one invitation until it expires.
- **Leave** removes the viewer from the room and hides that invitation.
- **Mute topic** hides the topic for ten minutes.
- **Report** records a bounded backend moderation event and mutes the topic.
- Rooms remain invitation-only and expire automatically.

Never expose TWITCH_EXTENSION_SECRET to browser code or commit it to source control.

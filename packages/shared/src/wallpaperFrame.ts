/** The web app's static page that runs chat wallpaper scenes (`apps/web/public`). */
export const WALLPAPER_FRAME_PATH = "/wallpaper-frame.html";

/**
 * Scenes are third-party code: an opaque origin, no network, and eval only for the scene the frame
 * hands its worker. Every server of the web app sends this instead of its app-wide policy, which
 * forbids framing and eval.
 */
export const WALLPAPER_FRAME_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval'",
  "worker-src blob:",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

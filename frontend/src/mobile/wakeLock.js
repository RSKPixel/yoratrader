import { useEffect, useState } from "react";

// Keep the phone's screen on while the app is open. Two ways:
//  1. the Screen Wake Lock API (https pages only, recent browsers);
//  2. otherwise (e.g. dev over plain http) a tiny silent video playing on a loop, out of sight, which phones
//     treat as "watching something" (it may need one tap on the page before it can start).
// Both are dropped by the phone when the app goes to the background, so they are taken again each time it comes back.
// Returns "on", "off" or "tap" (waiting for a tap to start the video).
export function useWakeLock(want) {
  const [state, setState] = useState("off");
  useEffect(() => {
    if (!want) {
      setState("off");
      return;
    }
    let gone = false;
    let lock = null;
    let video = null;

    const playVideo = () => {
      if (!video) {
        video = document.createElement("video");
        video.setAttribute("playsinline", "");
        video.setAttribute("muted", "");
        video.muted = true;
        video.loop = true;
        video.setAttribute("aria-hidden", "true");
        Object.assign(video.style, { position: "fixed", left: "-100px", top: "-100px", width: "1px", height: "1px", opacity: "0", pointerEvents: "none" });
        for (const [src, type] of [["/awake.webm", "video/webm"], ["/awake.mp4", "video/mp4"]]) {
          const s = document.createElement("source");
          s.src = src;
          s.type = type;
          video.appendChild(s);
        }
        document.body.appendChild(video);
      }
      return video.play().then(
        () => !gone && setState("on"),
        () => !gone && setState("tap"),
      );
    };

    const take = async () => {
      if (gone || document.visibilityState !== "visible") return;
      if ("wakeLock" in navigator && window.isSecureContext) {
        if (lock && !lock.released) return;
        try {
          lock = await navigator.wakeLock.request("screen");
          if (gone) return lock.release();
          setState("on");
          lock.addEventListener("release", () => !gone && document.visibilityState === "visible" && take());
          return;
        } catch {
          // refused (battery saver, say): fall back to the video
        }
      }
      playVideo();
    };
    // a tap anywhere lets the video start if the phone wouldn't play it by itself
    const onTap = () => {
      if (!lock || lock.released) take();
    };

    take();
    document.addEventListener("visibilitychange", take);
    document.addEventListener("touchend", onTap, { passive: true });
    document.addEventListener("click", onTap);
    return () => {
      gone = true;
      document.removeEventListener("visibilitychange", take);
      document.removeEventListener("touchend", onTap);
      document.removeEventListener("click", onTap);
      lock?.release().catch(() => {});
      if (video) {
        video.pause();
        video.remove();
      }
    };
  }, [want]);
  return state;
}

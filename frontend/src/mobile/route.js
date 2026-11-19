import { useEffect, useState } from "react";

// The phone app's own addresses: /mobile/<tab>[/<id>] (home, live, schedule, more; paper/<book>). A link
// into the wide site's paper books (/v2/paper/<book>, from shared parts like the position charts) opens the
// phone's book page instead; any other /v2 address loads the wide site.

export function parse(path = window.location.pathname) {
  const v2 = path.match(/^\/v2\/paper\/([^/]+)/);
  if (v2) return ["paper", v2[1]];
  const parts = path.replace(/^\/mobile\/?/, "").split("/").filter(Boolean);
  return parts.length ? parts : ["home"];
}

export function go(href) {
  window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export const link = (href) => (e) => {
  e.preventDefault();
  go(href);
};

export function useRoute() {
  const [route, setRoute] = useState(() => parse());
  useEffect(() => {
    const on = () => {
      const path = window.location.pathname;
      if (path.startsWith("/v2/paper/")) window.history.replaceState(null, "", `/mobile/paper/${parse(path)[1]}`);
      else if (!path.startsWith("/mobile")) return window.location.assign(path); // the wide site
      setRoute(parse());
      document.getElementById("mobile-main")?.scrollTo(0, 0);
    };
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}
